// Origin checks shared by the proxy functions: only the site itself and the
// origins listed in ALLOWED_ORIGINS may use them.

export function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * The page's origin, from the Origin header (fetch) or the Referer header
 * (map tiles load as plain <img> requests, which send no Origin).
 */
export function requestOrigin(request) {
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

/**
 * The site's own origins. The app is served from the same host as the API, but
 * the platform may forward the request under an internal host name, so every
 * header that can carry the public one is accepted.
 */
export function ownOrigins(request) {
  const hosts = [
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    new URL(request.url).host,
  ];
  const origins = hosts.filter(Boolean).map((host) => `https://${host.split(',')[0].trim()}`);
  const originalUrl = request.headers.get('x-ms-original-url');
  if (originalUrl) {
    try {
      origins.push(new URL(originalUrl).origin);
    } catch {
      // Ignore a malformed header.
    }
  }
  return origins;
}
