import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { attachCommand } from "./commands/attach";
import { handoffCommand } from "./commands/handoff";
import { interruptCommand } from "./commands/interrupt";
import { markCommand, type MarkStatus } from "./commands/mark";
import { mcpCommand } from "./commands/mcp";
import { pruneCommand } from "./commands/prune";
import { followRead, readCommand, readRun } from "./commands/read";
import { remotesCommand } from "./commands/remotes";
import { formatResultEnvelope, resultCommand, resultExitCode, waitResultEnvelope } from "./commands/result";
import { runCommand, type RunBackend } from "./commands/run";
import { sendCommand, type SendResult } from "./commands/send";
import { skillsCommand } from "./commands/skills";
import { formatStatusRows, statusCommand, statusJsonCommand } from "./commands/status";
import { stopCommand } from "./commands/stop";
import { upgradeCommand } from "./commands/upgrade";
import { formatWaitResult, waitCommand, waitExitCode } from "./commands/wait";
import { runNotifyCli } from "./bin/wux-notify";
import { loadConfig, remoteWuxHintFromEnv, remoteWuxPath, requireRemote } from "./runtime/config";
import { WuxError } from "./runtime/errors";
import type { CliIO } from "./runtime/io";
import { forwardSshCommand, stripTargetArgs, type SshRunner } from "./transport/ssh";
import { VERSION } from "./version";

export type { CliIO } from "./runtime/io";

const OPERATIONAL_COMMANDS = ["run", "send", "read", "status", "wait", "result", "mark", "attach", "stop", "interrupt", "handoff", "prune", "upgrade"] as const;
// `mcp` and `skills` are commands but NOT operational: they run locally and
// must never be forwarded to a default remote.
const COMMANDS = [...OPERATIONAL_COMMANDS, "remotes", "mcp", "skills", "notify"] as const;
const RUN_BACKENDS = new Set<RunBackend>(["shell", "claude", "codex"]);
const MARK_STATUSES = new Set<MarkStatus>(["waiting", "blocked", "running", "stopped"]);

type CommandName = (typeof COMMANDS)[number];
type OperationalCommandName = (typeof OPERATIONAL_COMMANDS)[number];

export interface CliDeps {
  sshRunner?: SshRunner;
  // Injectable MCP transport for tests; production uses stdio.
  mcpTransport?: Transport;
}

export interface GlobalOptions {
  host?: string;
  // Explicit remote wux path hint for raw `--host` (non-standard installs).
  // Only meaningful with `--host`; ignored for named/default remotes.
  hostWux?: string;
  remote?: string;
  local: boolean;
  help: boolean;
  version: boolean;
}

export interface ParsedGlobal {
  globals: GlobalOptions;
  command?: string;
  args: string[];
}

const ROOT_HELP = `wux ${VERSION}

Minimal tmux-backed worker wrapper for agent sessions.

Usage:
  wux [--local | --remote <name> | --host <host> [--host-wux <path>]] <command> [args...]
  wux --help
  wux --version

Global options:
  --local             Force local dispatch, bypassing a default remote.
  --remote <name>     Forward the command to a configured remote.
  --host <host>       Forward the command to a raw SSH host. Resolves wux on the
                      remote (hint, ~/.local/bin/wux, login-shell PATH, then PATH).
  --host-wux <path>   Explicit remote wux path for --host (also WUX_REMOTE_WUX_PATH).
  -h, --help          Show help.
  -v, --version       Show version.

Commands:
  run        Start a worker session.
  send       Send literal text plus Enter to a run.
  read       Read recent run output.
  status     List known runs.
  wait       Wait until a run settles or times out.
  result     Print a backend-agnostic result envelope for a run.
  mark       Mark a run waiting, blocked, running, or stopped.
  attach     Attach to a run's tmux session.
  stop       Stop a run.
  interrupt  Interrupt a run's current turn (sends C-c).
  handoff    Send a handoff prompt and read the result.
  prune      Remove old stopped run state.
  upgrade    Update wux to the latest GitHub release.
  remotes    Manage named SSH worker targets.
  mcp        Run the stdio MCP control surface (no daemon, no port).
  skills     List or emit bundled companion skills.
`;

const COMMAND_HELP: Record<CommandName, string> = {
  run: `Usage:
  wux run <backend> --name <run-name> --cwd <path> [--owner <owner>] [--json] [-- <backend args...>]

Starts a worker session. Supported v1 backends are shell, claude, and codex.
--json prints {name, tmuxSession, backend}.
A literal -- ends wux options; everything after it is forwarded verbatim to the
backend, after wux's own managed args (e.g. the notify hook). wux never
interprets these args. Example headless launch:
  wux run claude --name x --cwd P -- --dangerously-skip-permissions
`,
  send: `Usage:
  wux send <run-name> [--force-owner] [--json] <text>

Sends literal text plus Enter to a run, then reports whether the backend accepted
the submit. The verdict (submitted | uncertain | not-submitted) is a heuristic
over the pane, not an end-of-turn signal; a non-submitted send retries Enter once.
Options must precede <text>; use -- before literal text that starts with an
option-like value. --json prints {name, submission, retried, bytes}.
`,
  read: `Usage:
  wux read <run-name> [--tail <lines>] [--json]
  wux read --follow <run-name> [--poll-interval-ms <ms>]

Reads recent run output.
--json prints a wrapper {name, capturedAt, lines, paneLogPath, runDir}; lines
are a labelled pane scrape, not structured turn output.
--follow streams appended pane.log bytes until interrupted or the tmux session
ends. It is a raw stream for pipe composition and cannot be combined with
--json or --tail.
`,
  status: `Usage:
  wux status [--json]

Lists known runs.
--json prints an array of persisted run metadata.
`,
  'wait': `Usage:
  wux wait <run-name> [--idle <duration>] [--timeout <duration>] [--poll-interval-ms <ms>] [--json] [--result]

Waits until a run settles or times out. Durations accept bare milliseconds,
ms, or s suffixes. --json prints WaitResult with completedVia. Claude and
Codex can report completedVia: "hook"; shell only reports quiescence.
--result (with --json) inlines the same envelope as 'wux result' so an
autonomous loop can wait and collect the result in one call.
`,
  result: `Usage:
  wux result <run-name> --json

Prints a backend-agnostic result envelope composed read-only from existing run
state: outcome, completedVia, the worker's last turnId/lastAssistantMessage
(claude/codex only — omitted for shell), and pointers (runDir, paneLogPath,
eventsPath, sentinelPath) the operator follows for out-of-band ground truth.
It is a snapshot, not a blocker; pair it with 'wux wait'. Exit code mirrors
outcome (done -> 0, else nonzero). wux owns the schema, never the content:
there are no git/gh/test/PR connectors.
`,
  mark: `Usage:
  wux mark <run-name> <status>

Marks a run waiting, blocked, running, or stopped.
`,
  attach: `Usage:
  wux attach <run-name>

Attaches to a run's tmux session.
`,
  stop: `Usage:
  wux stop <run-name> [--yes]

Stops a run. --yes skips confirmation.
`,
  interrupt: `Usage:
  wux interrupt <run-name> [--force-owner]

Sends a single interrupt (C-c) to a run's current turn. Ownership-checked like
send; a cross-owner interrupt requires --force-owner.
`,
  handoff: `Usage:
  wux handoff <run-name> [--prompt-file <path>] [--wait-ms <ms>] [--tail <lines>]

Sends a handoff prompt, settles on the completion ladder (hook > sentinel >
quiescence) bounded by --wait-ms as a timeout, then reads the result.
--wait-ms is a hard upper bound, not a fixed pause (default 15000); 0 reads
immediately. For long turns, pair with \`wux wait\`.
`,
  prune: `Usage:
  wux prune [--older-than <duration>] [--days <days>] [--dry-run]

Removes stopped run state older than the age cutoff. A stopped run is a
candidate when its latest retention timestamp is strictly older than
now minus the cutoff (i.e. "stopped more than <duration> ago"); the boundary
is exclusive. --older-than accepts ms, s, m, h, or d suffixes (a bare number is
milliseconds) — a superset of 'wux wait''s ms/s durations, adding m/h/d for
coarse age cutoffs. --days <n> is the day-granularity alias for --older-than
<n>d; pass one, not both. The default retention is 30 days.

--older-than 0 (or 0s) is the explicit "select every stopped run regardless of
age" path for disposable cleanup; it ignores the retention timestamp so even a
seconds-old stopped run is selected. --dry-run names the candidate run dirs and
deletes nothing. Live tmux sessions and runs with an active status are never
candidates.
`,
  upgrade: `Usage:
  wux upgrade [--check] [--yes]

Updates wux to the latest GitHub release. --check reports availability without
changing anything. --yes skips the confirmation prompt (required for
non-interactive use). Only works on a released binary, not a source/dev run.
`,
  remotes: `Usage:
  wux remotes list [--json]
  wux remotes add <name> <ssh-host> [--wux-path <path>] [--cwd <path>] [--default]
  wux remotes show <name> [--json]
  wux remotes remove <name>
  wux remotes default <name>
  wux remotes clear-default
  wux remotes doctor <name> [--json]
  wux remotes doctor --all [--json]

Manages named SSH worker targets. doctor --all checks every configured remote
plus the local host (local/localhost are reserved names).
`,
  mcp: `Usage:
  wux mcp [--allow-raw-host]

Runs the wux MCP control surface over stdio (no daemon, no listening port) so a
client (Claude Code, Claude/Codex desktop, Codex CLI) can drive durable sessions.
Tools target local or configured remotes (call tools/list for the current surface);
--allow-raw-host opts in to raw SSH-host targets.
`,
  skills: `Usage:
  wux skills list [--json]
  wux skills show <name>

Lists or emits bundled Wux companion skills. show prints the selected SKILL.md
content verbatim to stdout and never writes files.
`,
  notify: `Usage:
  wux notify <run-name> [turn-complete|awaiting-approval|<event-json>]

Internal backend hook helper. Prefer the wux-notify wrapper.
`,
};

export function help(): string {
  return ROOT_HELP;
}

export function commandHelp(command: string): string | undefined {
  return isCommand(command) ? COMMAND_HELP[command] : undefined;
}

function requireHostValue(host: string | undefined): string {
  if (!host || host.startsWith("-")) throw new WuxError("--host requires <host>");
  return host;
}

function requireRemoteValue(remote: string | undefined): string {
  if (!remote || remote.startsWith("-")) throw new WuxError("--remote requires <name>");
  return remote;
}

function requireHostWuxValue(value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new WuxError("--host-wux requires <path>");
  return value;
}

export function parseGlobal(rawArgs: string[]): ParsedGlobal {
  const args = [...rawArgs];
  const globals: GlobalOptions = { local: false, help: false, version: false };
  let targetSelectors = 0;

  while (args.length > 0) {
    const arg = args[0];
    if (arg === "--host") {
      args.shift();
      globals.host = requireHostValue(args.shift());
      targetSelectors += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      args.shift();
      globals.host = requireHostValue(arg.slice("--host=".length));
      targetSelectors += 1;
      continue;
    }
    if (arg === "--host-wux") {
      args.shift();
      globals.hostWux = requireHostWuxValue(args.shift());
      continue;
    }
    if (arg.startsWith("--host-wux=")) {
      args.shift();
      globals.hostWux = requireHostWuxValue(arg.slice("--host-wux=".length));
      continue;
    }
    if (arg === "--remote") {
      args.shift();
      globals.remote = requireRemoteValue(args.shift());
      targetSelectors += 1;
      continue;
    }
    if (arg.startsWith("--remote=")) {
      args.shift();
      globals.remote = requireRemoteValue(arg.slice("--remote=".length));
      targetSelectors += 1;
      continue;
    }
    if (arg === "--local") {
      args.shift();
      globals.local = true;
      targetSelectors += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.shift();
      globals.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      args.shift();
      globals.version = true;
      continue;
    }
    break;
  }

  if (targetSelectors > 1) throw new WuxError("--local, --remote, and --host are mutually exclusive");
  // --host-wux is a hint for the raw-host path only; it is meaningless (and
  // silently misleading) alongside --remote/--local or with no --host at all.
  if (globals.hostWux !== undefined && globals.host === undefined) {
    throw new WuxError("--host-wux requires --host <host>");
  }
  return { globals, command: args.shift(), args };
}

export async function runCli(
  rawArgs: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  deps: CliDeps = {},
): Promise<number> {
  try {
    const parsed = parseGlobal(rawArgs);
    const forwardTimeoutMs = forwardTimeoutForCommand(parsed.command, parsed.args);
    // Only `attach` is interactive (needs a remote PTY + inherited stdio). `wait`
    // and `read --follow` are long-blocking but still capture, so they are NOT here.
    // `attach --help`/-h is a help REQUEST, not a live attach — keep it captured so
    // the forwarded help text is relayed, not swallowed by the inherited-stdio path.
    const interactive = parsed.command === "attach" && !hasHelpRequest(parsed.args);
    if (parsed.globals.host) {
      const hostWuxHint = parsed.globals.hostWux ?? remoteWuxHintFromEnv();
      return forwardSshCommand({
        host: parsed.globals.host,
        args: stripTargetArgs(rawArgs),
        io,
        interactive,
        resolveRemoteWux: true,
        ...(hostWuxHint ? { hostWuxHint } : {}),
        runner: deps.sshRunner,
        timeoutMs: forwardTimeoutMs,
      });
    }
    if (parsed.globals.remote) {
      const config = await loadConfig();
      const remote = requireRemote(config, parsed.globals.remote);
      return forwardSshCommand({
        host: remote.host,
        args: stripTargetArgs(rawArgs),
        io,
        interactive,
        wuxPath: remoteWuxPath(remote),
        runner: deps.sshRunner,
        timeoutMs: forwardTimeoutMs,
      });
    }
    if (await shouldForwardDefault(parsed)) {
      const config = await loadConfig();
      const remote = requireRemote(config, config.defaultRemote as string);
      return forwardSshCommand({
        host: remote.host,
        args: stripTargetArgs(rawArgs),
        io,
        interactive,
        wuxPath: remoteWuxPath(remote),
        runner: deps.sshRunner,
        timeoutMs: forwardTimeoutMs,
      });
    }
    return (await dispatch(parsed, io, deps)) ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonErrorRequested(rawArgs)) {
      io.stdout.write(`${JSON.stringify({ error: { code: errorCode(error, message), message } })}\n`);
    } else {
      io.stderr.write(`wux: ${message}\n`);
    }
    return 1;
  }
}

async function shouldForwardDefault(parsed: ParsedGlobal): Promise<boolean> {
  if (parsed.globals.local || process.env.WUX_FORCE_LOCAL === "1") return false;
  if (!parsed.command || parsed.globals.help || parsed.globals.version) return false;
  if (!isOperationalCommand(parsed.command)) return false;
  if (hasHelpRequest(parsed.args)) return false;
  const config = await loadConfig();
  return config.defaultRemote !== undefined;
}

async function dispatch(parsed: ParsedGlobal, io: CliIO, deps: CliDeps = {}): Promise<number | void> {
  const { globals, command, args } = parsed;

  if (globals.version) {
    io.stdout.write(`${VERSION}\n`);
    return;
  }

  if (!command || globals.help) {
    io.stdout.write(help());
    return;
  }

  if (!isCommand(command)) {
    if (command.startsWith("-")) throw new WuxError(`unknown option: ${command}`);
    throw new WuxError(`unknown command: ${command}`);
  }

  if (hasHelpRequest(args)) {
    io.stdout.write(COMMAND_HELP[command]);
    return;
  }

  switch (command) {
    case "run": {
      const backend = takeBackend(args);
      // A literal `--` ends wux options; everything after it is backend passthrough
      // (mirrors `cargo run -- …`, `npm run … --`). Split before parsing wux flags
      // so a backend arg like `--name` is never read as a wux option.
      const backendArgs = takeBackendArgs(args);
      const name = takeValue(args, "--name");
      const cwd = takeValue(args, "--cwd");
      const owner = takeValue(args, "--owner");
      const json = takeFlag(args, "--json");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      if (!name) throw new WuxError("run requires --name <run-name>");
      if (!cwd) throw new WuxError("run requires --cwd <path>");
      const result = await runCommand({ backend, name, cwd, owner, backendArgs });
      if (json) {
        io.stdout.write(`${JSON.stringify({ name: result.name, tmuxSession: result.tmuxSession, backend: result.backend })}\n`);
      } else {
        io.stdout.write(`created ${result.name} (${result.backend})\n`);
      }
      return;
    }
    case "send": {
      const parsedSend = parseSendArgs(args);
      if (!parsedSend.text) throw new WuxError("send requires <text>");
      const result = await sendCommand({ name: parsedSend.name, text: parsedSend.text, forceOwner: parsedSend.forceOwner });
      const rendered = renderSendResult(result, parsedSend.json);
      if (rendered.stdout) io.stdout.write(rendered.stdout);
      if (rendered.stderr) io.stderr.write(rendered.stderr);
      return;
    }
    case "read": {
      const { name, tail, json, follow, pollIntervalMs } = parseReadArgs(args);
      if (follow && json) throw new WuxError("--follow cannot be combined with --json");
      if (follow && tail !== undefined) throw new WuxError("--follow cannot be combined with --tail");
      if (!follow && pollIntervalMs !== undefined) throw new WuxError("--poll-interval-ms requires --follow");
      if (follow) {
        const abort = new AbortController();
        const onSigint = () => abort.abort();
        process.once("SIGINT", onSigint);
        try {
          const result = await followRead({ name, intervalMs: pollIntervalMs, writer: io.stdout, signal: abort.signal });
          return result.interrupted ? 130 : 0;
        } finally {
          process.off("SIGINT", onSigint);
        }
      }
      if (json) {
        io.stdout.write(`${JSON.stringify(await readCommand({ name, tail }))}\n`);
      } else {
        io.stdout.write(await readRun({ name, tail }));
      }
      return;
    }
    case "status": {
      const json = takeFlag(args, "--json");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      if (json) {
        const result = await statusJsonCommand();
        io.stdout.write(`${JSON.stringify(result.runs)}\n`);
      } else {
        const result = await statusCommand();
        io.stdout.write(formatStatusRows(result.rows));
      }
      return;
    }
    case "wait": {
      const name = takeRunName(args, "wait");
      const idleMs = parseDurationMsOption(takeValue(args, "--idle"), "--idle");
      const timeoutMs = parseDurationMsOption(takeValue(args, "--timeout"), "--timeout");
      const pollIntervalMs = parsePositiveIntegerOption(takeIntegerValue(args, "--poll-interval-ms"), "--poll-interval-ms");
      const json = takeFlag(args, "--json");
      const inlineResult = takeFlag(args, "--result");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      if (inlineResult && !json) throw new WuxError("--result requires --json");
      const result = await waitCommand({ name, idleMs, timeoutMs, pollIntervalMs });
      if (json) {
        const payload = inlineResult ? { ...result, result: await waitResultEnvelope(result) } : result;
        io.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        io.stdout.write(formatWaitResult(result));
      }
      return waitExitCode(result);
    }
    case "result": {
      const name = takeRunName(args, "result");
      const json = takeFlag(args, "--json");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      const envelope = await resultCommand({ name });
      if (json) {
        io.stdout.write(`${JSON.stringify(envelope)}\n`);
      } else {
        io.stdout.write(formatResultEnvelope(envelope));
      }
      return resultExitCode(envelope);
    }
    case "mark": {
      const name = takeRunName(args, "mark");
      const status = args.shift();
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      if (!status || status.startsWith("-")) throw new WuxError("mark requires <status>");
      if (!isMarkStatus(status)) throw new WuxError(`invalid status: ${status}`);
      await markCommand(name, status);
      return;
    }
    case "attach": {
      const name = parseSingleName(args, "attach");
      await attachCommand(name);
      return;
    }
    case "stop": {
      const name = takeRunName(args, "stop");
      const yes = takeFlag(args, "--yes");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      const result = await stopCommand(name, yes);
      io.stdout.write(`stopped ${result.name}\n`);
      return;
    }
    case "interrupt": {
      const name = takeRunName(args, "interrupt");
      const forceOwner = takeFlag(args, "--force-owner");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      const result = await interruptCommand({ name, forceOwner });
      io.stdout.write(`interrupted ${result.name}\n`);
      return;
    }
    case "handoff": {
      const name = takeRunName(args, "handoff");
      const promptFile = takeValue(args, "--prompt-file");
      const waitMs = parseIntegerOption(takeValue(args, "--wait-ms"), "--wait-ms");
      const tail = parseIntegerOption(takeValue(args, "--tail"), "--tail");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      await handoffCommand({ name, promptFile, waitMs, tail });
      return;
    }
    case "prune": {
      const olderThanMs = parseAgeOption(takeValue(args, "--older-than"), "--older-than");
      const days = parsePositiveIntegerOption(takeIntegerValue(args, "--days"), "--days");
      const dryRun = takeFlag(args, "--dry-run");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      if (olderThanMs !== undefined && days !== undefined) {
        throw new WuxError("pass either --older-than or --days, not both");
      }
      await pruneCommand({ olderThanMs, days, dryRun });
      return;
    }
    case "upgrade": {
      const check = takeFlag(args, "--check");
      const yes = takeFlag(args, "--yes");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      await upgradeCommand({ check, yes });
      return;
    }
    case "remotes": {
      await remotesCommand(args, io, { sshRunner: deps.sshRunner });
      return;
    }
    case "mcp": {
      const allowRawHost = takeFlag(args, "--allow-raw-host");
      rejectUnknownOptions(args);
      if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
      await mcpCommand({ allowRawHost, transport: deps.mcpTransport, sshRunner: deps.sshRunner });
      return;
    }
    case "skills": {
      await skillsCommand(args, io);
      return;
    }
    case "notify": {
      return runNotifyCli(args);
    }
  }
}

function takeBackend(args: string[]): RunBackend {
  const backend = args.shift();
  if (!backend || backend.startsWith("-")) throw new WuxError("run requires <backend>");
  if (!isRunBackend(backend)) throw new WuxError(`invalid backend: ${backend}`);
  return backend;
}

// Splits off the backend-passthrough remainder at the first literal `--`,
// removing it (and the `--`) from `args` so the wux option parsers never see it.
// No `--` => undefined (no passthrough; byte-identical to the pre-passthrough path).
function takeBackendArgs(args: string[]): string[] | undefined {
  const index = args.indexOf("--");
  if (index === -1) return undefined;
  return args.splice(index).slice(1);
}

function takeRunName(args: string[], command: string): string {
  const name = args.shift();
  if (!name || name.startsWith("-")) throw new WuxError(`${command} requires <run-name>`);
  return name;
}

function parseSendArgs(args: string[]): { name: string; text?: string; forceOwner: boolean; json: boolean } {
  const name = takeRunName(args, "send");
  const flags = { forceOwner: false, json: false };
  // Peel --force-owner / --json (each at most once, either order) that appear
  // before the literal text or a `--` terminator. A repeated flag falls through
  // to the text slot, where the leading-dash guard rejects it — preserving the
  // original "one leading --force-owner" semantics.
  peelSendFlags(args, flags);
  const hasTerminator = args[0] === "--";
  if (hasTerminator) args.shift();
  const text = args.shift();
  if (text?.startsWith("-") && !hasTerminator) throw new WuxError(`unknown option: ${text}`);
  // A trailing --force-owner after the literal text stays supported (original
  // behavior); --json must precede the text, so a trailing --json is rejected.
  if (!flags.forceOwner && args[0] === "--force-owner") {
    args.shift();
    flags.forceOwner = true;
  }
  if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
  return { name, text, forceOwner: flags.forceOwner, json: flags.json };
}

// Render a send verdict to the appropriate stream(s). Extracted so the
// stdout-success vs stderr-warning vs json-envelope branching is unit-testable.
export function renderSendResult(result: SendResult, json: boolean): { stdout?: string; stderr?: string } {
  if (json) {
    return {
      stdout: `${JSON.stringify({ name: result.name, submission: result.submission, retried: result.retried, bytes: result.bytes })}\n`,
    };
  }
  const retried = result.retried ? ", retried" : "";
  if (result.submission === "submitted") {
    return { stdout: `sent ${result.bytes} bytes to ${result.name} (submitted${retried})\n` };
  }
  return { stderr: `wux: warning: ${result.name} may not have submitted (${result.submission}${retried})\n` };
}

function forwardTimeoutForCommand(command: string | undefined, args: string[] = []): number | undefined {
  // Long-blocking forwarded commands are bounded by their own lifecycle and SSH
  // ConnectTimeout. 0 disables the generic command timeout.
  return command === "attach" || command === "wait" || (command === "read" && hasOptionBeforeTerminator(args, "--follow")) ? 0 : undefined;
}

function jsonErrorRequested(rawArgs: string[]): boolean {
  const args = stripGlobalArgsForJsonDetection(rawArgs);
  const command = args.shift();
  if (!command) return false;
  if (
    command === "run" ||
    command === "read" ||
    command === "status" ||
    command === "send" ||
    command === "wait" ||
    command === "result"
  ) {
    return hasOptionBeforeTerminator(args, "--json");
  }
  return false;
}

function stripGlobalArgsForJsonDetection(rawArgs: string[]): string[] {
  const args = [...rawArgs];
  while (args.length > 0) {
    const arg = args[0];
    if (arg === "--host" || arg === "--remote" || arg === "--host-wux") {
      args.splice(0, Math.min(2, args.length));
      continue;
    }
    if (
      arg.startsWith("--host=") ||
      arg.startsWith("--host-wux=") ||
      arg.startsWith("--remote=") ||
      arg === "--local" ||
      arg === "--help" ||
      arg === "-h" ||
      arg === "--version" ||
      arg === "-v"
    ) {
      args.shift();
      continue;
    }
    break;
  }
  return args;
}

function hasOptionBeforeTerminator(args: string[], option: string): boolean {
  const terminatorIndex = args.indexOf("--");
  const optionArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return optionArgs.includes(option);
}

function errorCode(error: unknown, message: string): string {
  if (!(error instanceof WuxError)) return "internal-error";
  if (message.startsWith("run not found:")) return "run-not-found";
  if (message.startsWith("run already exists:")) return "run-already-exists";
  if (message.startsWith("tmux session already exists:")) return "tmux-session-exists";
  if (message.startsWith("tmux session is not running")) return "tmux-session-not-running";
  if (message.includes("tmux") && message.includes("not found")) return "tmux-missing";
  if (
    message.includes(" requires ") ||
    message.startsWith("invalid ") ||
    message.startsWith("unknown ") ||
    message.startsWith("unexpected ") ||
    message.includes(" must ") ||
    message.includes(" cannot be combined") ||
    message.includes("mutually exclusive")
  ) {
    return "bad-args";
  }
  return "wux-error";
}

function peelSendFlags(args: string[], flags: { forceOwner: boolean; json: boolean }): void {
  for (let i = 0; i < 2; i += 1) {
    if (!flags.forceOwner && args[0] === "--force-owner") {
      args.shift();
      flags.forceOwner = true;
      continue;
    }
    if (!flags.json && args[0] === "--json") {
      args.shift();
      flags.json = true;
      continue;
    }
    break;
  }
}

function parseReadArgs(args: string[]): { name: string; tail?: number; json: boolean; follow: boolean; pollIntervalMs?: number } {
  let name: string | undefined;
  let tail: number | undefined;
  let json = false;
  let follow = false;
  let pollIntervalMs: number | undefined;

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--json") {
      if (json) throw new WuxError("unknown option: --json");
      json = true;
      continue;
    }
    if (arg === "--follow") {
      if (follow) throw new WuxError("unknown option: --follow");
      follow = true;
      continue;
    }
    if (arg === "--tail") {
      if (tail !== undefined) throw new WuxError("unknown option: --tail");
      tail = parseIntegerOption(takeInlineValue(args, "--tail"), "--tail");
      continue;
    }
    if (arg === "--poll-interval-ms") {
      if (pollIntervalMs !== undefined) throw new WuxError("unknown option: --poll-interval-ms");
      pollIntervalMs = parsePositiveIntegerOption(takeInlineValue(args, "--poll-interval-ms"), "--poll-interval-ms");
      continue;
    }
    if (arg.startsWith("-")) throw new WuxError(`unknown option: ${arg}`);
    if (name !== undefined) throw new WuxError(`unexpected argument: ${arg}`);
    name = arg;
  }

  if (!name) throw new WuxError("read requires <run-name>");
  return {
    name,
    ...(tail !== undefined ? { tail } : {}),
    json,
    follow,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

function takeInlineValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new WuxError(`${flag} requires a value`);
  return value;
}

function parseSingleName(args: string[], command: string): string {
  const name = takeRunName(args, command);
  rejectUnknownOptions(args);
  if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
  return name;
}

function isCommand(command: string): command is CommandName {
  return COMMANDS.includes(command as CommandName);
}

function isOperationalCommand(command: string): command is OperationalCommandName {
  return OPERATIONAL_COMMANDS.includes(command as OperationalCommandName);
}

function isRunBackend(backend: string): backend is RunBackend {
  return RUN_BACKENDS.has(backend as RunBackend);
}

function isMarkStatus(status: string): status is MarkStatus {
  return MARK_STATUSES.has(status as MarkStatus);
}

function hasHelpRequest(args: string[]): boolean {
  const terminatorIndex = args.indexOf("--");
  const optionArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  return optionArgs.includes("--help") || optionArgs.includes("-h");
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new WuxError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeIntegerValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new WuxError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

function parseIntegerOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new WuxError(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseDurationMsOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([0-9]+)(ms|s)?$/.exec(value);
  if (!match) throw new WuxError(`${flag} must be a positive duration`);
  const amount = Number.parseInt(match[1], 10);
  const multiplier = match[2] === "s" ? 1_000 : 1;
  const parsed = amount * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WuxError(`${flag} must be a positive duration`);
  }
  return parsed;
}

// Parses a non-negative age duration for `prune --older-than`, accepting ms, s,
// m, h, or d suffixes (a bare number is milliseconds). This is a superset of
// `parseDurationMsOption` (which `wux wait` uses, ms/s only): prune adds m/h/d
// for coarse age cutoffs. Unlike `parseDurationMsOption` this also allows 0,
// which is prune's explicit "select every stopped run regardless of age" value.
const AGE_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseAgeOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^([0-9]+)(ms|s|m|h|d)?$/.exec(value);
  if (!match) throw new WuxError(`${flag} must be a non-negative duration (e.g. 30s, 10m, 2h, 7d)`);
  const amount = Number.parseInt(match[1], 10);
  const multiplier = AGE_UNIT_MS[match[2] ?? "ms"];
  const parsed = amount * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WuxError(`${flag} must be a non-negative duration (e.g. 30s, 10m, 2h, 7d)`);
  }
  return parsed;
}

function parsePositiveIntegerOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed.toString() !== value) {
    throw new WuxError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function rejectUnknownOptions(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) throw new WuxError(`unknown option: ${unknown}`);
}

export const __test = { dispatch, forwardTimeoutForCommand, parseAgeOption, parseReadArgs, parseSendArgs, remoteWuxHintFromEnv, renderSendResult, takeBackendArgs, takeValue, takeFlag };
