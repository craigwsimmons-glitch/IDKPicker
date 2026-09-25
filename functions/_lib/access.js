// Cloudflare Access (Zero Trust) login check for /admin.
// When ACCESS_TEAM_DOMAIN (e.g. "craig.cloudflareaccess.com") and ADMIN_EMAILS
// (comma-separated) are set, /admin requires a valid Access login from one of those
// emails and the password prompt is skipped. ACCESS_AUD (the application's Audience
// tag) is optional — if set, tokens from other Access apps in the team are refused too.

let certCache = { at: 0, keys: [] };

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const parse = s => JSON.parse(new TextDecoder().decode(b64url(s)));

async function keys(team) {
  if (Date.now() - certCache.at < 3600e3 && certCache.team === team) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const { keys = [] } = await r.json();
  certCache = { at: Date.now(), team, keys };
  return keys;
}

const allowList = env => String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
export const accessEnabled = env => !!(env.ACCESS_TEAM_DOMAIN && allowList(env).length);

// Returns the signed-in email, or null.
export async function accessUser(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
    || (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = parse(h), payload = parse(p);
    const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const jwk = (await keys(team)).find(k => k.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const now = Date.now() / 1000;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;
    if (!(payload.exp > now) || payload.iss !== `https://${team}`) return null;
    const email = String(payload.email || '').toLowerCase();
    if (!email || !allowList(env).includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}
