// GET /api/region?lat=..&lng=.. — which country/region a spot is in, for the
// "switch to the local language?" prompt. Uses Google's Geocoding API when the
// key allows it, otherwise falls back to the visitor's IP location from Cloudflare.

const json = obj => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' } });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  const ipGuess = { country: request.cf?.country || null, region: request.cf?.regionCode || null, source: 'ip' };
  if (!isFinite(lat) || !isFinite(lng) || !env.GOOGLE_PLACES_KEY) return json(ipGuess);

  try {
    const g = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    g.searchParams.set('latlng', `${lat.toFixed(4)},${lng.toFixed(4)}`);
    g.searchParams.set('result_type', 'administrative_area_level_1|country');
    g.searchParams.set('key', env.GOOGLE_PLACES_KEY);
    const data = await (await fetch(g)).json();
    if (data.status !== 'OK') return json(ipGuess);
    const comps = data.results.flatMap(r => r.address_components || []);
    const country = comps.find(c => c.types.includes('country'))?.short_name || null;
    const region = comps.find(c => c.types.includes('administrative_area_level_1'))?.short_name || null;
    return json(country ? { country, region, source: 'geocode' } : ipGuess);
  } catch {
    return json(ipGuess);
  }
}
