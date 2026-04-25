export async function onRequestGet(context) {
  const input = new URL(context.request.url).searchParams.get('input') || '';
  if (input.length < 2) {
    return new Response(JSON.stringify({ predictions: [] }), {
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

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', input);
  url.searchParams.set('types', '(cities)');
  url.searchParams.set('key', apiKey);

  try {
    const resp = await fetch(url.toString());
    const data = await resp.json();
    return new Response(JSON.stringify({ predictions: data.predictions || [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Autocomplete request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
