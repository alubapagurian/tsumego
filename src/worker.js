/**
 * 詰棋練習 Worker（Cloudflare Workers + 靜態網頁 + D1）
 *
 * 網頁檔案放在 public/，由 Workers Static Assets 直接提供；
 * 只有 /api/* 會進到這支程式（見 wrangler.jsonc 的 run_worker_first）。
 *
 *   GET  /api/health   檢查連線與登入狀態
 *   GET  /api/deck?since=T   取得伺服器時間 T 之後有變動的題目（T=0 表示全部，含刪除標記）
 *   POST /api/sync           上傳本機的變更，回傳 since 之後有變動的題目
 *        body: { problems: [ {id, updatedAt, ...} ], deletes: [ {id, deletedAt} ], since }
 *   回傳 { problems, now }：下次同步時把 now 當成 since，就只會拿到新的變動
 *
 * 需要的設定：
 *   wrangler.jsonc：D1 資料庫綁定（名稱 DB，填入 database_id）
 *   Worker → Settings → Variables and Secrets：SYNC_PASSWORD（類型選 Secret，至少 12 個字元）
 *   測試用（不建議）：ALLOW_PUBLIC = true 可跳過密碼檢查
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS problems (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  server_ts  INTEGER NOT NULL DEFAULT 0
)`;
const MAX_ITEMS = 200;          // 每次同步最多幾筆（前端會分批）
const MAX_DATA = 200 * 1024;    // 單題資料上限

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, ''));
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, path) {
  try {
    const user = await authenticate(request, env);
    if (!user.ok) return json({ error: user.error, message: user.message }, 401);
    if (!env.DB) return json({ error: 'no_db', message: '尚未綁定名稱為 DB 的 D1 資料庫（請檢查 wrangler.jsonc 的 database_id）' }, 500);
    await ensureSchema(env.DB);

    if (path === 'health' && request.method === 'GET') return json({ ok: true });
    if (path === 'deck' && request.method === 'GET') {
      const now = Date.now();
      return json({ problems: await readDeck(env.DB, Number(new URL(request.url).searchParams.get('since')) || 0), now });
    }
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
  // 舊版資料表沒有 server_ts 欄位：補上（已存在時會出錯，忽略即可）
  try { await db.prepare('ALTER TABLE problems ADD COLUMN server_ts INTEGER NOT NULL DEFAULT 0').run(); } catch (e) {}
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_problems_server_ts ON problems(server_ts)').run();
  schemaReady = true;
}

async function readDeck(db, since = 0) {
  const { results } = await db.prepare('SELECT id, data, updated_at, deleted FROM problems WHERE server_ts >= ?1').bind(since).all();
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
  const now = Date.now();
  const upsert = `INSERT INTO problems (id, data, updated_at, deleted, server_ts) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, server_ts = excluded.server_ts
    WHERE excluded.updated_at >= problems.updated_at`;
  const stmts = [];
  for (const p of problems) {
    const id = cleanId(p?.id), ts = cleanTs(p?.updatedAt);
    if (!id || !ts) continue;
    const data = JSON.stringify(p);
    if (data.length > MAX_DATA) continue;
    stmts.push(db.prepare(upsert).bind(id, data, ts, 0, now));
  }
  for (const d of deletes) {
    const id = cleanId(d?.id), ts = cleanTs(d?.deletedAt);
    if (!id || !ts) continue;
    stmts.push(db.prepare(upsert).bind(id, '', ts, 1, now));
  }
  if (stmts.length) await db.batch(stmts);
  const since = Number(body?.since) || 0;
  return { ok: true, applied: stmts.length, problems: await readDeck(db, since), now };
}

const cleanId = v => (typeof v === 'string' && v.length > 0 && v.length <= 120 ? v : null);
const cleanTs = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ---------------- 登入檢查（同步密碼） ----------------
 * 前端以 Authorization: Bearer <密碼> 傳送；伺服器比對環境變數 SYNC_PASSWORD。
 * 比對前先各自做 SHA-256，避免以回應時間推測密碼。 */
async function authenticate(request, env) {
  const secret = env.SYNC_PASSWORD || '';
  if (!secret) {
    if (String(env.ALLOW_PUBLIC).toLowerCase() === 'true') return { ok: true, email: null };
    return { ok: false, error: 'not_configured', message: '伺服器尚未設定同步密碼（SYNC_PASSWORD）' };
  }
  if (secret.length < 12) return { ok: false, error: 'not_configured', message: 'SYNC_PASSWORD 太短，請至少 12 個字元' };
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, error: 'password_required', message: '請輸入同步密碼' };
  const [x, y] = await Promise.all([sha256(m[1].trim()), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  if (diff !== 0) return { ok: false, error: 'bad_password', message: '同步密碼不正確' };
  return { ok: true, email: null };
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
