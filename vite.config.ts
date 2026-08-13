import { defineConfig, loadEnv, type Plugin } from 'vite';
import aircraftHandler from './api/aircraft';
import satellitesHandler from './api/satellites';

type WebHandler = { fetch(request: Request): Response | Promise<Response> };

function localApi(path: string, handler: WebHandler): Plugin {
  return {
    name: `vector-local-api-${path.slice(1)}`,
    configureServer(server) {
      server.middlewares.use(path, async (request, response) => {
        const url = new URL(request.url ?? '/', `http://localhost${path}`);
        const webResponse = await handler.fetch(new Request(url, { method: request.method ?? 'GET' }));
        response.statusCode = webResponse.status;
        webResponse.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await webResponse.arrayBuffer()));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'OPENSKY_');
  const aircraftEnv = loadEnv(mode, process.cwd(), 'AIRCRAFT_');
  process.env.OPENSKY_CLIENT_ID = env.OPENSKY_CLIENT_ID;
  process.env.OPENSKY_CLIENT_SECRET = env.OPENSKY_CLIENT_SECRET;
  process.env.AIRCRAFT_ENABLE_OPENSKY_FALLBACK = aircraftEnv.AIRCRAFT_ENABLE_OPENSKY_FALLBACK;
  return {
    plugins: [
      localApi('/api/aircraft', aircraftHandler),
      localApi('/api/satellites', satellitesHandler),
    ],
  };
});
