import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("Wux agent skills", () => {
  test("encode the agent-readiness interactive backend pattern", async () => {
    const paths = [
      "docs/agent-wux-skill.md",
      ".agents/skills/wux/SKILL.md",
      ".claude/skills/wux/SKILL.md",
    ];

    for (const path of paths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("ground truth");
      expect(text).toContain("pane.log");
      expect(text).toContain("sentinel");
      expect(text).toContain("wux wait");
      expect(text).toContain("completedVia");
      expect(text).toContain("completedVia: \"hook\"");
      expect(text).toContain("per run");
      expect(text).toContain("wux read --follow");
      expect(text).toContain("claude -p --output-format json");
      expect(text).toContain("codex exec --json");
      expect(text).toContain("Avoid `attach` unless the user explicitly asks for interactive takeover.");
      expect(text).toContain("docs/agent-readiness.md");
    }
  });

  test("documents composed notify and sentinel conventions", async () => {
    const text = await readFile(join(repoRoot, "docs/agent-readiness.md"), "utf8");

    expect(text).toContain("wux wait job7 --idle 30s && ntfy publish");
    expect(text).toContain("wux owns the signal, not the notifier");
    expect(text).toContain("--notify");
    expect(text).toContain("--on-idle");
    expect(text).toContain("compose-don't-connect");
    expect(text).toContain("cooperative");
    expect(text).toContain("best-effort");
    expect(text).toContain("timeout");
    expect(text).toContain("wux attach");
    expect(text).toContain("not a Wux guarantee");
    expect(text).toContain("Ground truth");
    expect(text).toContain("Wux will not grep");
    expect(text).toContain("turn-complete");
    expect(text).toContain("completedVia: \"sentinel\"");
    expect(text).toContain("WUX_DONE");
    expect(text).toContain("illustrative default only");
    expect(text).toContain("never a reserved Wux constant");
    expect(text).toContain("no `wux sentinel` verb");
  });

  test("defines human-only Wux operator console skills", async () => {
    const commandPaths = [
      ".claude/skills/wux-command/SKILL.md",
      ".agents/skills/wux-command/SKILL.md",
    ];
    const hubPaths = [
      ".claude/skills/wux-hub/SKILL.md",
      ".agents/skills/wux-hub/SKILL.md",
    ];

    for (const path of [...commandPaths, ...hubPaths]) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("disable-model-invocation: true");
      expect(text).toContain("allowed-tools:");
      expect(text).toContain("description:");
      expect(text).toContain("human-only");
      expect(text).toContain("MCP");
      expect(text).toContain("mcp__wux__");
    }

    for (const path of commandPaths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      for (const verb of ["open", "send", "read", "interrupt", "stop", "view"]) {
        expect(text).toContain(verb);
      }
      expect(text).toContain("submitted");
      expect(text).toContain("uncertain");
      expect(text).toContain("not-submitted");
      expect(text).toContain("WARNING");
      expect(text).toContain("secret");
      expect(text).toContain("truncated");
    }

    for (const path of hubPaths) {
      const text = await readFile(join(repoRoot, path), "utf8");

      expect(text).toContain("MCP `list` tool");
      expect(text).toContain("not `wux status`");
      expect(text).toContain("run | backend | status | owner | last-activity | cwd | target");
      expect(text).toContain("needs you");
      expect(text).toContain("doctor --all");
    }
  });
});
