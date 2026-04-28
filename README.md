# multica-mobile-push

Web Push relay for the [multica-mobile](https://github.com/bustinjailey/multica-mobile) PWA. Subscribes to a Multica workspace's WebSocket using a long-lived Personal Access Token, watches for events that target a specific user, and fans out Web Push notifications to all registered devices.

Designed for self-hosted single-user setups where modifying the upstream Multica server isn't desired.

## Notification triggers (V1)

| Event | When fired | Notification |
|---|---|---|
| `inbox:new` (recipient = target user) | New inbox item arrives | 📥 `{issue.identifier}: {issue.title}` |
| `issue:updated` → assignee = target user (newly) | Reassigned to you | 👤 `Assigned: …` |
| `issue:created` assigned to target user | New issue filed and assigned to you | 👤 `Assigned: …` |
| `issue:updated` → status = `blocked` (newly) | Status transitions to blocked | 🚫 `Blocked: …` |
| `comment:created` mentioning the target user | `[@name](mention://member/<your-user-id>)` in a comment | 💬 `Mentioned in {ident}` |

Inbox notifications cover most "something needs my attention" cases — Multica creates an inbox item for assignments, mentions, etc. The other triggers are belt-and-suspenders for cases the inbox path doesn't catch (e.g., status transitioning to blocked without an inbox row).

## Architecture

```
┌─────────────────┐  ws  ┌──────────────────────┐  push  ┌─────────────┐
│ Multica server  │─────>│ multica-mobile-push  │───────>│ Phone (PWA) │
│ (LXC 122)       │      │  (LXC 122 alongside) │        │             │
└─────────────────┘      │ - holds WS 24/7      │        └─────────────┘
                         │ - stores subs in JSON│              ▲
                         │ - sends Web Push     │              │
                         │ - HTTP API on :7891  │ POST /subscribe
                         └──────────────────────┘<─────────────┘
                                  ▲
                                  │
                               Caddy (LXC 102)
                            multica.bustinjailey.org/m/push/*
```

## HTTP API

All write endpoints require `Authorization: Bearer <multica-pat>` and the PAT must belong to the configured `TARGET_USER_ID`.

| Method | Path | Description |
|---|---|---|
| `GET`    | `/vapid-public-key` | Returns the VAPID public key as text/plain. Public — needed by the PWA before subscribing. |
| `POST`   | `/subscribe`        | Body: `{endpoint, keys: {p256dh, auth}, user_agent?}`. Stores or replaces the subscription. |
| `DELETE` | `/subscribe`        | Body: `{endpoint}`. Removes a subscription. |
| `POST`   | `/test`             | Sends a test notification to all subscriptions. |
| `GET`    | `/health`           | Returns `{ok: true, subs: N}`. |

Behind Caddy, all routes are at `https://multica.bustinjailey.org/m/push/*`.

## Install (LXC 122)

```sh
# As root on LXC 122:
git clone https://github.com/bustinjailey/multica-mobile-push /opt/multica-mobile-push
cd /opt/multica-mobile-push
bash deploy/install.sh

# Edit /etc/multica-mobile-push/env to set MULTICA_PAT and TARGET_USER_ID
# (mint a dedicated PAT for this service so it can be rotated independently).
systemctl start multica-mobile-push
journalctl -u multica-mobile-push -f
```

The first start will generate a VAPID keypair under `/var/lib/multica-mobile-push/vapid.json` if one isn't already provided in env. Subscription storage lives at `/var/lib/multica-mobile-push/subs.json`.

## Update

```sh
cd /opt/multica-mobile-push
git pull
bash deploy/install.sh
```

## Caddy

The relay listens on `127.0.0.1:7891` only (no public binding). Add the corresponding reverse_proxy block to the existing `multica.bustinjailey.org { … }` block in `bustinlab-infra/caddy/Caddyfile`:

```caddy
handle_path /m/push/* {
    reverse_proxy 192.168.1.179:7891
}
```

Must come before the static `handle_path /m/* { ... }` block so it matches first.

## VAPID key rotation

Push subscriptions are bound to the VAPID public key the browser saw at subscription time. Rotating the keys invalidates every existing subscription. To rotate:

```sh
# Generate fresh keys
node -e 'const w=require("web-push");const k=w.generateVAPIDKeys();console.log(JSON.stringify(k))' \
  > /var/lib/multica-mobile-push/vapid.json
chmod 600 /var/lib/multica-mobile-push/vapid.json
chown multica:multica /var/lib/multica-mobile-push/vapid.json

# Drop existing subscriptions (they're tied to the old key)
echo '[]' > /var/lib/multica-mobile-push/subs.json
chown multica:multica /var/lib/multica-mobile-push/subs.json

systemctl restart multica-mobile-push
```

Then re-enable notifications in the PWA on each device.

## Limitations / TODO

- Single-user (`TARGET_USER_ID`). Generalize to multi-user by validating the PAT and using `userId` from `/api/me` as the per-sub recipient filter.
- Subscription store is a single JSON file. Fine for ≤100 devices; switch to SQLite if it grows.
- No backpressure on the WS — if Multica floods events the relay processes them sequentially. Add a bounded queue if it becomes a problem.
- Inbox payload shape is best-guess based on `EventInboxNew` publish callsites; verify and adjust if a real `inbox:new` event lands with different field names.
