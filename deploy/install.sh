#!/bin/bash
# Install / update multica-mobile-push on LXC 122. Idempotent.
# Run this from /opt/multica-mobile-push as root after `git pull`.
#
# First run also generates VAPID keys (under /var/lib/multica-mobile-push/) and
# warns if /etc/multica-mobile-push/env hasn't been seeded with MULTICA_PAT etc.
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
# multica-mobile-push environment. Seed MULTICA_PAT + TARGET_USER_ID before
# starting the service for the first time.
MULTICA_URL=https://multica.bustinjailey.org
WORKSPACE_SLUG=snapview
MULTICA_PAT=
TARGET_USER_ID=
VAPID_SUBJECT=mailto:bustinjailey@gmail.com
LISTEN_PORT=7891
DATA_DIR=/var/lib/multica-mobile-push
EOF
    chmod 600 "$ENV_DIR/env"
    chown root:"$SERVICE_USER" "$ENV_DIR/env"
    echo "[install] WROTE TEMPLATE: $ENV_DIR/env — fill MULTICA_PAT and TARGET_USER_ID before starting"
fi

cp deploy/multica-mobile-push.service /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

if grep -q "^MULTICA_PAT=$" "$ENV_DIR/env" 2>/dev/null || grep -q "^TARGET_USER_ID=$" "$ENV_DIR/env" 2>/dev/null; then
    echo "[install] env not fully configured — NOT starting. Edit $ENV_DIR/env and run: systemctl start $SERVICE_NAME"
else
    systemctl restart "$SERVICE_NAME"
    sleep 1
    systemctl --no-pager --lines=20 status "$SERVICE_NAME" || true
fi
