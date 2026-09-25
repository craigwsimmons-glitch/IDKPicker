// POST /api/feedback — stores a "Request an update" submission and emails a copy.
//
// Cloudflare Pages settings (Settings → Bindings / Variables and Secrets):
//   FEEDBACK_KV          KV namespace binding (required to store requests + power /admin)
//   RESEND_API_KEY       secret, optional — enables email notifications via resend.com
//   FEEDBACK_TO_EMAIL    where notifications go (e.g. your Gmail)
//   FEEDBACK_FROM_EMAIL  optional, defaults to "IDKPicker <onboarding@resend.dev>"

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const TYPES = ['feature', 'bug', 'other'];
const MAX_PER_HOUR = 5;

export async function onRequestPost({ request, env, waitUntil }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  // Honeypot — bots fill every field. Pretend success.
  if (body.website) return json({ ok: true });

  const message = String(body.message || '').trim().slice(0, 2000);
  const email = String(body.email || '').trim().slice(0, 200);
  const type = TYPES.includes(body.type) ? body.type : 'other';
  if (message.length < 3) return json({ error: 'Please enter a message' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const kv = env.FEEDBACK_KV;

  // Simple per-IP rate limit
  if (kv) {
    const rlKey = `rl:${ip}`;
    const count = parseInt(await kv.get(rlKey)) || 0;
    if (count >= MAX_PER_HOUR) return json({ error: 'Too many requests, try again later' }, 429);
    await kv.put(rlKey, String(count + 1), { expirationTtl: 3600 });
  }

  const now = Date.now();
  const entry = {
    id: `${(9999999999999 - now).toString().padStart(13, '0')}-${crypto.randomUUID().slice(0, 8)}`, // newest first in KV list
    createdAt: new Date(now).toISOString(),
    type, message, email,
    units: body.units === 'km' ? 'km' : 'mi',
    country: request.cf?.country || '',
    city: request.cf?.city || '',
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
    status: 'new',
  };

  let stored = false;
  if (kv) {
    await kv.put(`fb:${entry.id}`, JSON.stringify(entry));
    stored = true;
  }

  const emailTask = sendEmail(env, entry).catch(() => false);
  let emailed = false;
  if (stored) waitUntil(emailTask);          // don't make the user wait on email
  else emailed = await emailTask;             // no storage → email is the only record

  if (!stored && !emailed) return json({ error: 'Feedback is not configured yet' }, 503);
  return json({ ok: true });
}

async function sendEmail(env, e) {
  if (!env.RESEND_API_KEY || !env.FEEDBACK_TO_EMAIL) return false;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = { feature: '✨ Feature request', bug: '🐞 Bug report', other: '💬 Feedback' }[e.type];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FEEDBACK_FROM_EMAIL || 'IDKPicker <onboarding@resend.dev>',
      to: [env.FEEDBACK_TO_EMAIL],
      ...(e.email ? { reply_to: e.email } : {}),
      subject: `IDKPicker: ${label} — ${e.message.slice(0, 60)}`,
      html: `<h2 style="font-family:sans-serif">${label}</h2>
        <p style="font-family:sans-serif;white-space:pre-wrap;font-size:15px">${esc(e.message)}</p>
        <p style="font-family:sans-serif;color:#666;font-size:13px">
          From: ${e.email ? esc(e.email) : '(no email given)'}<br>
          Location: ${esc([e.city, e.country].filter(Boolean).join(', ') || 'unknown')} · Units: ${e.units}<br>
          ${esc(e.createdAt)}<br>
          <a href="https://idkpicker.com/admin">Open admin</a></p>`,
    }),
  });
  return res.ok;
}
