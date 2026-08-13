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

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'METHOD NOT ALLOWED' }, { status: 405, headers: { allow: 'GET' } });
    }

    const requested = Number(new URL(request.url).searchParams.get('limit') ?? 6000);
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
      return Response.json(
        { source: 'CelesTrak GP', catalogCount: cachedElements.length, retrievedAt, elements: cachedElements.slice(0, limit) },
        { headers: { 'cache-control': 's-maxage=3600, stale-while-revalidate=3600' } },
      );
    } catch (err: unknown) {
      if (cachedElements.length) {
        return Response.json(
          { source: 'CelesTrak GP (Cached)', catalogCount: cachedElements.length, retrievedAt, elements: cachedElements.slice(0, limit) },
          { headers: { 'cache-control': 's-maxage=60' } },
        );
      }
      const message = err instanceof Error ? err.message : 'SATELLITE DATA UNAVAILABLE';
      return Response.json({ error: message, elements: [] }, { status: 503 });
    }
  },
};
