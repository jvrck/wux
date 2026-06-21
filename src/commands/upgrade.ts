import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { WuxError } from "../runtime/errors";
import { VERSION } from "../version";

export interface UpgradeOptions {
  check: boolean;
  yes: boolean;
}

const DEFAULT_REPO = "jvrck/wux";

// ---- pure helpers (unit-tested) ---------------------------------------------

// Parse a CalVer string `YYYY.MM.DD` with optional `.N` micro segments into its
// numeric components, or null if it is not a release version (e.g. the
// `0.0.0-dev` sentinel).
export function parseCalVer(value: string): number[] | null {
  if (!/^\d{4}\.\d{2}\.\d{2}(\.\d+)*$/.test(value)) return null;
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

// Component-wise numeric comparison; shorter versions are padded with zeros so
// `2026.06.12` < `2026.06.12.2`.
export function compareCalVer(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export function isReleaseVersion(value: string): boolean {
  return parseCalVer(value) !== null;
}

// A compiled release binary's `process.execPath` is the wux executable itself; a
// source run (`bun run`) points at the bun/node host. Used to refuse `upgrade`
// from a dev run even if `WUX_VERSION` was forced to a CalVer value in the env
// (the `--define` stamp only constant-folds in compiled builds).
export function isSourceRun(execPath: string): boolean {
  const name = basename(execPath).toLowerCase().replace(/\.exe$/, "");
  return name === "bun" || name === "node";
}

// Map a Node/Bun platform + arch to the published `wux-<os>-<arch>` asset name.
export function assetName(platform: string, arch: string, isMusl: boolean): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu =
    arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : arch === "x64" || arch === "x86_64"
        ? "x64"
        : undefined;
  if (!os || !cpu) throw new WuxError(`unsupported platform: ${platform}/${arch}`);
  if (os === "darwin" && cpu === "arm64") return "wux-darwin-arm64";
  if (os === "linux" && cpu === "arm64") return "wux-linux-arm64";
  if (os === "linux" && cpu === "x64") return isMusl ? "wux-linux-x64-musl" : "wux-linux-x64";
  throw new WuxError(`no release asset is published for ${os}/${cpu}`);
}

// Extract the expected hex digest for `asset` from `sha256sum`-style content.
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === asset) return match[1].toLowerCase();
  }
  return undefined;
}

// ---- orchestration ----------------------------------------------------------

// Mirror install.sh's signals (loader symlink OR Alpine marker) so an upgrade
// can't move a musl host onto the glibc asset.
function isMuslLinux(): boolean {
  if (process.platform !== "linux") return false;
  return (
    existsSync("/lib/ld-musl-x86_64.so.1") ||
    existsSync("/lib/ld-musl-aarch64.so.1") ||
    existsSync("/etc/alpine-release")
  );
}

function repo(): string {
  return process.env.WUX_REPO ?? DEFAULT_REPO;
}

// Resolve the latest published release tag for a public repo over anonymous
// HTTPS (no gh, no token). The repo is public, so the GitHub REST API serves the
// latest full release (excluding drafts/prereleases) unauthenticated — the same
// "latest" semantics the previous `gh release view` used.
async function fetchLatestReleaseTag(repo: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "wux" },
    });
  } catch (error) {
    throw new WuxError(`could not reach GitHub to check for the latest wux release: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new WuxError(`could not resolve the latest wux release for ${repo} (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { tag_name?: string };
  const tag = body.tag_name?.trim();
  if (!tag) throw new WuxError(`latest release for ${repo} has no tag`);
  return tag;
}

// Download a release asset and its SHA256SUMS for a public repo into `dest` over
// anonymous HTTPS. Public release assets are served from the unauthenticated
// releases/download URL (302 → asset CDN), so no gh or token is needed.
async function downloadReleaseAsset(repo: string, tag: string, asset: string, dest: string): Promise<void> {
  for (const name of [asset, "SHA256SUMS"]) {
    const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "wux" } });
    } catch (error) {
      throw new WuxError(`failed to download ${name} from ${repo} ${tag}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new WuxError(`failed to download ${name} from ${repo} ${tag} (HTTP ${response.status})`);
    }
    await writeFile(join(dest, name), Buffer.from(await response.arrayBuffer()));
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  if (!isReleaseVersion(VERSION) || isSourceRun(process.execPath)) {
    throw new WuxError(
      `wux upgrade only works on a released binary (current version: ${VERSION}). ` +
        "Install a release with install.sh, or build one (see docs/releasing.md).",
    );
  }

  const latest = await fetchLatestReleaseTag(repo());
  if (!isReleaseVersion(latest)) throw new WuxError(`latest release tag is not CalVer: ${latest}`);

  if (compareCalVer(parseCalVer(latest)!, parseCalVer(VERSION)!) <= 0) {
    process.stdout.write(`already up to date (${VERSION})\n`);
    return;
  }

  if (options.check) {
    process.stdout.write(`upgrade available: ${VERSION} -> ${latest}\n`);
    return;
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new WuxError("wux upgrade needs confirmation; pass --yes for non-interactive upgrade");
    }
    if (!(await confirm(`Upgrade wux ${VERSION} -> ${latest}? [y/N] `))) {
      throw new WuxError("upgrade cancelled");
    }
  }

  const asset = assetName(process.platform, process.arch, isMuslLinux());
  const target = process.execPath;
  const dir = dirname(target);
  const work = await mkdtemp(join(tmpdir(), "wux-upgrade-"));
  // Stage in the target's own directory so the final swap is an atomic,
  // same-filesystem rename. Copy (not rename) from the temp dir, which is often
  // on a different filesystem (tmpfs) where rename would fail with EXDEV.
  const staged = join(dir, `.wux-upgrade-${asset}`);
  try {
    await downloadReleaseAsset(repo(), latest, asset, work);

    const sums = await readFile(join(work, "SHA256SUMS"), "utf8");
    const expected = checksumFor(sums, asset);
    if (!expected) throw new WuxError(`SHA256SUMS has no entry for ${asset}`);
    const actual = createHash("sha256").update(await readFile(join(work, asset))).digest("hex");
    if (actual !== expected) {
      throw new WuxError(`checksum mismatch for ${asset}; refusing to replace the binary`);
    }

    try {
      await copyFile(join(work, asset), staged);
      await chmod(staged, 0o755);
    } catch {
      throw new WuxError(`cannot write to ${dir} (need write access to replace ${target})`);
    }
    await rename(staged, target);
    process.stdout.write(`upgraded ${VERSION} -> ${latest}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(staged, { force: true }); // no-op once the rename has moved it onto target
  }
}
