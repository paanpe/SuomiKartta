import { app } from '@azure/functions';
import { allowedOrigins, ownOrigins, requestOrigin } from '../origin.js';

// Fallback route for Ilmatieteen laitos' open data. The browser calls FMI
// directly first; this is only used if a service refuses cross-origin requests.
// No key is needed, so it simply forwards GET requests to FMI's own hosts.

const FMI_HOSTS = new Set(['opendata.fmi.fi', 'openwms.fmi.fi', 'alerts.fmi.fi']);

app.http('fmi', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'fmi',
  handler: async (request) => {
    const origin = requestOrigin(request);
    if (!origin || ![...ownOrigins(request), ...allowedOrigins()].includes(origin)) {
      return { status: 403, body: 'Kielletty' };
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

    let target;
    try {
      target = new URL(request.query.get('url') ?? '');
    } catch {
      return { status: 400, headers: cors, body: 'Osoite puuttuu' };
    }
    if (target.protocol !== 'https:' || !FMI_HOSTS.has(target.hostname)) {
      return { status: 400, headers: cors, body: 'Vain Ilmatieteen laitoksen osoitteet sallitaan' };
    }

    const upstream = await fetch(target);
    return {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/xml',
        'Cache-Control': upstream.ok ? 'public, max-age=60' : 'no-store',
      },
      body: Buffer.from(await upstream.arrayBuffer()),
    };
  },
});
