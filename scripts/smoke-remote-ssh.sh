#!/usr/bin/env bash
# Validate wux remote forwarding through a Docker Compose SSH target.
#
# Required:
#   WUX_BIN  path to the controller executable under test
#
# Optional:
#   WUX_REMOTE_SMOKE_ROOT  directory for temporary ssh/state/output files
#   WUX_REMOTE_SMOKE_NAME  run name to use
#   WUX_REMOTE_DIAG_DIR    directory where failure diagnostics are copied
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux remote smoke: %s\n' "$*" >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
compose_file="$repo_root/test/e2e/docker-compose.yml"

WUX_BIN="${WUX_BIN:-}"
WUX_REMOTE_SMOKE_NAME="${WUX_REMOTE_SMOKE_NAME:-}"
WUX_REMOTE_DIAG_DIR="${WUX_REMOTE_DIAG_DIR:-}"

[ -n "$WUX_BIN" ] || die "WUX_BIN is required"
case "$WUX_BIN" in
  /*) ;;
  *) WUX_BIN="$PWD/$WUX_BIN" ;;
esac
[ -f "$WUX_BIN" ] || die "binary not found: $WUX_BIN"
[ -x "$WUX_BIN" ] || die "binary is not executable: $WUX_BIN"
[ -f "$compose_file" ] || die "compose file not found: $compose_file"

for command in docker ssh-keygen; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
docker compose version >/dev/null 2>&1 || die "docker compose is required"

own_root=0
if [ -n "${WUX_REMOTE_SMOKE_ROOT:-}" ]; then
  root="$WUX_REMOTE_SMOKE_ROOT"
  mkdir -p "$root"
else
  root="$(mktemp -d)"
  own_root=1
fi

run_name="$WUX_REMOTE_SMOKE_NAME"
if [ -z "$run_name" ]; then
  run_name="remote-smoke-$(date +%s)-$$"
fi
case "$run_name" in
  "." | ".." | *[!A-Za-z0-9._-]*) die "invalid run name: $run_name" ;;
esac

ssh_dir="$root/ssh"
output_dir="$root/output"
state_dir="$root/state"
work_dir="$root/work"
mkdir -p "$ssh_dir" "$output_dir" "$state_dir" "$work_dir"

client_key="$ssh_dir/id_ed25519"
authorized_keys="$ssh_dir/authorized_keys"
ssh_config="$ssh_dir/config"

ssh-keygen -q -t ed25519 -N "" -f "$client_key"

public_key="$(cat "$client_key.pub")"
printf 'command="XDG_STATE_HOME=/state; export XDG_STATE_HOME; PATH=/usr/local/bin:$PATH; export PATH; exec sh -c \\"$SSH_ORIGINAL_COMMAND\\"",no-agent-forwarding,no-X11-forwarding,no-port-forwarding %s\n' \
  "$public_key" > "$authorized_keys"
chmod 0600 "$authorized_keys"

cat > "$ssh_config" <<EOF
Host remote
  HostName remote
  User root
  IdentityFile /root/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
chmod 0600 "$ssh_config"

export COMPOSE_PROJECT_NAME="wux-e2e-$(date +%s)-$$"
export WUX_BIN
export WUX_E2E_SSH_DIR="$ssh_dir"
export WUX_E2E_OUTPUT_DIR="$output_dir"
export WUX_E2E_STATE_DIR="$state_dir"
export WUX_E2E_WORK_DIR="$work_dir"
export WUX_REMOTE_SMOKE_NAME="$run_name"

compose() {
  docker compose -f "$compose_file" "$@"
}

collect_diagnostics() {
  local status="$1"
  local diag_dir="$WUX_REMOTE_DIAG_DIR"
  if [ -z "$diag_dir" ]; then
    diag_dir="$root/diagnostics"
  fi
  mkdir -p "$diag_dir"

  {
    printf 'status=%s\n' "$status"
    printf 'run_name=%s\n' "$run_name"
    printf 'root=%s\n' "$root"
    printf 'state_dir=%s\n' "$state_dir"
    printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
    date -u
    uname -a
    file "$WUX_BIN" || true
    docker --version || true
    docker compose version || true
  } > "$diag_dir/environment.txt" 2>&1 || true

  compose ps > "$diag_dir/compose-ps.txt" 2>&1 || true
  compose logs --no-color > "$diag_dir/compose.log" 2>&1 || true
  cp -R "$output_dir" "$diag_dir/output" 2>/dev/null || true

  local run_dir="$state_dir/wux/runs/$run_name"
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

  compose down --volumes --remove-orphans >/dev/null 2>&1 || true

  if [ "$own_root" -eq 1 ] && [ "$status" -eq 0 ]; then
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT

note "wux remote smoke: building Compose SSH target"
compose build

note "wux remote smoke: starting $run_name through Compose SSH target"
compose run --rm controller

run_dir="$state_dir/wux/runs/$run_name"
[ -s "$run_dir/meta.json" ] || die "missing remote meta.json"
[ -s "$run_dir/pane.log" ] || die "missing remote pane.log"
[ -s "$run_dir/events.jsonl" ] || die "missing remote events.jsonl"
grep -Fq "$run_name" "$run_dir/meta.json" || die "remote meta.json has wrong run name"
grep -Eq '"backend"[[:space:]]*:[[:space:]]*"shell"' "$run_dir/meta.json" || die "remote meta.json has wrong backend"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"stopped"' "$run_dir/meta.json" || die "remote meta.json was not marked stopped"
grep -Fq "wux-remote-smoke-OK" "$run_dir/pane.log" || die "remote pane.log is missing smoke output"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"create"' "$run_dir/events.jsonl" || die "remote events.jsonl is missing create event"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"send"' "$run_dir/events.jsonl" || die "remote events.jsonl is missing send event"
grep -Eq '"type"[[:space:]]*:[[:space:]]*"stop"' "$run_dir/events.jsonl" || die "remote events.jsonl is missing stop event"

note "wux remote smoke: ok $run_name"
