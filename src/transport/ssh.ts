import { runInteractiveProcess, runProcess, type ProcessResult } from "../runtime/process";

type Writer = { write(chunk: string): unknown };

export interface TransportIO {
  stdout: Writer;
  stderr: Writer;
}

export type SshRunner = (args: string[]) => Promise<ProcessResult>;

export interface SshForwardOptions {
  host: string;
  args: string[];
  io: TransportIO;
  wuxPath?: string;
  // Raw `--host` forwarding resolves wux on the remote at runtime (common install
  // locations + a login-shell lookup) instead of trusting the bare non-interactive
  // PATH. Set for the raw-host path; named remotes keep using `wuxPath`. An optional
  // hint (`--host-wux` / WUX_REMOTE_WUX_PATH) is tried first for non-standard installs.
  resolveRemoteWux?: boolean;
  hostWuxHint?: string;
  runner?: SshRunner;
  // Command-level timeout override (ms). 0 disables the command timeout (used for
  // forwarded `attach`, which must not be capped); omitted uses the forward default.
  timeoutMs?: number;
  // Interactive forwarded verb (attach): allocate a remote PTY (`ssh -tt`) and run
  // with inherited stdio so the full-screen TUI passes through, instead of the
  // capture-and-replay path. Set ONLY for `attach` — never for long-but-captured
  // verbs like `wait`/`read --follow`, whose output must stay captured.
  interactive?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_FORWARD_TIMEOUT_MS = 30000;
// setTimeout delays above the 32-bit signed max overflow and fire almost
// immediately (Bun/Node clamp to 1ms), so cap the forward timeout there.
const MAX_TIMER_MS = 2_147_483_647;

export async function forwardSshCommand(options: SshForwardOptions): Promise<number> {
  const tty = options.interactive === true;
  const sshArgs = options.resolveRemoteWux
    ? sshRawHostForwardArgs(options.host, options.args, options.hostWuxHint, { tty })
    : sshForwardArgs(options.host, options.args, options.wuxPath, { tty });
  if (tty) {
    // Interactive attach: inherit the local terminal through the remote PTY. The
    // remote TUI and ssh's own diagnostics already reach the terminal via inherited
    // stdio, so there is no captured stdout to replay and no command-timeout cap —
    // the live session bounds its own lifecycle. A spawn-level failure (e.g. the
    // local `ssh` binary missing) surfaces ONLY through the runner's stderr, so write
    // it through; otherwise the user gets a bare non-zero exit with no reason.
    const result = await (options.runner ?? runInteractiveProcess)(sshArgs);
    if (result.stderr.length > 0) options.io.stderr.write(result.stderr);
    return result.code;
  }
  const result = options.runner
    ? await options.runner(sshArgs)
    : await runProcess(sshArgs, { timeoutMs: options.timeoutMs ?? forwardTimeoutMs() });
  if (result.stdout.length > 0) options.io.stdout.write(result.stdout);
  if (result.stderr.length > 0) options.io.stderr.write(result.stderr);
  return result.code;
}

export function sshForwardArgs(host: string, args: string[], wuxPath = "wux", opts: { tty?: boolean } = {}): string[] {
  return sshRemoteArgs(host, ["env", "WUX_FORCE_LOCAL=1", wuxPath, ...args], opts);
}

// Remote bootstrap for raw `--host`: a named remote stores an explicit `wuxPath`,
// but a raw host has none, and a bare `wux` over non-interactive SSH misses common
// install dirs like `~/.local/bin` (`env: 'wux': No such file or directory`). This
// resolves wux ON the remote at runtime — an optional hint first, then
// `$HOME/.local/bin/wux`, then a login-shell lookup, then the non-interactive PATH —
// and on miss prints an actionable error (install / `--host-wux`) instead of the raw
// `env` failure. The host label and hint are passed as positionals ($1/$2), never
// interpolated into the snippet, so a hostile host/hint string cannot break out.
export function sshRawHostForwardArgs(host: string, args: string[], hostWuxHint = "", opts: { tty?: boolean } = {}): string[] {
  return sshRemoteArgs(host, ["sh", "-c", RAW_HOST_RESOLVE_SNIPPET, "wux", host, hostWuxHint, ...args], opts);
}

const RAW_HOST_RESOLVE_SNIPPET = [
  '__wux_host=$1; __wux_hint=$2; shift 2;',
  'for __wux in "$__wux_hint" "$HOME/.local/bin/wux" "$(bash -lc \'command -v wux\' 2>/dev/null)" "$(command -v wux 2>/dev/null)"; do',
  '  if [ -n "$__wux" ] && [ -x "$__wux" ]; then exec env WUX_FORCE_LOCAL=1 "$__wux" "$@"; fi;',
  'done;',
  'echo "wux: could not resolve a wux binary on host \'$__wux_host\' (tried --host-wux hint, ~/.local/bin/wux, login-shell PATH, and bare wux on the non-interactive PATH). Install wux there (see docs/running.md) or pass --host-wux <path> / set WUX_REMOTE_WUX_PATH=<path>." 1>&2;',
  'exit 127',
].join("\n");

export function sshRemoteArgs(host: string, args: string[], opts: { tty?: boolean } = {}): string[] {
  return [
    "ssh",
    // Force a remote PTY for interactive forwarded verbs (attach). `-tt` (doubled)
    // allocates even when ssh's own stdin is not a tty; omitted otherwise so
    // captured verbs keep clean, PTY-free stdout/stderr.
    ...(opts.tty ? ["-tt"] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds()}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "--",
    host,
    remoteCommand(args),
  ];
}

export function connectTimeoutSeconds(): number {
  return positiveIntEnv("WUX_SSH_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_SECONDS);
}

export function forwardTimeoutMs(): number {
  return Math.min(positiveIntEnv("WUX_SSH_TIMEOUT", DEFAULT_FORWARD_TIMEOUT_MS), MAX_TIMER_MS);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  // Strict: only a pure non-negative integer string. Reject partial-numeric
  // values like "30s" (Number.parseInt would lenient-parse to 30) and anything
  // outside the safe-integer range.
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function remoteCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

export function stripTargetArgs(rawArgs: string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < rawArgs.length; ) {
    const arg = rawArgs[index];
    if (arg === "--host" || arg === "--host-wux") {
      index += 2;
      continue;
    }
    if (arg.startsWith("--host=") || arg.startsWith("--host-wux=")) {
      index += 1;
      continue;
    }
    if (arg === "--remote") {
      index += 2;
      continue;
    }
    if (arg.startsWith("--remote=") || arg === "--local") {
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") {
      forwarded.push(arg);
      index += 1;
      continue;
    }
    forwarded.push(...rawArgs.slice(index));
    break;
  }

  return forwarded;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
