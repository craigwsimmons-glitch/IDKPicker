// GET /api/translate?lang=xx — the site's text in any language.
// Built-in languages come from /i18n/<lang>.json; others are AI-translated once.
// Admin edits (KV "i18n-ovr:<lang>") are layered on top of either.
// English source is the <script id="i18n-en"> block in index.html. Results are cached
// in FEEDBACK_KV (global, if bound) and Cloudflare's edge cache, keyed by a hash of the
// English text, so each language is translated once per wording change.

import { json, getSettings, aiAllowed, claude } from '../_lib/store.js';
import { STATIC_LANGS } from '../_lib/i18n.js';

// djb2 — must match i18n.js
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const lang = url.searchParams.get('lang') || '';
  // Only well-formed language tags (keeps prompts clean and the cache bounded)
  if (!/^[a-z]{2,3}(-(Hans|Hant|[A-Z]{2}))?$/.test(lang) || lang === 'en') return json({ error: 'Unsupported language' }, 400);

  let languageName = lang;
  try { languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang; } catch {}
  if (languageName === lang) return json({ error: 'Unknown language' }, 400);

  // English source from the deployed page
  const page = await env.ASSETS.fetch(new URL('/', url.origin));
  const html = await page.text();
  const m = html.match(/<script type="application\/json" id="i18n-en">([\s\S]*?)<\/script>/);
  if (!m) return json({ error: 'Source text not found' }, 500);
  const enText = m[1].trim();
  const EN = JSON.parse(enText);
  const version = hash(enText);

  const cacheKey = `i18n:${lang}:${version}`;
  const ovr = env.FEEDBACK_KV ? await env.FEEDBACK_KV.get(`i18n-ovr:${lang}`, 'json').catch(() => null) : null;
  const rev = ovr?.rev || 0;
  const edgeKey = new Request(`${url.origin}/__i18n/${lang}/${version}/${rev}`);
  const cacheHeaders = { 'Cache-Control': 'public, max-age=3600' };
  const withOverrides = d => ({ ...d, ...(ovr?.d || {}) });

  const edge = await caches.default.match(edgeKey);
  if (edge) return edge;
  const finish = d => {
    const res = json(withOverrides(d), 200, cacheHeaders);
    waitUntil(caches.default.put(edgeKey, res.clone()));
    return res;
  };

  // Built-in translation files
  if (STATIC_LANGS.includes(lang)) {
    const f = await env.ASSETS.fetch(new URL(`/i18n/${lang}.json`, url.origin));
    if (f.ok) return finish(await f.json());
  }
  if (env.FEEDBACK_KV) {
    const stored = await env.FEEDBACK_KV.get(cacheKey);
    if (stored) return finish(JSON.parse(stored));
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Translation unavailable' }, 503);
  const allowed = await aiAllowed(env, await getSettings(env)).catch(() => ({ ok: true }));
  if (!allowed.ok) return json({ error: 'Translation paused' }, 503);

  const prompt = `Translate the values of this JSON object from English into ${languageName} (language code "${lang}") for a friendly, casual restaurant-picker web app called IDKPicker.

Rules:
- Return ONLY a JSON object with exactly the same keys. No markdown fences, no commentary.
- Keep "IDKPicker", "Google Places", "Claude AI", "Chrome", "Safari", "Firefox", "Edge", "Yelp", "GPS" and "$" signs unchanged.
- Keep every HTML tag (<strong>, <br>, <span class="optional">) and every {placeholder} exactly as-is.
- Keep emoji. Keep the tone short, warm and natural for a native speaker — not a literal translation.
- Settings paths like "Settings → Privacy & Security → Location Services" should use the names the phone/browser actually shows in ${languageName}.

${JSON.stringify(EN, null, 1)}`;

  let raw;
  try { raw = (await claude(env, prompt, 8000, 'translations')).replace(/```json|```/g, '').trim(); }
  catch { return json({ error: 'Translation service error' }, 502); }

  let out;
  try { out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return json({ error: 'Bad translation output' }, 502); }

  // Validate: keep only known keys whose placeholders and tags survived; otherwise fall back to English
  const tokens = s => (String(s).match(/\{\w+\}|<\/?[a-z][^>]*>/g) || []).sort().join('|');
  const clean = {};
  for (const k of Object.keys(EN)) {
    const v = out[k];
    if (typeof v === 'string' && v.trim() && tokens(v) === tokens(EN[k])) clean[k] = v;
  }

  if (env.FEEDBACK_KV) waitUntil(env.FEEDBACK_KV.put(cacheKey, JSON.stringify(clean)));
  return finish(clean);
}
