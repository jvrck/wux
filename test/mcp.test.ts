import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { assertCapable, ensureFeature, featureSupported, targetCapabilities } from "../src/mcp/capability";
import { createMcpServer } from "../src/mcp/server";
import { identityFor, resolveTarget } from "../src/mcp/target";
import type { WuxConfig } from "../src/runtime/config";
import type { ProcessResult } from "../src/runtime/process";
import { VERSION } from "../src/version";
import { tempConfig } from "./helpers";

function emptyConfig(): WuxConfig {
  return { version: 1, remotes: {} };
}

function memoryIO() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("wux mcp server", () => {
  test("completes an initialize handshake and exposes exactly the operator tool surface", async () => {
    const oldState = process.env.XDG_STATE_HOME;
    const temp = await tempConfig();
    process.env.XDG_STATE_HOME = temp.configHome; // isolate run state so `list` is deterministic
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ config: emptyConfig() });
    const client = new Client({ name: "wux-test-client", version: "9.9.9" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.listTools();
      // Exactly the seven operator tools (#79); no leftover scaffolding probe.
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["interrupt", "list", "open", "read", "send", "stop", "view"]);

      // The handshake drives end-to-end via an observation tool (no setup needed).
      const result = await client.callTool({ name: "list", arguments: { target: "local" } });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const payload = JSON.parse(text) as { identity: { targetType: string; host: string | null }; rows: unknown[] };
      expect(payload.identity.targetType).toBe("local");
      expect(payload.identity.host).toBe(null);
      expect(Array.isArray(payload.rows)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
      await temp.cleanup();
    }
  });
});

describe("mcp target resolver", () => {
  const config: WuxConfig = { version: 1, remotes: { work: { host: "worker", wuxPath: "/opt/wux" } } };

  test("defaults to local for omitted/local/localhost", () => {
    for (const target of [undefined, "", "local", "localhost", "LOCAL"]) {
      const resolved = resolveTarget(target, { config });
      expect(resolved.local).toBe(true);
      expect(resolved.targetType).toBe("local");
      expect(resolved.host).toBe(null);
    }
  });

  test("resolves a configured remote by name", () => {
    const resolved = resolveTarget("work", { config });
    expect(resolved).toMatchObject({ targetType: "remote", targetName: "work", host: "worker", wuxPath: "/opt/wux", local: false });
  });

  test("resolves a raw host only when allowed", () => {
    expect(() => resolveTarget("raw.example.com", { config })).toThrow("unknown target");
    const resolved = resolveTarget("raw.example.com", { config, allowRawHost: true });
    expect(resolved).toMatchObject({ targetType: "host", targetName: null, host: "raw.example.com", local: false });
    expect(resolveTarget("my-host-1", { config, allowRawHost: true }).host).toBe("my-host-1"); // hyphens ok
    expect(() => resolveTarget("-oProxyCommand=evil", { config, allowRawHost: true })).toThrow("invalid raw host");
    expect(() => resolveTarget("bad host", { config, allowRawHost: true })).toThrow("invalid raw host");
  });

  test("identityFor produces the §5 envelope with nullable run fields", () => {
    const resolved = resolveTarget("work", { config });
    expect(identityFor(resolved)).toEqual({
      targetType: "remote",
      targetName: "work",
      host: "worker",
      runName: null,
      tmuxSession: null,
    });
    expect(identityFor(resolved, "r1", "wux_r1").runName).toBe("r1");
  });
});

describe("mcp capability gating (version-derived, never probed)", () => {
  test("featureSupported: empty/unknown set is not gated; a declared set must include the feature", () => {
    expect(featureSupported([], "interrupt")).toBe(true); // first-cut empty table: not gated
    expect(featureSupported(["interrupt"], "interrupt")).toBe(true);
    expect(featureSupported(["something-else"], "interrupt")).toBe(false);
  });

  test("targetCapabilities: local reports VERSION with no skew; remote reads version + skew over the runner", async () => {
    const local = await targetCapabilities({ targetType: "local", targetName: null, host: null, wuxPath: "wux", local: true });
    expect(local.wuxVersion).toBe(VERSION);
    expect(local.skew).toBe(false);

    const remote = await targetCapabilities(
      { targetType: "remote", targetName: "work", host: "worker", wuxPath: "/opt/wux", local: false },
      async (): Promise<ProcessResult> => ({ code: 0, stdout: "2099.01.02\n", stderr: "" }),
    );
    expect(remote.wuxVersion).toBe("2099.01.02");
    expect(remote.skew).toBe(true);

    const unreadable = await targetCapabilities(
      { targetType: "remote", targetName: "work", host: "worker", wuxPath: "/opt/wux", local: false },
      async (): Promise<ProcessResult> => ({ code: 255, stdout: "", stderr: "boom" }),
    );
    expect(unreadable.wuxVersion).toBe(null);
  });

  test("assertCapable: throws a clear error when a declared set omits the feature, passes otherwise", () => {
    const caps = { wuxVersion: "2026.06.07", capabilities: ["send-json"], skew: true };
    expect(() => assertCapable(caps, "interrupt", "worker")).toThrow("does not support 'interrupt'");
    expect(() => assertCapable(caps, "interrupt", "worker")).toThrow("worker");
    expect(() => assertCapable({ ...caps, capabilities: ["interrupt"] }, "interrupt", "worker")).not.toThrow();
    expect(() => assertCapable({ ...caps, capabilities: [] }, "interrupt", "worker")).not.toThrow(); // empty = not gated
  });

  test("ensureFeature: local always passes; a remote with an empty (first-cut) capability set is not gated", async () => {
    await ensureFeature({ targetType: "local", targetName: null, host: null, wuxPath: "wux", local: true }, "interrupt");
    await ensureFeature(
      { targetType: "remote", targetName: "work", host: "worker", wuxPath: "/opt/wux", local: false },
      "interrupt",
      async (): Promise<ProcessResult> => ({ code: 0, stdout: "2099.01.02\n", stderr: "" }),
    );
  });
});

describe("mcp command registration", () => {
  test("mcp is non-operational: not forwarded to a configured default remote", async () => {
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const temp = await tempConfig();
    process.env.XDG_CONFIG_HOME = temp.configHome;
    let sshCalls = 0;
    try {
      // Configure a default remote so any operational command would forward.
      await runCli(["remotes", "add", "work", "worker", "--default"], memoryIO().io);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const memory = memoryIO();
      const run = runCli(["mcp"], memory.io, {
        sshRunner: async () => {
          sshCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        },
        mcpTransport: serverTransport,
      });
      // Let the server connect, then disconnect the client to end the long-lived server.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await clientTransport.close();
      const code = await run;

      expect(code).toBe(0);
      expect(sshCalls).toBe(0); // mcp ran locally, never forwarded to the default remote
      expect(memory.output().stdout).toBe(""); // MCP mode keeps stdout clean (JSON-RPC channel)
    } finally {
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
      await temp.cleanup();
    }
  });
});
