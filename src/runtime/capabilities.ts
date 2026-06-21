// Version-derived capability table (frozen interface, EPIC #72 §4).
//
// Capabilities are DERIVED from a host's reported wux version, never probed by
// sending commands at the remote. The MCP layer (#78/#79) keys off this table
// plus the doctor `wuxVersion`/`skew` to fail clearly *before* invoking a feature
// a remote is too old to support, rather than hanging or emitting a cryptic
// remote parse error.

// CalVer-aware comparison. Real releases are `YYYY.MM.DD`; the source/dev sentinel
// `0.0.0-dev` sorts below any release. Returns <0, 0, or >0.
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const da = left[i] ?? 0;
    const db = right[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

interface CapabilityEntry {
  capability: string;
  minVersion: string;
}

// First cut: intentionally empty (the doctor `capabilities` array may be `[]` per
// §4). The comparison machinery is in place so entries are added as features ship
// at known CalVer versions; until then no capability is version-gated and the MCP
// layer treats an empty set as "no version-derived gating".
const CAPABILITY_TABLE: CapabilityEntry[] = [];

export function capabilitiesForVersion(version: string | null): string[] {
  if (version === null) return [];
  return CAPABILITY_TABLE.filter((entry) => compareVersions(version, entry.minVersion) >= 0).map(
    (entry) => entry.capability,
  );
}
