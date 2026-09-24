import { app } from '@azure/functions';

// Forwards map tiles and place searches to Maanmittauslaitos' open APIs, adding
// the API key on the way so it never reaches the browser.

const WMTS_URL = 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0';
const GEOCODING_URL = 'https://avoin-paikkatieto.maanmittauslaitos.fi/geocoding/v2/pelias/search';
// GeoJSON order (longitude, latitude) in WGS84, which is what Leaflet needs.
const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

/** Background map layers served through the proxy, with their image format. */
const LAYERS = {
  taustakartta: 'png',
  maastokartta: 'png',
  selkokartta: 'png',
  ortokuva: 'jpg',
};

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * The page's origin, from the Origin header (fetch) or the Referer header
 * (map tiles load as plain <img> requests, which send no Origin).
 */
function requestOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const referer = request.headers.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/** The site's own origin; the app is served from the same host as the API. */
function ownOrigin(request) {
  const host = request.headers.get('x-forwarded-host') ?? new URL(request.url).host;
  return `https://${host}`;
}

/**
 * Only the site itself and the origins in ALLOWED_ORIGINS may use the proxy.
 * Headers can be forged outside a browser, so this keeps other sites from
 * hotlinking rather than stopping a determined abuser.
 */
function checkRequest(request) {
  const origin = requestOrigin(request);
  if (!origin || (origin !== ownOrigin(request) && !allowedOrigins().includes(origin))) {
    return { error: { status: 403, body: 'Kielletty' } };
  }
  const apiKey = process.env.MML_API_KEY;
  if (!apiKey) {
    return { error: { status: 500, body: 'MML_API_KEY puuttuu palvelimen asetuksista' } };
  }
  return { apiKey, cors: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
}

async function forward(url, cors, cacheSeconds) {
  const upstream = await fetch(url);
  return {
    status: upstream.status,
    headers: {
      ...cors,
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': upstream.ok ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
    body: Buffer.from(await upstream.arrayBuffer()),
  };
}

app.http('tiles', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tiles/{layer}/{z:int}/{y:int}/{x:int}',
  handler: async (request) => {
    const { error, apiKey, cors } = checkRequest(request);
    if (error) return error;

    const { layer, z, y, x } = request.params;
    const format = Object.hasOwn(LAYERS, layer) ? LAYERS[layer] : undefined;
    if (!format) return { status: 404, headers: cors, body: 'Tuntematon karttataso' };

    const url =
      `${WMTS_URL}/${layer}/default/WGS84_Pseudo-Mercator/${z}/${y}/${x}.${format}` +
      `?api-key=${encodeURIComponent(apiKey)}`;
    return forward(url, cors, 7 * 24 * 60 * 60);
  },
});

app.http('search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'search',
  handler: async (request) => {
    const { error, apiKey, cors } = checkRequest(request);
    if (error) return error;

    const text = request.query.get('text')?.trim() ?? '';
    if (!text || text.length > 200) {
      return { status: 400, headers: cors, body: 'Hakusana puuttuu tai on liian pitkä' };
    }

    const params = new URLSearchParams({
      text,
      size: '8',
      lang: 'fin',
      crs: CRS84,
      'api-key': apiKey,
    });
    return forward(`${GEOCODING_URL}?${params}`, cors, 60 * 60);
  },
});
