#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/marsel/private app/reed-cloud-sec}"
PUBLIC_DIR="${PUBLIC_DIR:-/home/marsel/public_html}"
SERVICE_NAME="${SERVICE_NAME:-reed-cloud-sec}"

cd "$APP_DIR"

mkdir -p "$PUBLIC_DIR/assets"

install -m 0644 index.html "$PUBLIC_DIR/index.html"
install -m 0644 styles.css "$PUBLIC_DIR/styles.css"
rsync -a --delete assets/ "$PUBLIC_DIR/assets/"

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "$SERVICE_NAME"
    systemctl --no-pager --full status "$SERVICE_NAME"
  else
    sudo -n systemctl restart "$SERVICE_NAME"
    sudo -n systemctl --no-pager --full status "$SERVICE_NAME"
  fi
fi

curl -fsS -I https://reedcloudsec.com/index.html >/dev/null

for attempt in {1..10}; do
  inquiry_code="$(curl -sS -o /dev/null -w "%{http_code}" https://reedcloudsec.com/api/inquiry || true)"
  if [[ "$inquiry_code" == "302" ]]; then
    echo "Inquiry route HTTP $inquiry_code"
    exit 0
  fi
  echo "Waiting for inquiry route, got HTTP $inquiry_code"
  sleep 2
done

echo "Inquiry route did not become healthy after restart." >&2
exit 1
