import { app } from '@azure/functions';
import { allowedOrigins, ownOrigins, requestOrigin } from '../origin.js';

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

/**
 * Only the site itself and the origins in ALLOWED_ORIGINS may use the proxy.
 * Headers can be forged outside a browser, so this keeps other sites from
 * hotlinking rather than stopping a determined abuser.
 */
function checkRequest(request) {
  const origin = requestOrigin(request);
  if (!origin || ![...ownOrigins(request), ...allowedOrigins()].includes(origin)) {
    return { error: { status: 403, body: 'Kielletty' } };
  }
  const apiKey = process.env.MML_API_KEY;
  if (!apiKey) {
    return { error: { status: 500, body: 'MML_API_KEY puuttuu palvelimen asetuksista' } };
  }
  return { apiKey, cors: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
}

function tileUrl(layer, z, y, x, apiKey) {
  return (
    `${WMTS_URL}/${layer}/default/WGS84_Pseudo-Mercator/${z}/${y}/${x}.${LAYERS[layer]}` +
    `?api-key=${encodeURIComponent(apiKey)}`
  );
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
    if (!Object.hasOwn(LAYERS, layer)) {
      return { status: 404, headers: cors, body: 'Tuntematon karttataso' };
    }

    return forward(tileUrl(layer, z, y, x, apiKey), cors, 7 * 24 * 60 * 60);
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

/** Tries MML with the configured key, to diagnose setup problems. */
async function probe(url, apiKey) {
  try {
    const response = await fetch(url);
    const result = { status: response.status, contentType: response.headers.get('content-type') };
    if (!response.ok) {
      result.body = (await response.text()).slice(0, 300).replaceAll(apiKey, '***');
    }
    return result;
  } catch (error) {
    return { error: String(error) };
  }
}

// Open /api/status in the browser to see whether the proxy is set up. It never
// shows the API key itself.
app.http('status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'status',
  handler: async (request) => {
    const apiKey = process.env.MML_API_KEY;
    const report = {
      apiKeyConfigured: Boolean(apiKey),
      ownOrigins: ownOrigins(request),
      allowedOrigins: allowedOrigins(),
    };
    if (apiKey) {
      report.tile = await probe(tileUrl('taustakartta', 5, 9, 18, apiKey), apiKey);
      const params = new URLSearchParams({
        text: 'Oulu',
        size: '1',
        lang: 'fin',
        crs: CRS84,
        'api-key': apiKey,
      });
      report.search = await probe(`${GEOCODING_URL}?${params}`, apiKey);
    }
    return { jsonBody: report, headers: { 'Cache-Control': 'no-store' } };
  },
});
