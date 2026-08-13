import { defineConfig, loadEnv, type Plugin } from 'vite';
import aircraftHandler from './api/aircraft';
import satellitesHandler from './api/satellites';

function aircraftApi(): Plugin {
  return {
    name: 'vector-aircraft-api',
    configureServer(server) {
      server.middlewares.use('/api/aircraft', async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const query = Object.fromEntries(url.searchParams);
        await aircraftHandler(
          { query },
          {
            setHeader: (name, value) => response.setHeader(name, value),
            status: code => ({ json: body => {
              response.statusCode = code;
              response.setHeader('content-type', 'application/json');
              response.end(JSON.stringify(body));
            } }),
          },
        );
      });
    },
  };
}

function satellitesApi(): Plugin {
  return {
    name: 'vector-satellites-api',
    configureServer(server) {
      server.middlewares.use('/api/satellites', async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const query = Object.fromEntries(url.searchParams);
        await satellitesHandler(
          { query },
          {
            setHeader: (name, value) => response.setHeader(name, value),
            status: code => ({ json: body => {
              response.statusCode = code;
              response.setHeader('content-type', 'application/json');
              response.end(JSON.stringify(body));
            } }),
          },
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'OPENSKY_');
  process.env.OPENSKY_CLIENT_ID = env.OPENSKY_CLIENT_ID;
  process.env.OPENSKY_CLIENT_SECRET = env.OPENSKY_CLIENT_SECRET;
  return { plugins: [aircraftApi(), satellitesApi()] };
});
