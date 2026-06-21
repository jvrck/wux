import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const workflowsDir = join(import.meta.dir, "..", ".github", "workflows");
const repoRoot = join(import.meta.dir, "..");

async function workflowText(): Promise<string> {
  const names = await readdir(workflowsDir);
  const texts = await Promise.all(
    names
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map(async (name) => await readFile(join(workflowsDir, name), "utf8")),
  );
  return texts.join("\n");
}

describe("GitHub workflows", () => {
  test("use Node 24 compatible first-party actions", async () => {
    const text = await workflowText();

    expect(text).not.toContain("actions/checkout@v4");
    expect(text).not.toContain("actions/upload-artifact@v4");
    expect(text).not.toContain("actions/download-artifact@v4");
    expect(text).toContain("actions/checkout@v6.0.3");
    // upload-artifact is still pinned where it survives (e2e/security failure
    // diagnostics). download-artifact is no longer invoked anywhere: release.yml
    // carries binaries as draft-release assets, so the action is fully removed
    // rather than pinned to a presence-checked version.
    expect(text).toContain("actions/upload-artifact@v7.0.1");
    expect(text).not.toContain("uses: actions/download-artifact");
  });

  test("dependency security workflow scans lockfiles on PRs and a weekly schedule", async () => {
    const workflow = await readFile(join(workflowsDir, "security.yml"), "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("test -f bun.lock && ! test -f bun.lockb");
    expect(workflow).toContain("osv-scanner scan source --lockfile=bun.lock");
    expect(workflow).toContain("trivy fs --scanners vuln --include-dev-deps");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("security-gate:");
    expect(workflow).not.toContain("if: github.event_name != 'schedule'");
    expect(workflow).toContain("--severity HIGH,CRITICAL");
    expect(workflow).toContain("--ignore-unfixed");
    expect(workflow).toContain("--exit-code 1");
  });

  test("security scanning is available from local package scripts", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["security:osv"]).toContain("osv-scanner scan source --lockfile=bun.lock");
    expect(pkg.scripts["security:trivy"]).toContain("trivy fs --scanners vuln --include-dev-deps");
    expect(pkg.scripts["security:sbom"]).toContain(
      "trivy fs --format cyclonedx --include-dev-deps --output sbom.cdx.json",
    );
    expect(pkg.scripts["security:sbom:scan"]).toContain("trivy sbom sbom.cdx.json");
  });

  test("scanner suppression policy is documented and time-boxed", async () => {
    const docs = await readFile(join(repoRoot, "docs", "security.md"), "utf8");
    const osv = await readFile(join(repoRoot, "osv-scanner.toml"), "utf8");
    const trivy = await readFile(join(repoRoot, ".trivyignore.yaml"), "utf8");

    expect(docs).toContain("OSV-Scanner");
    expect(docs).toContain("Trivy");
    expect(docs).toContain("owner");
    expect(docs).toContain("expiry");
    expect(docs).toContain("tracking issue");
    expect(osv).toContain("ignoreUntil");
    expect(osv).toContain("owner");
    expect(trivy).toContain("expired_at");
    expect(trivy).toContain("owner");
  });

  test("E2E workflow runs public binary and remote SSH smoke on GitHub-hosted Ubuntu", async () => {
    const text = await readFile(join(workflowsDir, "e2e.yml"), "utf8");

    expect(text).toContain("pull_request:");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("runs-on: ubuntu-latest");
    expect(text).toContain("bun run build");
    expect(text).toContain("docker compose version");
    expect(text).toContain("scripts/smoke-release-asset.sh");
    expect(text).toContain("scripts/smoke-remote-ssh.sh");
    expect(text).toContain("actions/upload-artifact@v7.0.1");
    expect(text).toContain("if: failure()");
  });

  test("remote SSH smoke uses Docker Compose isolation", async () => {
    const text = await readFile(join(repoRoot, "scripts", "smoke-remote-ssh.sh"), "utf8");
    const compose = await readFile(join(repoRoot, "test", "e2e", "docker-compose.yml"), "utf8");
    const controller = await readFile(join(repoRoot, "test", "e2e", "run-compose-controller.sh"), "utf8");

    expect(text).toContain("WUX_BIN");
    expect(text).toContain("docker compose");
    expect(text).toContain("COMPOSE_PROJECT_NAME");
    expect(text).toContain("SSH_ORIGINAL_COMMAND");
    expect(compose).toContain("remote:");
    expect(compose).toContain("controller:");
    expect(compose).toContain("/ssh:ro");
    expect(compose).toContain("condition: service_healthy");
    expect(controller).toContain("cp /ssh/config /ssh/id_ed25519 /root/.ssh/");
    expect(controller).toContain("wux --host remote");
  });

  test("preview workflow cross-compiles the release target set without uploading Actions artifacts", async () => {
    const text = await readFile(join(workflowsDir, "preview.yml"), "utf8");

    expect(text).toContain("pull_request:");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("0.0.0-preview.$short_sha");
    // Cross-compiles the full release target set so a target-specific compile
    // break is caught at PR time, before a release tag hits release.yml.
    expect(text).toContain("bun-linux-arm64:wux-linux-arm64");
    expect(text).toContain("bun-darwin-arm64:wux-darwin-arm64");
    expect(text).toContain("bun-linux-x64-musl:wux-linux-x64-musl");
    expect(text).toContain("BUILD_INFO.json");
    expect(text).toContain("SHA256SUMS");
    // Preview binaries are a cross-compile gate, not a downloadable artifact:
    // the manifest is recorded in the run summary instead of consuming Actions
    // artifact storage (#148), and no release is ever published.
    expect(text).toContain("GITHUB_STEP_SUMMARY");
    expect(text).not.toContain("uses: actions/upload-artifact");
    expect(text).not.toContain("gh release create");
    expect(text).not.toContain("scripts/smoke-remote-ssh.sh");
  });

  test("preview and release carry binaries without disposable Actions artifacts", async () => {
    const preview = await readFile(join(workflowsDir, "preview.yml"), "utf8");
    const release = await readFile(join(workflowsDir, "release.yml"), "utf8");

    // Preview builds previously dominated Actions storage (#148) and tripped the
    // account-wide artifact quota. The preview job now cross-compiles and records
    // its manifest in the run summary instead of uploading an Actions artifact.
    expect(preview).not.toContain("uses: actions/upload-artifact");
    expect(preview).not.toContain("uses: actions/download-artifact");
    expect(preview).toContain("GITHUB_STEP_SUMMARY");

    // The release workflow carries binaries between jobs as assets on a draft
    // GitHub Release (gh release upload/download), not actions/{upload,download}-
    // artifact, then flips the validated draft public.
    expect(release).not.toContain("uses: actions/upload-artifact");
    expect(release).not.toContain("uses: actions/download-artifact");
    expect(release).toContain("gh release upload");
    expect(release).toContain("gh release download");
    expect(release).toContain("--draft");
    expect(release).toContain("--draft=false");
  });

  test("preview docs align artifact previews with the E2E workflow", async () => {
    const docs = await readFile(join(repoRoot, "docs", "previews.md"), "utf8");

    expect(docs).toContain(".github/workflows/preview.yml");
    expect(docs).toContain(".github/workflows/e2e.yml");
    expect(docs).toContain("BUILD_INFO.json");
    expect(docs).toContain("SHA256SUMS");
    expect(docs).toContain("0.0.0-preview.<short-sha>");
    expect(docs).toContain("scripts/smoke-remote-ssh.sh");
    expect(docs).toContain("Do not report a preview as a release");
  });

  test("E2E docs explain public Actions coverage and optional self-hosted compute", async () => {
    const docs = await readFile(join(repoRoot, "docs", "e2e.md"), "utf8");

    expect(docs).toContain("GitHub-hosted Ubuntu");
    expect(docs).toContain("Docker Compose");
    expect(docs).toContain("scripts/smoke-release-asset.sh");
    expect(docs).toContain("scripts/smoke-remote-ssh.sh");
    expect(docs).toContain("Compose network");
    expect(docs).toContain("Self-hosted runners");
    expect(docs).toContain("not required");
  });

});
