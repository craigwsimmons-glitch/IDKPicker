// GET /api/stats?key=… — read-only usage summary for the daily morning brief.
//
// Cloudflare Pages setting (Settings → Variables and Secrets):
//   STATS_KEY  secret — a long random string. Without it this endpoint is disabled (404).
//
// Returns anonymous aggregates only (counts, cities, estimated AI cost). No emails,
// feedback text or personal data. Days are Central time.
import { json, db, costOf } from '../_lib/store.js';

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

// Epoch ms of the most recent midnight in America/Chicago at or before `at` (handles daylight saving)
function chicagoMidnight(at = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(x => [x.type, x.value]));
  return at - (((+p.hour * 60 + +p.minute) * 60 + +p.second) * 1000 + (at % 1000));
}
const centralDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

function keyOk(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet({ request, env }) {
  if (!env.STATS_KEY) return new Response('Not found', { status: 404, headers: NO_STORE });
  const url = new URL(request.url);
  const given = url.searchParams.get('key') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!keyOk(given, env.STATS_KEY)) return json({ error: 'Unauthorized' }, 401, NO_STORE);

  const h = db(env);
  if (!h) return json({ error: 'D1 binding DB is missing' }, 503, NO_STORE);
  await h.ready;

  const now = Date.now();
  const todayStart = chicagoMidnight(now);
  const yStart = chicagoMidnight(todayStart - 1);
  const weekStart = chicagoMidnight(todayStart - 6.5 * 864e5);      // last 7 full days, ending yesterday
  const prevWeekStart = chicagoMidnight(weekStart - 6.5 * 864e5);   // the 7 days before that
  const q = (sql, ...b) => h.d.prepare(sql).bind(...b).all().then(r => r.results || []);
  const one = (sql, ...b) => h.d.prepare(sql).bind(...b).first();
  const pickTotals = `SELECT COUNT(*) picks, COALESCE(SUM(again),0) pick_again, COALESCE(SUM(ai),0) ai_picks,
      COUNT(DISTINCT city) cities FROM events WHERE kind='pick' AND ts >= ? AND ts < ?`;

  const utcToday = new Date(now).toISOString().slice(0, 10);
  const utcYesterday = new Date(now - 864e5).toISOString().slice(0, 10);
  const month = utcToday.slice(0, 7);

  const [yday, todaySoFar, week, prevWeek, topCities, topCuisines, aiRows] = await Promise.all([
    one(pickTotals, yStart, todayStart),
    one(pickTotals, todayStart, now + 1),
    one(pickTotals, weekStart, todayStart),
    one(pickTotals, prevWeekStart, weekStart),
    q(`SELECT COALESCE(city,'Unknown') city, COALESCE(country,'') country, COUNT(*) n FROM events
       WHERE kind='pick' AND ts >= ? AND ts < ? GROUP BY city, country ORDER BY n DESC LIMIT 5`, yStart, todayStart),
    q(`SELECT COALESCE(NULLIF(cuisine,''),'any') cuisine, COUNT(*) n FROM events
       WHERE kind='pick' AND ts >= ? AND ts < ? GROUP BY 1 ORDER BY n DESC LIMIT 5`, yStart, todayStart),
    q(`SELECT * FROM daily WHERE day >= ?`, `${month}-01` < utcYesterday ? `${month}-01` : utcYesterday),
  ]);

  const byDay = Object.fromEntries(aiRows.map(r => [r.day, r]));
  const ai = r => ({ ai_calls: r?.ai_calls || 0, fallbacks: r?.fallbacks || 0, blocked: r?.blocked || 0,
    est_cost_usd: +costOf(r?.in_tokens || 0, r?.out_tokens || 0).toFixed(4) });
  const monthCost = aiRows.filter(r => r.day.startsWith(month))
    .reduce((a, r) => a + costOf(r.in_tokens || 0, r.out_tokens || 0), 0);

  // Feedback requests: counts only (newest 200 keys; ids sort newest first)
  let feedback = null;
  if (env.FEEDBACK_KV) {
    const list = await env.FEEDBACK_KV.list({ prefix: 'fb:', limit: 200 }).catch(() => ({ keys: [] }));
    const items = (await Promise.all(list.keys.map(k => env.FEEDBACK_KV.get(k.name, 'json').catch(() => null)))).filter(Boolean);
    feedback = {
      new_last_24h: items.filter(e => Date.parse(e.createdAt) >= now - 864e5).length,
      awaiting_review: items.filter(e => !e.status || e.status === 'new').length,
    };
  }

  return json({
    generated_at: new Date(now).toISOString(),
    timezone: 'America/Chicago',
    yesterday: { date: centralDate(yStart), ...yday, top_cities: topCities, top_cuisines: topCuisines },
    today_so_far: { date: centralDate(todayStart), ...todaySoFar },
    last_7_days: { from: centralDate(weekStart), to: centralDate(yStart), ...week },
    previous_7_days: { from: centralDate(prevWeekStart), to: centralDate(weekStart - 1), ...prevWeek },
    ai: { note: 'AI counters are per UTC day', yesterday_utc: { day: utcYesterday, ...ai(byDay[utcYesterday]) },
      month_to_date_est_cost_usd: +monthCost.toFixed(2) },
    feedback,
    note: 'Picks are the main usage signal (one per restaurant pick). Page views live in Google Analytics.',
  }, 200, NO_STORE);
}
