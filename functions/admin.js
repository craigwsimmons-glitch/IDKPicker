// /admin — IDKPicker control panel (password protected with ADMIN_PASSWORD; any username).
// Tabs: Requests · Usage · AI & Costs · Banner · Translations
import { getSettings, saveSettings, db, today, costOf, DEFAULT_SETTINGS } from './_lib/store.js';
import { englishSource, baseTranslation, overrides, langName, tokens, STATIC_LANGS } from './_lib/i18n.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const STATUSES = { new: '🆕 New', planned: '🗓️ Planned', in_progress: '🔧 In progress', shipped: '🚀 Shipped', closed: '✓ Closed' };
const OPEN = ['new', 'planned', 'in_progress'];
const TYPE_ICON = { feature: '✨', bug: '🐞', other: '💬' };
const fmtDate = ts => new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = n => n < 0.01 && n > 0 ? '<$0.01' : '$' + n.toFixed(2);
const normStatus = s => (s === 'done' ? 'closed' : STATUSES[s] ? s : 'new');

// ── auth ────────────────────────────────────────────────────────────────────
function authorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  if (pass.length !== env.ADMIN_PASSWORD.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) diff |= pass.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  return diff === 0;
}
const unauthorized = env => new Response(
  env.ADMIN_PASSWORD ? 'Login required' : 'Admin is not configured: set ADMIN_PASSWORD in Cloudflare Pages settings.',
  { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="IDKPicker admin", charset="UTF-8"', ...NO_STORE } });

// ── entry point ─────────────────────────────────────────────────────────────
export async function onRequest(ctx) {
  const { request, env } = ctx;
  if (!authorized(request, env)) return unauthorized(env);
  if (!env.FEEDBACK_KV) return page('Setup needed', '', '<p class="note">FEEDBACK_KV binding is missing — add it in Cloudflare Pages → Settings → Bindings.</p>');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return new Response('Bad origin', { status: 403 });
    const form = await request.formData();
    const flash = await handlePost(ctx, url, form).catch(e => '⚠️ ' + e.message);
    const back = new URL(form.get('back') || '/admin', url.origin);
    if (flash) back.searchParams.set('msg', flash);
    return Response.redirect(back.toString(), 303);
  }

  if (url.searchParams.get('export') === 'csv') return exportCsv(env);

  const tab = url.searchParams.get('tab') || 'requests';
  const views = { requests: viewRequests, usage: viewUsage, ai: viewAi, banner: viewBanner, translations: viewTranslations };
  try {
    return page(tab, url.searchParams.get('msg') || '', await (views[tab] || viewRequests)(ctx, url));
  } catch (e) {
    return page(tab, '', `<p class="note err">Something went wrong: ${esc(e.message)}</p>`);
  }
}

// ── actions ─────────────────────────────────────────────────────────────────
async function handlePost({ env, request }, url, form) {
  const action = form.get('action');
  const kv = env.FEEDBACK_KV;

  if (['status', 'delete', 'reply'].includes(action)) {
    const key = `fb:${form.get('id')}`;
    if (action === 'delete') { await kv.delete(key); return 'Deleted.'; }
    const e = await kv.get(key, 'json');
    if (!e) return 'That request no longer exists.';
    if (action === 'status') {
      e.status = normStatus(form.get('status'));
      await kv.put(key, JSON.stringify(e));
      return `Marked as ${STATUSES[e.status]}.`;
    }
    if (action === 'reply') {
      const text = String(form.get('text') || '').trim().slice(0, 4000);
      if (!text) return 'Write a reply first.';
      if (!e.email) return 'This person didn\'t leave an email.';
      if (!env.RESEND_API_KEY) return 'Add RESEND_API_KEY in Cloudflare to send replies from here.';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FEEDBACK_FROM_EMAIL || 'IDKPicker <onboarding@resend.dev>',
          to: [e.email], ...(env.FEEDBACK_TO_EMAIL ? { reply_to: env.FEEDBACK_TO_EMAIL } : {}),
          subject: 'Re: your IDKPicker request',
          text: `${text}\n\n— IDKPicker\n\nYou wrote:\n> ${e.message.replace(/\n/g, '\n> ')}`,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return '⚠️ Email not sent: ' + (err.message || r.status) + (env.FEEDBACK_FROM_EMAIL ? '' : ' (Resend can only email other people after you verify a domain and set FEEDBACK_FROM_EMAIL)');
      }
      e.replies = [...(e.replies || []), { at: new Date().toISOString(), text }];
      if (e.status === 'new') e.status = 'planned';
      await kv.put(key, JSON.stringify(e));
      return 'Reply sent.';
    }
  }

  if (action === 'ai-settings') {
    const s = await getSettings(env);
    s.aiEnabled = form.get('aiEnabled') === 'on';
    s.aiDailyCap = Math.max(0, Math.min(100000, parseInt(form.get('aiDailyCap'), 10) || 0));
    s.picksPerHour = Math.max(0, Math.min(1000, parseInt(form.get('picksPerHour'), 10) || 0));
    await saveSettings(env, s);
    return 'AI settings saved.';
  }

  if (action === 'banner') {
    const s = await getSettings(env);
    const text = String(form.get('text') || '').trim().slice(0, 200);
    const link = String(form.get('link') || '').trim().slice(0, 300);
    if (link && !/^https?:\/\//.test(link)) return '⚠️ Link must start with http:// or https://';
    const style = ['info', 'promo', 'warn'].includes(form.get('style')) ? form.get('style') : 'info';
    const changed = text !== s.banner.text || link !== s.banner.link;
    s.banner = { active: form.get('active') === 'on' && !!text, text, link, style, id: changed || !s.banner.id ? crypto.randomUUID().slice(0, 8) : s.banner.id };
    await saveSettings(env, s);
    return s.banner.active ? 'Banner is live (visitors see it within a minute).' : 'Banner saved but hidden.';
  }

  if (action === 'i18n-save' || action === 'i18n-reset' || action === 'i18n-retranslate') {
    const lang = String(form.get('lang') || '');
    if (!/^[a-z]{2,3}(-(Hans|Hant|[A-Z]{2}))?$/.test(lang)) return 'Bad language code.';
    const ovr = await overrides(env, lang);
    if (action === 'i18n-reset') {
      await kv.put(`i18n-ovr:${lang}`, JSON.stringify({ rev: ovr.rev + 1, d: {} }));
      return `Your edits to ${langName(lang)} were removed.`;
    }
    const { EN, version } = await englishSource(env, url.origin);
    if (action === 'i18n-retranslate') {
      await kv.delete(`i18n:${lang}:${version}`);
      await kv.put(`i18n-ovr:${lang}`, JSON.stringify({ rev: ovr.rev + 1, d: ovr.d }));
      return `${langName(lang)} will be re-translated by AI on the next visit (your edits are kept).`;
    }
    const base = (await baseTranslation(env, url.origin, lang, version)) || {};
    const d = {}; const bad = [];
    for (const k of Object.keys(EN)) {
      const v = form.get('k:' + k);
      if (v == null) continue;
      const val = String(v).trim();
      if (!val || val === (base[k] ?? '')) continue;
      if (tokens(val) !== tokens(EN[k])) { bad.push(k); continue; }
      d[k] = val;
    }
    await kv.put(`i18n-ovr:${lang}`, JSON.stringify({ rev: ovr.rev + 1, d }));
    return `Saved ${Object.keys(d).length} edited line(s) for ${langName(lang)}.` +
      (bad.length ? ` ⚠️ Skipped ${bad.length} line(s) because a {placeholder} or HTML tag was changed: ${bad.join(', ')}` : '');
  }
  return 'Unknown action.';
}

// ── Requests ────────────────────────────────────────────────────────────────
async function allRequests(env) {
  const keys = [];
  let cursor;
  do {
    const p = await env.FEEDBACK_KV.list({ prefix: 'fb:', cursor, limit: 1000 });
    keys.push(...p.keys);
    cursor = p.list_complete ? null : p.cursor;
  } while (cursor && keys.length < 1000);
  const items = (await Promise.all(keys.slice(0, 1000).map(k => env.FEEDBACK_KV.get(k.name, 'json')))).filter(Boolean);
  items.forEach(e => { e.status = normStatus(e.status); });
  return items;
}

async function viewRequests({ env }, url) {
  const all = await allRequests(env);
  const show = url.searchParams.get('show') || 'open';
  const counts = { open: all.filter(e => OPEN.includes(e.status)).length, shipped: all.filter(e => e.status === 'shipped').length, closed: all.filter(e => e.status === 'closed').length, all: all.length };
  const items = show === 'all' ? all : show === 'open' ? all.filter(e => OPEN.includes(e.status)) : all.filter(e => e.status === show);
  const back = `/admin?tab=requests&show=${show}`;
  const canReply = !!env.RESEND_API_KEY;

  const rows = items.map(e => `
    <article class="item st-${e.status}" data-search="${esc((e.message + ' ' + (e.email || '') + ' ' + (e.city || '')).toLowerCase())}" data-type="${esc(e.type)}">
      <div class="meta">${TYPE_ICON[e.type] || '💬'} <b>${esc(e.type)}</b> · ${esc(fmtDate(e.createdAt))} · ${esc([e.city, e.country].filter(Boolean).join(', ') || 'unknown')}${e.lang && e.lang !== 'en' ? ' · ' + esc(langName(e.lang)) : ''}</div>
      <p class="msg">${esc(e.message)}</p>
      ${(e.replies || []).map(r => `<div class="reply">↪︎ You replied ${esc(fmtDate(r.at))}: ${esc(r.text)}</div>`).join('')}
      <div class="actions">
        <form method="post" class="inline">
          <input type="hidden" name="id" value="${esc(e.id)}"><input type="hidden" name="action" value="status"><input type="hidden" name="back" value="${back}">
          <select name="status" onchange="this.form.submit()" aria-label="Status">
            ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${k === e.status ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </form>
        ${e.email ? `<a class="btn" href="mailto:${esc(e.email)}?subject=${encodeURIComponent('Re: your IDKPicker request')}">✉️ ${esc(e.email)}</a>` : ''}
        <form method="post" class="inline right" onsubmit="return confirm('Delete this request?')">
          <input type="hidden" name="id" value="${esc(e.id)}"><input type="hidden" name="back" value="${back}">
          <button name="action" value="delete" class="del">Delete</button>
        </form>
      </div>
      ${e.email ? `<details class="replybox"><summary>Reply from here</summary>
        ${canReply ? '' : '<p class="note">Add <code>RESEND_API_KEY</code> in Cloudflare to send replies from this page — or use the email link above.</p>'}
        <form method="post">
          <input type="hidden" name="id" value="${esc(e.id)}"><input type="hidden" name="back" value="${back}">
          <textarea name="text" rows="4" placeholder="Hi! Thanks for the idea…"${canReply ? '' : ' disabled'}></textarea>
          <button name="action" value="reply" class="primary"${canReply ? '' : ' disabled'}>Send reply</button>
        </form></details>` : ''}
    </article>`).join('') || '<p class="empty">Nothing here. 🎉</p>';

  return `
    <nav class="pills">
      ${[['open', 'Open'], ['shipped', 'Shipped'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => `<a href="/admin?tab=requests&show=${k}" class="${show === k ? 'on' : ''}">${l} <span>${counts[k]}</span></a>`).join('')}
      <a href="/admin?export=csv" class="right">⬇ Export CSV</a>
    </nav>
    <div class="filters">
      <input type="search" id="q" placeholder="Search requests…" aria-label="Search requests">
      <select id="typeFilter" aria-label="Type"><option value="">All types</option><option value="feature">✨ Features</option><option value="bug">🐞 Bugs</option><option value="other">💬 Other</option></select>
    </div>
    <div id="list">${rows}</div>
    <p class="empty" id="noMatch" hidden>No requests match.</p>
    <script>
      const q = document.getElementById('q'), tf = document.getElementById('typeFilter');
      function filter() {
        const s = q.value.trim().toLowerCase(), ty = tf.value; let n = 0;
        document.querySelectorAll('#list .item').forEach(el => {
          const ok = (!s || el.dataset.search.includes(s)) && (!ty || el.dataset.type === ty);
          el.hidden = !ok; if (ok) n++;
        });
        document.getElementById('noMatch').hidden = n > 0 || !document.querySelector('#list .item');
      }
      q.addEventListener('input', filter); tf.addEventListener('change', filter);
    </script>`;
}

async function exportCsv(env) {
  const all = await allRequests(env);
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['created', 'status', 'type', 'message', 'email', 'city', 'country', 'language', 'units', 'replies'];
  const rows = all.map(e => [e.createdAt, e.status, e.type, e.message, e.email, e.city, e.country, e.lang || 'en', e.units, (e.replies || []).length].map(cell).join(','));
  return new Response('﻿' + [head.join(','), ...rows].join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="idkpicker-requests-${today()}.csv"`, ...NO_STORE },
  });
}

// ── Usage ───────────────────────────────────────────────────────────────────
const d1Missing = `<div class="note">📊 Usage stats need a D1 database. In Cloudflare: <b>Storage &amp; databases → D1 → Create</b> (name it <code>idkpicker</code>), then in your Pages project <b>Settings → Bindings → Add → D1 database</b> with variable name <code>DB</code>, and redeploy.</div>`;

function barList(rows, label, value = r => r.n) {
  if (!rows.length) return '<p class="empty small">No data yet.</p>';
  const max = Math.max(...rows.map(value), 1);
  return `<ul class="bars">${rows.map(r => `<li title="${esc(label(r))}: ${value(r).toLocaleString()}">
      <span class="lbl">${esc(label(r))}</span><span class="track"><span class="fill" style="width:${Math.max(2, (value(r) / max) * 100)}%"></span></span><span class="val">${value(r).toLocaleString()}</span></li>`).join('')}</ul>`;
}

function dayColumns(days, rowsByDay, value, fmt = v => v.toLocaleString()) {
  const vals = days.map(d => value(rowsByDay[d] || {}));
  const max = Math.max(...vals, 1);
  return `<div class="cols" role="img" aria-label="Daily chart">${days.map((d, i) => `
      <div class="col" title="${esc(new Date(d + 'T12:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}: ${esc(fmt(vals[i]))}">
        <span class="bar" style="height:${vals[i] ? Math.max(3, (vals[i] / max) * 100) : 0}%"></span></div>`).join('')}</div>
    <div class="axis"><span>${esc(new Date(days[0] + 'T12:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span><span>Today</span></div>`;
}

function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  return out;
}

async function viewUsage({ env }, url) {
  const h = db(env);
  if (!h) return d1Missing;
  await h.ready;
  const range = [7, 30, 90].includes(+url.searchParams.get('days')) ? +url.searchParams.get('days') : 30;
  const days = lastDays(range), since = days[0];
  const q = (sql, ...b) => h.d.prepare(sql).bind(...b).all().then(r => r.results || []);
  // keep the table small: drop events older than 180 days
  await h.d.prepare('DELETE FROM events WHERE ts < ?').bind(Date.now() - 180 * 864e5).run().catch(() => {});

  const [perDay, cities, langs, cuisines, places, vibes, totals] = await Promise.all([
    q(`SELECT day, COUNT(*) n, SUM(again) again, SUM(ai) ai FROM events WHERE kind='pick' AND day >= ? GROUP BY day`, since),
    q(`SELECT COALESCE(city,'Unknown') city, COALESCE(country,'') country, COUNT(*) n FROM events WHERE kind='pick' AND day >= ? GROUP BY city, country ORDER BY n DESC LIMIT 10`, since),
    q(`SELECT COALESCE(lang,'en') lang, COUNT(*) n FROM events WHERE kind='pick' AND day >= ? GROUP BY lang ORDER BY n DESC LIMIT 10`, since),
    q(`SELECT COALESCE(NULLIF(cuisine,''),'any') cuisine, COUNT(*) n FROM events WHERE kind='pick' AND day >= ? GROUP BY 1 ORDER BY n DESC LIMIT 10`, since),
    q(`SELECT restaurant, COUNT(*) n FROM events WHERE kind='pick' AND restaurant IS NOT NULL AND day >= ? GROUP BY restaurant ORDER BY n DESC LIMIT 10`, since),
    q(`SELECT ts, vibe, city FROM events WHERE kind='pick' AND vibe IS NOT NULL AND vibe <> '' ORDER BY id DESC LIMIT 20`),
    q(`SELECT COUNT(*) n, SUM(again) again, SUM(ai) ai, SUM(units='km') km, COUNT(DISTINCT city) cities FROM events WHERE kind='pick' AND day >= ?`, since),
  ]);
  const t = totals[0] || {};
  const byDay = Object.fromEntries(perDay.map(r => [r.day, r]));
  const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '—';

  return `
    <nav class="pills">${[7, 30, 90].map(d => `<a href="/admin?tab=usage&days=${d}" class="${d === range ? 'on' : ''}">Last ${d} days</a>`).join('')}</nav>
    <div class="tiles">
      <div class="tile"><div class="big">${(t.n || 0).toLocaleString()}</div><div class="cap">Picks</div></div>
      <div class="tile"><div class="big">${pct(t.again || 0, t.n)}</div><div class="cap">Tapped “Pick Again”</div></div>
      <div class="tile"><div class="big">${(t.cities || 0).toLocaleString()}</div><div class="cap">Cities</div></div>
      <div class="tile"><div class="big">${pct(t.km || 0, t.n)}</div><div class="cap">Use kilometers</div></div>
    </div>
    <section class="card"><h3>Picks per day</h3>${dayColumns(days, byDay, r => r.n || 0)}</section>
    <div class="grid2">
      <section class="card"><h3>Top cities <small>(visitor location)</small></h3>${barList(cities, r => [r.city, r.country].filter(Boolean).join(', '))}</section>
      <section class="card"><h3>Languages</h3>${barList(langs, r => `${langName(r.lang)} (${r.lang})`)}</section>
      <section class="card"><h3>Cuisines chosen</h3>${barList(cuisines, r => r.cuisine)}</section>
      <section class="card"><h3>Most-picked restaurants</h3>${barList(places, r => r.restaurant)}</section>
    </div>
    <section class="card"><h3>Recent vibes people typed</h3>
      ${vibes.length ? `<ul class="vibes">${vibes.map(v => `<li><span>“${esc(v.vibe)}”</span><small>${esc(v.city || '')} · ${esc(fmtDate(v.ts))}</small></li>`).join('')}</ul>` : '<p class="empty small">No vibes yet.</p>'}
    </section>
    <p class="note small">Counts are anonymous — no names, emails or exact locations are stored. Events older than 180 days are deleted automatically. For page views and traffic sources, see Google Analytics.</p>`;
}

// ── AI & Costs ──────────────────────────────────────────────────────────────
async function viewAi({ env }) {
  const s = await getSettings(env);
  const h = db(env);
  let stats = '';
  if (!h) stats = d1Missing;
  else {
    await h.ready;
    const days = lastDays(30);
    const rows = (await h.d.prepare('SELECT * FROM daily WHERE day >= ?').bind(days[0]).all()).results || [];
    const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
    const td = byDay[today()] || {};
    const month = today().slice(0, 7);
    const mtd = rows.filter(r => r.day.startsWith(month)).reduce((a, r) => a + costOf(r.in_tokens, r.out_tokens), 0);
    const last30 = rows.reduce((a, r) => a + costOf(r.in_tokens, r.out_tokens), 0);
    const usedPct = s.aiDailyCap ? Math.min(100, Math.round(((td.ai_calls || 0) / s.aiDailyCap) * 100)) : 0;
    stats = `
      <div class="tiles">
        <div class="tile"><div class="big">${(td.ai_calls || 0).toLocaleString()}</div><div class="cap">AI calls today${s.aiDailyCap ? ` of ${s.aiDailyCap.toLocaleString()}` : ''}</div>
          ${s.aiDailyCap ? `<div class="meter" title="${usedPct}% of today's cap"><span style="width:${usedPct}%"></span></div>` : ''}</div>
        <div class="tile"><div class="big">${money(costOf(td.in_tokens || 0, td.out_tokens || 0))}</div><div class="cap">Est. cost today</div></div>
        <div class="tile"><div class="big">${money(mtd)}</div><div class="cap">Est. cost this month</div></div>
        <div class="tile"><div class="big">${(td.fallbacks || 0).toLocaleString()}</div><div class="cap">Picks without AI today</div></div>
      </div>
      <section class="card"><h3>AI calls per day</h3>${dayColumns(days, byDay, r => r.ai_calls || 0)}</section>
      <section class="card"><h3>Estimated cost per day</h3>${dayColumns(days, byDay, r => costOf(r.in_tokens || 0, r.out_tokens || 0), money)}
        <p class="note small">Last 30 days: <b>${money(last30)}</b>. Estimates use Claude Haiku 4.5 list prices ($1 per million input tokens, $5 per million output). Your Anthropic console has the exact bill.</p></section>
      <section class="card"><h3>Last 14 days</h3>
        <table><thead><tr><th>Day</th><th>Picks</th><th>AI calls</th><th>Translations</th><th>No-AI picks</th><th>Rate-limited</th><th>Est. cost</th></tr></thead>
        <tbody>${lastDays(14).reverse().map(d => { const r = byDay[d] || {}; return `<tr><td>${esc(new Date(d + 'T12:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</td><td>${r.picks || 0}</td><td>${r.ai_calls || 0}</td><td>${r.translations || 0}</td><td>${r.fallbacks || 0}</td><td>${r.blocked || 0}</td><td>${money(costOf(r.in_tokens || 0, r.out_tokens || 0))}</td></tr>`; }).join('')}</tbody></table>
      </section>`;
  }
  return `
    <section class="card">
      <h3>Controls</h3>
      <form method="post" class="settings">
        <input type="hidden" name="back" value="/admin?tab=ai">
        <label class="switch"><input type="checkbox" name="aiEnabled"${s.aiEnabled ? ' checked' : ''}> <span><b>AI picks on</b> — when off, picks use the highest-rated nearby places instead (free), and new translations pause.</span></label>
        <label>Daily AI call limit <input type="number" name="aiDailyCap" min="0" max="100000" value="${s.aiDailyCap}"> <small>0 = no limit. When reached, picks fall back to top-rated until midnight UTC.</small></label>
        <label>Picks per visitor per hour <input type="number" name="picksPerHour" min="0" max="1000" value="${s.picksPerHour}"> <small>Stops one person (or bot) from running up your bill. 0 = no limit. Default ${DEFAULT_SETTINGS.picksPerHour}.</small></label>
        <button name="action" value="ai-settings" class="primary">Save</button>
      </form>
    </section>
    ${stats}`;
}

// ── Banner ──────────────────────────────────────────────────────────────────
async function viewBanner({ env }) {
  const b = (await getSettings(env)).banner;
  return `
    <section class="card">
      <h3>Announcement banner</h3>
      <p class="note small">Shows at the top of idkpicker.com for everyone until you turn it off. Visitors can dismiss it; changing the text shows it to them again.</p>
      <form method="post" class="settings" id="bannerForm">
        <input type="hidden" name="back" value="/admin?tab=banner">
        <label class="switch"><input type="checkbox" name="active"${b.active ? ' checked' : ''}> <span><b>Show banner</b></span></label>
        <label>Message <input type="text" name="text" maxlength="200" value="${esc(b.text)}" placeholder="New: kilometers and 60+ languages! 🌍"></label>
        <label>Link <small>(optional)</small> <input type="url" name="link" value="${esc(b.link)}" placeholder="https://…"></label>
        <label>Style <select name="style">
          ${[['info', 'Soft (default)'], ['promo', 'Bold orange'], ['warn', 'Heads-up (yellow)']].map(([k, l]) => `<option value="${k}"${b.style === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <div class="previewwrap"><span class="small">Preview</span><div class="site-banner" id="pv"><span id="pvText"></span><span>✕</span></div></div>
        <button name="action" value="banner" class="primary">Save banner</button>
      </form>
      <p class="note small">The banner text is shown as written (it isn't translated), so keep it short and simple.</p>
    </section>
    <script>
      const f = document.getElementById('bannerForm'), pv = document.getElementById('pv'), pt = document.getElementById('pvText');
      function upd() { pt.textContent = (f.text.value || 'Your message here') + (f.link.value ? ' →' : ''); pv.className = 'site-banner ' + f.style.value; pv.style.opacity = f.active.checked ? 1 : .45; }
      f.addEventListener('input', upd); upd();
    </script>`;
}

// ── Translations ────────────────────────────────────────────────────────────
async function viewTranslations({ env }, url) {
  const { EN, version } = await englishSource(env, url.origin);
  const edit = url.searchParams.get('lang');
  if (edit && /^[a-z]{2,3}(-(Hans|Hant|[A-Z]{2}))?$/.test(edit)) {
    const base = await baseTranslation(env, url.origin, edit, version);
    const ovr = await overrides(env, edit);
    if (!base && !Object.keys(ovr.d).length) return `<p class="note">${esc(langName(edit))} hasn't been translated yet — it will be the first time someone visits in that language. <a href="/admin?tab=translations">← Back</a></p>`;
    const keys = Object.keys(EN);
    return `
      <p><a href="/admin?tab=translations">← All languages</a></p>
      <h3>${esc(langName(edit))} <small>(${esc(edit)}) · ${STATIC_LANGS.includes(edit) ? 'built-in' : 'AI-translated'} · ${Object.keys(ovr.d).length} line(s) edited by you</small></h3>
      <div class="filters"><input type="search" id="q" placeholder="Find a line…" aria-label="Find a line"><label class="small"><input type="checkbox" id="onlyEdited"> Only my edits</label></div>
      <p class="note small">Keep anything in <code>{curly braces}</code> and HTML tags like <code>&lt;strong&gt;</code> exactly as they are. Changes go live within an hour (visitors' browsers refresh their copy daily).</p>
      <form method="post">
        <input type="hidden" name="lang" value="${esc(edit)}"><input type="hidden" name="back" value="/admin?tab=translations&lang=${esc(edit)}">
        <table class="tr"><thead><tr><th>English</th><th>${esc(langName(edit))}</th></tr></thead><tbody>
        ${keys.map(k => {
          const cur = ovr.d[k] ?? base?.[k] ?? '';
          const edited = k in ovr.d;
          return `<tr data-s="${esc((k + ' ' + EN[k] + ' ' + cur).toLowerCase())}" data-edited="${edited ? 1 : 0}"><td><code>${esc(k)}</code><div>${esc(EN[k])}</div></td>
            <td><textarea name="k:${esc(k)}" rows="${Math.min(6, Math.ceil(cur.length / 60) || 1)}"${edited ? ' class="edited"' : ''}${cur ? '' : ' placeholder="(missing — English is shown)"'}>${esc(cur)}</textarea></td></tr>`;
        }).join('')}
        </tbody></table>
        <div class="stickybar">
          <button name="action" value="i18n-save" class="primary">Save changes</button>
          ${Object.keys(ovr.d).length ? `<button name="action" value="i18n-reset" onclick="return confirm('Remove all your edits to this language?')">Undo all my edits</button>` : ''}
          ${STATIC_LANGS.includes(edit) ? '' : `<button name="action" value="i18n-retranslate" onclick="return confirm('Ask the AI to translate this language again from scratch? Your edits are kept.')">Re-translate with AI</button>`}
        </div>
      </form>
      <script>
        const q = document.getElementById('q'), oe = document.getElementById('onlyEdited');
        function f() { const s = q.value.toLowerCase(); document.querySelectorAll('table.tr tbody tr').forEach(r => { r.hidden = (s && !r.dataset.s.includes(s)) || (oe.checked && r.dataset.edited !== '1'); }); }
        q.addEventListener('input', f); oe.addEventListener('change', f);
      </script>`;
  }

  // Overview: built-in + AI-cached languages, plus demand from usage events
  const kv = env.FEEDBACK_KV;
  const cached = (await kv.list({ prefix: 'i18n:' })).keys.map(k => k.name.split(':')).filter(p => p[2] === version).map(p => p[1]);
  const edited = (await kv.list({ prefix: 'i18n-ovr:' })).keys.map(k => k.name.slice(9));
  let demand = {};
  const h = db(env);
  if (h) {
    await h.ready;
    const rows = (await h.d.prepare(`SELECT COALESCE(lang,'en') lang, COUNT(*) n FROM events WHERE kind='pick' AND day >= ? GROUP BY lang`).bind(lastDays(30)[0]).all()).results || [];
    demand = Object.fromEntries(rows.map(r => [r.lang, r.n]));
  }
  const langs = [...new Set([...STATIC_LANGS, ...cached, ...Object.keys(demand).filter(l => l !== 'en')])];
  const ovrCounts = Object.fromEntries(await Promise.all(edited.map(async l => [l, Object.keys((await overrides(env, l)).d).length])));
  langs.sort((a, b) => (demand[b] || 0) - (demand[a] || 0) || langName(a).localeCompare(langName(b)));

  return `
    <section class="card">
      <h3>Languages</h3>
      <p class="note small">Spanish, French, German and Portuguese are built in. Every other language is translated by AI the first time someone uses it, then saved. Click a language to fix any line.</p>
      <table><thead><tr><th>Language</th><th>Source</th><th>Picks (30 days)</th><th>Your edits</th><th></th></tr></thead><tbody>
      ${langs.map(l => `<tr><td><b>${esc(langName(l))}</b> <small>${esc(l)}</small></td>
        <td>${STATIC_LANGS.includes(l) ? 'Built-in' : cached.includes(l) ? 'AI' : '<span class="muted">Not translated yet</span>'}</td>
        <td>${(demand[l] || 0).toLocaleString()}</td><td>${ovrCounts[l] || '—'}</td>
        <td>${STATIC_LANGS.includes(l) || cached.includes(l) ? `<a class="btn" href="/admin?tab=translations&lang=${encodeURIComponent(l)}">Review / edit</a>` : ''}</td></tr>`).join('')}
      </tbody></table>
      <p class="note small">English picks (30 days): ${(demand.en || 0).toLocaleString()}. English text lives in the site code — ask Claude to change it.</p>
    </section>`;
}

// ── layout ──────────────────────────────────────────────────────────────────
function page(tab, msg, body) {
  const tabs = [['requests', '📬 Requests'], ['usage', '📊 Usage'], ['ai', '🤖 AI & Costs'], ['banner', '📣 Banner'], ['translations', '🌍 Translations']];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>IDKPicker Admin</title>
<style>
  :root { --bg:#FFF8F0; --surface:#fff; --text:#1A1108; --mid:#5C4A35; --muted:#8a735a; --border:#F0E4D4; --accent:#FF5C35; --accent-dim:rgba(255,92,53,.12); --track:#F6EDE2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17120d; --surface:#221a13; --text:#f5ece2; --mid:#d9c8b4; --muted:#b09a82; --border:#3a2e22; --accent:#FF7A57; --accent-dim:rgba(255,122,87,.16); --track:#2e241b; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,sans-serif; }
  main { max-width:900px; margin:0 auto; padding:20px 16px 80px; }
  h1 { font-size:1.4rem; margin:0 0 12px; } h1 span, a { color:var(--accent); } h3 { margin:0 0 10px; font-size:1rem; } h3 small { color:var(--muted); font-weight:500; }
  .tabs { display:flex; gap:4px; overflow-x:auto; border-bottom:1.5px solid var(--border); margin-bottom:16px; }
  .tabs a { padding:8px 12px; text-decoration:none; color:var(--mid); font-weight:600; white-space:nowrap; border-bottom:2.5px solid transparent; margin-bottom:-1.5px; }
  .tabs a.on { color:var(--text); border-color:var(--accent); }
  .flash { background:var(--accent-dim); border:1.5px solid var(--accent); padding:8px 12px; border-radius:10px; margin-bottom:14px; font-weight:600; }
  .pills { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
  .pills a { padding:5px 12px; border-radius:999px; border:1.5px solid var(--border); color:var(--text); text-decoration:none; font-weight:600; font-size:.85rem; }
  .pills a span { color:var(--muted); font-weight:500; } .pills a.on { background:var(--accent); border-color:var(--accent); color:#fff; } .pills a.on span { color:#fff; }
  .right { margin-left:auto; }
  .filters { display:flex; gap:8px; margin-bottom:12px; align-items:center; flex-wrap:wrap; }
  input, select, textarea { font:inherit; color:var(--text); background:var(--surface); border:1.5px solid var(--border); border-radius:8px; padding:6px 10px; }
  input[type=search] { flex:1; min-width:180px; } textarea { width:100%; resize:vertical; }
  .item, .card { background:var(--surface); border:1.5px solid var(--border); border-radius:14px; padding:14px 16px; margin-bottom:12px; }
  .item.st-closed, .item.st-shipped { opacity:.65; }
  .meta, .small, small { color:var(--muted); font-size:.8rem; }
  .msg { white-space:pre-wrap; margin:8px 0; word-break:break-word; }
  .reply { font-size:.85rem; color:var(--mid); border-left:3px solid var(--border); padding-left:8px; margin:6px 0; white-space:pre-wrap; }
  .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; } form.inline { display:inline; }
  button, .btn { font:inherit; font-size:.82rem; font-weight:600; padding:6px 12px; border-radius:8px; border:1.5px solid var(--border); background:transparent; color:var(--text); cursor:pointer; text-decoration:none; display:inline-block; }
  button:hover, .btn:hover { border-color:var(--accent); } button:disabled { opacity:.5; cursor:not-allowed; }
  .primary { background:var(--accent); border-color:var(--accent); color:#fff; } .del { color:#c0392b; }
  details.replybox { margin-top:8px; } details summary { cursor:pointer; color:var(--accent); font-weight:600; font-size:.85rem; }
  details form { display:flex; flex-direction:column; gap:8px; margin-top:8px; align-items:flex-start; }
  .empty { color:var(--muted); text-align:center; padding:30px 0; } .empty.small { padding:8px 0; text-align:left; }
  .note { background:var(--track); border-radius:10px; padding:10px 12px; } .note.small { background:none; padding:0; } .err { color:#c0392b; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:12px; }
  .tile { background:var(--surface); border:1.5px solid var(--border); border-radius:14px; padding:12px 14px; }
  .tile .big { font-size:1.6rem; font-weight:800; } .tile .cap { color:var(--muted); font-size:.8rem; }
  .meter { height:6px; background:var(--track); border-radius:4px; margin-top:6px; overflow:hidden; } .meter span { display:block; height:100%; background:var(--accent); border-radius:4px; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; } .grid2 .card { margin:0; } .grid2 + * { margin-top:12px; }
  .bars { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
  .bars li { display:grid; grid-template-columns:minmax(0,40%) 1fr auto; gap:8px; align-items:center; font-size:.85rem; }
  .bars .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .bars .val { color:var(--mid); font-variant-numeric:tabular-nums; }
  .bars .track { height:10px; background:var(--track); border-radius:4px; overflow:hidden; }
  .bars .fill { display:block; height:100%; background:var(--accent); border-radius:0 4px 4px 0; }
  .bars li:hover .fill { filter:brightness(1.1); }
  .cols { display:flex; align-items:flex-end; gap:2px; height:120px; border-bottom:1px solid var(--border); }
  .col { flex:1; height:100%; display:flex; align-items:flex-end; cursor:default; } .col:hover { background:var(--track); }
  .col .bar { display:block; width:100%; background:var(--accent); border-radius:4px 4px 0 0; }
  .axis { display:flex; justify-content:space-between; color:var(--muted); font-size:.75rem; margin-top:4px; }
  .vibes { list-style:none; padding:0; margin:0; display:grid; gap:6px; } .vibes li { display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border); padding-bottom:6px; } .vibes small { white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; } th { color:var(--muted); font-weight:600; }
  td { font-variant-numeric:tabular-nums; } .muted { color:var(--muted); }
  table.tr td:first-child { width:45%; } table.tr code { color:var(--muted); font-size:.72rem; } table.tr textarea.edited { border-color:var(--accent); }
  .settings { display:flex; flex-direction:column; gap:12px; align-items:flex-start; } .settings label { display:flex; flex-direction:column; gap:4px; font-weight:600; width:100%; max-width:520px; }
  .settings small { font-weight:400; }
  .settings label.switch { flex-direction:row; align-items:flex-start; gap:10px; font-weight:400; } .settings input[type=checkbox] { width:18px; height:18px; margin-top:2px; }
  .stickybar { position:sticky; bottom:0; background:var(--bg); padding:10px 0; display:flex; gap:8px; flex-wrap:wrap; border-top:1.5px solid var(--border); }
  .previewwrap { width:100%; max-width:520px; } .site-banner { display:flex; gap:12px; background:var(--accent-dim); border:1.5px solid var(--accent); border-radius:10px; padding:8px 12px; font-weight:700; font-size:.86rem; margin-top:4px; }
  .site-banner span:first-child { flex:1; } .site-banner.promo { background:var(--accent); color:#fff; } .site-banner.warn { background:rgba(245,158,11,.12); border-color:#F59E0B; }
  code { font-size:.85em; }
</style></head><body><main>
  <h1>IDK<span>Picker</span> admin</h1>
  <nav class="tabs">${tabs.map(([k, l]) => `<a href="/admin?tab=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
  ${msg ? `<div class="flash" role="status">${esc(msg)}</div>` : ''}
  ${body}
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } });
}
