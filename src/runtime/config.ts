import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WuxError } from "./errors";

export interface RemoteConfig {
  host: string;
  wuxPath?: string;
  defaultCwd?: string;
}

export interface WuxConfig {
  version: 1;
  defaultRemote?: string;
  remotes: Record<string, RemoteConfig>;
}

const REMOTE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Reserved so `remotes doctor --all`'s implicit local-host entry can never be
// confused with a configured remote named `local`/`localhost`.
const RESERVED_REMOTE_NAMES = new Set(["local", "localhost"]);

export function configRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "wux");
  return join(homedir(), ".config", "wux");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configRoot(env), "config.json");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<WuxConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, remotes: {} };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WuxError(`invalid config JSON at ${configPath(env)}: ${(error as Error).message}`);
  }

  return validateConfig(parsed);
}

export async function saveConfig(config: WuxConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const valid = validateConfig(config);
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export function validateRemoteName(name: string): void {
  if (!REMOTE_NAME_RE.test(name) || name === "." || name === "..") {
    throw new WuxError(`invalid remote name '${name}'; use letters, numbers, dot, underscore, or dash`);
  }
  if (RESERVED_REMOTE_NAMES.has(name.toLowerCase())) {
    throw new WuxError(`remote name '${name}' is reserved for the local host`);
  }
}

export function validateRemoteHost(host: string, context: string): void {
  if (!host || host.startsWith("-")) throw new WuxError(`${context} requires <ssh-host>`);
}

export function remoteWuxPath(remote: RemoteConfig): string {
  return remote.wuxPath ?? "wux";
}

// Env fallback for the raw-host wux path hint when no explicit hint is given
// (`--host-wux` on the CLI; there is no per-call flag on the MCP raw-host path, so
// the env var is the sole hint source there). An empty/whitespace value is treated
// as unset so it cannot shadow the resolver's own location search.
export function remoteWuxHintFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.WUX_REMOTE_WUX_PATH?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export function requireRemote(config: WuxConfig, name: string): RemoteConfig {
  validateRemoteName(name);
  const remote = config.remotes[name];
  if (!remote) throw new WuxError(`remote not found: ${name}`);
  return remote;
}

function validateConfig(value: unknown): WuxConfig {
  if (!isRecord(value)) throw new WuxError("invalid config: expected object");
  if (value.version !== 1) throw new WuxError("invalid config: expected version 1");
  if (!isRecord(value.remotes)) throw new WuxError("invalid config: expected remotes object");

  const remotes: Record<string, RemoteConfig> = {};
  for (const [name, remote] of Object.entries(value.remotes)) {
    validateRemoteName(name);
    remotes[name] = validateRemote(remote, name);
  }

  const config: WuxConfig = { version: 1, remotes };
  if (value.defaultRemote !== undefined) {
    if (typeof value.defaultRemote !== "string") throw new WuxError("invalid config: expected defaultRemote string");
    validateRemoteName(value.defaultRemote);
    if (!remotes[value.defaultRemote]) throw new WuxError(`invalid config: default remote not found: ${value.defaultRemote}`);
    config.defaultRemote = value.defaultRemote;
  }

  return config;
}

function validateRemote(value: unknown, name: string): RemoteConfig {
  if (!isRecord(value)) throw new WuxError(`invalid config: expected remote object for ${name}`);
  if (typeof value.host !== "string" || value.host.length === 0 || value.host.startsWith("-")) {
    throw new WuxError(`invalid config: expected valid host for remote ${name}`);
  }

  const remote: RemoteConfig = { host: value.host };
  if (value.wuxPath !== undefined) {
    if (typeof value.wuxPath !== "string" || value.wuxPath.length === 0 || value.wuxPath.startsWith("-")) {
      throw new WuxError(`invalid config: expected valid wuxPath for remote ${name}`);
    }
    remote.wuxPath = value.wuxPath;
  }
  if (value.defaultCwd !== undefined) {
    if (typeof value.defaultCwd !== "string" || value.defaultCwd.length === 0) {
      throw new WuxError(`invalid config: expected valid defaultCwd for remote ${name}`);
    }
    remote.defaultCwd = value.defaultCwd;
  }

  return remote;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
