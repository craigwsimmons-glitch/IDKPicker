// /admin — password-protected list of "Request an update" submissions.
// Requires Pages variables: ADMIN_PASSWORD (secret) and the FEEDBACK_KV binding.
// Log in with any username and the ADMIN_PASSWORD.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function authorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  // constant-time-ish compare
  if (pass.length !== env.ADMIN_PASSWORD.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) diff |= pass.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  return diff === 0;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const unauthorized = env => new Response(
  env.ADMIN_PASSWORD ? 'Login required' : 'Admin is not configured: set ADMIN_PASSWORD in Cloudflare Pages settings.',
  { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="IDKPicker admin", charset="UTF-8"', ...NO_STORE } });

export async function onRequest({ request, env }) {
  if (!authorized(request, env)) return unauthorized(env);
  const kv = env.FEEDBACK_KV;
  if (!kv) return new Response('FEEDBACK_KV binding is missing — add it in Cloudflare Pages → Settings → Bindings.', { status: 500, headers: NO_STORE });

  const url = new URL(request.url);

  if (request.method === 'POST') {
    // Basic CSRF guard: only accept same-origin form posts
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return new Response('Bad origin', { status: 403 });
    const form = await request.formData();
    const id = String(form.get('id') || '');
    const action = form.get('action');
    const key = `fb:${id}`;
    if (action === 'delete') await kv.delete(key);
    else if (action === 'done' || action === 'new') {
      const raw = await kv.get(key);
      if (raw) { const e = JSON.parse(raw); e.status = action; await kv.put(key, JSON.stringify(e)); }
    }
    return Response.redirect(`${url.origin}/admin${url.search}`, 303);
  }

  const show = url.searchParams.get('show') || 'open';
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'fb:', cursor, limit: 1000 });
    keys.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < 500);

  const all = (await Promise.all(keys.slice(0, 500).map(k => kv.get(k.name, 'json')))).filter(Boolean);
  const items = show === 'all' ? all : all.filter(e => e.status !== 'done');
  const openCount = all.filter(e => e.status !== 'done').length;
  const icon = { feature: '✨', bug: '🐞', other: '💬' };

  const rows = items.map(e => `
    <article class="item ${e.status === 'done' ? 'done' : ''}">
      <div class="meta">${icon[e.type] || '💬'} <b>${esc(e.type)}</b> · ${esc(new Date(e.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }))}
        · ${esc([e.city, e.country].filter(Boolean).join(', ') || 'unknown')} · ${esc(e.units)}</div>
      <p class="msg">${esc(e.message)}</p>
      ${e.email ? `<div class="meta">✉️ <a href="mailto:${esc(e.email)}?subject=${encodeURIComponent('Re: your IDKPicker request')}">${esc(e.email)}</a></div>` : ''}
      <form method="post" class="actions">
        <input type="hidden" name="id" value="${esc(e.id)}">
        ${e.status === 'done'
          ? '<button name="action" value="new">↩︎ Reopen</button>'
          : '<button name="action" value="done">✓ Mark done</button>'}
        <button name="action" value="delete" class="del">Delete</button>
      </form>
    </article>`).join('') || '<p class="empty">Nothing here yet. 🎉</p>';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>IDKPicker Admin</title>
<style>
  :root { --bg:#FFF8F0; --surface:#fff; --text:#1A1108; --muted:#9C856A; --border:#F0E4D4; --accent:#FF5C35; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17120d; --surface:#221a13; --text:#f5ece2; --muted:#b09a82; --border:#3a2e22; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:1.5rem; margin:0 0 4px; } h1 span { color:var(--accent); }
  .tabs { display:flex; gap:8px; margin:12px 0 20px; } .tabs a { padding:6px 14px; border-radius:999px; border:1.5px solid var(--border); color:var(--text); text-decoration:none; font-weight:600; font-size:.85rem; }
  .tabs a.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .item { background:var(--surface); border:1.5px solid var(--border); border-radius:14px; padding:14px 16px; margin-bottom:12px; }
  .item.done { opacity:.55; }
  .meta { color:var(--muted); font-size:.8rem; } .meta a { color:var(--accent); }
  .msg { white-space:pre-wrap; margin:8px 0; word-break:break-word; }
  .actions { display:flex; gap:8px; margin-top:8px; }
  button { font:inherit; font-size:.8rem; font-weight:600; padding:5px 12px; border-radius:8px; border:1.5px solid var(--border); background:transparent; color:var(--text); cursor:pointer; }
  button:hover { border-color:var(--accent); } .del { color:#c0392b; margin-left:auto; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
</style></head><body><main>
  <h1>IDK<span>Picker</span> requests</h1>
  <div class="meta">${openCount} open · ${all.length} total</div>
  <nav class="tabs"><a href="/admin" class="${show !== 'all' ? 'on' : ''}">Open</a><a href="/admin?show=all" class="${show === 'all' ? 'on' : ''}">All</a></nav>
  ${rows}
  <script>document.querySelectorAll('.del').forEach(b=>b.addEventListener('click',e=>{if(!confirm('Delete this request?'))e.preventDefault();}));</script>
</main></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } });
}
