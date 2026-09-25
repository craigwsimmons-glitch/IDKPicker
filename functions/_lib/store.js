// Shared storage helpers for IDKPicker's Pages Functions.
//   env.FEEDBACK_KV — KV: settings, feedback requests, translations (rarely written)
//   env.DB          — D1: usage events, daily AI counters, rate limits (written per pick)
// Everything degrades gracefully if a binding is missing.

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

export const today = () => new Date().toISOString().slice(0, 10);

// ── Settings (KV key "settings") ────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
  aiEnabled: true,        // off → picks fall back to top-rated, translations pause
  aiDailyCap: 2000,       // max AI calls per UTC day (picks + translations)
  picksPerHour: 40,       // per visitor IP
  banner: { active: false, text: '', link: '', style: 'info', id: '' },
};
export async function getSettings(env) {
  if (!env.FEEDBACK_KV) return structuredClone(DEFAULT_SETTINGS);
  const s = await env.FEEDBACK_KV.get('settings', 'json').catch(() => null);
  return { ...structuredClone(DEFAULT_SETTINGS), ...(s || {}), banner: { ...DEFAULT_SETTINGS.banner, ...(s?.banner || {}) } };
}
export async function saveSettings(env, s) {
  if (env.FEEDBACK_KV) await env.FEEDBACK_KV.put('settings', JSON.stringify(s));
}

// ── D1 schema (created on first use) ────────────────────────────────────────
let schemaReady = null;
export function db(env) {
  if (!env.DB) return null;
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
        country TEXT, city TEXT, lang TEXT, cuisine TEXT, vibe TEXT, again INTEGER DEFAULT 0,
        ai INTEGER DEFAULT 0, units TEXT, restaurant TEXT)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS events_day ON events(day, kind)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily (
        day TEXT PRIMARY KEY, picks INTEGER DEFAULT 0, ai_calls INTEGER DEFAULT 0, fallbacks INTEGER DEFAULT 0,
        translations INTEGER DEFAULT 0, in_tokens INTEGER DEFAULT 0, out_tokens INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS ratelimit (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)`),
    ]).catch(e => { schemaReady = null; throw e; });
  }
  return { ready: schemaReady, d: env.DB };
}

// Add to today's counters, e.g. bump(env, { ai_calls: 1, in_tokens: 900 })
export async function bump(env, fields) {
  const h = db(env); if (!h) return;
  await h.ready;
  const cols = Object.keys(fields).filter(k => /^(picks|ai_calls|fallbacks|translations|in_tokens|out_tokens|blocked)$/.test(k));
  if (!cols.length) return;
  await h.d.prepare(`INSERT INTO daily (day, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})
    ON CONFLICT(day) DO UPDATE SET ${cols.map(c => `${c} = ${c} + excluded.${c}`).join(', ')}`)
    .bind(today(), ...cols.map(c => fields[c] | 0)).run();
}

export async function aiCallsToday(env) {
  const h = db(env); if (!h) return 0;
  await h.ready;
  const r = await h.d.prepare('SELECT ai_calls FROM daily WHERE day = ?').bind(today()).first();
  return r?.ai_calls || 0;
}

// Is the AI allowed right now? Returns { ok, reason }
export async function aiAllowed(env, settings) {
  if (!settings.aiEnabled) return { ok: false, reason: 'disabled' };
  if (settings.aiDailyCap > 0 && (await aiCallsToday(env)) >= settings.aiDailyCap) return { ok: false, reason: 'cap' };
  return { ok: true };
}

// Fixed-window rate limit. Returns true if allowed.
export async function rateLimit(env, key, limit, windowSec) {
  const h = db(env); if (!h || !limit) return true;
  await h.ready;
  const now = Math.floor(Date.now() / 1000);
  const row = await h.d.prepare(`INSERT INTO ratelimit (key, count, expires) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN expires < ? THEN 1 ELSE count + 1 END,
        expires = CASE WHEN expires < ? THEN excluded.expires ELSE expires END
      RETURNING count`).bind(key, now + windowSec, now, now).first();
  return (row?.count || 0) <= limit;
}

export async function logEvent(env, e) {
  const h = db(env); if (!h) return;
  await h.ready;
  const cut = (s, n) => (s == null ? null : String(s).slice(0, n));
  await h.d.prepare(`INSERT INTO events (ts, day, kind, country, city, lang, cuisine, vibe, again, ai, units, restaurant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(Date.now(), today(), cut(e.kind, 20), cut(e.country, 4), cut(e.city, 60), cut(e.lang, 12), cut(e.cuisine, 20),
      cut(e.vibe, 160), e.again ? 1 : 0, e.ai ? 1 : 0, cut(e.units, 3), cut(e.restaurant, 80)).run();
}

// Claude Haiku 4.5 list prices (USD per million tokens) — used for cost estimates only
export const PRICE_IN = 1, PRICE_OUT = 5;
export const costOf = (inTok, outTok) => (inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6;

// Call Claude and record usage. Returns the text.
export async function claude(env, prompt, maxTokens, counterField) {
  const res = await fetch(`${env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error ${res.status}`);
  const u = data.usage || {};
  await bump(env, { ai_calls: 1, in_tokens: u.input_tokens || 0, out_tokens: u.output_tokens || 0, ...(counterField ? { [counterField]: 1 } : {}) }).catch(() => {});
  return (data.content || []).map(c => c.text || '').join('');
}
