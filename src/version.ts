// Single source of truth for the wux version.
//
// Stamped at release build time via `bun build --define
// 'process.env.WUX_VERSION="<tag>"'` (see docs/releasing.md). Source/dev runs
// fall back to a non-CalVer sentinel so tooling can tell a dev build from a
// real release.
export const VERSION = process.env.WUX_VERSION ?? "0.0.0-dev";
