exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let params;
  try {
    params = JSON.parse(event.body);
    if (!params.lat || !params.lng) throw new Error('Missing location');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Google Places API key' }) };
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
      return { statusCode: 502, body: JSON.stringify({ error: `Google Places error: ${data.status}` }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Google Places API' }) };
  }
};
