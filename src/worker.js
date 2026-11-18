/**
 * 詰棋練習 Worker（Cloudflare Workers + 靜態網頁 + D1）
 *
 * 網頁檔案放在 public/，由 Workers Static Assets 直接提供；
 * 只有 /api/* 會進到這支程式（見 wrangler.jsonc 的 run_worker_first）。
 *
 * 帳號：
 *   - 管理者：名稱「管理者」（或 admin），密碼是 Cloudflare Secret SYNC_PASSWORD。可以新增、編輯題目與管理帳號。
 *   - 使用者：由管理者在 App 裡建立（最多 MAX_USERS 個），密碼以 PBKDF2 雜湊後存在 D1。只能練習，紀錄各自分開。
 *   登入後取得 token，之後以 Authorization: Bearer <token> 呼叫其他 API。
 *
 *   POST /api/login {name, password}      → { token, user }
 *   POST /api/logout
 *   GET  /api/me                          → { user }
 *   GET  /api/deck?since=T                → 題目（所有人可讀）
 *   POST /api/sync {problems, deletes, since}   → 上傳題目變更（只有管理者）
 *   GET  /api/progress?since=T[&user=ID]  → 作答紀錄（自己的；管理者可看別人的）
 *   POST /api/progress {items:[{problemId, updatedAt, data}], since}   → 上傳自己的作答紀錄
 *   GET  /api/users                       → 帳號清單與成績摘要（管理者）
 *   POST /api/users {action, ...}         → create / update / delete（管理者）
 *
 * 需要的設定：
 *   wrangler.jsonc：D1 資料庫綁定（名稱 DB）
 *   Worker → Settings → Variables and Secrets：SYNC_PASSWORD（Secret，至少 12 個字元）＝管理者密碼
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, server_ts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL, problem_id TEXT NOT NULL, data TEXT NOT NULL,
    updated_at INTEGER NOT NULL, server_ts INTEGER NOT NULL, PRIMARY KEY (user_id, problem_id))`,
  `CREATE TABLE IF NOT EXISTS login_fails (name TEXT PRIMARY KEY, fails INTEGER NOT NULL, lock_until INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_problems_server_ts ON problems(server_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_user_ts ON progress(user_id, server_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];
const ADMIN_ID = 0;
const ADMIN_NAMES = ['管理者', 'admin'];
const MAX_USERS = 10;
const MAX_ITEMS = 200;              // 每次同步最多幾筆（前端會分批）
const MAX_DATA = 200 * 1024;        // 單筆資料上限
const SESSION_DAYS = 365;           // 一人一台裝置：登入一次可用一年
const PBKDF2_ITER = 100000;
const PROGRESS_FIELDS = ['level', 'streak', 'penalty', 'history'];   // 舊版存在題目裡的個人紀錄（已改存 progress 表）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url, url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, ''));
    }
    return env.ASSETS.fetch(request);
  },
};

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}

async function handleApi(request, env, url, path) {
  try {
    if (!env.DB) throw new HttpError(500, 'no_db', '尚未綁定名稱為 DB 的 D1 資料庫（請檢查 wrangler.jsonc 的 database_id）');
    const secret = env.SYNC_PASSWORD || '';
    if (secret.length < 12) throw new HttpError(401, 'not_configured', '伺服器尚未設定管理者密碼（SYNC_PASSWORD，至少 12 個字元）');
    await ensureSchema(env.DB);
    const db = env.DB, method = request.method;

    if (path === 'login' && method === 'POST') return json(await login(db, secret, await body(request)));

    const user = await authenticate(request, db, secret);
    const admin = user.role === 'admin';
    const q = url.searchParams;

    if (path === 'health' && method === 'GET') return json({ ok: true });
    if (path === 'me' && method === 'GET') return json({ user });
    if (path === 'logout' && method === 'POST') {
      if (user.tokenHash) await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(user.tokenHash).run();
      return json({ ok: true });
    }
    if (path === 'deck' && method === 'GET') {
      const now = Date.now();
      return json({ problems: await readDeck(db, Number(q.get('since')) || 0), now });
    }
    if (path === 'sync' && method === 'POST') {
      const b = await body(request);
      const writes = (b?.problems?.length || 0) + (b?.deletes?.length || 0);
      if (writes && !admin) throw new HttpError(403, 'forbidden', '只有管理者可以修改題目');
      return json(await syncDeck(db, b));
    }
    if (path === 'progress' && method === 'GET') {
      let uid = user.id;
      if (q.has('user')) {
        uid = Number(q.get('user'));
        if (uid !== user.id && !admin) throw new HttpError(403, 'forbidden', '只能查看自己的紀錄');
      }
      const now = Date.now();
      return json({ items: await readProgress(db, uid, Number(q.get('since')) || 0), now });
    }
    if (path === 'progress' && method === 'POST') return json(await syncProgress(db, user.id, await body(request)));
    if (path === 'users') {
      if (!admin) throw new HttpError(403, 'forbidden', '只有管理者可以管理帳號');
      if (method === 'GET') return json({ users: await listUsers(db), max: MAX_USERS });
      if (method === 'POST') return json(await manageUser(db, await body(request)));
    }
    throw new HttpError(404, 'not_found', '找不到這個 API');
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.error, message: err.message }, err.status);
    return json({ error: 'server_error', message: String(err && err.message || err) }, 500);
  }
}
async function body(request) {
  try { return await request.json(); } catch (e) { throw new HttpError(400, 'bad_json', '資料格式錯誤'); }
}

/* ---------------- 資料表 ---------------- */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const s of SCHEMA.slice(0, 5)) await db.prepare(s).run();
  // 舊版資料表沒有 server_ts 欄位：補上（已存在時會出錯，忽略即可）
  try { await db.prepare('ALTER TABLE problems ADD COLUMN server_ts INTEGER NOT NULL DEFAULT 0').run(); } catch (e) {}
  for (const s of SCHEMA.slice(5)) await db.prepare(s).run();
  schemaReady = true;
}

/* ---------------- 題目 ---------------- */
async function readDeck(db, since = 0) {
  const { results } = await db.prepare('SELECT id, data, updated_at, deleted FROM problems WHERE server_ts >= ?1').bind(since).all();
  return results.map(r => ({
    id: r.id,
    updatedAt: r.updated_at,
    deleted: !!r.deleted,
    data: r.deleted ? null : stripProgress(safeParse(r.data)),
  })).filter(r => r.deleted || r.data);
}
function stripProgress(p) {
  if (!p || typeof p !== 'object') return p;
  for (const k of PROGRESS_FIELDS) delete p[k];
  return p;
}

async function syncDeck(db, b) {
  const problems = Array.isArray(b?.problems) ? b.problems : [];
  const deletes = Array.isArray(b?.deletes) ? b.deletes : [];
  if (problems.length + deletes.length > MAX_ITEMS) throw new HttpError(400, 'too_many', `一次最多同步 ${MAX_ITEMS} 筆`);
  // 只有比伺服器上新（或一樣新）的資料才會寫入
  const now = Date.now();
  const upsert = `INSERT INTO problems (id, data, updated_at, deleted, server_ts) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, server_ts = excluded.server_ts
    WHERE excluded.updated_at >= problems.updated_at`;
  const stmts = [];
  for (const p of problems) {
    const id = cleanId(p?.id), ts = cleanTs(p?.updatedAt);
    if (!id || !ts) continue;
    const data = JSON.stringify(stripProgress({ ...p }));
    if (data.length > MAX_DATA) continue;
    stmts.push(db.prepare(upsert).bind(id, data, ts, 0, now));
  }
  for (const d of deletes) {
    const id = cleanId(d?.id), ts = cleanTs(d?.deletedAt);
    if (!id || !ts) continue;
    stmts.push(db.prepare(upsert).bind(id, '', ts, 1, now));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, applied: stmts.length, problems: await readDeck(db, Number(b?.since) || 0), now };
}

/* ---------------- 作答紀錄（每人每題一筆） ---------------- */
async function readProgress(db, uid, since = 0) {
  const { results } = await db.prepare('SELECT problem_id, data, updated_at FROM progress WHERE user_id = ?1 AND server_ts >= ?2')
    .bind(uid, since).all();
  // data 直接以字串回傳，由前端解析（省下 Worker 的 CPU 時間）
  return results.map(r => ({ problemId: r.problem_id, updatedAt: r.updated_at, data: r.data }));
}
async function syncProgress(db, uid, b) {
  const items = Array.isArray(b?.items) ? b.items : [];
  if (items.length > MAX_ITEMS) throw new HttpError(400, 'too_many', `一次最多同步 ${MAX_ITEMS} 筆`);
  const now = Date.now();
  const upsert = `INSERT INTO progress (user_id, problem_id, data, updated_at, server_ts) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(user_id, problem_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, server_ts = excluded.server_ts
    WHERE excluded.updated_at >= progress.updated_at`;
  const stmts = [];
  for (const it of items) {
    const id = cleanId(it?.problemId), ts = cleanTs(it?.updatedAt);
    if (!id || !ts || !it.data || typeof it.data !== 'object') continue;
    const data = JSON.stringify(it.data);
    if (data.length > MAX_DATA) continue;
    stmts.push(db.prepare(upsert).bind(uid, id, data, ts, now));
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, applied: stmts.length, items: await readProgress(db, uid, Number(b?.since) || 0), now };
}

/* ---------------- 帳號管理 ---------------- */
async function listUsers(db) {
  const { results: users } = await db.prepare('SELECT id, name, disabled, created_at FROM users ORDER BY id').all();
  // 成績摘要直接在資料庫算（data 裡的 n＝作答次數、ok＝答對次數、ms＝總用時、last＝最後作答時間）
  const { results: sums } = await db.prepare(`SELECT user_id, COUNT(*) AS problems,
      SUM(json_extract(data, '$.n')) AS n, SUM(json_extract(data, '$.ok')) AS ok,
      SUM(json_extract(data, '$.ms')) AS ms, MAX(json_extract(data, '$.last')) AS last,
      SUM(CASE WHEN json_extract(data, '$.level') >= 4 THEN 1 ELSE 0 END) AS mastered
    FROM progress GROUP BY user_id`).all();
  const by = new Map(sums.map(s => [s.user_id, s]));
  const summary = id => {
    const s = by.get(id) || {};
    return { problems: s.problems || 0, attempts: s.n || 0, correct: s.ok || 0, totalMs: s.ms || 0, last: s.last || 0, mastered: s.mastered || 0 };
  };
  return [
    { id: ADMIN_ID, name: ADMIN_NAMES[0], role: 'admin', disabled: false, ...summary(ADMIN_ID) },
    ...users.map(u => ({ id: u.id, name: u.name, role: 'user', disabled: !!u.disabled, createdAt: u.created_at, ...summary(u.id) })),
  ];
}
async function manageUser(db, b) {
  const action = b?.action;
  if (action === 'create') {
    const name = cleanName(b.name), pw = cleanPw(b.password);
    const { results } = await db.prepare('SELECT COUNT(*) AS c FROM users').all();
    if (results[0].c >= MAX_USERS) throw new HttpError(400, 'limit', `最多只能建立 ${MAX_USERS} 個使用者帳號`);
    await assertNameFree(db, name);
    const { salt, hash } = await hashPassword(pw);
    await db.prepare('INSERT INTO users (name, salt, hash, disabled, created_at) VALUES (?1, ?2, ?3, 0, ?4)').bind(name, salt, hash, Date.now()).run();
    return { ok: true, users: await listUsers(db) };
  }
  const id = Number(b?.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_id', '管理者帳號不能在這裡修改');
  const { results } = await db.prepare('SELECT id FROM users WHERE id = ?1').bind(id).all();
  if (!results.length) throw new HttpError(404, 'no_user', '找不到這個帳號');
  if (action === 'update') {
    const stmts = [];
    if (b.name !== undefined) {
      const name = cleanName(b.name);
      await assertNameFree(db, name, id);
      stmts.push(db.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(name, id));
    }
    if (b.password !== undefined) {
      const { salt, hash } = await hashPassword(cleanPw(b.password));
      stmts.push(db.prepare('UPDATE users SET salt = ?1, hash = ?2 WHERE id = ?3').bind(salt, hash, id));
      stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id));   // 改密碼後，舊裝置要重新登入
    }
    if (b.disabled !== undefined) {
      stmts.push(db.prepare('UPDATE users SET disabled = ?1 WHERE id = ?2').bind(b.disabled ? 1 : 0, id));
      if (b.disabled) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id));
    }
    if (stmts.length) await db.batch(stmts);
    return { ok: true, users: await listUsers(db) };
  }
  if (action === 'delete') {
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
      db.prepare('DELETE FROM progress WHERE user_id = ?1').bind(id),
      db.prepare('DELETE FROM users WHERE id = ?1').bind(id),
    ]);
    return { ok: true, users: await listUsers(db) };
  }
  throw new HttpError(400, 'bad_action', '不支援的動作');
}
function cleanName(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 20) throw new HttpError(400, 'bad_name', '名稱需為 1–20 個字');
  return s;
}
function cleanPw(v) {
  const s = String(v ?? '');
  if (s.length < 4 || s.length > 100) throw new HttpError(400, 'bad_password', '密碼至少 4 個字元');
  return s;
}
async function assertNameFree(db, name, selfId = -1) {
  if (ADMIN_NAMES.some(n => n.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'name_taken', '這個名稱保留給管理者');
  const { results } = await db.prepare('SELECT id FROM users WHERE lower(name) = lower(?1) AND id != ?2').bind(name, selfId).all();
  if (results.length) throw new HttpError(400, 'name_taken', '這個名稱已經有人使用');
}

/* ---------------- 登入 ---------------- */
async function login(db, secret, b) {
  const name = String(b?.name ?? '').trim(), pw = String(b?.password ?? '');
  if (!name || !pw) throw new HttpError(400, 'missing', '請輸入名稱和密碼');
  const key = name.toLowerCase(), now = Date.now();
  const { results: f } = await db.prepare('SELECT fails, lock_until FROM login_fails WHERE name = ?1').bind(key).all();
  if (f.length && f[0].lock_until > now) {
    throw new HttpError(429, 'locked', `密碼錯太多次，請 ${Math.ceil((f[0].lock_until - now) / 60000)} 分鐘後再試`);
  }
  let user = null;
  if (ADMIN_NAMES.some(n => n.toLowerCase() === key)) {
    if (await sameText(pw, secret)) user = { id: ADMIN_ID, name: ADMIN_NAMES[0], role: 'admin' };
  } else {
    const { results } = await db.prepare('SELECT id, name, salt, hash, disabled FROM users WHERE lower(name) = ?1').bind(key).all();
    const u = results[0];
    if (u && await checkPassword(pw, u.salt, u.hash)) {
      if (u.disabled) throw new HttpError(403, 'disabled', '這個帳號已被停用，請找管理者');
      user = { id: u.id, name: u.name, role: 'user' };
    }
  }
  if (!user) {
    const fails = (f[0]?.fails || 0) + 1;
    const lock = fails >= 5 ? now + 5 * 60000 : 0;
    await db.prepare(`INSERT INTO login_fails (name, fails, lock_until) VALUES (?1, ?2, ?3)
      ON CONFLICT(name) DO UPDATE SET fails = excluded.fails, lock_until = excluded.lock_until`).bind(key, lock ? 0 : fails, lock).run();
    throw new HttpError(401, 'bad_login', '名稱或密碼不正確');
  }
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(toHex(await sha256(token)), user.id, now, now + SESSION_DAYS * 86400000),
    db.prepare('DELETE FROM login_fails WHERE name = ?1').bind(key),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
  ]);
  return { token, user };
}
async function authenticate(request, db, secret) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/);
  if (!m) throw new HttpError(401, 'login_required', '請先登入');
  const token = m[1].trim(), tokenHash = toHex(await sha256(token));
  const { results } = await db.prepare(`SELECT s.user_id, s.expires_at, u.name, u.disabled FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1`).bind(tokenHash).all();
  const s = results[0];
  if (s && s.expires_at > Date.now()) {
    if (s.user_id === ADMIN_ID) return { id: ADMIN_ID, name: ADMIN_NAMES[0], role: 'admin', tokenHash };
    if (s.name != null && !s.disabled) return { id: s.user_id, name: s.name, role: 'user', tokenHash };
  }
  throw new HttpError(401, 'login_required', '登入已失效，請重新登入');
}

/* ---------------- 密碼雜湊 ---------------- */
async function hashPassword(pw) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pbkdf2(pw, salt) };
}
async function checkPassword(pw, salt, hash) { return sameHex(await pbkdf2(pw, salt), hash); }
async function pbkdf2(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITER }, key, 256);
  return toHex(new Uint8Array(bits));
}
/** 比對前先各自做 SHA-256，避免以回應時間推測密碼 */
async function sameText(a, b) { return sameHex(toHex(await sha256(a)), toHex(await sha256(b))); }
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sha256(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
const toHex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));

const cleanId = v => (typeof v === 'string' && v.length > 0 && v.length <= 120 ? v : null);
const cleanTs = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
