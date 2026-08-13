const providers = [
  ['adsb.lol', (lat: number, lon: number) => `https://api.adsb.lol/v2/point/${lat}/${lon}/250`],
  ['adsb.fi', (lat: number, lon: number) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/250`],
  ['Airplanes.live', (lat: number, lon: number) => `https://api.airplanes.live/v2/point/${lat}/${lon}/250`],
] as const;

async function probe(name: string, url: string) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { provider: name, reachable: true, status: response.status, aircraft: 0 };
    const body = await response.json() as { ac?: unknown; aircraft?: unknown };
    const aircraft = Array.isArray(body.ac) ? body.ac.length : Array.isArray(body.aircraft) ? body.aircraft.length : 0;
    return { provider: name, reachable: true, status: response.status, aircraft };
  } catch {
    return { provider: name, reachable: false, networkCode: 'FETCH_ERROR', aircraft: 0 };
  }
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (request.method !== 'GET' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return Response.json({ error: 'INVALID REQUEST' }, { status: 400 });
    }
    return Response.json({ results: await Promise.all(providers.map(([name, endpoint]) => probe(name, endpoint(lat, lon)))) }, {
      headers: { 'cache-control': 'no-store' },
    });
  },
};
