import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommand } from "../src/commands/send";
import { interruptCommand } from "../src/commands/interrupt";
import { stopCommand } from "../src/commands/stop";
import { runCommand } from "../src/commands/run";
import { sendPayload } from "../src/mcp/tools/send";
import { createMcpServer } from "../src/mcp/server";
import type { ResolvedTarget } from "../src/mcp/target";
import type { SendResult } from "../src/commands/send";
import { lastInput } from "../src/runtime/events";
import type { WuxConfig } from "../src/runtime/config";
import { hasTmux, killTmux, tempState } from "./helpers";

function emptyConfig(): WuxConfig {
  return { version: 1, remotes: {} };
}

function uniqueRunName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Harness {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

async function connect(): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ config: emptyConfig() });
  const client = new Client({ name: "wux-tools-test", version: "9.9.9" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

interface ToolResponse {
  isError?: boolean;
  text: string;
  structured: Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content.map((item) => item.text).join("\n");
  return {
    isError: result.isError as boolean | undefined,
    text,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
  };
}

function localResolved(): ResolvedTarget {
  return { targetType: "local", targetName: null, host: null, wuxPath: "wux", local: true };
}

describe("mcp tools — identity envelope + scope", () => {
  test("registers exactly the seven operator tools (no deferred verbs, no scaffolding probe)", async () => {
    const harness = await connect();
    try {
      const tools = await harness.client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["interrupt", "list", "open", "read", "send", "stop", "view"]);
      // Deferred verbs must never be a tool.
      for (const banned of ["handoff", "mark", "wait", "submit", "control-send"]) {
        expect(names).not.toContain(banned);
      }
    } finally {
      await harness.close();
    }
  });

  test("observation tools default to local and carry the §5 identity envelope", async () => {
    const harness = await connect();
    try {
      const list = await call(harness.client, "list", {});
      const identity = list.structured.identity as { targetType: string };
      expect(identity.targetType).toBe("local");
    } finally {
      await harness.close();
    }
  });
});

describe("mcp tools — mutation target + confirmation gating", () => {
  test("send rejects a missing/implicit target", async () => {
    const harness = await connect();
    try {
      const missing = await call(harness.client, "send", { name: "anything", text: "hi" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("target is required");

      const empty = await call(harness.client, "send", { name: "anything", text: "hi", target: "  " });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain("target is required");
    } finally {
      await harness.close();
    }
  });

  test("stop requires yes:true (rejected without it)", async () => {
    const harness = await connect();
    try {
      // Omitting yes fails the yes:literal(true) input schema -> isError.
      const missing = await call(harness.client, "stop", { name: "x", target: "local" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("yes");

      // yes:false also fails the literal(true) schema.
      const refused = await call(harness.client, "stop", { name: "x", target: "local", yes: false });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("yes");
    } finally {
      await harness.close();
    }
  });
});

describe("mcp tools — send payload shaping (unit)", () => {
  test("submitted result carries submission + submitted:true and no warning", () => {
    const result: SendResult = { name: "r", bytes: 3, submission: "submitted", retried: false };
    const payload = sendPayload(localResolved(), result);
    expect(payload.submission).toBe("submitted");
    expect(payload.submitted).toBe(true);
    expect(payload.warning).toBeUndefined();
    expect((payload.identity as { targetType: string }).targetType).toBe("local");
  });

  test("a not-submitted result surfaces an explicit warning, never a clean success", () => {
    for (const submission of ["uncertain", "not-submitted"] as const) {
      const result: SendResult = { name: "r", bytes: 3, submission, retried: true };
      const payload = sendPayload(localResolved(), result);
      expect(payload.submission).toBe(submission);
      expect(payload.submitted).toBe(false);
      expect(typeof payload.warning).toBe("string");
      expect(payload.warning as string).toContain(submission);
    }
  });
});

describe("mcp tools — by stamping (unit, real run)", () => {
  test("sendCommand({actor}) writes by:actor; CLI default stays the owner", async () => {
    if (!(await hasTmux())) return;
    const temp = await tempState();
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("stamp");
    let created = false;
    try {
      await runCommand({ backend: "shell", name, cwd: temp.root });
      created = true;

      await sendCommand({ name, text: "echo a", forceOwner: false, actor: "mcp:probe-x" });
      let input = await lastInput(name);
      expect(input.lastInputBy).toBe("mcp:probe-x");

      await interruptCommand({ name, forceOwner: false, actor: "mcp:probe-y" });
      input = await lastInput(name);
      expect(input.lastInputBy).toBe("mcp:probe-y");

      // No actor -> default owner "user@host" (not an mcp: id).
      await sendCommand({ name, text: "echo b", forceOwner: false });
      input = await lastInput(name);
      expect(input.lastInputBy).not.toBeNull();
      expect((input.lastInputBy as string).startsWith("mcp:")).toBe(false);

      await stopCommand(name, true, "mcp:probe-z");
      input = await lastInput(name);
      expect(input.lastInputBy).toBe("mcp:probe-z");
      created = false; // stopped session already killed
    } finally {
      if (created) await killTmux(name);
      process.env.XDG_STATE_HOME = old;
      await temp.cleanup();
    }
  });
});

describe("mcp tools — full local loop (open → list → send → read → interrupt → view → stop)", () => {
  let temp: Awaited<ReturnType<typeof tempState>> | null = null;
  let old: string | undefined;

  beforeEach(async () => {
    old = process.env.XDG_STATE_HOME;
  });

  afterEach(async () => {
    process.env.XDG_STATE_HOME = old;
    if (temp) await temp.cleanup();
    temp = null;
  });

  test("drives a real shell run end to end with identity on every response", async () => {
    if (!(await hasTmux())) return;
    temp = await tempState();
    process.env.XDG_STATE_HOME = temp.stateHome;
    const name = uniqueRunName("loop");
    const harness = await connect();
    let live = false;

    try {
      // open (mutation; explicit target required)
      const opened = await call(harness.client, "open", { backend: "shell", name, cwd: temp.root, target: "local" });
      expect(opened.isError).toBeFalsy();
      live = true;
      expect(opened.structured.name).toBe(name);
      expect(opened.structured.tmuxSession).toBe(`wux_${name}`);
      expectIdentity(opened.structured, "local", name);

      // list (observation; filter to the one run)
      const list = await call(harness.client, "list", { name });
      const rows = list.structured.rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe(name);
      expect((rows[0].identity as { targetType: string }).targetType).toBe("local");
      expect("lastInputBy" in rows[0]).toBe(true);
      expect("lastInputAt" in rows[0]).toBe(true);

      // send (mutation; stamps mcp client id)
      const sent = await call(harness.client, "send", { name, text: "echo wux-loop-marker", target: "local" });
      expect(sent.isError).toBeFalsy();
      expect(["submitted", "uncertain", "not-submitted"]).toContain(sent.structured.submission as string);
      // shell backend always classifies submitted.
      expect(sent.structured.submission).toBe("submitted");
      expect(sent.structured.submitted).toBe(true);
      expect("retried" in sent.structured).toBe(true);
      expectIdentity(sent.structured, "local", name);

      await new Promise((resolve) => setTimeout(resolve, 400));

      // read (observation; labeled raw capture with local log paths)
      const read = await call(harness.client, "read", { name });
      expect(read.structured.label).toBe("pane capture (raw TUI, may be truncated)");
      expect(typeof read.structured.paneLogPath).toBe("string");
      expect(typeof read.structured.runDir).toBe("string");
      expect((read.structured.lines as string[]).join("\n")).toContain("wux-loop-marker");
      expectIdentity(read.structured, "local", name);

      // list/view expose lastInputBy after a send -> the mcp client id.
      const listAfter = await call(harness.client, "list", { name });
      const rowAfter = (listAfter.structured.rows as Array<Record<string, unknown>>)[0];
      expect(rowAfter.lastInputBy).toBe("mcp:wux-tools-test");
      expect(typeof rowAfter.lastInputAt).toBe("string");

      // view (observation; watch instructions + lastInput)
      const view = await call(harness.client, "view", { name });
      expect(view.structured.tmuxTarget).toBe(`=wux_${name}:`);
      expect(view.structured.attachCommand).toBe(`wux attach ${name}`);
      expect(typeof view.structured.paneLogPath).toBe("string");
      expect(view.structured.lastInputBy).toBe("mcp:wux-tools-test");
      expectIdentity(view.structured, "local", name);

      // interrupt (mutation)
      const interrupted = await call(harness.client, "interrupt", { name, target: "local" });
      expect(interrupted.isError).toBeFalsy();
      expect(interrupted.structured.interrupted).toBe(true);
      expectIdentity(interrupted.structured, "local", name);

      // stop (mutation; requires yes:true)
      const stopped = await call(harness.client, "stop", { name, target: "local", yes: true });
      expect(stopped.isError).toBeFalsy();
      expect(stopped.structured.stopped).toBe(true);
      expectIdentity(stopped.structured, "local", name);
      live = false;
    } finally {
      if (live) await killTmux(name);
      await harness.close();
    }
  });
});

function expectIdentity(structured: Record<string, unknown>, targetType: string, runName: string): void {
  const identity = structured.identity as {
    targetType: string;
    targetName: string | null;
    host: string | null;
    runName: string | null;
    tmuxSession: string | null;
  };
  expect(identity).toBeDefined();
  expect(identity.targetType).toBe(targetType);
  expect(identity.runName).toBe(runName);
  expect(identity.tmuxSession).toBe(`wux_${runName}`);
}

describe("mcp tools — remote target forwarding", () => {
  const remoteConfig: WuxConfig = { version: 1, remotes: { work: { host: "worker", wuxPath: "/opt/wux" } } };

  async function connectRemote(sshRunner: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ config: remoteConfig, sshRunner });
    const client = new Client({ name: "wux-remote-test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => (await client.close(), await server.close()) };
  }

  test("a remote observation tool forwards over SSH and returns a labeled result + remote identity", async () => {
    const calls: string[][] = [];
    const harness = await connectRemote(async (args) => {
      calls.push(args);
      return { code: 0, stdout: "remote pane line\n", stderr: "" };
    });
    try {
      const read = await call(harness.client, "read", { name: "r1", target: "work" });
      expect(read.structured.forwarded).toBe(true);
      const identity = read.structured.identity as { targetType: string; targetName: string; host: string };
      expect(identity.targetType).toBe("remote");
      expect(identity.targetName).toBe("work");
      expect(identity.host).toBe("worker");
      // forwarded the read to the worker host over the hardened SSH path
      expect(calls.some((argv) => argv.includes("worker") && argv[argv.length - 1].includes("'read'"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test("a remote mutation version-gates, then forwards send --json and returns a structured verdict", async () => {
    const calls: string[][] = [];
    const harness = await connectRemote(async (args) => {
      calls.push(args);
      const remoteCmd = args[args.length - 1];
      if (remoteCmd.includes("'--version'")) return { code: 0, stdout: "2099.01.02\n", stderr: "" };
      // the forwarded `send --json` returns the SendResult envelope
      return { code: 0, stdout: `${JSON.stringify({ name: "r1", submission: "submitted", retried: false, bytes: 2 })}\n`, stderr: "" };
    });
    try {
      const sent = await call(harness.client, "send", { name: "r1", text: "hi", target: "work" });
      expect(sent.structured.submission).toBe("submitted");
      expect(sent.structured.submitted).toBe(true);
      expect((sent.structured.identity as { host: string }).host).toBe("worker");
      // ensureFeature ran a version check before forwarding the mutation
      expect(calls.some((argv) => argv[argv.length - 1].includes("'--version'"))).toBe(true);
      expect(calls.some((argv) => argv[argv.length - 1].includes("'send'"))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

// #124 BLOCKING (S13b): an MCP raw `--allow-raw-host` target has no stored wuxPath,
// so it MUST forward through the same remote runtime resolver the CLI raw `--host`
// path uses — NOT a bare `wux` (which fails with `env: 'wux'` when wux is in
// ~/.local/bin). Both the forward AND the capability `--version` probe must use the
// resolver, or the probe returns null (ungated) and the tool proceeds into the
// failure this issue exists to eliminate.
describe("mcp tools — raw-host (allowRawHost) forwarding resolves wux on the remote", () => {
  const savedHint = process.env.WUX_REMOTE_WUX_PATH;
  beforeEach(() => {
    delete process.env.WUX_REMOTE_WUX_PATH;
  });
  afterEach(() => {
    if (savedHint === undefined) delete process.env.WUX_REMOTE_WUX_PATH;
    else process.env.WUX_REMOTE_WUX_PATH = savedHint;
  });

  async function connectRawHost(sshRunner: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ config: emptyConfig(), allowRawHost: true, sshRunner });
    const client = new Client({ name: "wux-rawhost-test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => (await client.close(), await server.close()) };
  }

  // A forwarded remote command rides as the LAST ssh argv element. The resolver
  // wraps it in an `sh -c <snippet>` with host+hint positionals; a regression to a
  // bare wux would instead be the old `'env' 'WUX_FORCE_LOCAL=1' 'wux' ...` shape.
  function assertResolverNotBareWux(remoteCmd: string): void {
    expect(remoteCmd.startsWith("'sh' '-c' ")).toBe(true);
    expect(remoteCmd).toContain('"$HOME/.local/bin/wux"');
    expect(remoteCmd).toContain("bash -lc");
    expect(remoteCmd).toContain("could not resolve a wux binary on host");
    // The exact broken leg #124 fixes: never a bare `wux` over non-interactive SSH.
    expect(remoteCmd).not.toContain("'env' 'WUX_FORCE_LOCAL=1' 'wux' '");
    // host label + empty hint ride as the snippet's positionals.
    expect(remoteCmd).toContain("'wux' 'raw.example'");
  }

  test("an observation tool on a raw host forwards through the resolver, not a bare wux", async () => {
    const calls: string[][] = [];
    const harness = await connectRawHost(async (args) => {
      calls.push(args);
      return { code: 0, stdout: "remote pane line\n", stderr: "" };
    });
    try {
      const read = await call(harness.client, "read", { name: "r1", target: "raw.example" });
      expect(read.structured.forwarded).toBe(true);
      expect((read.structured.identity as { targetType: string; host: string }).targetType).toBe("host");
      const forward = calls.find((argv) => argv.includes("raw.example") && argv[argv.length - 1].includes("'read'"));
      expect(forward).toBeDefined();
      assertResolverNotBareWux((forward as string[])[forward!.length - 1]);
    } finally {
      await harness.close();
    }
  });

  test("a raw-host mutation runs the capability probe AND the send through the resolver", async () => {
    const calls: string[][] = [];
    const harness = await connectRawHost(async (args) => {
      calls.push(args);
      const remoteCmd = args[args.length - 1];
      if (remoteCmd.includes("'--version'")) return { code: 0, stdout: "2099.01.02\n", stderr: "" };
      return { code: 0, stdout: `${JSON.stringify({ name: "r1", submission: "submitted", retried: false, bytes: 2 })}\n`, stderr: "" };
    });
    try {
      const sent = await call(harness.client, "send", { name: "r1", text: "hi", target: "raw.example" });
      expect(sent.structured.submitted).toBe(true);
      const versionProbe = calls.find((argv) => argv[argv.length - 1].includes("'--version'"));
      const sendForward = calls.find((argv) => argv[argv.length - 1].includes("'send'"));
      expect(versionProbe).toBeDefined();
      expect(sendForward).toBeDefined();
      // BOTH legs go through the resolver — the probe especially, since a bare
      // `wux --version` would return null and silently ungate into the failure.
      assertResolverNotBareWux((versionProbe as string[])[versionProbe!.length - 1]);
      assertResolverNotBareWux((sendForward as string[])[sendForward!.length - 1]);
    } finally {
      await harness.close();
    }
  });

  test("WUX_REMOTE_WUX_PATH rides as the resolver hint positional for a raw host", async () => {
    process.env.WUX_REMOTE_WUX_PATH = "/opt/wux/bin/wux";
    const calls: string[][] = [];
    const harness = await connectRawHost(async (args) => {
      calls.push(args);
      return { code: 0, stdout: "remote pane line\n", stderr: "" };
    });
    try {
      await call(harness.client, "read", { name: "r1", target: "raw.example" });
      const forward = calls.find((argv) => argv.includes("raw.example") && argv[argv.length - 1].includes("'read'"));
      expect(forward).toBeDefined();
      // hint lands as the 2nd positional ($2), quoted — never interpolated.
      expect((forward as string[])[forward!.length - 1]).toContain("'wux' 'raw.example' '/opt/wux/bin/wux'");
    } finally {
      await harness.close();
    }
  });
});
