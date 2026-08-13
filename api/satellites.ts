type ApiResponse = { status: (code: number) => { json: (body: unknown) => void }; setHeader: (name: string, value: string) => void };
type ApiRequest = { query?: Record<string, string | string[] | undefined> };

let cachedElements: unknown[] = [];
let retrievedAt = 0;
const CACHE_MS = 2 * 60 * 60 * 1000;

async function fetchGroup(group: string) {
  const upstream = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=JSON`, {
    headers: { accept: 'application/json', 'user-agent': 'VECTOR/0.1 orbital-visualization' },
  });
  if (!upstream.ok) throw Error(`CelesTrak ${group} returned ${upstream.status}`);
  const elements = await upstream.json();
  if (!Array.isArray(elements) || !elements.length) throw Error(`CelesTrak ${group} returned no elements`);
  return elements;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  const requested = Number(request.query?.limit ?? 6000);
  const limit = Math.min(6000, Math.max(1, Number.isFinite(requested) ? requested : 6000));
  try {
    if (!cachedElements.length || Date.now() - retrievedAt > CACHE_MS) {
      let elements: unknown[] | null = null;
      for (const group of ['active', 'visual', 'stations', 'weather']) {
        try {
          elements = await fetchGroup(group);
          if (elements && elements.length) break;
        } catch {
          continue;
        }
      }
      if (elements && elements.length) {
        cachedElements = elements;
        retrievedAt = Date.now();
      } else if (!cachedElements.length) {
        throw Error('All CelesTrak groups failed');
      }
    }
    response.setHeader('cache-control', 's-maxage=3600, stale-while-revalidate=3600');
    response.status(200).json({ source: 'CelesTrak GP', catalogCount: cachedElements.length, retrievedAt, elements: cachedElements.slice(0, limit) });
  } catch (err: unknown) {
    if (cachedElements.length) {
      // Serve stale cache if available
      response.setHeader('cache-control', 's-maxage=60');
      response.status(200).json({ source: 'CelesTrak GP (Cached)', catalogCount: cachedElements.length, retrievedAt, elements: cachedElements.slice(0, limit) });
    } else {
      const msg = err instanceof Error ? err.message : 'SATELLITE DATA UNAVAILABLE';
      response.status(503).json({ error: msg, elements: [] });
    }
  }
}
