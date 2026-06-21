import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const helperPath = join(repoRoot, ".claude", "skills", "dual-review", "scripts", "dual-review.sh");

async function runCommand(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function fakeGhBin(root: string): Promise<string> {
  const binDir = join(root, "bin");
  const ghPath = join(binDir, "gh");
  await mkdir(binDir);
  await writeFile(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail

case "$1:$2" in
  pr:view)
    printf '17\\n'
    ;;
  repo:view)
    printf 'jvrck/wux\\n'
    ;;
  api:repos/jvrck/wux/issues/17/comments)
    printf 'lookup:%s\\n' "$5" >> "$FAKE_GH_LOG"
    if [ -n "\${FAKE_GH_EXISTING_ID:-}" ]; then
      printf '%s\\n' "$FAKE_GH_EXISTING_ID"
    fi
    ;;
  pr:comment)
    printf 'comment:%s\\n' "$3" >> "$FAKE_GH_LOG"
    printf '%s\\n' "$5" > "$FAKE_GH_BODY"
    ;;
  api:-X)
    printf 'patch:%s\\n' "$4" >> "$FAKE_GH_LOG"
    printf '%s\\n' "\${6#body=}" > "$FAKE_GH_BODY"
    ;;
  *)
    printf 'unexpected gh args: %s\\n' "$*" >&2
    exit 99
    ;;
esac
`,
  );
  await chmod(ghPath, 0o755);
  return binDir;
}

describe("dual-review helper", () => {
  test("posts a new review comment with an agent-specific marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-dual-review-"));
    try {
      const binDir = await fakeGhBin(root);
      const reportPath = join(root, "codex.md");
      const bodyPath = join(root, "body.md");
      const logPath = join(root, "gh.log");
      await writeFile(reportPath, "## Codex review\n\nNo must-fix findings.\n");
      await writeFile(logPath, "");

      const result = await runCommand(["bash", helperPath, "comment", "codex", "17", reportPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          FAKE_GH_BODY: bodyPath,
          FAKE_GH_LOG: logPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result).toEqual({
        code: 0,
        stdout: "posted Codex review comment on jvrck/wux#17\n",
        stderr: "",
      });
      expect(await readFile(bodyPath, "utf8")).toBe(
        "<!-- dual-review:codex -->\n\n## Codex review\n\nNo must-fix findings.\n",
      );
      expect(await readFile(logPath, "utf8")).toContain("lookup:map(select(.body | startswith(\"<!-- dual-review:codex -->\")))");
      expect(await readFile(logPath, "utf8")).toContain("comment:17");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("updates an existing review comment for the requested agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-dual-review-"));
    try {
      const binDir = await fakeGhBin(root);
      const reportPath = join(root, "claude.md");
      const bodyPath = join(root, "body.md");
      const logPath = join(root, "gh.log");
      await writeFile(reportPath, "## Claude review\n\nNo must-fix findings.\n");
      await writeFile(logPath, "");

      const result = await runCommand(["bash", helperPath, "comment", "claude", "17", reportPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          FAKE_GH_BODY: bodyPath,
          FAKE_GH_EXISTING_ID: "901",
          FAKE_GH_LOG: logPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result).toEqual({
        code: 0,
        stdout: "updated Claude review comment (901) on jvrck/wux#17\n",
        stderr: "",
      });
      expect(await readFile(bodyPath, "utf8")).toBe(
        "<!-- dual-review:claude -->\n\n## Claude review\n\nNo must-fix findings.\n",
      );
      expect(await readFile(logPath, "utf8")).toContain("lookup:map(select(.body | startswith(\"<!-- dual-review:claude -->\")))");
      expect(await readFile(logPath, "utf8")).toContain("patch:repos/jvrck/wux/issues/comments/901");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown review comment agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-dual-review-"));
    try {
      const reportPath = join(root, "review.md");
      await writeFile(reportPath, "review\n");

      const result = await runCommand(["bash", helperPath, "comment", "gpt", "17", reportPath], {
        cwd: repoRoot,
        env: process.env,
      });

      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: "comment requires <agent> to be codex or claude\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skill instructions post separate comments for each reviewer", async () => {
    const skillPaths = [
      ".agents/skills/dual-review/SKILL.md",
      ".claude/skills/dual-review/SKILL.md",
    ];

    for (const path of skillPaths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("dual-review.sh comment codex");
      expect(text).toContain("dual-review.sh comment claude");
      expect(text).toContain("same two PR comments");
    }
  });

  test("project review docs describe per-agent PR comments", async () => {
    const paths = ["AGENTS.md", "CLAUDE.md"];

    for (const path of paths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("separate per-agent PR comments");
      expect(text).not.toContain("consolidated onto the PR");
    }
  });

  test("skill instructions prefer Wux for cross-agent reviewers", async () => {
    const codexSkill = await readFile(join(repoRoot, ".agents/skills/dual-review/SKILL.md"), "utf8");
    const claudeSkill = await readFile(join(repoRoot, ".claude/skills/dual-review/SKILL.md"), "utf8");

    for (const text of [codexSkill, claudeSkill]) {
      expect(text).toContain("command -v wux");
      expect(text).toContain("wux remotes list");
      expect(text).toContain("wux --local");
      expect(text).toContain("unless an explicit Wux remote/default target has been chosen");
      expect(text).toContain("report file");
      expect(text).toContain("sentinel");
      expect(text).toContain("pane.log");
      expect(text).toContain("fallback");
      expect(text).toContain("wux --local stop");
    }

    expect(codexSkill).toContain("wux --local run claude");
    expect(codexSkill).toContain("wux --local send");
    expect(codexSkill).toContain("claude -p");

    expect(claudeSkill).toContain("wux --local run codex");
    expect(claudeSkill).toContain("wux --local send");
    expect(claudeSkill).toContain("mcp__codex__codex");
  });

  test("project review docs describe Wux-first reviewer execution", async () => {
    const paths = ["AGENTS.md", "CLAUDE.md"];

    for (const path of paths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("Wux-first cross-agent reviewer execution");
      expect(text).toContain("report file");
      expect(text).toContain("sentinel");
    }
  });
});
