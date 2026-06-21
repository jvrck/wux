import { resolveExecutable } from "../backends/path";
import { capabilitiesForVersion } from "../runtime/capabilities";
import {
  loadConfig,
  remoteWuxPath,
  requireRemote,
  saveConfig,
  validateRemoteHost,
  validateRemoteName,
  type RemoteConfig,
} from "../runtime/config";
import { WuxError } from "../runtime/errors";
import { runProcess, type ProcessResult } from "../runtime/process";
import { forwardTimeoutMs, sshForwardArgs, sshRemoteArgs, type SshRunner } from "../transport/ssh";
import { VERSION } from "../version";

type Writer = { write(chunk: string): unknown };

interface RemotesIO {
  stdout: Writer;
  stderr: Writer;
}

interface RemotesDeps {
  sshRunner?: SshRunner;
}

interface RemoteRow {
  name: string;
  host: string;
  wuxPath: string;
  defaultCwd?: string;
  default: boolean;
}

const REMOTES_HELP = `Usage:
  wux remotes list [--json]
  wux remotes add <name> <ssh-host> [--wux-path <path>] [--cwd <path>] [--default]
  wux remotes show <name> [--json]
  wux remotes remove <name>
  wux remotes default <name>
  wux remotes clear-default
  wux remotes doctor <name> [--json]
  wux remotes doctor --all [--json]

Manages named SSH worker targets in the local wux config. doctor --all checks
every configured remote plus the local host; local/localhost are reserved names.
`;

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  targetType: "remote" | "local";
  host: string | null;
  wuxPath: string;
  wuxVersion: string | null;
  skew: boolean;
  capabilities: string[];
  checks: DoctorCheck[];
  ready: boolean;
}

// ssh/wux/tmux are critical (a failure means the host cannot run workers);
// claude/codex/cwd/version are advisory (warn, never fail the host).
const REMOTE_CRITICAL = ["ssh", "wux", "tmux"];
const LOCAL_CRITICAL = ["wux", "tmux"];

export async function remotesCommand(args: string[], io: RemotesIO, deps: RemotesDeps = {}): Promise<void> {
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    io.stdout.write(REMOTES_HELP);
    return;
  }

  switch (command) {
    case "list":
      await listRemotes(args, io);
      return;
    case "add":
      await addRemote(args, io);
      return;
    case "show":
      await showRemote(args, io);
      return;
    case "remove":
      await removeRemote(args, io);
      return;
    case "default":
      await setDefaultRemote(args, io);
      return;
    case "clear-default":
      await clearDefaultRemote(args, io);
      return;
    case "doctor":
      await doctorRemote(args, io, deps);
      return;
    default:
      if (command.startsWith("-")) throw new WuxError(`unknown option: ${command}`);
      throw new WuxError(`unknown remotes command: ${command}`);
  }
}

async function listRemotes(args: string[], io: RemotesIO): Promise<void> {
  const json = takeFlag(args, "--json");
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const config = await loadConfig();
  const rows = remoteRows(config.remotes, config.defaultRemote);
  if (json) {
    io.stdout.write(`${JSON.stringify({ defaultRemote: config.defaultRemote ?? null, remotes: rows }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    io.stdout.write("no remotes configured\n");
    return;
  }
  io.stdout.write(formatRemoteRows(rows));
}

async function addRemote(args: string[], io: RemotesIO): Promise<void> {
  const name = args.shift();
  const host = args.shift();
  if (!name || name.startsWith("-")) throw new WuxError("remotes add requires <name>");
  validateRemoteName(name);
  validateRemoteHost(host ?? "", "remotes add");
  const wuxPath = takeValue(args, "--wux-path");
  const defaultCwd = takeValue(args, "--cwd");
  const makeDefault = takeFlag(args, "--default");
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const config = await loadConfig();
  if (config.remotes[name]) throw new WuxError(`remote already exists: ${name}`);
  config.remotes[name] = compactRemote({ host: host as string, wuxPath, defaultCwd });
  if (makeDefault) config.defaultRemote = name;
  await saveConfig(config);

  io.stdout.write(`added remote ${name}\n`);
  if (makeDefault) io.stdout.write(`set default remote ${name}\n`);
}

async function showRemote(args: string[], io: RemotesIO): Promise<void> {
  const name = args.shift();
  if (!name || name.startsWith("-")) throw new WuxError("remotes show requires <name>");
  const json = takeFlag(args, "--json");
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const config = await loadConfig();
  const remote = requireRemote(config, name);
  const row = rowForRemote(name, remote, config.defaultRemote);
  if (json) {
    io.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    return;
  }
  io.stdout.write(formatRemoteRows([row]));
}

async function removeRemote(args: string[], io: RemotesIO): Promise<void> {
  const name = parseName(args, "remotes remove");
  const config = await loadConfig();
  requireRemote(config, name);
  delete config.remotes[name];
  const wasDefault = config.defaultRemote === name;
  if (wasDefault) delete config.defaultRemote;
  await saveConfig(config);
  io.stdout.write(`removed remote ${name}\n`);
  if (wasDefault) io.stdout.write(`cleared default remote ${name}\n`);
}

async function setDefaultRemote(args: string[], io: RemotesIO): Promise<void> {
  const name = parseName(args, "remotes default");
  const config = await loadConfig();
  requireRemote(config, name);
  config.defaultRemote = name;
  await saveConfig(config);
  io.stdout.write(`set default remote ${name}\n`);
}

async function clearDefaultRemote(args: string[], io: RemotesIO): Promise<void> {
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);
  const config = await loadConfig();
  delete config.defaultRemote;
  await saveConfig(config);
  io.stdout.write("cleared default remote\n");
}

async function doctorRemote(args: string[], io: RemotesIO, deps: RemotesDeps): Promise<void> {
  const all = takeFlag(args, "--all");
  const json = takeFlag(args, "--json");
  let name: string | undefined;
  if (!all) {
    name = args.shift();
    if (!name || name.startsWith("-")) throw new WuxError("remotes doctor requires <name> (or --all)");
    validateRemoteName(name);
  }
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);

  const config = await loadConfig();
  // Bound the command timeout on the real path so a connected-but-wedged remote
  // cannot stall the report; an injected runner (tests) supplies its own behavior.
  const runner: SshRunner = deps.sshRunner ?? ((argv) => runProcess(argv, { timeoutMs: forwardTimeoutMs() }));

  const entries: { name: string; report: DoctorReport }[] = [];
  if (all) {
    // Local first, then every configured remote; one bad host never aborts the rest.
    entries.push({ name: "local", report: await buildLocalReport() });
    for (const [remoteName, remote] of sortedRemotes(config.remotes)) {
      entries.push({ name: remoteName, report: await buildRemoteReport(remote, runner) });
    }
  } else {
    const remote = requireRemote(config, name as string);
    entries.push({ name: name as string, report: await buildRemoteReport(remote, runner) });
  }

  if (json) {
    const payload = all ? entries.map((entry) => entry.report) : entries[0].report;
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.stdout.write(entries.map((entry) => renderReport(entry.name, entry.report)).join("\n"));
  }

  const notReady = entries.filter((entry) => !entry.report.ready).map((entry) => entry.name);
  if (notReady.length > 0) {
    throw new WuxError(`not ready: ${notReady.join(", ")}`);
  }
}

function toCheck(label: string, result: ProcessResult): DoctorCheck {
  if (result.code === 0) {
    const detail = result.stdout.trim();
    return detail.length > 0 ? { label, ok: true, detail } : { label, ok: true };
  }
  return { label, ok: false, detail: describeFailure(result) };
}

async function buildRemoteReport(remote: RemoteConfig, runner: SshRunner): Promise<DoctorReport> {
  const host = remote.host;
  const wuxPath = remoteWuxPath(remote);
  const checks: DoctorCheck[] = [];

  checks.push(toCheck("ssh", await runner(sshRemoteArgs(host, ["true"]))));
  checks.push(toCheck("wux", await runner(sshRemoteArgs(host, ["command", "-v", wuxPath]))));

  const version = await runner(sshForwardArgs(host, ["--version"], wuxPath));
  const wuxVersion = version.code === 0 ? version.stdout.trim() || null : null;
  checks.push({
    label: "version",
    ok: version.code === 0,
    // Omit a misleading "exit 0" detail when the check succeeded but reported no version.
    detail: wuxVersion ?? (version.code === 0 ? undefined : describeFailure(version)),
  });

  checks.push(toCheck("tmux", await runner(sshRemoteArgs(host, ["tmux", "-V"]))));
  checks.push(toCheck("claude", await runner(sshRemoteArgs(host, ["command", "-v", "claude"]))));
  checks.push(toCheck("codex", await runner(sshRemoteArgs(host, ["command", "-v", "codex"]))));
  if (remote.defaultCwd) {
    checks.push(toCheck("cwd", await runner(sshRemoteArgs(host, ["test", "-d", remote.defaultCwd]))));
  }

  // Frozen §4 formula: skew = remote wuxVersion !== local VERSION. An unknown
  // (unreadable) remote version is treated as skewed — we cannot confirm a match,
  // so the MCP layer should warn rather than assume parity.
  const skew = wuxVersion !== VERSION;
  return {
    schemaVersion: 1,
    targetType: "remote",
    host,
    wuxPath,
    wuxVersion,
    skew,
    capabilities: capabilitiesForVersion(wuxVersion),
    checks,
    ready: REMOTE_CRITICAL.every((label) => checks.find((check) => check.label === label)?.ok ?? false),
  };
}

async function buildLocalReport(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  // wux is this process; tmux is a binary; claude/codex are resolved on PATH
  // without a shell (advisory).
  checks.push({ label: "wux", ok: true, detail: `self (${VERSION})` });
  checks.push(toCheck("tmux", await runProcess(["tmux", "-V"])));
  checks.push(await localPresence("claude"));
  checks.push(await localPresence("codex"));

  return {
    schemaVersion: 1,
    targetType: "local",
    host: null,
    wuxPath: "self",
    wuxVersion: VERSION,
    skew: false,
    capabilities: capabilitiesForVersion(VERSION),
    checks,
    ready: LOCAL_CRITICAL.every((label) => checks.find((check) => check.label === label)?.ok ?? false),
  };
}

async function localPresence(name: string): Promise<DoctorCheck> {
  const resolved = await resolveExecutable(name);
  return resolved ? { label: name, ok: true, detail: resolved } : { label: name, ok: false, detail: "not found" };
}

function renderReport(name: string, report: DoctorReport): string {
  const heading = report.host ? `${name} (remote ${report.host})` : `${name} (local)`;
  const lines = [heading];
  for (const check of report.checks) {
    lines.push(`  ${check.label}: ${check.ok ? "ok" : "FAILED"}${check.detail ? ` (${check.detail})` : ""}`);
  }
  lines.push(`  skew: ${report.skew ? `yes (local ${VERSION})` : "no"}`);
  if (report.capabilities.length > 0) lines.push(`  capabilities: ${report.capabilities.join(", ")}`);
  lines.push(`  ready: ${report.ready ? "yes" : "no"}`);
  return `${lines.join("\n")}\n`;
}

function sortedRemotes(remotes: Record<string, RemoteConfig>): [string, RemoteConfig][] {
  return Object.entries(remotes).sort(([left], [right]) => left.localeCompare(right));
}

function describeFailure(result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `exit ${result.code}`;
}

function parseName(args: string[], command: string): string {
  const name = args.shift();
  if (!name || name.startsWith("-")) throw new WuxError(`${command} requires <name>`);
  validateRemoteName(name);
  rejectUnknownOptions(args);
  rejectUnexpectedArgs(args);
  return name;
}

function remoteRows(remotes: Record<string, RemoteConfig>, defaultRemote?: string): RemoteRow[] {
  return Object.entries(remotes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, remote]) => rowForRemote(name, remote, defaultRemote));
}

function rowForRemote(name: string, remote: RemoteConfig, defaultRemote?: string): RemoteRow {
  return {
    name,
    host: remote.host,
    wuxPath: remoteWuxPath(remote),
    defaultCwd: remote.defaultCwd,
    default: defaultRemote === name,
  };
}

function formatRemoteRows(rows: RemoteRow[]): string {
  const table = [
    ["NAME", "DEFAULT", "HOST", "WUX", "CWD"],
    ...rows.map((row) => [row.name, row.default ? "yes" : "no", row.host, row.wuxPath, row.defaultCwd ?? "-"]),
  ];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  return `${table.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n")}\n`;
}

function compactRemote(remote: RemoteConfig): RemoteConfig {
  return {
    host: remote.host,
    ...(remote.wuxPath ? { wuxPath: remote.wuxPath } : {}),
    ...(remote.defaultCwd ? { defaultCwd: remote.defaultCwd } : {}),
  };
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

function rejectUnknownOptions(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) throw new WuxError(`unknown option: ${unknown}`);
}

function rejectUnexpectedArgs(args: string[]): void {
  if (args.length > 0) throw new WuxError(`unexpected argument: ${args[0]}`);
}
