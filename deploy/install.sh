#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo 'Usage: install.sh <linux-binary> <deploy-public-key>' >&2
  exit 64
fi
app=/opt/curio
binary=$(realpath "$1")
public_key=$(realpath "$2")
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -r /etc/server-maintenance-host && $(< /etc/server-maintenance-host) == nas ]] || { echo 'Curio installation targets NAS.' >&2; exit 1; }
exec 8>/run/lock/server-maintenance.lock
flock -s -n 8 || { echo 'A full backup or maintenance operation is running.' >&2; exit 75; }
exec 9>/run/lock/curio-deploy.lock
flock -n 9 || { echo 'Another Curio installation or release is running.' >&2; exit 75; }
[[ ! -e $app && ! -e /etc/systemd/system/curio.service && ! -e /etc/nginx/app-locations/curio.conf ]] || { echo 'Installation already exists.' >&2; exit 1; }
if id curio >/dev/null 2>&1 || id curio-deploy >/dev/null 2>&1; then echo 'Account already exists.' >&2; exit 1; fi
[[ -x /opt/serverportal/bin/portal && -f /opt/server-context/scripts/upgrade-state.py ]]
for tool in vips vipsheader exiftool ffmpeg ffprobe; do command -v "$tool" >/dev/null; done
ssh-keygen -l -f "$public_key" >/dev/null
[[ -z $(ss -H -ltn 'sport = :18088') ]] || { echo 'Port 18088 is in use.' >&2; exit 1; }
useradd --system --home-dir "$app" --shell /usr/sbin/nologin curio
install -d -m 0755 "$app" "$app/bin" "$app/config" "$app/releases"
install -d -m 0700 -o curio -g curio "$app/data"
install -m 0755 "$binary" "$app/bin/curio"
install -m 0644 "$scripts/nginx-location.conf" "$scripts/curio.service" "$app/config/"
runuser -u curio -- "$app/bin/curio" init --data "$app/data"
bash "$scripts/setup-deploy.sh" "$public_key"
systemctl link "$app/config/curio.service"
systemctl daemon-reload
systemctl enable --now curio.service
curl --fail --silent --retry 10 --retry-delay 1 --retry-connrefused http://127.0.0.1:18088/healthz
ln -s "$app/config/nginx-location.conf" /etc/nginx/app-locations/curio.conf
if ! nginx -t; then rm /etc/nginx/app-locations/curio.conf; echo 'Nginx validation failed; new link removed.' >&2; exit 1; fi
systemctl reload nginx
echo 'Curio installed on NAS. Publish its Portal declaration and synchronize documents next.'
