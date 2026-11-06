#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

if [[ $EUID -eq 0 && $# -eq 3 && ( $1 == portal || $1 == portal-check ) && $2 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9a-f]{64}$ ]]; then
  portal_action=register
  if [[ $1 == portal-check ]]; then portal_action=check-registration; fi
  exec timeout 45 /opt/serverportal/bin/portal "$portal_action" --app curio --commit "$2" --sha256 "$3"
fi

if [[ $EUID -ne 0 || $# -lt 2 || $# -gt 3 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then echo 'Usage: deploy-release.sh <commit> <sha256> < binary' >&2; exit 64; fi
commit=$1
expected=$2
plan_token=${3:-}
if [[ -n $plan_token && ( ! $plan_token =~ ^[A-Za-z0-9_-]+$ || ${#plan_token} -gt 4096 ) ]]; then
  echo 'Invalid database protection plan.' >&2; exit 64
fi
app=/opt/curio
upgrade=/opt/server-context/scripts/upgrade-state.py
[[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]] || { echo 'Curio releases target NAS.' >&2; exit 1; }
test -f "$upgrade"
exec 8>/run/lock/server-maintenance.lock
flock -s -n 8 || { printf 'A full backup or maintenance operation is running.\n' >&2; exit 75; }
exec 9>/run/lock/curio-deploy.lock
flock -n 9 || { echo 'Another Curio release is running.' >&2; exit 75; }
test -f "$app/data/curio.sqlite"
test -x "$app/bin/curio"
release=$(mktemp -d "$app/releases/$commit.XXXXXX")
chmod 0755 "$release"
stopped=false
replaced=false
healthy() {
  systemctl is-active --quiet curio &&
    curl --fail --silent --max-time 3 http://127.0.0.1:18088/healthz | grep -q '"status":"ok"' &&
    curl --fail --silent --max-time 3 http://127.0.0.1/curio/ | grep -q '/curio/assets/'
}
wait_healthy() { for ((attempt=0;attempt<20;attempt++)); do if healthy; then return 0; fi; sleep 1; done; return 1; }
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  recovery_status=not-needed
  if [[ $result -ne 0 && $stopped == true ]]; then
    recovery_status=failed
    systemctl stop curio || true
    if [[ $replaced == true ]]; then install -m 0755 "$release/previous" "$app/bin/curio.rollback"; mv -f "$app/bin/curio.rollback" "$app/bin/curio"; fi
    if systemctl start curio && wait_healthy; then recovery_status=healthy; echo 'Previous program is healthy; data was not rolled back.' >&2;
    else echo 'ROLLBACK FAILED: inspect journalctl -u curio.' >&2; fi
  fi
  printf '%s\n' "$recovery_status" > "$release/recovery"
  if [[ $result -eq 0 ]]; then echo success > "$release/result"; else echo failed > "$release/result"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
timeout 90 head -c 67108865 > "$release/curio"
size=$(stat -c %s "$release/curio")
if ((size==0||size>67108864)); then echo 'Binary size must be 1 byte to 64 MiB.' >&2; exit 65; fi
actual=$(sha256sum "$release/curio")
if [[ ${actual%% *} != "$expected" ]]; then echo 'Checksum mismatch.' >&2; exit 65; fi
chmod 0755 "$release/curio"
cp "$app/bin/curio" "$release/previous"
chmod 0755 "$release/previous"
printf 'commit=%s\nsha256=%s\n' "$commit" "$expected" > "$release/metadata"
stopped=true
systemctl stop curio
candidate_data=$(python3 "$upgrade" begin --app curio --release "$(basename "$release")" --plan-token "$plan_token")
backup="/var/lib/server-upgrades/curio/$(basename "$release")"
runuser -u curio -- timeout 60 "$release/curio" check --data "$candidate_data"
install -m 0755 "$release/curio" "$app/bin/curio.next"
replaced=true
mv -f "$app/bin/curio.next" "$app/bin/curio"
systemctl start curio
wait_healthy
if [[ -d $backup ]]; then
  systemctl stop curio
  python3 "$upgrade" verify --app curio --release "$(basename "$release")"
  systemctl start curio
  wait_healthy
fi
printf '%s\n' "$commit" > "$app/current-commit"
chmod 0644 "$app/current-commit"
python3 "$upgrade" accept --app curio --release "$(basename "$release")"
printf 'Deployed Curio %s.\n' "$commit"
