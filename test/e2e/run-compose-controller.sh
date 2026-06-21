#!/usr/bin/env bash
set -euo pipefail

die() { printf 'wux remote smoke: %s\n' "$*" >&2; exit 1; }

run_name="${WUX_REMOTE_SMOKE_NAME:-}"
[ -n "$run_name" ] || die "WUX_REMOTE_SMOKE_NAME is required"
case "$run_name" in
  "." | ".." | *[!A-Za-z0-9._-]*) die "invalid run name: $run_name" ;;
esac

output_dir="/output"
remote_cwd="/work"
mkdir -p "$output_dir"
mkdir -p /root/.ssh
cp /ssh/config /ssh/id_ed25519 /root/.ssh/
chmod 0700 /root/.ssh
chmod 0600 /root/.ssh/config /root/.ssh/id_ed25519

for _ in {1..50}; do
  if ssh -- remote "true" > "$output_dir/ssh-ready.txt" 2> "$output_dir/ssh-ready.err"; then
    break
  fi
  sleep 0.2
done
if ! ssh -- remote "true" >> "$output_dir/ssh-ready.txt" 2>> "$output_dir/ssh-ready.err"; then
  die "sshd did not become reachable at remote:22"
fi

wux_remote() {
  wux --host remote "$@"
}

ssh -- remote "wux --version" > "$output_dir/ssh-version.txt" 2> "$output_dir/ssh-version.err"
wux_remote status > "$output_dir/status-initial.txt" 2> "$output_dir/status-initial.err"
wux_remote run shell --name "$run_name" --cwd "$remote_cwd" > "$output_dir/run.txt" 2> "$output_dir/run.err"
sleep 0.2

expected_output="wux-remote-smoke-OK"
wux_remote send "$run_name" "printf 'wux-remote-smoke-%s\n' OK" > "$output_dir/send.txt" 2> "$output_dir/send.err"

found_output=0
for _ in {1..50}; do
  if wux_remote read "$run_name" --tail 50 > "$output_dir/read.txt" 2> "$output_dir/read.err"; then
    if grep -Fq "$expected_output" "$output_dir/read.txt"; then
      found_output=1
      break
    fi
  fi
  sleep 0.2
done
[ "$found_output" -eq 1 ] || die "expected remote shell output was not captured"

wux_remote status > "$output_dir/status-running.txt" 2> "$output_dir/status-running.err"
grep -Fq "$run_name" "$output_dir/status-running.txt" || die "remote status did not include $run_name"
awk -v name="$run_name" '$1 == name && $3 == "running" { found = 1 } END { exit found ? 0 : 1 }' "$output_dir/status-running.txt" \
  || die "remote status did not report $run_name as running"

wux_remote stop "$run_name" --yes > "$output_dir/stop.txt" 2> "$output_dir/stop.err"
