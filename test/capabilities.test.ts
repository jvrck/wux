import { describe, expect, test } from "bun:test";
import { capabilitiesForVersion, compareVersions } from "../src/runtime/capabilities";

describe("compareVersions", () => {
  test("orders CalVer releases by year, month, day", () => {
    expect(compareVersions("2026.06.07", "2026.06.08")).toBe(-1);
    expect(compareVersions("2026.07.01", "2026.06.30")).toBe(1);
    expect(compareVersions("2027.01.01", "2026.12.31")).toBe(1);
    expect(compareVersions("2026.06.07", "2026.06.07")).toBe(0);
  });

  test("sorts the 0.0.0-dev sentinel below any release", () => {
    expect(compareVersions("0.0.0-dev", "2026.06.07")).toBe(-1);
    expect(compareVersions("2026.06.07", "0.0.0-dev")).toBe(1);
    expect(compareVersions("0.0.0-dev", "0.0.0-dev")).toBe(0);
  });

  test("treats missing trailing components as zero", () => {
    expect(compareVersions("2026.06", "2026.06.00")).toBe(0);
    expect(compareVersions("2026.06.01", "2026.06")).toBe(1);
  });
});

describe("capabilitiesForVersion", () => {
  test("returns [] for a null version", () => {
    expect(capabilitiesForVersion(null)).toEqual([]);
  });

  test("returns an array for any version (empty first cut)", () => {
    expect(Array.isArray(capabilitiesForVersion("2026.06.07"))).toBe(true);
    expect(Array.isArray(capabilitiesForVersion("0.0.0-dev"))).toBe(true);
  });
});
