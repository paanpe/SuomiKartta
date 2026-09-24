import L from 'leaflet';

/**
 * Road data from Fintraffic's Digitraffic (https://www.digitraffic.fi/tieliikenne/).
 * The API is open and needs no key, so the browser calls it directly. Every
 * dataset is its own overlay, and nothing is fetched until the overlay is
 * switched on.
 */

const API = 'https://tie.digitraffic.fi';
const CAMERA_IMAGES = 'https://weathercam.digitraffic.fi';
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
  shortName?: string;
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

interface CameraProps extends StationProps {
  presets?: { id: string; inCollection?: boolean }[];
}

interface MaintenanceProps {
  time?: string;
  tasks?: string[];
  source?: string;
}

interface Announcement {
  title?: string;
  comment?: string;
  location?: { description?: string };
  timeAndDuration?: { startTime?: string; endTime?: string };
  features?: { name?: string }[];
}

interface TrafficMessageProps {
  situationType?: string;
  trafficAnnouncementType?: string;
  announcements?: Announcement[];
}

function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
  const group = L.layerGroup();
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
          const tasks = (props.tasks ?? []).map((t) => `<li>${escapeHtml(names.get(t) ?? t)}</li>`).join('');
          featureLayer.bindPopup(
            `<strong>Kunnossapitoajoneuvo</strong>` +
              (tasks ? `<ul class="dt-list">${tasks}</ul>` : '') +
              `<div class="dt-muted">${escapeHtml(props.source ?? '')} ${escapeHtml(formatTime(props.time))}</div>`,
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

function messageColor(props: TrafficMessageProps): string {
  if (props.situationType === 'ROAD_WORK') return '#e07b00';
  if (props.trafficAnnouncementType?.includes('ACCIDENT')) return '#d7263d';
  return '#8e44ad';
}

function messagePopup(props: TrafficMessageProps): string {
  return (props.announcements ?? [])
    .map((a) => {
      const features = (a.features ?? [])
        .map((f) => f.name)
        .filter(Boolean)
        .map((name) => `<li>${escapeHtml(name)}</li>`)
        .join('');
      const start = formatTime(a.timeAndDuration?.startTime);
      const end = formatTime(a.timeAndDuration?.endTime);
      return (
        `<strong>${escapeHtml(a.title ?? 'Liikennetiedote')}</strong>` +
        (a.location?.description ? `<p>${escapeHtml(a.location.description)}</p>` : '') +
        (a.comment ? `<p>${escapeHtml(a.comment)}</p>` : '') +
        (features ? `<ul class="dt-list">${features}</ul>` : '') +
        (start ? `<div class="dt-muted">${escapeHtml(start)}${end ? ` – ${escapeHtml(end)}` : ''}</div>` : '')
      );
    })
    .join('<hr>');
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
          featureLayer.bindPopup(messagePopup(feature.properties ?? {}), { maxWidth: 320 }),
      });
      group.clearLayers().addLayer(layer);
    },
    120_000,
  );
}

// --- Weather stations and TMS (LAM) points ---------------------------------

function sensorTable(data: StationData): string {
  const rows = (data.sensorValues ?? [])
    .map((s) => {
      const label = s.name ? s.name.replace(/_/g, ' ').toLowerCase() : s.shortName ?? '';
      const value = s.sensorValueDescriptionFi ?? `${s.value ?? ''} ${s.unit && s.unit !== '***' ? s.unit : ''}`;
      return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value.trim())}</td></tr>`;
    })
    .join('');
  return rows ? `<table class="dt-table">${rows}</table>` : '<p>Ei mittaustietoja.</p>';
}

/**
 * Station locations are loaded once; a station's latest measurements are
 * fetched when its popup opens, so they are always current.
 */
function stationLayer(map: L.Map, label: string, path: string, color: string): L.LayerGroup {
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
      marker.bindPopup(`${title}<p>Ladataan…</p>`, { maxWidth: 320 });
      marker.on('popupopen', async () => {
        try {
          const values = await dtFetch<StationData>(`${path}/stations/${props.id}/data`);
          marker.setPopupContent(
            `${title}${sensorTable(values)}<div class="dt-muted">Päivitetty ${escapeHtml(formatTime(values.dataUpdatedTime))}</div>`,
          );
        } catch {
          marker.setPopupContent(`${title}<p>Mittaustietojen haku epäonnistui.</p>`);
        }
      });
      group.addLayer(marker);
    }
  });
}

// --- Weather cameras -------------------------------------------------------

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
      // Build the popup only when opened, so the images are fresh and are not
      // downloaded for every camera up front.
      marker.bindPopup(
        () =>
          `<strong>${escapeHtml(props.name ?? `Kelikamera ${props.id}`)}</strong>` +
          presets
            .map(
              (p) =>
                `<a href="${CAMERA_IMAGES}/${encodeURIComponent(p.id)}.jpg" target="_blank" rel="noopener">` +
                `<img class="dt-camera" src="${CAMERA_IMAGES}/${encodeURIComponent(p.id)}.jpg?t=${Date.now()}" alt="Kelikamerakuva ${escapeHtml(p.id)}" loading="lazy"></a>`,
            )
            .join(''),
        { maxWidth: 340, minWidth: 280 },
      );
      group.addLayer(marker);
    }
  });
}

export function createDigitrafficOverlays(map: L.Map): Record<string, L.LayerGroup> {
  return {
    'Auraus ja kunnossapito': maintenanceLayer(map),
    'Liikennetiedotteet': trafficMessageLayer(map),
    'Tiesääasemat': stationLayer(map, 'Tiesääasemat', '/api/weather/v1', '#1e88e5'),
    'LAM-pisteet': stationLayer(map, 'LAM-pisteet', '/api/tms/v1', '#6d4c41'),
    'Kelikamerat': weatherCameraLayer(map),
  };
}
