#!/usr/bin/env bash
# Deploys one prism-chat release. Run as root on the server:
#   bash deploy-release.sh <release.tar.gz> [label]
# The tarball holds src/, public/, data/ and package.json. It is unpacked into a
# new /opt/prism-chat/releases/<utc-time>-<label>, `current` is swapped
# atomically, the service restarted, and /health must report the new release
# (and the public route must answer) or `current` goes back to the previous
# release. Old releases are pruned afterwards (prism-prune-releases).
set -euo pipefail
TARBALL=${1:?usage: deploy-release.sh <release.tar.gz> [label]}
LABEL=${2:-release}
APP=/opt/prism-chat
SITE=qiuzhang.xyz
NAME="$(date -u +%Y%m%d-%H%M%S)-$LABEL"
REL="$APP/releases/$NAME"
PREV=$(readlink -f "$APP/current")

# Keeps the watchdog from restarting things halfway through.
touch /run/prism-maintenance
trap 'rm -f /run/prism-maintenance' EXIT

install -d -m 0755 "$REL"
tar -xzf "$TARBALL" -C "$REL"
for f in src/server.js public/index.html data/modeltrace/unified_bank.json package.json; do
  [ -f "$REL/$f" ] || { echo "release is missing $f" >&2; rm -rf "$REL"; exit 1; }
done
chown -R root:root "$REL"
find "$REL" -type d -exec chmod 0755 {} +
find "$REL" -type f -exec chmod 0644 {} +

switch_to() {
  ln -sfn "$1" "$APP/current.new"
  mv -T "$APP/current.new" "$APP/current"
  systemctl restart prism-chat
}

healthy() {
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 http://127.0.0.1:4320/health 2>/dev/null | grep -q "\"release\":\"$1\""; then return 0; fi
    sleep 0.5
  done
  return 1
}

switch_to "$REL"
if ! healthy "$NAME" || ! curl -fsS --max-time 10 -o /dev/null --resolve "$SITE:443:127.0.0.1" "https://$SITE/chat/healthz"; then
  echo "new release failed its health check; rolling back to $(basename "$PREV")" >&2
  journalctl -u prism-chat -n 30 --no-pager >&2 || true
  switch_to "$PREV"
  exit 1
fi
echo "deployed $NAME (previous: $(basename "$PREV"))"
curl -fsS http://127.0.0.1:4320/health
echo
[ -x /usr/local/sbin/prism-prune-releases ] && /usr/local/sbin/prism-prune-releases "$APP" 2 || true
