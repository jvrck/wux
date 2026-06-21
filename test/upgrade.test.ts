import { describe, expect, test } from "bun:test";
import {
  assetName,
  checksumFor,
  compareCalVer,
  isReleaseVersion,
  isSourceRun,
  parseCalVer,
} from "../src/commands/upgrade";

describe("parseCalVer", () => {
  test("parses YYYY.MM.DD into numeric components", () => {
    expect(parseCalVer("2026.06.12")).toEqual([2026, 6, 12]);
  });

  test("parses same-day micro segments", () => {
    expect(parseCalVer("2026.06.12.2")).toEqual([2026, 6, 12, 2]);
  });

  test("rejects the dev sentinel and non-CalVer strings", () => {
    expect(parseCalVer("0.0.0-dev")).toBeNull();
    expect(parseCalVer("0.0.0")).toBeNull();
    expect(parseCalVer("v2026.06.12")).toBeNull();
    expect(parseCalVer("2026.6.12")).toBeNull();
  });
});

describe("compareCalVer", () => {
  test("orders by date components", () => {
    expect(compareCalVer(parseCalVer("2026.06.12")!, parseCalVer("2026.06.13")!)).toBe(-1);
    expect(compareCalVer(parseCalVer("2026.07.01")!, parseCalVer("2026.06.30")!)).toBe(1);
    expect(compareCalVer(parseCalVer("2026.06.12")!, parseCalVer("2026.06.12")!)).toBe(0);
  });

  test("treats a micro segment as newer than the bare date", () => {
    expect(compareCalVer(parseCalVer("2026.06.12.2")!, parseCalVer("2026.06.12")!)).toBe(1);
    expect(compareCalVer(parseCalVer("2026.06.12")!, parseCalVer("2026.06.12.2")!)).toBe(-1);
  });
});

describe("isReleaseVersion", () => {
  test("true for CalVer, false for the dev sentinel", () => {
    expect(isReleaseVersion("2026.06.12")).toBe(true);
    expect(isReleaseVersion("2026.06.12.3")).toBe(true);
    expect(isReleaseVersion("0.0.0-dev")).toBe(false);
  });
});

describe("isSourceRun", () => {
  test("detects a bun/node host executable (source run)", () => {
    expect(isSourceRun("/usr/local/bin/bun")).toBe(true);
    expect(isSourceRun("/opt/homebrew/bin/node")).toBe(true);
    expect(isSourceRun("/root/.bun/bin/bun")).toBe(true);
  });

  test("treats a compiled wux binary as a real release run", () => {
    expect(isSourceRun("/usr/local/bin/wux")).toBe(false);
    expect(isSourceRun("/home/jvrck/.local/bin/wux")).toBe(false);
  });
});

describe("assetName", () => {
  test("maps supported platforms to wux-<os>-<arch>", () => {
    expect(assetName("linux", "x64", false)).toBe("wux-linux-x64");
    expect(assetName("linux", "x86_64", false)).toBe("wux-linux-x64");
    expect(assetName("linux", "arm64", false)).toBe("wux-linux-arm64");
    expect(assetName("linux", "aarch64", false)).toBe("wux-linux-arm64");
    expect(assetName("darwin", "arm64", false)).toBe("wux-darwin-arm64");
  });

  test("selects the musl asset for musl linux x64", () => {
    expect(assetName("linux", "x64", true)).toBe("wux-linux-x64-musl");
  });

  test("throws on unsupported platform/arch combinations", () => {
    expect(() => assetName("darwin", "x64", false)).toThrow();
    expect(() => assetName("win32", "x64", false)).toThrow();
    expect(() => assetName("linux", "riscv64", false)).toThrow();
  });
});

describe("checksumFor", () => {
  const sums = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  wux-linux-x64",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  wux-darwin-arm64",
  ].join("\n");

  test("returns the digest for a matching asset", () => {
    expect(checksumFor(sums, "wux-darwin-arm64")).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  test("returns undefined when the asset is absent", () => {
    expect(checksumFor(sums, "wux-linux-arm64")).toBeUndefined();
  });
});
