import L from 'leaflet';
import { MML_PROXY_URL } from './config';
import { escapeHtml, factTable, formatTime, liveLayer, showNotice } from './digitraffic';
import type { OverlayGroup } from './layer-panel';
import { formatLatLng } from './map';

/**
 * Weather from Ilmatieteen laitos' open data (https://www.ilmatieteenlaitos.fi/avoin-data).
 * Open and keyless, so the browser calls it directly. If a service refuses
 * cross-origin requests, the Azure site retries through its own /api/fmi route;
 * the GitHub Pages copy has no proxy and then shows a notice instead.
 */

const WFS = 'https://opendata.fmi.fi/wfs';
const WMS = 'https://openwms.fmi.fi/geoserver/wms';
const RADAR_CAPABILITIES = 'https://openwms.fmi.fi/geoserver/Radar/wms?service=WMS&version=1.3.0&request=GetCapabilities';
const WARNINGS_FEED = 'https://alerts.fmi.fi/cap/feed/atom_fi-FI.xml';
const WARNINGS_PAGE = 'https://www.ilmatieteenlaitos.fi/varoitukset';

const ATTRIBUTION =
  'Säätiedot &copy; <a href="https://www.ilmatieteenlaitos.fi/avoin-data">Ilmatieteen laitos</a>, CC BY 4.0';

/** Finland with some margin, as lon/lat for FMI's bbox parameter. */
const FINLAND_BBOX = '19,59,32,71';

let useProxy = false;

async function fmiXml(url: string): Promise<Document> {
  let response: Response | undefined;
  if (!useProxy) {
    try {
      response = await fetch(url);
    } catch (error) {
      // A network-level failure here is usually a CORS refusal.
      if (!MML_PROXY_URL) throw error;
      useProxy = true;
    }
  }
  response ??= await fetch(`${MML_PROXY_URL}/fmi?url=${encodeURIComponent(url)}`);
  if (!response.ok) throw new Error(`Ilmatieteen laitos ${response.status}: ${url}`);
  const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`Virheellinen XML: ${url}`);
  return doc;
}

/** Elements by local name, whatever their XML namespace prefix. */
function all(parent: Document | Element, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', name));
}

function text(parent: Document | Element, name: string): string | undefined {
  return all(parent, name)[0]?.textContent?.trim() || undefined;
}

function sourceLink(url: string, label: string): string {
  return `<a class="dt-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

/** FMI's time parameters want whole seconds: 2026-09-24T21:30:00Z. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

function agoText(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  return minutes < 1 ? 'juuri nyt' : `${minutes} min sitten`;
}

// --- Warnings --------------------------------------------------------------

const LEVELS: Record<string, { label: string; color: string; order: number }> = {
  Minor: { label: 'Keltainen', color: '#f2c800', order: 1 },
  Moderate: { label: 'Keltainen', color: '#f2c800', order: 1 },
  Severe: { label: 'Oranssi', color: '#ff8c00', order: 2 },
  Extreme: { label: 'Punainen', color: '#e0001b', order: 3 },
};

interface Warning {
  id: string;
  event?: string;
  headline?: string;
  level: (typeof LEVELS)[string];
  onset?: string;
  expires?: string;
  sent?: string;
  description?: string;
  web: string;
  areas: { name?: string; polygons: L.LatLngTuple[][] }[];
}

/** CAP polygons are "lat,lon lat,lon ..." strings. */
function parsePolygon(value: string): L.LatLngTuple[] {
  return value
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number) as [number, number])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function parseAlert(alert: Element): Warning | undefined {
  if (text(alert, 'msgType') === 'Cancel') return undefined;
  const infos = all(alert, 'info');
  const info = infos.find((i) => text(i, 'language')?.startsWith('fi')) ?? infos[0];
  if (!info) return undefined;

  const expires = text(info, 'expires');
  if (expires && new Date(expires).getTime() < Date.now()) return undefined;

  const areas = all(info, 'area')
    .map((area) => ({
      name: text(area, 'areaDesc'),
      polygons: all(area, 'polygon')
        .map((p) => parsePolygon(p.textContent ?? ''))
        .filter((p) => p.length >= 3),
    }))
    .filter((a) => a.polygons.length);
  if (!areas.length) return undefined;

  return {
    id: text(alert, 'identifier') ?? crypto.randomUUID(),
    event: text(info, 'event'),
    headline: text(info, 'headline'),
    level: LEVELS[text(info, 'severity') ?? ''] ?? LEVELS.Moderate,
    onset: text(info, 'onset') ?? text(info, 'effective'),
    expires,
    sent: text(alert, 'sent'),
    description: text(info, 'description'),
    web: text(info, 'web') ?? WARNINGS_PAGE,
    areas,
  };
}

/**
 * The Atom feed lists the active warnings. Each entry either carries the CAP
 * alert inline or links to it, so both are handled.
 */
async function loadWarnings(): Promise<Warning[]> {
  const feed = await fmiXml(WARNINGS_FEED);
  const alerts = await Promise.all(
    all(feed, 'entry').map(async (entry): Promise<Element | undefined> => {
      const inline = all(entry, 'alert')[0];
      if (inline) return inline;
      const link = all(entry, 'link').find((l) => {
        const href = l.getAttribute('href') ?? '';
        return l.getAttribute('rel') !== 'self' && (/cap/i.test(l.getAttribute('type') ?? '') || href.endsWith('.xml'));
      });
      const href = link?.getAttribute('href');
      if (!href) return undefined;
      try {
        return all(await fmiXml(new URL(href, WARNINGS_FEED).href), 'alert')[0];
      } catch (error) {
        console.warn(error);
        return undefined;
      }
    }),
  );

  const byId = new Map<string, Warning>();
  for (const alert of alerts) {
    const warning = alert && parseAlert(alert);
    if (warning) byId.set(warning.id, warning);
  }
  return [...byId.values()].sort((a, b) => a.level.order - b.level.order);
}

function warningPopup(warning: Warning, area?: string): string {
  const valid = [formatTime(warning.onset), formatTime(warning.expires)].filter(Boolean).join(' – ');
  return (
    `<strong>${escapeHtml(warning.headline ?? warning.event ?? 'Säävaroitus')}</strong>` +
    factTable([
      ['Laji', warning.event],
      ['Taso', warning.level.label],
      ['Alue', area],
      ['Voimassa', valid],
      ['Julkaistu', formatTime(warning.sent)],
    ]) +
    (warning.description ? `<p class="dt-figure">${escapeHtml(warning.description)}</p>` : '') +
    sourceLink(warning.web, 'Avaa Ilmatieteen laitoksen varoitukset')
  );
}

function warningLayer(map: L.Map): L.LayerGroup {
  return liveLayer(
    map,
    'Säävaroitukset',
    async (group) => {
      const warnings = await loadWarnings();
      group.clearLayers();
      for (const warning of warnings) {
        for (const area of warning.areas) {
          const polygon = L.polygon(area.polygons, {
            color: warning.level.color,
            weight: 1,
            fillColor: warning.level.color,
            fillOpacity: 0.3,
          });
          polygon.bindPopup(warningPopup(warning, area.name), { maxWidth: 340 });
          group.addLayer(polygon);
        }
      }
    },
    5 * 60 * 1000,
    ATTRIBUTION,
  );
}

// --- Lightning -------------------------------------------------------------

const LIGHTNING_MINUTES = 60;

interface Strike {
  time: Date;
  lat: number;
  lon: number;
  values: Record<string, number>;
}

/** The "simple" query returns one element per parameter per strike; group them back. */
async function loadStrikes(): Promise<Strike[]> {
  const end = new Date();
  const start = new Date(end.getTime() - LIGHTNING_MINUTES * 60 * 1000);
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'getFeature',
    storedquery_id: 'fmi::observations::lightning::simple',
    parameters: 'multiplicity,peak_current,cloud_indicator,ellipse_major',
    starttime: isoSeconds(start),
    endtime: isoSeconds(end),
    bbox: FINLAND_BBOX,
  });
  const doc = await fmiXml(`${WFS}?${params}`);

  const strikes = new Map<string, Strike>();
  for (const element of all(doc, 'BsWfsElement')) {
    const time = text(element, 'Time');
    const pos = text(element, 'pos');
    const name = text(element, 'ParameterName');
    if (!time || !pos || !name) continue;
    const key = `${time} ${pos}`;
    let strike = strikes.get(key);
    if (!strike) {
      const [lat, lon] = pos.split(/\s+/).map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      strike = { time: new Date(time), lat, lon, values: {} };
      strikes.set(key, strike);
    }
    const value = Number(text(element, 'ParameterValue'));
    if (Number.isFinite(value)) strike.values[name] = value;
  }
  // Oldest first, so the newest strikes are drawn on top.
  return [...strikes.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
}

const LIGHTNING_COLORS = [
  { minutes: 5, color: '#ffe600', label: 'Alle 5 min sitten' },
  { minutes: 15, color: '#ff9800', label: '5–15 min sitten' },
  { minutes: 30, color: '#e53935', label: '15–30 min sitten' },
  { minutes: Infinity, color: '#8e24aa', label: '30–60 min sitten' },
];

function strikeStyle(strike: Strike): L.CircleMarkerOptions {
  const minutes = (Date.now() - strike.time.getTime()) / 60000;
  const color = LIGHTNING_COLORS.find((c) => minutes < c.minutes)!.color;
  // Fades from fully visible to faint over the hour.
  const opacity = Math.max(0.2, 1 - (0.8 * minutes) / LIGHTNING_MINUTES);
  return { radius: 5, color: '#222', weight: 1, opacity, fillColor: color, fillOpacity: opacity };
}

/** The strike's own record in FMI's open data: its exact time and a tiny box around it. */
function strikeLink(strike: Strike): string {
  const time = isoSeconds(strike.time);
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'getFeature',
    storedquery_id: 'fmi::observations::lightning::simple',
    starttime: time,
    endtime: time,
    bbox: [strike.lon - 0.01, strike.lat - 0.01, strike.lon + 0.01, strike.lat + 0.01].map((n) => n.toFixed(4)).join(','),
  });
  return sourceLink(`${WFS}?${params}`, 'Avaa tietue Ilmatieteen laitoksen avoimessa datassa');
}

function strikePopup(strike: Strike): string {
  const v = strike.values;
  const kind = v.cloud_indicator === undefined ? undefined : v.cloud_indicator === 1 ? 'Pilvisalama' : 'Maasalama';
  const time = strike.time.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    `<strong>${escapeHtml(kind ?? 'Salama')}</strong>` +
    factTable([
      ['Aika', `${time} (${agoText(strike.time)})`],
      ['Virta', v.peak_current === undefined ? undefined : `${v.peak_current.toLocaleString('fi-FI')} kA`],
      ['Iskujen määrä', v.multiplicity === undefined ? undefined : String(v.multiplicity)],
      ['Paikannustarkkuus', v.ellipse_major === undefined ? undefined : `${v.ellipse_major.toLocaleString('fi-FI')} km`],
    ]) +
    strikeLink(strike)
  );
}

function lightningLayer(map: L.Map): L.LayerGroup {
  return liveLayer(
    map,
    'Salamat',
    async (group) => {
      const strikes = await loadStrikes();
      group.clearLayers();
      for (const strike of strikes) {
        const marker = L.circleMarker([strike.lat, strike.lon], strikeStyle(strike));
        // Built on open so "minutes ago" is current.
        marker.bindPopup(() => strikePopup(strike), { maxWidth: 320 });
        group.addLayer(marker);
      }
    },
    60 * 1000,
    ATTRIBUTION,
  );
}

// --- Radar -----------------------------------------------------------------

const RADAR_LAYER = 'Radar:suomi_dbz_eureffin';
/** Rain rate in mm/h, queried where the user clicks. */
const RAIN_RATE_LAYER = 'Radar:suomi_rr_eureffin';

/** The newest image time from the WMS time dimension, e.g. "start/end/PT5M" or a list. */
async function latestRadarTime(): Promise<string | undefined> {
  const doc = await fmiXml(RADAR_CAPABILITIES);
  const name = RADAR_LAYER.split(':')[1];
  const layer = all(doc, 'Layer').find((l) => {
    const own = Array.from(l.children).find((c) => c.localName === 'Name')?.textContent?.trim();
    return own === name || own === RADAR_LAYER;
  });
  const dimension = layer && all(layer, 'Dimension').find((d) => d.getAttribute('name') === 'time');
  if (!dimension) return undefined;
  const values = (dimension.textContent ?? '').trim().split(',');
  const last = values[values.length - 1].trim();
  return (last.includes('/') ? last.split('/')[1] : last) || dimension.getAttribute('default') || undefined;
}

const TimeLabel = L.Control.extend({
  onAdd() {
    return L.DomUtil.create('div', 'fmi-radar-time');
  },
});

function rainRateUrl(latlng: L.LatLng, time?: string): string {
  // A 101 × 101 pixel image, 10 m per pixel, centred on the clicked point.
  const center = L.CRS.EPSG3857.project(latlng);
  const half = 505;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: RAIN_RATE_LAYER,
    query_layers: RAIN_RATE_LAYER,
    crs: 'EPSG:3857',
    bbox: [center.x - half, center.y - half, center.x + half, center.y + half].join(','),
    width: '101',
    height: '101',
    i: '50',
    j: '50',
    info_format: 'application/json',
    styles: '',
  });
  if (time) params.set('time', time);
  return `${WMS}?${params}`;
}

async function rainRate(url: string): Promise<number | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (!MML_PROXY_URL) throw error;
    response = await fetch(`${MML_PROXY_URL}/fmi?url=${encodeURIComponent(url)}`);
  }
  if (!response.ok) throw new Error(`Ilmatieteen laitos ${response.status}`);
  const data = (await response.json()) as { features?: { properties?: Record<string, unknown> }[] };
  const properties = data.features?.[0]?.properties ?? {};
  const value = Object.values(properties).map(Number).find(Number.isFinite);
  return value;
}

function radarLayer(map: L.Map): L.LayerGroup {
  const group = L.layerGroup(undefined, { attribution: ATTRIBUTION });
  const wms = L.tileLayer.wms(WMS, {
    layers: RADAR_LAYER,
    format: 'image/png',
    transparent: true,
    opacity: 0.6,
    version: '1.3.0',
    // FMI's radar images are coarse; there is no need to fetch them per zoom level past this.
    maxNativeZoom: 10,
    maxZoom: 19,
  } as L.WMSOptions);
  group.addLayer(wms);

  const label = new TimeLabel({ position: 'bottomleft' });
  let time: string | undefined;
  let timer: number | undefined;

  const refresh = async () => {
    try {
      time = await latestRadarTime();
    } catch (error) {
      // Without the time the server still returns its newest image.
      console.warn(error);
      time = undefined;
    }
    if (time) wms.setParams({ time } as unknown as L.WMSParams);
    const box = label.getContainer();
    if (box) box.textContent = time ? `Sadetutka ${formatTime(time)}` : 'Sadetutka: uusin kuva';
  };

  const onClick = (e: L.LeafletMouseEvent) => {
    const url = rainRateUrl(e.latlng, time);
    const link = sourceLink(url, 'Avaa tieto Ilmatieteen laitoksen rajapinnassa');
    const title = '<strong>Sadetutka</strong>';
    const place = `<div class="dt-muted">${escapeHtml(formatLatLng(e.latlng))}</div>`;
    const popup = L.popup()
      .setLatLng(e.latlng)
      .setContent(`${title}<p>Ladataan…</p>${place}${link}`)
      .openOn(map);
    rainRate(url)
      .then((value) => {
        const amount =
          value === undefined || value <= 0 ? 'Ei sadetta' : `${value.toLocaleString('fi-FI', { maximumFractionDigits: 1 })} mm/h`;
        popup.setContent(
          title +
            factTable([
              ['Sateen voimakkuus', amount],
              ['Kuvan aika', time ? formatTime(time) : undefined],
            ]) +
            place +
            link,
        );
      })
      .catch((error) => {
        console.warn(error);
        popup.setContent(`${title}<p>Sateen voimakkuuden haku epäonnistui.</p>${place}${link}`);
      });
  };

  group.on('add', () => {
    label.addTo(map);
    void refresh();
    timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    map.on('click', onClick);
  });
  group.on('remove', () => {
    label.remove();
    window.clearInterval(timer);
    map.off('click', onClick);
  });
  wms.on('tileerror', () => showNotice(map, 'Sadetutka: kuvan haku epäonnistui.'));
  return group;
}

export function createWeatherOverlays(map: L.Map): OverlayGroup {
  return {
    title: 'Sää',
    source: 'Ilmatieteen laitos',
    items: [
      {
        name: 'Säävaroitukset',
        description: 'Voimassa olevat varoitukset alueittain',
        layer: warningLayer(map),
        legend: [
          { color: LEVELS.Moderate.color, label: 'Keltainen' },
          { color: LEVELS.Severe.color, label: 'Oranssi' },
          { color: LEVELS.Extreme.color, label: 'Punainen' },
        ],
      },
      {
        name: 'Sadetutka',
        description: 'Uusin tutkakuva; klikkaa nähdäksesi sateen voimakkuus',
        layer: radarLayer(map),
        legend: [{ color: '#4f9fe8', label: 'Sadealue' }],
      },
      {
        name: 'Salamat',
        description: 'Viimeisen tunnin salamat',
        layer: lightningLayer(map),
        legend: LIGHTNING_COLORS.map(({ color, label }) => ({ color, label })),
      },
    ],
  };
}
