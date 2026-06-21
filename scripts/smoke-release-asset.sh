#!/usr/bin/env bash
# Validate one downloaded wux release binary in an isolated tmux lifecycle.
#
# Required:
#   WUX_BIN           path to the executable release asset
#   EXPECTED_VERSION  release version that `wux --version` must print
#
# Optional:
#   WUX_SMOKE_ROOT      directory for temporary cwd/state/output files
#   WUX_SMOKE_NAME      run name to use
#   WUX_SMOKE_DIAG_DIR  directory where failure diagnostics are copied
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux smoke: %s\n' "$*" >&2; exit 1; }

WUX_BIN="${WUX_BIN:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
WUX_SMOKE_NAME="${WUX_SMOKE_NAME:-}"
WUX_SMOKE_DIAG_DIR="${WUX_SMOKE_DIAG_DIR:-}"

[ -n "$WUX_BIN" ] || die "WUX_BIN is required"
[ -n "$EXPECTED_VERSION" ] || die "EXPECTED_VERSION is required"
[ -f "$WUX_BIN" ] || die "binary not found: $WUX_BIN"
[ -x "$WUX_BIN" ] || die "binary is not executable: $WUX_BIN"

if ! command -v tmux >/dev/null 2>&1; then
  die "tmux is required for the lifecycle smoke"
fi

own_root=0
if [ -n "${WUX_SMOKE_ROOT:-}" ]; then
  root="$WUX_SMOKE_ROOT"
  mkdir -p "$root"
else
  root="$(mktemp -d)"
  own_root=1
fi

run_name="$WUX_SMOKE_NAME"
if [ -z "$run_name" ]; then
  run_name="release-smoke-$(date +%s)-$$"
fi

state_home="$root/state"
cwd="$root/cwd"
output_dir="$root/output"
install_dir="$root/bin"
installed_wux="$install_dir/wux"
mkdir -p "$state_home" "$cwd" "$output_dir" "$install_dir"
cp "$WUX_BIN" "$installed_wux"
chmod 0755 "$installed_wux"

wux() {
  XDG_STATE_HOME="$state_home" "$installed_wux" "$@"
}

collect_diagnostics() {
  local status="$1"
  local diag_dir="$WUX_SMOKE_DIAG_DIR"
  if [ -z "$diag_dir" ]; then
    diag_dir="$root/diagnostics"
  fi
  mkdir -p "$diag_dir"

  {
    printf 'status=%s\n' "$status"
    printf 'run_name=%s\n' "$run_name"
    printf 'root=%s\n' "$root"
    printf 'state_home=%s\n' "$state_home"
    printf 'installed_wux=%s\n' "$installed_wux"
    date -u
    uname -a
    "$installed_wux" --version || true
    tmux -V || true
  } > "$diag_dir/environment.txt" 2>&1 || true

  tmux list-sessions > "$diag_dir/tmux-list-sessions.txt" 2>&1 || true
  cp -R "$output_dir" "$diag_dir/output" 2>/dev/null || true

  local run_dir="$state_home/wux/runs/$run_name"
  for file in meta.json pane.log events.jsonl; do
    if [ -f "$run_dir/$file" ]; then
      cp "$run_dir/$file" "$diag_dir/$file" 2>/dev/null || true
    fi
  done
}

cleanup() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    collect_diagnostics "$status"
  fi

  wux stop "$run_name" --yes >/dev/null 2>&1 || true
  tmux kill-session -t "=wux_$run_name" >/dev/null 2>&1 || true

  if [ "$own_root" -eq 1 ] && [ "$status" -eq 0 ]; then
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT

expected_version="${EXPECTED_VERSION#v}"
actual_version="$("$installed_wux" --version)"
[ "$actual_version" = "$expected_version" ] || die "expected version $expected_version, got $actual_version"

"$installed_wux" --help > "$output_dir/help.txt"

note "wux smoke: starting $run_name with $installed_wux"
wux run shell --name "$run_name" --cwd "$cwd" > "$output_dir/run.txt" 2> "$output_dir/run.err"
sleep 0.2
expected_output="wux-smoke-OK"
wux send "$run_name" "printf 'wux-smoke-%s\n' OK" > "$output_dir/send.txt" 2> "$output_dir/send.err"

found_output=0
for _ in {1..50}; do
  if wux read "$run_name" --tail 50 > "$output_dir/read.txt" 2> "$output_dir/read.err"; then
    if grep -Fq "$expected_output" "$output_dir/read.txt"; then
      found_output=1
      break
    fi
  fi
  sleep 0.2
done
[ "$found_output" -eq 1 ] || die "expected shell output was not captured"

wux status > "$output_dir/status.txt" 2> "$output_dir/status.err"
grep -Fq "$run_name" "$output_dir/status.txt" || die "status did not include $run_name"
awk -v name="$run_name" '$1 == name && $3 == "running" { found = 1 } END { exit found ? 0 : 1 }' "$output_dir/status.txt" \
  || die "status did not report $run_name as running"

wux stop "$run_name" --yes > "$output_dir/stop.txt" 2> "$output_dir/stop.err"

run_dir="$state_home/wux/runs/$run_name"
[ -s "$run_dir/meta.json" ] || die "missing meta.json"
[ -s "$run_dir/pane.log" ] || die "missing pane.log"
[ -s "$run_dir/events.jsonl" ] || die "missing events.jsonl"
grep -Eq '"name"[[:space:]]*:[[:space:]]*"' "$run_dir/meta.json" || die "meta.json is missing name"
grep -Fq "$run_name" "$run_dir/meta.json" || die "meta.json has wrong run name"
grep -Eq '"backend"[[:space:]]*:[[:space:]]*"shell"' "$run_dir/meta.json" || die "meta.json has wrong backend"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"stopped"' "$run_dir/meta.json" || die "meta.json was not marked stopped"
grep -Fq "$expected_output" "$run_dir/pane.log" || die "pane.log is missing smoke output"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"create"' "$run_dir/events.jsonl" || die "events.jsonl is missing create event"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"send"' "$run_dir/events.jsonl" || die "events.jsonl is missing send event"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"stop"' "$run_dir/events.jsonl" || die "events.jsonl is missing stop event"

note "wux smoke: ok $run_name"
