type ApiResponse = { status: (code: number) => { json: (body: unknown) => void }; setHeader: (name: string, value: string) => void };
type ApiRequest = { query?: Record<string, string | string[] | undefined> };

let token = '';
let expiresAt = 0;

type AircraftPayload = {
  source: 'OpenSky';
  observedAt: number;
  bounds: { lamin: number; lomin: number; lamax: number; lomax: number };
  states: Record<string, unknown>[];
};

const regionCache = new Map<string, { expiresAt: number; payload: AircraftPayload }>();
const pendingRegions = new Map<string, Promise<AircraftPayload>>();
const cacheLifetime = 26_000;

async function accessToken() {
  if (token && Date.now() < expiresAt) return token;
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw Error('OpenSky credentials are not configured');
  const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw Error('OpenSky token request failed');
  const body = await response.json() as { access_token: string; expires_in?: number };
  token = body.access_token;
  expiresAt = Date.now() + ((body.expires_in ?? 1800) - 45) * 1000;
  return token;
}

const scalar = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const positionSources = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];

function sharedRegion(lamin: number, lomin: number, lamax: number, lomax: number) {
  const requestedLatitude = (lamin + lamax) / 2;
  const requestedLongitude = (lomin + lomax) / 2;
  const latitude = Math.max(-80, Math.min(80, Math.round(requestedLatitude / 5) * 5));
  const longitude = Math.max(-170, Math.min(170, Math.round(requestedLongitude / 5) * 5));
  return { key: `${latitude}:${longitude}`, bounds: { lamin: latitude - 10, lomin: longitude - 10, lamax: latitude + 10, lomax: longitude + 10 } };
}

async function retrieveRegion(key: string, bounds: AircraftPayload['bounds']) {
  const cached = regionCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.payload;
  const inFlight = pendingRegions.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(bounds).map(([name, value]) => [name, String(value)])), extended: '1' });
    const upstream = await fetch(`https://opensky-network.org/api/states/all?${query}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!upstream.ok) throw Error(`OpenSky returned ${upstream.status}`);
    const body = await upstream.json() as { time: number; states: Array<(string | number | boolean | null)[]> | null };
    const states = (body.states ?? []).map(row => ({
      icao24: row[0], callsign: typeof row[1] === 'string' ? row[1].trim() : null, country: row[2],
      positionTime: row[3], lastContact: row[4], longitude: row[5], latitude: row[6],
      barometricAltitude: row[7], onGround: row[8], velocity: row[9], trueTrack: row[10],
      verticalRate: row[11], geometricAltitude: row[13],
      positionSource: typeof row[16] === 'number' ? positionSources[row[16]] ?? `SOURCE ${row[16]}` : null,
      category: row[17],
    })).filter(item => typeof item.icao24 === 'string' && typeof item.country === 'string' && typeof item.longitude === 'number' && typeof item.latitude === 'number' && (typeof item.geometricAltitude === 'number' || typeof item.barometricAltitude === 'number'));
    const payload: AircraftPayload = { source: 'OpenSky', observedAt: body.time, bounds, states };
    regionCache.set(key, { expiresAt: Date.now() + cacheLifetime, payload });
    for (const [cachedKey, value] of regionCache) if (Date.now() >= value.expiresAt) regionCache.delete(cachedKey);
    return payload;
  })();
  pendingRegions.set(key, request);
  try { return await request; } finally { pendingRegions.delete(key); }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const values = ['lamin', 'lomin', 'lamax', 'lomax'].map(key => Number(scalar(request.query?.[key])));
    const [lamin, lomin, lamax, lomax] = values;
    if (values.some(value => !Number.isFinite(value)) || lamin < -90 || lamax > 90 || lomin < -180 || lomax > 180 || lamin >= lamax || lomin >= lomax || (lamax - lamin) * (lomax - lomin) > 900) throw Error('Invalid bounding box');
    const region = sharedRegion(lamin, lomin, lamax, lomax);
    response.setHeader('cache-control', 's-maxage=26, stale-while-revalidate=12');
    response.status(200).json(await retrieveRegion(region.key, region.bounds));
  } catch {
    response.status(503).json({ error: 'ADS-B UNAVAILABLE', states: [] });
  }
}
