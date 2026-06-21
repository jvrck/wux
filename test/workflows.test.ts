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
    expect(text).toContain("actions/upload-artifact@v7.0.1");
    expect(text).toContain("actions/download-artifact@v8.0.1");
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

  test("preview workflow builds ref-scoped artifacts without publishing releases", async () => {
    const text = await readFile(join(workflowsDir, "preview.yml"), "utf8");

    expect(text).toContain("pull_request:");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("bun run typecheck");
    expect(text).toContain("bun test");
    expect(text).toContain("0.0.0-preview.$short_sha");
    expect(text).toContain("BUILD_INFO.json");
    expect(text).toContain("SHA256SUMS");
    expect(text).toContain("actions/upload-artifact@v7.0.1");
    expect(text).not.toContain("gh release create");
    expect(text).not.toContain("scripts/smoke-remote-ssh.sh");
  });

  test("disposable Actions artifacts use short retention to avoid storage blowups", async () => {
    const preview = await readFile(join(workflowsDir, "preview.yml"), "utf8");
    const release = await readFile(join(workflowsDir, "release.yml"), "utf8");

    // Preview build artifacts are disposable per-PR builds and previously
    // dominated Actions storage (#148) — short window, never the old 14 days.
    expect(preview).toContain("retention-days: 5");
    expect(preview).not.toContain("retention-days: 14");

    // The intermediate matrix build artifacts the release job downloads in-run
    // get a short explicit retention; the published Release assets are durable.
    expect(release).toContain("retention-days: 3");

    // Release publishing still resolves those artifacts within the same run: the
    // matrix build uploads them and later jobs download them.
    expect(release).toContain("uses: actions/upload-artifact@v7.0.1");
    expect(release).toContain("uses: actions/download-artifact@v8.0.1");
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
