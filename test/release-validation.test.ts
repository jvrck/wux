import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTmux } from "./helpers";

const repoRoot = join(import.meta.dir, "..");

async function readRepoFile(path: string): Promise<string> {
  return await readFile(join(repoRoot, path), "utf8");
}

function expectBefore(text: string, earlier: string, later: string): void {
  const earlierIndex = text.indexOf(earlier);
  const laterIndex = text.indexOf(later);

  expect(earlierIndex).not.toBe(-1);
  expect(laterIndex).not.toBe(-1);
  expect(earlierIndex).toBeLessThan(laterIndex);
}

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

describe("release validation assets", () => {
  test("repository includes a release-level changelog", async () => {
    const changelog = await readRepoFile("CHANGELOG.md");

    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("## Unreleased");
    expect(changelog).toContain("## 2026.06.21");
    expect(changelog).toContain("Initial public release");
    expect(changelog).toContain("### Added");
  });

  test("changelog extractor prints only the matching release section", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-changelog-"));
    try {
      const changelog = join(root, "CHANGELOG.md");
      await writeFile(
        changelog,
        [
          "# Changelog",
          "",
          "## Unreleased",
          "",
          "### Added",
          "",
          "- Future work.",
          "",
          "## 2099.01.02",
          "",
          "### Fixed",
          "",
          "- Release-specific fix.",
          "",
          "## 2099.01.01",
          "",
          "### Added",
          "",
          "- Older release.",
          "",
        ].join("\n"),
      );

      const result = await runCommand([
        join(repoRoot, "scripts", "extract-changelog-section.sh"),
        "2099.01.02",
        changelog,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("### Fixed");
      expect(result.stdout).toContain("- Release-specific fix.");
      expect(result.stdout).not.toContain("Future work.");
      expect(result.stdout).not.toContain("Older release.");
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("changelog extractor fails clearly when the release section is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-changelog-"));
    try {
      const changelog = join(root, "CHANGELOG.md");
      await writeFile(changelog, "# Changelog\n\n## Unreleased\n\n### Added\n\n- Future work.\n");

      const result = await runCommand([
        join(repoRoot, "scripts", "extract-changelog-section.sh"),
        "2099.01.02",
        changelog,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("::error::CHANGELOG.md has no section for release tag 2099.01.02");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("changelog extractor fails clearly when the release section is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "wux-changelog-"));
    try {
      const changelog = join(root, "CHANGELOG.md");
      await writeFile(
        changelog,
        "# Changelog\n\n## Unreleased\n\n### Added\n\n- Future work.\n\n## 2099.01.02\n\n## 2099.01.01\n\n- Older release.\n",
      );

      const result = await runCommand([
        join(repoRoot, "scripts", "extract-changelog-section.sh"),
        "2099.01.02",
        changelog,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("::error::CHANGELOG.md section for release tag 2099.01.02 is empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("smoke script validates a downloaded binary lifecycle", async () => {
    const scriptPath = join(repoRoot, "scripts", "smoke-release-asset.sh");
    const script = await readFile(scriptPath, "utf8");
    const mode = (await stat(scriptPath)).mode;

    expect(mode & 0o111).not.toBe(0);
    expect(script).toContain("WUX_BIN");
    expect(script).toContain("EXPECTED_VERSION");
    expect(script).toContain("XDG_STATE_HOME");
    expect(script).toContain("wux run shell");
    expect(script).toContain("wux send");
    expect(script).toContain("wux read");
    expect(script).toContain("wux status");
    expect(script).toContain("wux stop");
    expect(script).toContain("meta.json");
    expect(script).toContain("pane.log");
    expect(script).toContain("events.jsonl");
  });

  test("workflow can validate published assets by tag", async () => {
    const workflow = await readRepoFile(".github/workflows/validate-release.yml");

    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("tag:");
    for (const asset of ["wux-linux-x64", "wux-linux-x64-musl", "wux-linux-arm64", "wux-darwin-arm64"]) {
      expect(workflow).toContain(`asset: ${asset}`);
    }
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("ubuntu-24.04-arm");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("alpine");
    expect(workflow).toContain("libstdc++");
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain("scripts/smoke-release-asset.sh");
    expect(workflow).toContain("actions/upload-artifact");
    expect(workflow).toContain("failure()");
  });

  test("release workflow validates build artifacts before publishing", async () => {
    const workflow = await readRepoFile(".github/workflows/release.yml");

    expect(workflow).toContain("  validate-native:");
    expect(workflow).toContain("  validate-linux-musl:");
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain("needs: [validate-native, validate-linux-musl]");
    expect(workflow).toContain("actions/download-artifact@v8.0.1");
    expect(workflow).toContain("name: ${{ matrix.asset }}");
    expect(workflow).toContain("scripts/smoke-release-asset.sh");
    expect(workflow).toContain("ubuntu-24.04-arm");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("alpine");
    expect(workflow).toContain("libstdc++");
    expect(workflow).toContain("actions/upload-artifact@v7.0.1");
    expect(workflow).toContain("failure()");
    expect(workflow).not.toContain("gh release download");
    expectBefore(workflow, "  validate-native:", "  release:");
    expectBefore(workflow, "  validate-linux-musl:", "  release:");
    expectBefore(workflow, "scripts/smoke-release-asset.sh", "gh release create");
  });

  test("release workflow publishes a CycloneDX SBOM after scanning it", async () => {
    const workflow = await readRepoFile(".github/workflows/release.yml");
    const docs = await readRepoFile("docs/releasing.md");

    expect(workflow).toContain("sbom.cdx.json");
    expect(workflow).toContain("trivy fs --format cyclonedx --include-dev-deps --output sbom.cdx.json .");
    expect(workflow).toContain("trivy sbom sbom.cdx.json");
    expect(workflow).toContain("--severity HIGH,CRITICAL");
    expect(workflow).toContain("--ignore-unfixed");
    expect(workflow).toContain("--exit-code 1");
    expect(workflow).toContain("sha256sum wux-* sbom.cdx.json > SHA256SUMS");
    expect(workflow).toContain("scripts/extract-changelog-section.sh \"$TAG\" CHANGELOG.md > \"$RUNNER_TEMP/release-notes.md\"");
    expect(workflow).toContain("gh release create \"$TAG\" --repo \"$GITHUB_REPOSITORY\" --notes-file \"$RUNNER_TEMP/release-notes.md\" wux-* sbom.cdx.json SHA256SUMS");
    expect(workflow).not.toContain("--generate-notes");
    expectBefore(workflow, "scripts/extract-changelog-section.sh", "gh release create");
    expectBefore(workflow, "trivy sbom sbom.cdx.json", "gh release create");
    expect(docs).toContain("sbom.cdx.json");
    expect(docs).toContain("CycloneDX");
    expect(docs).toContain("CHANGELOG.md");
    expect(docs).toContain("Confirm breaking changes and migration notes are explicit");
  });

  test(
    "smoke script runs against a stamped local binary when tmux is available",
    async () => {
      if (!(await hasTmux())) return;

      const version = "2099.01.04";
      const root = await mkdtemp(join(tmpdir(), "wux-release-validation-"));
      try {
        const binary = join(root, "wux-smoke");
        const build = await runCommand(
          [
            "bun",
            "build",
            join(repoRoot, "src", "index.ts"),
            "--compile",
            "--define",
            `process.env.WUX_VERSION="${version}"`,
            "--outfile",
            binary,
          ],
          { cwd: root },
        );
        if (build.code !== 0) {
          throw new Error(`build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
        }

        const smoke = await runCommand([join(repoRoot, "scripts", "smoke-release-asset.sh")], {
          cwd: repoRoot,
          env: {
            ...process.env,
            EXPECTED_VERSION: version,
            WUX_BIN: binary,
            WUX_SMOKE_ROOT: join(root, "smoke"),
          },
        });
        if (smoke.code !== 0) {
          throw new Error(`smoke failed\nstdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`);
        }

        expect(smoke.stderr).toContain("wux smoke: ok");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );

  test("release docs explain public and optional architecture coverage", async () => {
    const docs = await readRepoFile("docs/release-validation.md");

    for (const asset of ["wux-linux-x64", "wux-linux-x64-musl", "wux-linux-arm64", "wux-darwin-arm64"]) {
      expect(docs).toContain(asset);
    }
    expect(docs).toContain("public GitHub-hosted");
    expect(docs).toContain("optional");
    expect(docs).toContain("pre-publish");
    expect(docs).toContain("post-publish");
    expect(docs).toContain("workflow_dispatch");
    expect(docs).toContain("scripts/smoke-release-asset.sh");
    expect(docs).toContain("sbom.cdx.json");
  });
});
