#!/bin/bash
# Install / update multica-mobile-push. Idempotent.
# Run this from $INSTALL_DIR as root after `git pull`.
#
# First run also generates VAPID keys (under /var/lib/multica-mobile-push/) and
# warns if /etc/multica-mobile-push/env hasn't been seeded with required values.
set -euo pipefail

INSTALL_DIR="/opt/multica-mobile-push"
DATA_DIR="/var/lib/multica-mobile-push"
ENV_DIR="/etc/multica-mobile-push"
SERVICE_NAME="multica-mobile-push"
SERVICE_USER="multica"

cd "$INSTALL_DIR"

echo "[install] pnpm install"
pnpm install --prod=false --frozen-lockfile

echo "[install] pnpm build"
pnpm build

mkdir -p "$DATA_DIR" "$ENV_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_DIR/env" ]; then
    cat > "$ENV_DIR/env" <<EOF
# multica-mobile-push environment. Fill in all of MULTICA_URL, WORKSPACE_SLUG,
# MULTICA_PAT, TARGET_USER_ID and VAPID_SUBJECT before starting the service for
# the first time.
MULTICA_URL=
WORKSPACE_SLUG=
MULTICA_PAT=
TARGET_USER_ID=
# RFC 8292 requires a contact for VAPID. Use a mailto: URL you control.
VAPID_SUBJECT=
LISTEN_PORT=7891
# Default to localhost-only. If the reverse proxy lives on a different host,
# bind to a LAN interface (or 0.0.0.0) — the relay still requires a valid
# Multica PAT on every write endpoint, but do not expose this port to the
# public internet.
LISTEN_HOST=127.0.0.1
DATA_DIR=/var/lib/multica-mobile-push
EOF
    chmod 600 "$ENV_DIR/env"
    chown root:"$SERVICE_USER" "$ENV_DIR/env"
    echo "[install] WROTE TEMPLATE: $ENV_DIR/env — fill required values before starting"
fi

cp deploy/multica-mobile-push.service /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

if grep -q "^MULTICA_URL=$" "$ENV_DIR/env" 2>/dev/null \
    || grep -q "^WORKSPACE_SLUG=$" "$ENV_DIR/env" 2>/dev/null \
    || grep -q "^MULTICA_PAT=$" "$ENV_DIR/env" 2>/dev/null \
    || grep -q "^TARGET_USER_ID=$" "$ENV_DIR/env" 2>/dev/null \
    || grep -q "^VAPID_SUBJECT=$" "$ENV_DIR/env" 2>/dev/null; then
    echo "[install] env not fully configured — NOT starting. Edit $ENV_DIR/env and run: systemctl start $SERVICE_NAME"
else
    systemctl restart "$SERVICE_NAME"
    sleep 1
    systemctl --no-pager --lines=20 status "$SERVICE_NAME" || true
fi
