// Helpers for reading the site's text in any language (used by /admin's translation manager).
export const STATIC_LANGS = ['es', 'fr', 'de', 'pt'];
export const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
export const tokens = s => (String(s).match(/\{\w+\}|<\/?[a-z][^>]*>/g) || []).sort().join('|');

export async function englishSource(env, origin) {
  const html = await (await env.ASSETS.fetch(new URL('/', origin))).text();
  const m = html.match(/<script type="application\/json" id="i18n-en">([\s\S]*?)<\/script>/);
  const text = m[1].trim();
  return { EN: JSON.parse(text), version: hash(text) };
}

// Base translation (built-in file or cached AI translation) before admin edits
export async function baseTranslation(env, origin, lang, version) {
  if (STATIC_LANGS.includes(lang)) {
    const f = await env.ASSETS.fetch(new URL(`/i18n/${lang}.json`, origin));
    return f.ok ? await f.json() : {};
  }
  return (await env.FEEDBACK_KV?.get(`i18n:${lang}:${version}`, 'json')) || null;
}

export async function overrides(env, lang) {
  return (await env.FEEDBACK_KV?.get(`i18n-ovr:${lang}`, 'json')) || { rev: 0, d: {} };
}

export function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code); } catch { return code; }
}
