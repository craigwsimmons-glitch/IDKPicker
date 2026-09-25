// GET /api/translate?lang=xx — AI-translates the site's text into any language.
// English source is the <script id="i18n-en"> block in index.html. Results are cached
// in FEEDBACK_KV (global, if bound) and Cloudflare's edge cache, keyed by a hash of the
// English text, so each language is translated once per wording change.

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });

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
  const edgeKey = new Request(`${url.origin}/__i18n/${lang}/${version}`);
  const cacheHeaders = { 'Cache-Control': 'public, max-age=86400' };

  const edge = await caches.default.match(edgeKey);
  if (edge) return edge;
  if (env.FEEDBACK_KV) {
    const stored = await env.FEEDBACK_KV.get(cacheKey);
    if (stored) {
      const res = json(JSON.parse(stored), 200, cacheHeaders);
      waitUntil(caches.default.put(edgeKey, res.clone()));
      return res;
    }
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Translation unavailable' }, 503);

  const prompt = `Translate the values of this JSON object from English into ${languageName} (language code "${lang}") for a friendly, casual restaurant-picker web app called IDKPicker.

Rules:
- Return ONLY a JSON object with exactly the same keys. No markdown fences, no commentary.
- Keep "IDKPicker", "Google Places", "Claude AI", "Chrome", "Safari", "Firefox", "Edge", "Yelp", "GPS" and "$" signs unchanged.
- Keep every HTML tag (<strong>, <br>, <span class="optional">) and every {placeholder} exactly as-is.
- Keep emoji. Keep the tone short, warm and natural for a native speaker — not a literal translation.
- Settings paths like "Settings → Privacy & Security → Location Services" should use the names the phone/browser actually shows in ${languageName}.

${JSON.stringify(EN, null, 1)}`;

  const ai = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!ai.ok) return json({ error: 'Translation service error' }, 502);
  const data = await ai.json();
  const raw = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();

  let out;
  try { out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return json({ error: 'Bad translation output' }, 502); }

  // Validate: keep only known keys whose placeholders and tags survived; otherwise fall back to English
  const tokens = s => (String(s).match(/\{\w+\}|<\/?[a-z][^>]*>/g) || []).sort().join('|');
  const clean = {};
  for (const k of Object.keys(EN)) {
    const v = out[k];
    if (typeof v === 'string' && v.trim() && tokens(v) === tokens(EN[k])) clean[k] = v;
  }

  const res = json(clean, 200, cacheHeaders);
  if (env.FEEDBACK_KV) waitUntil(env.FEEDBACK_KV.put(cacheKey, JSON.stringify(clean)));
  waitUntil(caches.default.put(edgeKey, res.clone()));
  return res;
}
