export async function onRequestGet(context) {
  const placeId = new URL(context.request.url).searchParams.get('place_id') || '';
  if (!placeId) {
    return new Response(JSON.stringify({ error: 'Missing place_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = context.env.GOOGLE_PLACES_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'geometry,formatted_address');
  url.searchParams.set('key', apiKey);

  try {
    const resp = await fetch(url.toString());
    const data = await resp.json();
    const loc = data.result?.geometry?.location;
    if (!loc) throw new Error('No geometry in response');
    return new Response(JSON.stringify({
      lat: loc.lat,
      lng: loc.lng,
      name: data.result.formatted_address,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Geocode request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
