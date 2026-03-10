export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let params;
  try {
    params = await req.json();
    if (!params.lat || !params.lng) throw new Error('Missing location');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing Google API key' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
    url.searchParams.set('location', `${params.lat},${params.lng}`);
    url.searchParams.set('radius', params.radius || 1600);
    url.searchParams.set('type', 'restaurant');
    url.searchParams.set('key', apiKey);
    if (params.keyword) url.searchParams.set('keyword', params.keyword);
    if (params.minprice !== undefined) url.searchParams.set('minprice', params.minprice);
    if (params.maxprice !== undefined) url.searchParams.set('maxprice', params.maxprice);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return new Response(JSON.stringify({ error: `Google Places error: ${data.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to reach Google Places API' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/places' };
