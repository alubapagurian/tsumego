/**
 * 詰棋練習 API（Cloudflare Pages Functions + D1）
 *
 *   GET  /api/health   檢查連線與登入狀態
 *   GET  /api/deck     取得整個題庫（含已刪除的標記）
 *   POST /api/sync     上傳本機的變更，回傳伺服器上最新的整個題庫
 *        body: { problems: [ {id, updatedAt, ...} ], deletes: [ {id, deletedAt} ] }
 *
 * 需要的設定（Pages 專案 → Settings）：
 *   Bindings：D1 database，名稱 DB
 *   Variables：CF_ACCESS_TEAM_DOMAIN（例：https://myteam.cloudflareaccess.com）
 *              CF_ACCESS_AUD（Access 應用程式的 Application Audience (AUD) Tag）
 *   測試用（不建議）：ALLOW_PUBLIC = true 可跳過登入檢查
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS problems (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
)`;
const MAX_ITEMS = 200;          // 每次同步最多幾筆（前端會分批）
const MAX_DATA = 200 * 1024;    // 單題資料上限

export async function onRequest({ request, env, params }) {
  try {
    const path = (params.path || []).join('/');
    const user = await authenticate(request, env);
    if (!user.ok) return json({ error: user.error, message: user.message }, 401);
    if (!env.DB) return json({ error: 'no_db', message: '尚未在 Pages 設定中綁定名稱為 DB 的 D1 資料庫' }, 500);
    await ensureSchema(env.DB);

    if (path === 'health' && request.method === 'GET') return json({ ok: true, user: user.email });
    if (path === 'deck' && request.method === 'GET') return json({ problems: await readDeck(env.DB) });
    if (path === 'sync' && request.method === 'POST') return json(await sync(env.DB, await request.json()));
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    return json({ error: 'server_error', message: String(err && err.message || err) }, 500);
  }
}

/* ---------------- 資料存取 ---------------- */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}

async function readDeck(db) {
  const { results } = await db.prepare('SELECT id, data, updated_at, deleted FROM problems').all();
  return results.map(r => ({
    id: r.id,
    updatedAt: r.updated_at,
    deleted: !!r.deleted,
    data: r.deleted ? null : safeParse(r.data),
  })).filter(r => r.deleted || r.data);
}

async function sync(db, body) {
  const problems = Array.isArray(body?.problems) ? body.problems : [];
  const deletes = Array.isArray(body?.deletes) ? body.deletes : [];
  if (problems.length + deletes.length > MAX_ITEMS) throw new Error(`一次最多同步 ${MAX_ITEMS} 筆`);

  // 只有比伺服器上新（或一樣新）的資料才會寫入
  const upsert = `INSERT INTO problems (id, data, updated_at, deleted) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
    WHERE excluded.updated_at >= problems.updated_at`;
  const stmts = [];
  for (const p of problems) {
    const id = cleanId(p?.id), ts = cleanTs(p?.updatedAt);
    if (!id || !ts) continue;
    const data = JSON.stringify(p);
    if (data.length > MAX_DATA) continue;
    stmts.push(db.prepare(upsert).bind(id, data, ts, 0));
  }
  for (const d of deletes) {
    const id = cleanId(d?.id), ts = cleanTs(d?.deletedAt);
    if (!id || !ts) continue;
    stmts.push(db.prepare(upsert).bind(id, '', ts, 1));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, applied: stmts.length, problems: await readDeck(db) };
}

const cleanId = v => (typeof v === 'string' && v.length > 0 && v.length <= 120 ? v : null);
const cleanTs = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ---------------- 登入檢查（Cloudflare Access JWT） ---------------- */
let certCache = { url: '', keys: [], at: 0 };

async function authenticate(request, env) {
  const team = (env.CF_ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  const aud = env.CF_ACCESS_AUD || '';
  if (!team || !aud) {
    if (String(env.ALLOW_PUBLIC).toLowerCase() === 'true') return { ok: true, email: null };
    return { ok: false, error: 'not_configured', message: '伺服器尚未設定 Cloudflare Access（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD）' };
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request, 'CF_Authorization');
  if (!token) return { ok: false, error: 'login_required', message: '請先登入' };

  try {
    const [h64, p64, s64] = token.split('.');
    const header = JSON.parse(b64urlText(h64));
    const payload = JSON.parse(b64urlText(p64));
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error('aud');
    if (payload.iss !== team) throw new Error('iss');
    if (!payload.exp || payload.exp < now) throw new Error('exp');

    const keys = await getCerts(team);
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) throw new Error('kid');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
    if (!valid) throw new Error('sig');
    return { ok: true, email: payload.email || null };
  } catch (e) {
    return { ok: false, error: 'login_required', message: '登入已失效，請重新整理頁面登入' };
  }
}

async function getCerts(team) {
  const url = `${team}/cdn-cgi/access/certs`;
  if (certCache.url === url && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error('certs');
  const { keys } = await res.json();
  certCache = { url, keys: keys || [], at: Date.now() };
  return certCache.keys;
}
function readCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const b64urlText = s => new TextDecoder().decode(b64urlBytes(s));

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
