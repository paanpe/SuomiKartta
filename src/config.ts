/**
 * Base URL of the proxy that serves Maanmittauslaitos maps and search. When it
 * is not set, the app falls back to OpenStreetMap tiles and Nominatim search.
 */
export const MML_PROXY_URL = import.meta.env.VITE_MML_PROXY_URL?.trim().replace(/\/+$/, '') || undefined;
