import L from 'leaflet';

/**
 * Road data from Fintraffic's Digitraffic (https://www.digitraffic.fi/tieliikenne/).
 * The API is open and needs no key, so the browser calls it directly. Every
 * dataset is its own overlay, and nothing is fetched until the overlay is
 * switched on.
 */

const API = 'https://tie.digitraffic.fi';
const CAMERA_IMAGES = 'https://weathercam.digitraffic.fi';
const ATTRIBUTION =
  'Liikennetiedot &copy; <a href="https://www.digitraffic.fi/">Fintraffic / digitraffic.fi</a>, CC BY 4.0';
/** Digitraffic asks clients to identify themselves with this header. */
const USER_HEADER = { 'Digitraffic-User': 'SuomiKartta' };

let sendUserHeader = true;

async function dtFetch<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, sendUserHeader ? { headers: USER_HEADER } : undefined);
  } catch (error) {
    // A network-level failure with the custom header may be a CORS preflight
    // rejection. Retry once without it, and keep it off if that works.
    if (!sendUserHeader) throw error;
    response = await fetch(`${API}${path}`);
    sendUserHeader = false;
  }
  if (!response.ok) throw new Error(`Digitraffic ${response.status}: ${path}`);
  return (await response.json()) as T;
}

type Feature<P> = GeoJSON.Feature<GeoJSON.Geometry | null, P>;
type FeatureCollection<P> = { features?: Feature<P>[] };

interface SensorValue {
  name?: string;
  value?: number;
  unit?: string;
  measuredTime?: string;
  sensorValueDescriptionFi?: string;
}

interface StationData {
  dataUpdatedTime?: string;
  sensorValues?: SensorValue[];
}

interface StationProps {
  id: number;
  name?: string;
  collectionStatus?: string;
}

interface TmsStationDetails {
  properties?: { direction1Municipality?: string; direction2Municipality?: string };
}

interface CameraPreset {
  id: string;
  inCollection?: boolean;
  presentationName?: string;
  measuredTime?: string;
}

interface CameraProps extends StationProps {
  presets?: CameraPreset[];
}

interface MaintenanceProps {
  id?: number;
  time?: string;
  tasks?: string[];
  direction?: number;
}

interface TimeAndDuration {
  startTime?: string;
  endTime?: string;
}

interface MessageFeature {
  name?: string;
  quantity?: number;
  unit?: string;
  description?: string;
}

interface RoadWorkPhase {
  workTypes?: { type?: string; description?: string }[];
  workingHours?: { weekday?: string; startTime?: string; endTime?: string }[];
  restrictions?: { restriction?: MessageFeature }[];
  timeAndDuration?: TimeAndDuration;
}

interface Announcement {
  title?: string;
  location?: { description?: string };
  timeAndDuration?: TimeAndDuration;
  features?: MessageFeature[];
  roadWorkPhases?: RoadWorkPhase[];
  alternativeRoute?: string | string[];
}

interface TrafficMessageProps {
  situationId?: string;
  situationType?: string;
  trafficAnnouncementType?: string;
  releaseTime?: string;
  announcements?: Announcement[];
}

function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A link to the item's own record in the Digitraffic API. */
function dataLink(path: string): string {
  return `<a class="dt-link" href="${escapeHtml(API + path)}" target="_blank" rel="noopener">Avaa tiedot Digitrafficissa</a>`;
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toLatLng(geometry: GeoJSON.Geometry | null): L.LatLng | undefined {
  if (geometry?.type !== 'Point') return undefined;
  const [lng, lat] = geometry.coordinates;
  return L.latLng(lat, lng);
}

let noticeTimer: number | undefined;

/** Shows a short message at the bottom of the map when a dataset fails to load. */
function showNotice(map: L.Map, text: string): void {
  let box = map.getContainer().querySelector<HTMLDivElement>('.dt-notice');
  if (!box) {
    box = L.DomUtil.create('div', 'dt-notice', map.getContainer());
    box.setAttribute('role', 'status');
  }
  box.textContent = text;
  box.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (box!.hidden = true), 6000);
}

/**
 * A layer group that fills itself with `load` when it is added to the map and,
 * when `refreshMs` is given, reloads on that interval while it stays on.
 */
function liveLayer(
  map: L.Map,
  label: string,
  load: (group: L.LayerGroup) => Promise<void>,
  refreshMs?: number,
): L.LayerGroup {
  const group = L.layerGroup(undefined, { attribution: ATTRIBUTION });
  let timer: number | undefined;
  let loaded = false;
  let loading = false;

  const run = async () => {
    if (loading) return;
    loading = true;
    try {
      await load(group);
      loaded = true;
    } catch (error) {
      console.warn(error);
      showNotice(map, `${label}: tietojen haku epäonnistui.`);
    } finally {
      loading = false;
    }
  };

  group.on('add', () => {
    if (!loaded || refreshMs) void run();
    if (refreshMs) timer = window.setInterval(() => void run(), refreshMs);
  });
  group.on('remove', () => window.clearInterval(timer));
  return group;
}

// --- Maintenance vehicles -------------------------------------------------

let taskNames: Promise<Map<string, string>> | undefined;

function loadTaskNames(): Promise<Map<string, string>> {
  taskNames ??= dtFetch<{ id: string; nameFi?: string }[]>('/api/maintenance/v1/tracking/tasks')
    .then((tasks) => new Map(tasks.map((t) => [t.id, t.nameFi ?? t.id])))
    .catch(() => new Map());
  return taskNames;
}

const COMPASS = ['pohjoiseen', 'koilliseen', 'itään', 'kaakkoon', 'etelään', 'lounaaseen', 'länteen', 'luoteeseen'];

function compassDirection(degrees: number): string {
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return `${COMPASS[index]} (${Math.round(degrees)}°)`;
}

/** Rows of a two-column fact table; rows with an empty value are left out. */
function factTable(rows: [string, string | undefined][]): string {
  const html = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('');
  return html ? `<table class="dt-table">${html}</table>` : '';
}

function maintenanceLayer(map: L.Map): L.LayerGroup {
  return liveLayer(
    map,
    'Auraus ja kunnossapito',
    async (group) => {
      const [data, names] = await Promise.all([
        dtFetch<FeatureCollection<MaintenanceProps>>('/api/maintenance/v1/tracking/routes/latest'),
        loadTaskNames(),
      ]);
      const layer = L.geoJSON(data as GeoJSON.FeatureCollection, {
        style: () => ({ color: '#0077cc', weight: 4 }),
        pointToLayer: (feature, latlng) => {
          const tasks: string[] = feature.properties?.tasks ?? [];
          const ploughing = tasks.some((t) => t.includes('PLOUGHING'));
          return L.circleMarker(latlng, {
            radius: 6,
            color: '#fff',
            weight: 1.5,
            fillColor: ploughing ? '#0057b8' : '#2e9e44',
            fillOpacity: 0.9,
          });
        },
        onEachFeature: (feature, featureLayer) => {
          const props = (feature.properties ?? {}) as MaintenanceProps;
          const id = props.id ?? feature.id;
          const tasks = (props.tasks ?? []).map((t) => `<li>${escapeHtml(names.get(t) ?? t)}</li>`).join('');
          featureLayer.bindPopup(
            `<strong>Kunnossapitoajoneuvo</strong>` +
              (tasks ? `<ul class="dt-list">${tasks}</ul>` : '') +
              factTable([
                ['Ajosuunta', props.direction != null ? compassDirection(props.direction) : undefined],
                ['Havaittu', formatTime(props.time)],
              ]) +
              (id != null ? dataLink(`/api/maintenance/v1/tracking/routes/${encodeURIComponent(id)}`) : ''),
          );
        },
      });
      group.clearLayers().addLayer(layer);
    },
    60_000,
  );
}

// --- Traffic messages -----------------------------------------------------

const MESSAGE_TYPES = ['TRAFFIC_ANNOUNCEMENT', 'ROAD_WORK'];

const ANNOUNCEMENT_TYPES: Record<string, string> = {
  GENERAL: 'Liikennetiedote',
  PRELIMINARY_ACCIDENT_REPORT: 'Ensitiedote onnettomuudesta',
  ACCIDENT_REPORT: 'Onnettomuus',
  UNCONFIRMED_OBSERVATION: 'Vahvistamaton havainto',
  ENDED: 'Päättynyt',
  RETRACTED: 'Peruttu',
};

const WEEKDAYS: Record<string, string> = {
  MONDAY: 'ma',
  TUESDAY: 'ti',
  WEDNESDAY: 'ke',
  THURSDAY: 'to',
  FRIDAY: 'pe',
  SATURDAY: 'la',
  SUNDAY: 'su',
};

function messageColor(props: TrafficMessageProps): string {
  if (props.situationType === 'ROAD_WORK') return '#e07b00';
  if (props.trafficAnnouncementType?.includes('ACCIDENT')) return '#d7263d';
  return '#8e44ad';
}

function messageType(props: TrafficMessageProps): string {
  if (props.situationType === 'ROAD_WORK') return 'Tietyö';
  return ANNOUNCEMENT_TYPES[props.trafficAnnouncementType ?? ''] ?? 'Liikennehäiriö';
}

function describeFeature(f: MessageFeature): string {
  const amount = f.quantity != null ? ` ${f.quantity}${f.unit ? ` ${f.unit}` : ''}` : '';
  return `${f.name ?? ''}${amount}${f.description ? ` (${f.description})` : ''}`.trim();
}

function timeRange(t?: TimeAndDuration): string | undefined {
  const start = formatTime(t?.startTime);
  const end = formatTime(t?.endTime);
  if (!start && !end) return undefined;
  return `${start || '?'} – ${end || 'toistaiseksi'}`;
}

function listHtml(items: string[]): string {
  const html = items.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return html ? `<ul class="dt-list">${html}</ul>` : '';
}

function roadWorkPhasesHtml(phases: RoadWorkPhase[]): string {
  return phases
    .map((phase, i) => {
      const works = (phase.workTypes ?? []).map((w) => w.description ?? w.type ?? '').filter(Boolean);
      const hours = (phase.workingHours ?? [])
        .map((h) => `${WEEKDAYS[h.weekday ?? ''] ?? h.weekday ?? ''} ${(h.startTime ?? '').slice(0, 5)}–${(h.endTime ?? '').slice(0, 5)}`)
        .join(', ');
      const restrictions = (phase.restrictions ?? []).map((r) => (r.restriction ? describeFeature(r.restriction) : ''));
      return (
        `<div class="dt-phase"><em>Vaihe ${i + 1}${works.length ? `: ${escapeHtml(works.join(', '))}` : ''}</em>` +
        factTable([
          ['Aika', timeRange(phase.timeAndDuration)],
          ['Työaika', hours || undefined],
        ]) +
        listHtml(restrictions) +
        '</div>'
      );
    })
    .join('');
}

function messagePopup(props: TrafficMessageProps): string {
  const link = props.situationId
    ? dataLink(`/api/traffic-message/v1/messages/${encodeURIComponent(props.situationId)}`)
    : '';
  const body = (props.announcements ?? [])
    .map((a) => {
      const detour = [a.alternativeRoute ?? []].flat().join(' ');
      return (
        `<strong>${escapeHtml(a.title ?? 'Liikennetiedote')}</strong>` +
        `<div class="dt-type">${escapeHtml(messageType(props))}</div>` +
        (a.location?.description ? `<p>${escapeHtml(a.location.description)}</p>` : '') +
        listHtml((a.features ?? []).map(describeFeature)) +
        factTable([
          ['Voimassa', timeRange(a.timeAndDuration)],
          ['Kiertotie', detour || undefined],
        ]) +
        roadWorkPhasesHtml(a.roadWorkPhases ?? [])
      );
    })
    .join('<hr>');
  const released = formatTime(props.releaseTime);
  return body + (released ? `<div class="dt-muted">Julkaistu ${escapeHtml(released)}</div>` : '') + link;
}

function trafficMessageLayer(map: L.Map): L.LayerGroup {
  return liveLayer(
    map,
    'Liikennetiedotteet',
    async (group) => {
      const collections = await Promise.all(
        MESSAGE_TYPES.map((type) =>
          dtFetch<FeatureCollection<TrafficMessageProps>>(
            `/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=${type}`,
          ),
        ),
      );
      const features = collections.flatMap((c) => c.features ?? []).filter((f) => f.geometry);
      const layer = L.geoJSON({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection, {
        style: (feature) => ({ color: messageColor(feature?.properties ?? {}), weight: 5, opacity: 0.8 }),
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 7,
            color: '#fff',
            weight: 1.5,
            fillColor: messageColor(feature.properties ?? {}),
            fillOpacity: 0.9,
          }),
        onEachFeature: (feature, featureLayer) =>
          featureLayer.bindPopup(messagePopup(feature.properties ?? {}), { maxWidth: 340 }),
      });
      group.clearLayers().addLayer(layer);
    },
    120_000,
  );
}

// --- Weather stations and TMS (LAM) points ---------------------------------

/** Sensor names are matched without diacritics, so NÄKYVYYS and NAKYVYYS both work. */
function sensorKey(name?: string): string {
  return (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function sensorText(s?: SensorValue): string | undefined {
  if (!s) return undefined;
  if (s.sensorValueDescriptionFi) return s.sensorValueDescriptionFi;
  if (s.value == null) return undefined;
  const unit = s.unit && s.unit !== '***' ? ` ${s.unit}` : '';
  return `${s.value}${unit}`;
}

function measuredLine(values: SensorValue[], fallback?: string): string {
  const times = values.map((v) => v.measuredTime).filter((t): t is string => !!t).sort();
  const latest = formatTime(times.at(-1) ?? fallback);
  return latest ? `<div class="dt-muted">Mitattu ${escapeHtml(latest)}</div>` : '';
}

/** The weather readings Pekka picked, each with the sensor names it may appear under. */
const WEATHER_ROWS: [string, string[]][] = [
  ['Ilma', ['ILMA']],
  ['Tien pinta', ['TIE_1', 'TIE_2']],
  ['Keli', ['KELI_1', 'KELI_2']],
  ['Keskituuli', ['KESKITUULI']],
  ['Puuskat', ['MAKSIMITUULI']],
  ['Sade', ['SADE', 'SATEEN_OLOMUOTO_PWDXX']],
  ['Sateen voimakkuus', ['SADE_INTENSITEETTI']],
  ['Sademäärä', ['SADESUMMA']],
  ['Ilmankosteus', ['ILMAN_KOSTEUS']],
  ['Kastepiste', ['KASTEPISTE']],
  ['Näkyvyys', ['NAKYVYYS_KM', 'NAKYVYYS']],
  ['Lumensyvyys', ['LUMEN_SYVYYS']],
];

async function weatherPopup(id: number): Promise<string> {
  const data = await dtFetch<StationData>(`/api/weather/v1/stations/${id}/data`);
  const values = data.sensorValues ?? [];
  const byName = new Map(values.map((v) => [sensorKey(v.name), v]));
  const rows = WEATHER_ROWS.map(([label, names]): [string, string | undefined] => [
    label,
    sensorText(names.map((n) => byName.get(n)).find(Boolean)),
  ]);
  return (
    (factTable(rows) || '<p>Ei mittaustietoja.</p>') +
    measuredLine(values, data.dataUpdatedTime)
  );
}

const TMS_ROWS: [string, string][] = [
  ['Keskinopeus (5 min)', 'KESKINOPEUS_5MIN_LIUKUVA'],
  ['Keskinopeus (60 min)', 'KESKINOPEUS_60MIN_KIINTEA'],
  ['Ohitukset (5 min, tuntivauhti)', 'OHITUKSET_5MIN_LIUKUVA'],
  ['Ohitukset (60 min)', 'OHITUKSET_60MIN_KIINTEA'],
];

async function tmsPopup(id: number): Promise<string> {
  const [data, details] = await Promise.all([
    dtFetch<StationData>(`/api/tms/v1/stations/${id}/data`),
    dtFetch<TmsStationDetails>(`/api/tms/v1/stations/${id}`).catch(() => undefined),
  ]);
  const values = data.sensorValues ?? [];
  const byName = new Map(values.map((v) => [sensorKey(v.name), v]));
  const dir1 = details?.properties?.direction1Municipality;
  const dir2 = details?.properties?.direction2Municipality;
  const head =
    `<tr><th></th><th>${escapeHtml(dir1 ? `→ ${dir1}` : 'Suunta 1')}</th>` +
    `<th>${escapeHtml(dir2 ? `→ ${dir2}` : 'Suunta 2')}</th></tr>`;
  const rows = TMS_ROWS.map(([label, prefix]) => {
    const d1 = sensorText(byName.get(`${prefix}_SUUNTA1`));
    const d2 = sensorText(byName.get(`${prefix}_SUUNTA2`));
    if (!d1 && !d2) return '';
    return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(d1 ?? '–')}</td><td>${escapeHtml(d2 ?? '–')}</td></tr>`;
  }).join('');
  return (
    (rows ? `<table class="dt-table">${head}${rows}</table>` : '<p>Ei mittaustietoja.</p>') +
    measuredLine(values, data.dataUpdatedTime)
  );
}

/**
 * Station locations are loaded once; a station's latest measurements are
 * fetched when its popup opens, so they are always current.
 */
function stationLayer(
  map: L.Map,
  label: string,
  path: string,
  color: string,
  popup: (id: number) => Promise<string>,
): L.LayerGroup {
  return liveLayer(map, label, async (group) => {
    const data = await dtFetch<FeatureCollection<StationProps>>(`${path}/stations`);
    for (const feature of data.features ?? []) {
      const props = feature.properties;
      const latlng = toLatLng(feature.geometry);
      if (!props || !latlng) continue;
      if (props.collectionStatus && props.collectionStatus !== 'GATHERING') continue;

      const marker = L.circleMarker(latlng, {
        radius: 5,
        color: '#fff',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
      });
      const title = `<strong>${escapeHtml(props.name ?? `${props.id}`)}</strong>`;
      const link = dataLink(`${path}/stations/${encodeURIComponent(props.id)}/data`);
      marker.bindPopup(`${title}<p>Ladataan…</p>${link}`, { maxWidth: 340 });
      marker.on('popupopen', async () => {
        try {
          marker.setPopupContent(`${title}${await popup(props.id)}${link}`);
        } catch {
          marker.setPopupContent(`${title}<p>Mittaustietojen haku epäonnistui.</p>${link}`);
        }
      });
      group.addLayer(marker);
    }
  });
}

// --- Weather cameras -------------------------------------------------------

interface CameraDetails {
  properties?: { presets?: CameraPreset[] };
}

interface CameraData {
  presets?: CameraPreset[];
}

function cameraImage(preset: CameraPreset, name?: string, time?: string): string {
  const url = `${CAMERA_IMAGES}/${encodeURIComponent(preset.id)}.jpg`;
  const caption = [name, time ? `kuvattu ${time}` : ''].filter(Boolean).join(', ');
  return (
    `<figure class="dt-figure"><a href="${url}" target="_blank" rel="noopener">` +
    `<img class="dt-camera" src="${url}?t=${Date.now()}" alt="${escapeHtml(name ?? 'Kelikamerakuva')}" loading="lazy"></a>` +
    (caption ? `<figcaption class="dt-muted">${escapeHtml(caption)}</figcaption>` : '') +
    '</figure>'
  );
}

function weatherCameraLayer(map: L.Map): L.LayerGroup {
  return liveLayer(map, 'Kelikamerat', async (group) => {
    const data = await dtFetch<FeatureCollection<CameraProps>>('/api/weathercam/v1/stations');
    for (const feature of data.features ?? []) {
      const props = feature.properties;
      const latlng = toLatLng(feature.geometry);
      const presets = (props?.presets ?? []).filter((p) => p.inCollection !== false);
      if (!props || !latlng || presets.length === 0) continue;
      if (props.collectionStatus && props.collectionStatus !== 'GATHERING') continue;

      const marker = L.circleMarker(latlng, {
        radius: 5,
        color: '#fff',
        weight: 1,
        fillColor: '#444',
        fillOpacity: 0.9,
      });
      const id = encodeURIComponent(props.id);
      const title = `<strong>${escapeHtml(props.name ?? `Kelikamera ${props.id}`)}</strong>`;
      const link = dataLink(`/api/weathercam/v1/stations/${id}`);
      // Images and their names and times load only when the popup opens, so
      // they are fresh and are not downloaded for every camera up front.
      marker.bindPopup(`${title}<p>Ladataan…</p>${link}`, { maxWidth: 340, minWidth: 280 });
      marker.on('popupopen', async () => {
        const [details, times] = await Promise.all([
          dtFetch<CameraDetails>(`/api/weathercam/v1/stations/${id}`).catch(() => undefined),
          dtFetch<CameraData>(`/api/weathercam/v1/stations/${id}/data`).catch(() => undefined),
        ]);
        const names = new Map((details?.properties?.presets ?? []).map((p) => [p.id, p.presentationName]));
        const measured = new Map((times?.presets ?? []).map((p) => [p.id, p.measuredTime]));
        const images = presets
          .map((p) => cameraImage(p, names.get(p.id) ?? p.presentationName, formatTime(measured.get(p.id))))
          .join('');
        marker.setPopupContent(`${title}${images}${link}`);
      });
      group.addLayer(marker);
    }
  });
}

export function createDigitrafficOverlays(map: L.Map): Record<string, L.LayerGroup> {
  return {
    'Auraus ja kunnossapito': maintenanceLayer(map),
    'Liikennetiedotteet': trafficMessageLayer(map),
    'Tiesääasemat': stationLayer(map, 'Tiesääasemat', '/api/weather/v1', '#1e88e5', weatherPopup),
    'LAM-pisteet': stationLayer(map, 'LAM-pisteet', '/api/tms/v1', '#6d4c41', tmsPopup),
    'Kelikamerat': weatherCameraLayer(map),
  };
}
