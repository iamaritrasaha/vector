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
- **Aircraft observations:** Runtime-selected public ADS-B observations from [adsb.lol](https://adsb.lol/) (primary, ODbL 1.0) and [adsb.fi](https://adsb.fi/) (fallback). [Airplanes.live](https://airplanes.live/) and [OpenSky Network](https://opensky-network.org/) remain opt-in server-side fallbacks. These are recent sensor-network observations whose coverage, source and freshness vary. Visual interpolation does not constitute a new observation.
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

The preferred production aircraft path uses public regional APIs and requires no credentials. OpenSky OAuth credentials are optional and must be configured only in the server/serverless environment:

```text
OPENSKY_CLIENT_ID
OPENSKY_CLIENT_SECRET
```

Set `AIRCRAFT_ENABLE_AIRPLANES_LIVE_FALLBACK=true` or `AIRCRAFT_ENABLE_OPENSKY_FALLBACK=true` only when those optional fallbacks should be enabled. Never prefix these values with `VITE_` or expose them to browser code. No OpenSky credentials are required for the preferred aircraft path, static geography, or CelesTrak GP proxy.

### OpenSky configuration

1. Obtain an OpenSky API client only if the optional fallback is desired.
2. Copy `.env.example` to `.env.local`, set the server-side `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` values, and enable `AIRCRAFT_ENABLE_OPENSKY_FALLBACK`.
3. Never expose either credential through `VITE_*` variables or frontend source.

`npm run dev` serves the normalized aircraft route at `/api/aircraft`. Production deployments use the same provider-adapter handler in `api/aircraft.ts`; OpenSky variables are needed only when its optional fallback is enabled.

## Disclaimer

VECTOR is intended for informational, educational and portfolio purposes. Satellite positions are calculated from published orbital elements. Aircraft positions may be delayed, incomplete, stale or unavailable and must not be used for operational navigation.
