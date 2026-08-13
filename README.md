# VECTOR

Earth, in motion.

A real-time planetary situational visualization designed and developed by Hrik.

A Foresight Labs experiment.

Copyright © 2026 Hrik. All rights reserved.

## About

VECTOR is an independent interactive 3D visualization of Earth, public orbital objects, aircraft observations and geographic reference data. It prioritizes meaningful coordinates and transparent provenance: orbital positions are propagated mathematically, aircraft positions remain identified as observations, and unavailable feeds fail closed without silently substituting sample objects.

## Technology

- TypeScript and Vite
- Three.js
- Satellite.js with SGP4 propagation
- Serverless TypeScript data proxies

## Data sources and integrity

- **Satellite orbital data:** [CelesTrak](https://celestrak.org/) public GP catalog in OMM/JSON form. VECTOR propagates these elements locally to current UTC using SGP4; rendered positions are not direct spacecraft telemetry.
- **Aircraft observations:** [OpenSky Network](https://opensky-network.org/) state vectors. These are recent sensor-network observations whose coverage, source and freshness vary. Visual interpolation does not constitute a new observation.
- **Geographic reference data:** [Natural Earth](https://www.naturalearthdata.com/) 1:50m coastlines, Admin-0 boundaries and disputed-boundary classifications.
- **Orbital propagation:** [Satellite.js](https://github.com/shashwatak/satellite-js), implementing SGP4/SDP4 coordinate and propagation utilities.

VECTOR is not affiliated with or endorsed by these providers. External software and datasets remain subject to their respective licenses, terms and ownership. VECTOR’s copyright applies only to its original application code, interface, visual design, interaction design, graphics, branding and implementation, subject to third-party rights.

## Local setup

Use Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

The `/api` directory contains serverless handlers. A static-only server can render the globe and geography, but operational feeds require those handlers or compatible endpoints.

## Environment variables

OpenSky OAuth credentials must be configured only in the server/serverless environment:

```text
OPENSKY_CLIENT_ID
OPENSKY_CLIENT_SECRET
```

Never prefix the secret with `VITE_` or expose it to browser code. No OpenSky credentials are required for the static geography or CelesTrak GP proxy.

### OpenSky configuration

1. Obtain an OpenSky API client.
2. Copy `.env.example` to `.env.local` and set the server-side `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` values.
3. Never expose either credential through `VITE_*` variables or frontend source.

`npm run dev` loads `.env.local` only into the local Vite server and serves the normalized aircraft route at `/api/aircraft`. Production deployments use the serverless handler in `api/aircraft.ts` and must configure the same variables in the hosting environment.

## Disclaimer

VECTOR is intended for informational, educational and portfolio purposes. Satellite positions are calculated from published orbital elements. Aircraft positions may be delayed, incomplete, stale or unavailable and must not be used for operational navigation.
