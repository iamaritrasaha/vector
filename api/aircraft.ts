type ProviderName = 'adsb.lol' | 'adsb.fi' | 'Airplanes.live' | 'OpenSky';

type AircraftState = {
  icao24: string;
  callsign: string | null;
  country: string | null;
  positionTime: number;
  lastContact: number | null;
  longitude: number;
  latitude: number;
  barometricAltitude: number | null;
  geometricAltitude: number | null;
  onGround: boolean | null;
  velocity: number | null;
  trueTrack: number | null;
  verticalRate: number | null;
  positionSource: string | null;
  category: number | null;
};

type AircraftPayload = {
  source: ProviderName;
  provider: ProviderName;
  observedAt: number;
  bounds: { lamin: number; lomin: number; lamax: number; lomax: number };
  states: AircraftState[];
};

type Region = {
  key: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
  bounds: AircraftPayload['bounds'];
};

type ProviderAdapter = {
  name: ProviderName;
  code: string;
  minimumIntervalMs: number;
  url(region: Region): string;
};

const regionCache = new Map<string, { expiresAt: number; payload: AircraftPayload }>();
const pendingRegions = new Map<string, Promise<AircraftPayload>>();
const providerQueues = new Map<ProviderName, Promise<void>>();
const providerLastRequestAt = new Map<ProviderName, number>();
const cacheLifetime = 26_000;
const requestTimeout = 3_500;
const feetToMetres = 0.3048;
const knotsToMetresPerSecond = 0.514444;
const feetPerMinuteToMetresPerSecond = 0.00508;

const productionProviders: ProviderAdapter[] = [
  {
    name: 'adsb.lol',
    code: 'ADSB_LOL',
    minimumIntervalMs: 1_000,
    url: region => `https://api.adsb.lol/v2/point/${region.latitude}/${region.longitude}/${region.radiusNm}`,
  },
  {
    name: 'adsb.fi',
    code: 'ADSB_FI',
    minimumIntervalMs: 1_100,
    url: region => `https://opendata.adsb.fi/api/v3/lat/${region.latitude}/lon/${region.longitude}/dist/${region.radiusNm}`,
  },
];

const airplanesLiveProvider: ProviderAdapter = {
  name: 'Airplanes.live',
  code: 'AIRPLANES_LIVE',
  minimumIntervalMs: 1_100,
  url: region => `https://api.airplanes.live/v2/point/${region.latitude}/${region.longitude}/${region.radiusNm}`,
};

class ProviderError extends Error {
  constructor(public code: string, public status?: number) {
    super(code);
  }
}

function safeErrorInformation(error: unknown) {
  if (error instanceof ProviderError) {
    return error.status === undefined ? { code: error.code } : { code: error.code, status: error.status };
  }
  return { code: 'AIRCRAFT_UNEXPECTED_ERROR' };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function secondsFromProviderTimestamp(value: unknown): number | null {
  const timestamp = finiteNumber(value);
  if (timestamp === null || timestamp <= 0) return null;
  return timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp;
}

function converted(value: unknown, factor: number): number | null {
  const number = finiteNumber(value);
  return number === null ? null : number * factor;
}

function emitterCategory(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const categories: Record<string, number> = {
    A0: 1, A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8,
    B0: 1, B1: 9, B2: 10, B3: 11, B4: 12, B5: 13, B6: 14, B7: 15,
    C0: 1, C1: 16, C2: 17, C3: 18, C4: 19, C5: 20, C6: 13, C7: 13,
    D0: 1, D1: 13, D2: 13, D3: 13, D4: 13, D5: 13, D6: 13, D7: 13,
  };
  return categories[value.toUpperCase()] ?? null;
}

function fieldsInclude(value: unknown, field: string) {
  return Array.isArray(value) && value.includes(field);
}

function positionSource(item: Record<string, unknown>): string | null {
  if (fieldsInclude(item.mlat, 'lat') || fieldsInclude(item.mlat, 'lon')) return 'MLAT';
  if (fieldsInclude(item.tisb, 'lat') || fieldsInclude(item.tisb, 'lon')) return 'TIS-B';
  if (typeof item.type !== 'string') return null;
  const sources: Record<string, string> = {
    adsb_icao: 'ADS-B',
    adsb_other: 'ADS-B',
    adsr_icao: 'ADS-R',
    adsr_other: 'ADS-R',
    tisb_icao: 'TIS-B',
    tisb_other: 'TIS-B',
    tisb_trackfile: 'TIS-B',
    adsc: 'ADS-C',
    mode_s: 'MODE-S',
    other: 'OTHER',
  };
  return sources[item.type] ?? null;
}

function normalizeReadsbAircraft(item: unknown, observedAt: number): AircraftState | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const aircraft = item as Record<string, unknown>;
  const icao24 = typeof aircraft.hex === 'string' ? aircraft.hex.trim().toLowerCase() : '';
  const latitude = finiteNumber(aircraft.lat);
  const longitude = finiteNumber(aircraft.lon);
  const seenPosition = finiteNumber(aircraft.seen_pos);
  if (!/^[0-9a-f]{6}$/.test(icao24) || latitude === null || longitude === null || seenPosition === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || seenPosition < 0) return null;

  const callsign = typeof aircraft.flight === 'string' && aircraft.flight.trim() ? aircraft.flight.trim() : null;
  const seen = finiteNumber(aircraft.seen);
  const track = finiteNumber(aircraft.track);
  const barometricFeet = finiteNumber(aircraft.alt_baro);
  const geometricFeet = finiteNumber(aircraft.alt_geom);
  const verticalFeetPerMinute = finiteNumber(aircraft.baro_rate) ?? finiteNumber(aircraft.geom_rate);

  return {
    icao24,
    callsign,
    country: null,
    positionTime: observedAt - seenPosition,
    lastContact: seen === null || seen < 0 ? null : observedAt - seen,
    longitude,
    latitude,
    barometricAltitude: barometricFeet === null ? null : barometricFeet * feetToMetres,
    geometricAltitude: geometricFeet === null ? null : geometricFeet * feetToMetres,
    onGround: aircraft.alt_baro === 'ground' ? true : barometricFeet === null ? null : false,
    velocity: converted(aircraft.gs, knotsToMetresPerSecond),
    trueTrack: track !== null && track >= 0 && track < 360 ? track : null,
    verticalRate: verticalFeetPerMinute === null ? null : verticalFeetPerMinute * feetPerMinuteToMetresPerSecond,
    positionSource: positionSource(aircraft),
    category: emitterCategory(aircraft.category),
  };
}

async function rateLimitedFetch(adapter: ProviderAdapter, url: string) {
  const previous = providerQueues.get(adapter.name) ?? Promise.resolve();
  const request = previous.catch(() => undefined).then(async () => {
    const elapsed = Date.now() - (providerLastRequestAt.get(adapter.name) ?? 0);
    const delay = Math.max(0, adapter.minimumIntervalMs - elapsed);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    providerLastRequestAt.set(adapter.name, Date.now());
    try {
      return await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeout),
      });
    } catch {
      throw new ProviderError(`${adapter.code}_NETWORK_ERROR`);
    }
  });
  providerQueues.set(adapter.name, request.then(() => undefined, () => undefined));
  return request;
}

async function retrieveReadsb(adapter: ProviderAdapter, region: Region): Promise<AircraftPayload> {
  const response = await rateLimitedFetch(adapter, adapter.url(region));
  console.info('[VECTOR aircraft]', { provider: adapter.name, requestStatus: response.status });
  if (!response.ok) throw new ProviderError(`${adapter.code}_HTTP_${response.status}`, response.status);

  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    throw new ProviderError(`${adapter.code}_INVALID_RESPONSE`);
  }

  const observedAt = secondsFromProviderTimestamp(body.now);
  const rows = Array.isArray(body.ac) ? body.ac : Array.isArray(body.aircraft) ? body.aircraft : null;
  if (observedAt === null || rows === null) throw new ProviderError(`${adapter.code}_INVALID_RESPONSE`);
  const states = rows.map(item => normalizeReadsbAircraft(item, observedAt)).filter((item): item is AircraftState => item !== null);
  if (rows.length > 0 && states.length === 0) throw new ProviderError(`${adapter.code}_NORMALIZATION_EMPTY`);

  console.info('[VECTOR aircraft]', { provider: adapter.name, upstreamAircraft: rows.length, normalizedAircraft: states.length });
  return { source: adapter.name, provider: adapter.name, observedAt, bounds: region.bounds, states };
}

let token = '';
let expiresAt = 0;

async function accessToken() {
  if (token && Date.now() < expiresAt) return token;
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  console.info('[VECTOR aircraft]', {
    provider: 'OpenSky',
    clientIdConfigured: Boolean(clientId),
    clientSecretConfigured: Boolean(clientSecret),
  });
  if (!clientId || !clientSecret) throw new ProviderError('OPENSKY_CREDENTIALS_MISSING');

  let response: Response;
  try {
    response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch {
    throw new ProviderError('OPENSKY_TOKEN_NETWORK_ERROR');
  }
  console.info('[VECTOR aircraft]', { provider: 'OpenSky', tokenRequestStatus: response.status });
  if (!response.ok) throw new ProviderError(`OPENSKY_TOKEN_HTTP_${response.status}`, response.status);

  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = await response.json() as { access_token?: unknown; expires_in?: unknown };
  } catch {
    throw new ProviderError('OPENSKY_TOKEN_INVALID_RESPONSE');
  }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new ProviderError('OPENSKY_TOKEN_INVALID_RESPONSE');
  token = body.access_token;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 1800;
  expiresAt = Date.now() + Math.max(60, expiresIn - 45) * 1000;
  return token;
}

const openSkyPositionSources = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];

async function retrieveOpenSky(region: Region): Promise<AircraftPayload> {
  const query = new URLSearchParams({
    lamin: String(region.bounds.lamin),
    lomin: String(region.bounds.lomin),
    lamax: String(region.bounds.lamax),
    lomax: String(region.bounds.lomax),
    extended: '1',
  });
  const bearerToken = await accessToken();
  let response: Response;
  try {
    response = await fetch(`https://opensky-network.org/api/states/all?${query}`, {
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch {
    throw new ProviderError('OPENSKY_STATES_NETWORK_ERROR');
  }
  console.info('[VECTOR aircraft]', { provider: 'OpenSky', requestStatus: response.status });
  if (!response.ok) throw new ProviderError(`OPENSKY_STATES_HTTP_${response.status}`, response.status);

  let body: { time?: unknown; states?: unknown };
  try {
    body = await response.json() as { time?: unknown; states?: unknown };
  } catch {
    throw new ProviderError('OPENSKY_STATES_INVALID_RESPONSE');
  }
  const observedAt = secondsFromProviderTimestamp(body.time);
  if (observedAt === null || (!Array.isArray(body.states) && body.states !== null)) throw new ProviderError('OPENSKY_STATES_INVALID_RESPONSE');
  const rows = Array.isArray(body.states) ? body.states : [];
  const states = rows.map(row => {
    if (!Array.isArray(row)) return null;
    const icao24 = typeof row[0] === 'string' ? row[0].toLowerCase() : '';
    const positionTime = finiteNumber(row[3]);
    const longitude = finiteNumber(row[5]);
    const latitude = finiteNumber(row[6]);
    if (!/^[0-9a-f]{6}$/.test(icao24) || positionTime === null || longitude === null || latitude === null) return null;
    return {
      icao24,
      callsign: typeof row[1] === 'string' && row[1].trim() ? row[1].trim() : null,
      country: typeof row[2] === 'string' ? row[2] : null,
      positionTime,
      lastContact: finiteNumber(row[4]),
      longitude,
      latitude,
      barometricAltitude: finiteNumber(row[7]),
      onGround: typeof row[8] === 'boolean' ? row[8] : null,
      velocity: finiteNumber(row[9]),
      trueTrack: finiteNumber(row[10]),
      verticalRate: finiteNumber(row[11]),
      geometricAltitude: finiteNumber(row[13]),
      positionSource: typeof row[16] === 'number' ? openSkyPositionSources[row[16]] ?? null : null,
      category: finiteNumber(row[17]),
    } satisfies AircraftState;
  }).filter((item): item is AircraftState => item !== null);

  console.info('[VECTOR aircraft]', { provider: 'OpenSky', upstreamAircraft: rows.length, normalizedAircraft: states.length });
  return { source: 'OpenSky', provider: 'OpenSky', observedAt, bounds: region.bounds, states };
}

function sharedRegion(lamin: number, lomin: number, lamax: number, lomax: number): Region {
  const requestedLatitude = (lamin + lamax) / 2;
  const requestedLongitude = (lomin + lomax) / 2;
  const latitude = Math.max(-80, Math.min(80, Math.round(requestedLatitude / 5) * 5));
  const longitude = Math.max(-175, Math.min(175, Math.round(requestedLongitude / 5) * 5));
  const radiusNm = 250;
  const latitudeDelta = radiusNm / 60;
  const longitudeDelta = latitudeDelta / Math.max(0.2, Math.cos(latitude * Math.PI / 180));
  const bounds = {
    lamin: Math.max(-90, latitude - latitudeDelta),
    lomin: Math.max(-180, longitude - longitudeDelta),
    lamax: Math.min(90, latitude + latitudeDelta),
    lomax: Math.min(180, longitude + longitudeDelta),
  };
  return { key: `${latitude}:${longitude}:${radiusNm}`, latitude, longitude, radiusNm, bounds };
}

async function retrieveRegion(region: Region) {
  const cached = regionCache.get(region.key);
  if (cached && Date.now() < cached.expiresAt) return cached.payload;
  const inFlight = pendingRegions.get(region.key);
  if (inFlight) return inFlight;

  const request = (async () => {
    console.info('[VECTOR aircraft]', { snappedRegion: { latitude: region.latitude, longitude: region.longitude, radiusNm: region.radiusNm } });
    const attempts: Array<() => Promise<AircraftPayload>> = productionProviders.map(adapter => () => retrieveReadsb(adapter, region));
    if (process.env.AIRCRAFT_ENABLE_AIRPLANES_LIVE_FALLBACK === 'true') attempts.push(() => retrieveReadsb(airplanesLiveProvider, region));
    if (process.env.AIRCRAFT_ENABLE_OPENSKY_FALLBACK === 'true') attempts.push(() => retrieveOpenSky(region));

    for (const attempt of attempts) {
      try {
        const payload = await attempt();
        regionCache.set(region.key, { expiresAt: Date.now() + cacheLifetime, payload });
        for (const [key, value] of regionCache) if (Date.now() >= value.expiresAt) regionCache.delete(key);
        return payload;
      } catch (error) {
        console.warn('[VECTOR aircraft]', safeErrorInformation(error));
      }
    }
    throw new ProviderError('AIRCRAFT_PROVIDERS_UNAVAILABLE');
  })();

  pendingRegions.set(region.key, request);
  try {
    return await request;
  } finally {
    pendingRegions.delete(region.key);
  }
}

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'METHOD NOT ALLOWED' }, { status: 405, headers: { allow: 'GET' } });
    }

    try {
      const searchParams = new URL(request.url).searchParams;
      const values = ['lamin', 'lomin', 'lamax', 'lomax'].map(key => Number(searchParams.get(key)));
      const [lamin, lomin, lamax, lomax] = values;
      if (values.some(value => !Number.isFinite(value)) || lamin < -90 || lamax > 90 || lomin < -180 || lomax > 180 || lamin >= lamax || lomin >= lomax || (lamax - lamin) * (lomax - lomin) > 900) {
        throw new ProviderError('INVALID_BOUNDING_BOX');
      }
      const region = sharedRegion(lamin, lomin, lamax, lomax);
      return Response.json(await retrieveRegion(region), {
        headers: { 'cache-control': 's-maxage=26, stale-while-revalidate=12' },
      });
    } catch (error) {
      console.error('[VECTOR aircraft]', safeErrorInformation(error));
      return Response.json({ error: 'ADS-B UNAVAILABLE', states: [] }, { status: 503 });
    }
  },
};
