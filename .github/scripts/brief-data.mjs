// Collects data for Craig's morning brief and writes it to brief-data/latest.json.
// Runs in GitHub Actions (see .github/workflows/brief-data.yml). Node 20+, no dependencies.
// Every check is independent: a failure is recorded in the JSON instead of stopping the run.
import { writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (compatible; IDKPickerMorningBrief/1.0; +https://idkpicker.com)';
const out = { generated_at: new Date().toISOString(), sites: {}, idkpicker_stats: null, makerworld: null };

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, ...opts,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(opts.headers || {}) } });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
}
const titleOf = html => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

async function checkSite(name, url, expect) {
  try {
    const { status, body } = await get(url);
    const title = titleOf(body);
    const ok = status === 200 && expect(title) && body.length > 500;
    out.sites[name] = { up: ok, http: status, title, bytes: body.length };
  } catch (e) {
    out.sites[name] = { up: false, error: String(e.message || e) };
  }
}

async function idkStats() {
  const key = process.env.IDKPICKER_STATS_KEY;
  if (!key) { out.idkpicker_stats = { error: 'IDKPICKER_STATS_KEY secret is not set' }; return; }
  try {
    const { status, body } = await get('https://idkpicker.com/api/stats',
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    out.idkpicker_stats = status === 200 ? JSON.parse(body) : { error: `HTTP ${status}` };
  } catch (e) { out.idkpicker_stats = { error: String(e.message || e) }; }
}

// MakerWorld is a Next.js site; the profile page embeds its data in __NEXT_DATA__.
// The JSON layout isn't documented, so walk it and pick out anything that looks like
// the user's totals and their models. Best effort — MakerWorld may block automated requests.
const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : undefined));
function pick(o, ...keys) { for (const k of keys) if (num(o[k]) !== undefined) return num(o[k]); }

async function makerworld() {
  const handle = 'Squirrels_Nest';
  const res = { handle, source: null };
  try {
    let page = null;
    for (const path of ['upload', 'profile', '']) {
      const url = `https://makerworld.com/en/@${handle}${path ? '/' + path : ''}`;
      const r = await get(url);
      res.http = r.status;
      if (r.status === 200 && r.body.includes('__NEXT_DATA__')) { page = r.body; res.source = url; break; }
    }
    if (!page) { out.makerworld = { ...res, error: `no readable page (last HTTP ${res.http})` }; return; }
    const raw = page.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    const data = JSON.parse(raw);

    const models = new Map();
    let user = null;
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const id = o.id ?? o.designId;
      if (id && typeof o.title === 'string' && pick(o, 'downloadCount', 'downloadCnt') !== undefined) {
        models.set(String(id), {
          id: String(id), title: o.title,
          downloads: pick(o, 'downloadCount', 'downloadCnt') ?? 0,
          likes: pick(o, 'likeCount', 'likeCnt') ?? 0,
          prints: pick(o, 'printCount', 'printCnt') ?? 0,
          collections: pick(o, 'collectionCount', 'collectionCnt', 'favoriteCount') ?? 0,
          comments: pick(o, 'commentCount', 'commentCnt') ?? 0,
          boosts: pick(o, 'boostCnt', 'boostCount', 'boosts') ?? 0,
        });
      }
      if (!user && (o.handle === handle || o.name === handle) && pick(o, 'fanCount', 'followerCount', 'fansCount') !== undefined) user = o;
      Object.values(o).forEach(walk);
    })(data);

    const list = [...models.values()];
    const sum = k => list.reduce((a, m) => a + (m[k] || 0), 0);
    out.makerworld = {
      ...res,
      followers: user ? pick(user, 'fanCount', 'followerCount', 'fansCount') : null,
      likes: (user && pick(user, 'likeCount', 'likeCnt')) ?? sum('likes'),
      downloads: (user && pick(user, 'downloadCount', 'downloadCnt')) ?? sum('downloads'),
      collections: (user && pick(user, 'collectionCount', 'collectionCnt')) ?? sum('collections'),
      boosts: (user && pick(user, 'boostCount', 'boostCnt')) ?? sum('boosts'),
      models: list,
    };
    if (!list.length) out.makerworld.error = 'page loaded but no models were found in its data';
  } catch (e) { out.makerworld = { ...res, error: String(e.message || e) }; }
}

await Promise.all([
  checkSite('idkpicker', 'https://idkpicker.com/', t => t.startsWith('IDKPicker')),
  checkSite('birminghamhomeservices', 'https://birminghamhomeservices.com/',
    t => t === 'Birmingham Home Services | Find Local Contractors in Birmingham, AL'),
  idkStats(),
  makerworld(),
]);

await mkdir('brief-data', { recursive: true });
await writeFile('brief-data/latest.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ sites: out.sites, stats: out.idkpicker_stats?.error || 'ok',
  makerworld: out.makerworld?.error || `${out.makerworld?.models?.length} models` }, null, 2));
