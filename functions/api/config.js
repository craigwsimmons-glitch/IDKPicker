// GET /api/config — public site settings the page needs (currently: the announcement banner).
import { json, getSettings } from '../_lib/store.js';

export async function onRequestGet({ env }) {
  const s = await getSettings(env);
  const b = s.banner || {};
  return json({ banner: b.active && b.text ? { id: b.id, text: b.text, link: b.link || '', style: b.style || 'info' } : null },
    200, { 'Cache-Control': 'public, max-age=60' });
}
