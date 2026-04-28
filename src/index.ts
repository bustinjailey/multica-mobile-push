import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import webpush from 'web-push';

// ===================== Config =====================

interface Config {
  multicaUrl: string;        // e.g. https://multica.bustinjailey.org
  multicaWsUrl: string;      // wss://multica.bustinjailey.org/ws
  multicaPat: string;        // long-lived PAT for the relay's WS subscription
  workspaceSlug: string;     // e.g. snapview
  targetUserId: string;      // user_id whose events trigger pushes
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;      // mailto:bustinjailey@gmail.com
  listenPort: number;
  listenHost: string;        // bind address; default 127.0.0.1 for safety
  dataDir: string;           // where subs.json + vapid.json live
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
  return v;
}

const config: Config = (() => {
  const multicaUrl = process.env.MULTICA_URL || 'https://multica.bustinjailey.org';
  const dataDir = process.env.DATA_DIR || '/var/lib/multica-mobile-push';
  return {
    multicaUrl,
    multicaWsUrl: multicaUrl.replace(/^http/, 'ws') + '/ws',
    multicaPat: requireEnv('MULTICA_PAT'),
    workspaceSlug: requireEnv('WORKSPACE_SLUG'),
    targetUserId: requireEnv('TARGET_USER_ID'),
    vapidPublic: process.env.VAPID_PUBLIC || '',
    vapidPrivate: process.env.VAPID_PRIVATE || '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:bustinjailey@gmail.com',
    listenPort: Number(process.env.LISTEN_PORT || 7891),
    listenHost: process.env.LISTEN_HOST || '127.0.0.1',
    dataDir,
  };
})();

// ===================== VAPID + subscription store =====================

interface PushSub {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
  created_at: string;
}

const subsPath = () => path.join(config.dataDir, 'subs.json');
const vapidPath = () => path.join(config.dataDir, 'vapid.json');

async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function loadOrInitVapid() {
  if (config.vapidPublic && config.vapidPrivate) return;
  try {
    const raw = await fs.readFile(vapidPath(), 'utf8');
    const v = JSON.parse(raw);
    config.vapidPublic = v.publicKey;
    config.vapidPrivate = v.privateKey;
    return;
  } catch {}
  const k = webpush.generateVAPIDKeys();
  config.vapidPublic = k.publicKey;
  config.vapidPrivate = k.privateKey;
  await fs.writeFile(vapidPath(), JSON.stringify(k, null, 2), { mode: 0o600 });
  console.log('[push] generated new VAPID keys at', vapidPath());
}

let subs: PushSub[] = [];

async function loadSubs() {
  try {
    const raw = await fs.readFile(subsPath(), 'utf8');
    subs = JSON.parse(raw);
  } catch {
    subs = [];
  }
}

async function saveSubs() {
  const tmp = subsPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(subs, null, 2));
  await fs.rename(tmp, subsPath());
}

function subId(endpoint: string) {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

// ===================== Auth =====================

// Validate a bearer PAT by calling Multica's /api/me. Returns the user_id if
// the token is valid AND it belongs to the configured target user — anyone else
// trying to subscribe gets 403.
async function validatePAT(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await fetch(config.multicaUrl + '/api/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const me = await r.json() as { id?: string };
    return me.id || null;
  } catch {
    return null;
  }
}

// ===================== Push delivery =====================

interface NotificationPayload {
  title: string;
  body: string;
  tag?: string;            // dedupe key (browser collapses notifications with same tag)
  url?: string;            // path to open on click
  icon?: string;
}

async function fanout(payload: NotificationPayload) {
  if (!subs.length) return;
  console.log(`[push] -> ${subs.length} subs: ${payload.title} — ${payload.body}`);
  const dead: string[] = [];
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 * 7 }, // 7 days
      );
    } catch (e: any) {
      const code = e?.statusCode;
      // 404 = endpoint gone (uninstalled), 410 = unsubscribed. Drop them.
      if (code === 404 || code === 410) {
        dead.push(sub.id);
      } else {
        console.warn(`[push] send failed (sub=${sub.id}): ${code || e?.message}`);
      }
    }
  }));
  if (dead.length) {
    subs = subs.filter(s => !dead.includes(s.id));
    await saveSubs();
    console.log(`[push] dropped ${dead.length} dead subs`);
  }
}

// ===================== Trigger logic =====================

// Best-effort fetch of an issue to enrich the notification with its identifier
// + title. Cached briefly to avoid hammering the API on event bursts.
const issueCache = new Map<string, { ident: string; title: string; ts: number }>();
async function lookupIssue(id: string): Promise<{ ident: string; title: string } | null> {
  const cached = issueCache.get(id);
  if (cached && Date.now() - cached.ts < 30_000) return cached;
  try {
    const r = await fetch(config.multicaUrl + `/api/issues/${id}`, {
      headers: {
        'Authorization': `Bearer ${config.multicaPat}`,
        'X-Workspace-Slug': config.workspaceSlug,
      },
    });
    if (!r.ok) return null;
    const i = await r.json() as { identifier: string; title: string };
    const v = { ident: i.identifier, title: i.title, ts: Date.now() };
    issueCache.set(id, v);
    return v;
  } catch {
    return null;
  }
}

const issueUrl = (id: string) => `/m/#/issue/${id}`;

// Track previous assignee/status per issue so we can detect transitions on
// issue:updated (which carries the post-update issue, not a delta).
const lastSeen = new Map<string, { assignee_id?: string | null; status?: string }>();

interface MulticaEvent {
  type: string;
  payload: any;
}

async function handleEvent(ev: MulticaEvent) {
  const t = ev.type;
  const p = ev.payload || {};

  switch (t) {
    case 'inbox:new': {
      // recipient_type/recipient_id fields filter to relevant user.
      const item = p.item || p;
      if (item.recipient_type !== 'member' || item.recipient_id !== config.targetUserId) return;
      const issueId: string | undefined = item.issue_id;
      const enriched = issueId ? await lookupIssue(issueId) : null;
      const title = enriched ? `${enriched.ident}: ${enriched.title}` : (item.title || 'New inbox item');
      const body = item.body || item.title || (enriched ? '' : 'tap to view');
      await fanout({
        title: '📥 ' + title,
        body,
        tag: `inbox-${item.id}`,
        url: issueId ? issueUrl(issueId) : '/m/',
      });
      return;
    }
    case 'issue:updated': {
      const issue = p.issue || p;
      const id = issue.id;
      if (!id) return;
      const prev = lastSeen.get(id) || {};
      lastSeen.set(id, { assignee_id: issue.assignee_id, status: issue.status });

      // Assigned to me (newly)
      const justAssignedToMe =
        issue.assignee_type === 'member' &&
        issue.assignee_id === config.targetUserId &&
        prev.assignee_id !== config.targetUserId;
      if (justAssignedToMe) {
        await fanout({
          title: `👤 Assigned: ${issue.identifier || ''} ${issue.title || ''}`.trim(),
          body: 'You were just assigned this issue.',
          tag: `assign-${id}`,
          url: issueUrl(id),
        });
      }

      // Status transitioned to blocked
      const justBlocked = issue.status === 'blocked' && prev.status !== 'blocked';
      if (justBlocked) {
        await fanout({
          title: `🚫 Blocked: ${issue.identifier || ''} ${issue.title || ''}`.trim(),
          body: 'Status changed to blocked.',
          tag: `blocked-${id}`,
          url: issueUrl(id),
        });
      }
      return;
    }
    case 'issue:created': {
      const issue = p.issue || p;
      // Only notify if the new issue starts assigned to us.
      if (issue.assignee_type === 'member' && issue.assignee_id === config.targetUserId) {
        await fanout({
          title: `👤 Assigned: ${issue.identifier || ''} ${issue.title || ''}`.trim(),
          body: 'A new issue was filed and assigned to you.',
          tag: `assign-${issue.id}`,
          url: issueUrl(issue.id),
        });
      }
      // Seed the lastSeen map so the subsequent issue:updated can detect transitions.
      if (issue.id) lastSeen.set(issue.id, { assignee_id: issue.assignee_id, status: issue.status });
      return;
    }
    case 'comment:created': {
      // Inbox:new typically already fires for at-mentions, but cover the case
      // where the inbox path didn't (e.g. comment in a thread you're in but
      // not @-mentioned). Filter to mentions of the target user only.
      const c = p.comment || p;
      const content: string = c.content || '';
      const mentionPattern = `mention://member/${config.targetUserId}`;
      if (!content.includes(mentionPattern)) return;
      // Suppress if the author is the target user themselves (self-mentions).
      if (c.author_type === 'member' && c.author_id === config.targetUserId) return;
      const issueId: string | undefined = c.issue_id || p.issue_id;
      const enriched = issueId ? await lookupIssue(issueId) : null;
      const preview = content.replace(/\[([^\]]+)\]\(mention:\/\/[^)]+\)/g, '@$1').slice(0, 120);
      await fanout({
        title: `💬 Mentioned${enriched ? ' in ' + enriched.ident : ''}`,
        body: preview,
        tag: `mention-${c.id}`,
        url: issueId ? issueUrl(issueId) : '/m/',
      });
      return;
    }
  }
}

// ===================== WebSocket relay =====================

let wsRetryDelay = 1000;
function connectWS() {
  console.log(`[ws] connecting to ${config.multicaWsUrl}?workspace_slug=${config.workspaceSlug}`);
  const ws = new WebSocket(`${config.multicaWsUrl}?workspace_slug=${encodeURIComponent(config.workspaceSlug)}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', payload: { token: config.multicaPat } }));
    wsRetryDelay = 1000;
  });
  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.error) { console.warn('[ws] error:', msg.error); ws.close(); return; }
    if (msg.type === 'auth_ack') { console.log('[ws] authenticated'); return; }
    if (msg.type) handleEvent(msg).catch(e => console.warn('[handleEvent]', e));
  });
  ws.on('close', () => {
    console.log(`[ws] closed; reconnecting in ${wsRetryDelay}ms`);
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 30_000);
  });
  ws.on('error', (e) => console.warn('[ws] error:', (e as Error).message));
}

// ===================== HTTP server =====================

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: any) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(isText ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, subs: subs.length });
    }
    if (req.method === 'GET' && pathname === '/vapid-public-key') {
      return send(res, 200, config.vapidPublic);
    }
    if (req.method === 'POST' && pathname === '/subscribe') {
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const userId = await validatePAT(auth);
      if (!userId) return send(res, 401, { error: 'unauthorized' });
      if (userId !== config.targetUserId) return send(res, 403, { error: 'not the target user' });
      const body = await readBody(req);
      if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
        return send(res, 400, { error: 'invalid subscription' });
      }
      const id = subId(body.endpoint);
      // Replace any existing sub with the same endpoint hash.
      subs = subs.filter(s => s.id !== id);
      subs.push({
        id,
        endpoint: body.endpoint,
        keys: body.keys,
        user_agent: typeof body.user_agent === 'string' ? body.user_agent.slice(0, 200) : undefined,
        created_at: new Date().toISOString(),
      });
      await saveSubs();
      return send(res, 201, { id, total: subs.length });
    }
    if (req.method === 'DELETE' && pathname === '/subscribe') {
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const userId = await validatePAT(auth);
      if (!userId) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      if (!body?.endpoint) return send(res, 400, { error: 'endpoint required' });
      const id = subId(body.endpoint);
      const before = subs.length;
      subs = subs.filter(s => s.id !== id);
      if (subs.length !== before) await saveSubs();
      return send(res, 204, '');
    }
    if (req.method === 'POST' && pathname === '/test') {
      // Smoke test: send a fake notification to all subs. Bearer-PAT-gated.
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const userId = await validatePAT(auth);
      if (!userId || userId !== config.targetUserId) return send(res, 401, { error: 'unauthorized' });
      await fanout({
        title: '✅ Notifications working',
        body: 'This is a test push from multica-mobile-push.',
        tag: 'test',
        url: '/m/',
      });
      return send(res, 200, { ok: true, sent: subs.length });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.warn('[http]', e);
    return send(res, 500, { error: 'server error' });
  }
});

// ===================== Boot =====================

async function main() {
  await ensureDataDir();
  await loadOrInitVapid();
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
  await loadSubs();

  console.log(`[boot] target user_id: ${config.targetUserId}`);
  console.log(`[boot] vapid public key: ${config.vapidPublic}`);
  console.log(`[boot] subscriptions loaded: ${subs.length}`);

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[http] listening on ${config.listenHost}:${config.listenPort}`);
  });

  connectWS();
}

main().catch(e => { console.error(e); process.exit(1); });

process.on('SIGINT', () => { console.log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('shutting down'); process.exit(0); });
