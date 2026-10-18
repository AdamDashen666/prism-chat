#!/usr/bin/env bash
# Installs/updates the PRISM chat sidecar. Run as root from the unpacked upload dir.
# Backs up everything it touches under /var/backups/prism-vault/chat-<ts>-before.
set -euo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
TS=$(date -u +%Y%m%d-%H%M%S)
BACKUP=/var/backups/prism-vault/chat-$TS-before
CADDY=/opt/prism-vault/current/proxy/caddy
CADDYFILE=/etc/prism-vault/Caddyfile
WWW=/opt/prism-vault/current/web/wwwroot
NODE=/opt/streak-runtime/node/bin/node

install -d -m 0700 "$BACKUP"
cp -a "$CADDYFILE" "$BACKUP/"
cp -a "$WWW"/index.html* "$BACKUP/"
[ -f /etc/systemd/system/prism-chat.service ] && cp -a /etc/systemd/system/prism-chat.service "$BACKUP/"
echo "backup: $BACKUP"

# 1. user + release
id prism-chat >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin prism-chat
REL=/opt/prism-chat/releases/$TS
install -d -m 0755 /opt/prism-chat /opt/prism-chat/releases "$REL"
cp -r "$SRC/src" "$SRC/public" "$SRC/data" "$SRC/package.json" "$REL/"
chown -R root:root "$REL"; find "$REL" -type d -exec chmod 0755 {} +; find "$REL" -type f -exec chmod 0644 {} +
PREV=$(readlink -f /opt/prism-chat/current 2>/dev/null || true)
ln -sfn "$REL" /opt/prism-chat/current.new && mv -T /opt/prism-chat/current.new /opt/prism-chat/current

# 2. service
install -m 0644 "$SRC/deploy/prism-chat.service" /etc/systemd/system/prism-chat.service
systemctl daemon-reload
systemctl enable prism-chat.service >/dev/null
systemctl restart prism-chat.service
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:4320/health >/dev/null 2>&1 && break; sleep 0.5; done
if ! curl -fsS http://127.0.0.1:4320/health; then
  echo "chat service failed health check" >&2
  journalctl -u prism-chat -n 30 --no-pager >&2
  [ -n "$PREV" ] && ln -sfn "$PREV" /opt/prism-chat/current && systemctl restart prism-chat
  exit 1
fi
echo

# 3. Caddy route (idempotent)
if ! grep -q '@chat ' "$CADDYFILE"; then
  NEW=$(mktemp)
  awk '
    /@streaks path/ && !done {
      print "\t@chat path /chat /chat/* /api/chat/* /chat-nav.js"
      print "\thandle @chat {"
      print "\t\treverse_proxy 127.0.0.1:4320 {"
      print "\t\t\tflush_interval -1"
      print "\t\t}"
      print "\t}"
      done=1
    }
    { print }' "$CADDYFILE" > "$NEW"
  grep -q '@chat ' "$NEW" || { echo "failed to insert chat route" >&2; exit 1; }
  VT=$(mktemp -d)
  if ! HOME=$VT XDG_DATA_HOME=$VT XDG_CONFIG_HOME=$VT "$CADDY" validate --config "$NEW" --adapter caddyfile >/dev/null 2>"$VT/err"; then
    cat "$VT/err" >&2; rm -rf "$VT" "$NEW"; exit 1
  fi
  rm -rf "$VT"
  install -m "$(stat -c %a "$CADDYFILE")" -o "$(stat -c %u "$CADDYFILE")" -g "$(stat -c %g "$CADDYFILE")" "$NEW" "$CADDYFILE"
  rm -f "$NEW"
  systemctl restart prism-vault-proxy.service
  sleep 2
  if ! systemctl is-active --quiet prism-vault-proxy.service; then
    echo "proxy failed; restoring Caddyfile" >&2
    cp -a "$BACKUP/Caddyfile" "$CADDYFILE"; systemctl restart prism-vault-proxy.service; exit 1
  fi
  echo "caddy route added"
else
  echo "caddy route already present"
fi

# 4. nav link in the main SPA shell (idempotent)
if ! grep -q 'chat-nav.js' "$WWW/index.html"; then
  sed -i 's#</head>#<script defer src="/chat-nav.js"></script></head>#' "$WWW/index.html"
  grep -q 'chat-nav.js' "$WWW/index.html" || { echo "failed to patch index.html" >&2; exit 1; }
  gzip -9 -c "$WWW/index.html" > "$WWW/index.html.gz"
  "$NODE" -e 'const z=require("zlib"),f=require("fs");f.writeFileSync(process.argv[2],z.brotliCompressSync(f.readFileSync(process.argv[1]),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}))' "$WWW/index.html" "$WWW/index.html.br"
  chmod 0644 "$WWW"/index.html*
  echo "nav link added"
else
  echo "nav link already present"
fi

systemctl is-active prism-vault.service prism-vault-proxy.service prism-chat.service
echo "release: $REL"
