import L from 'leaflet';
import { escapeHtml, factTable, liveLayer, USER_HEADER } from './digitraffic';
import type { OverlayGroup } from './layer-panel';

/**
 * Rail data from Fintraffic's Digitraffic (https://www.digitraffic.fi/rautatieliikenne/).
 * Open and keyless like the road data, so the browser calls it directly.
 * Train positions come from the REST API; current delays for colouring come
 * from one GraphQL query so we do not have to download every train's full
 * timetable. Details for a train or station load when its popup opens.
 */

const API = 'https://rata.digitraffic.fi';
const GRAPHQL = `${API}/api/v2/graphql/graphql`;

let sendUserHeader = true;

async function railFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const withHeader = (headers: Record<string, string>) => ({
    ...init,
    headers: { ...headers, ...(sendUserHeader ? USER_HEADER : {}) },
  });
  const baseHeaders = (init.headers ?? {}) as Record<string, string>;
  let response: Response;
  try {
    response = await fetch(url, withHeader(baseHeaders));
  } catch (error) {
    // Same CORS fallback as the road data: retry once without our header.
    if (!sendUserHeader) throw error;
    sendUserHeader = false;
    response = await fetch(url, withHeader(baseHeaders));
  }
  if (!response.ok) throw new Error(`Digitraffic ${response.status}: ${path}`);
  return (await response.json()) as T;
}

// --- Stations --------------------------------------------------------------

interface Station {
  stationName: string;
  stationShortCode: string;
  passengerTraffic?: boolean;
  countryCode?: string;
  latitude: number;
  longitude: number;
}

let stations: Promise<Map<string, Station>> | undefined;

function loadStations(): Promise<Map<string, Station>> {
  stations ??= railFetch<Station[]>('/api/v1/metadata/stations')
    .then((list) => new Map(list.map((s) => [s.stationShortCode, s])))
    .catch((error) => {
      stations = undefined;
      throw error;
    });
  return stations;
}

/** Station names in the metadata are like "Helsinki asema"; drop the suffix. */
function stationName(names: Map<string, Station>, code?: string): string {
  if (!code) return '';
  const name = names.get(code)?.stationName ?? code;
  return name.replace(/ asema$/, '');
}

/** Lookup tables for operators and delay causes, loaded once. */
interface Metadata {
  names: Map<string, Station>;
  operators: Map<string, string>;
  causes: Map<string, string>;
}

let metadata: Promise<Metadata> | undefined;

function loadMetadata(): Promise<Metadata> {
  const optional = <T>(path: string) => railFetch<T[]>(path).catch(() => [] as T[]);
  metadata ??= Promise.all([
    loadStations(),
    optional<{ operatorShortCode: string; operatorName?: string }>('/api/v1/metadata/operators'),
    optional<{ categoryCode: string; categoryName?: string }>('/api/v1/metadata/cause-category-codes'),
    optional<{ detailedCategoryCode: string; detailedCategoryName?: string }>(
      '/api/v1/metadata/detailed-cause-category-codes',
    ),
  ])
    .then(([names, operators, categories, details]) => ({
      names,
      operators: new Map(operators.map((o) => [o.operatorShortCode, o.operatorName ?? o.operatorShortCode])),
      causes: new Map([
        ...categories.map((c): [string, string] => [c.categoryCode, c.categoryName ?? c.categoryCode]),
        ...details.map((d): [string, string] => [d.detailedCategoryCode, d.detailedCategoryName ?? d.detailedCategoryCode]),
      ]),
    }))
    .catch((error) => {
      metadata = undefined;
      throw error;
    });
  return metadata;
}

// --- Trains ----------------------------------------------------------------

interface TimetableRow {
  stationShortCode: string;
  type: 'ARRIVAL' | 'DEPARTURE';
  trainStopping?: boolean;
  commercialStop?: boolean;
  commercialTrack?: string;
  cancelled?: boolean;
  scheduledTime: string;
  liveEstimateTime?: string;
  actualTime?: string;
  differenceInMinutes?: number;
  causes?: Cause[];
}

interface Cause {
  categoryCode?: string;
  detailedCategoryCode?: string;
}

interface Train {
  trainNumber: number;
  departureDate: string;
  trainType?: string;
  trainCategory?: string;
  commuterLineID?: string;
  operatorShortCode?: string;
  cancelled?: boolean;
  timetableRows?: TimetableRow[];
}

interface TrainLocation {
  trainNumber: number;
  departureDate: string;
  timestamp: string;
  location?: { coordinates?: [number, number] };
  speed?: number;
}

interface DelayRow {
  actualTime?: string | null;
  differenceInMinutes?: number | null;
}

interface DelayResponse {
  data?: {
    currentlyRunningTrains?: {
      trainNumber: number;
      departureDate: string;
      timetableRows?: DelayRow[] | null;
    }[];
  };
}

const DELAY_QUERY = `{
  currentlyRunningTrains {
    trainNumber
    departureDate
    timetableRows { actualTime differenceInMinutes }
  }
}`;

const trainKey = (departureDate: string, trainNumber: number) => `${departureDate}/${trainNumber}`;

/** Delay at the last station the train has passed, in minutes. */
function currentDelay(rows: { actualTime?: string | null; differenceInMinutes?: number | null }[]) {
  let delay: number | undefined;
  for (const row of rows) {
    if (row.actualTime && row.differenceInMinutes != null) delay = row.differenceInMinutes;
  }
  return delay;
}

async function loadDelays(): Promise<Map<string, number>> {
  const response = await railFetch<DelayResponse>(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: DELAY_QUERY }),
  });
  const delays = new Map<string, number>();
  for (const train of response.data?.currentlyRunningTrains ?? []) {
    const delay = currentDelay(train.timetableRows ?? []);
    if (delay != null) delays.set(trainKey(train.departureDate, train.trainNumber), delay);
  }
  return delays;
}

const DELAY_COLORS = {
  onTime: '#2e9e44',
  small: '#f2b705',
  medium: '#e07b00',
  large: '#d7263d',
  unknown: '#8a8f98',
};

function delayColor(delay?: number): string {
  if (delay == null) return DELAY_COLORS.unknown;
  if (delay < 1) return DELAY_COLORS.onTime;
  if (delay <= 5) return DELAY_COLORS.small;
  if (delay <= 15) return DELAY_COLORS.medium;
  return DELAY_COLORS.large;
}

function delayText(delay?: number): string | undefined {
  if (delay == null) return undefined;
  if (delay < 1) return delay < 0 ? `Etuajassa ${-delay} min` : 'Ajallaan';
  return `${delay} min myöhässä`;
}

/** "IC 27", or "Lähijuna R" for commuter trains. */
function trainName(train: Pick<Train, 'trainType' | 'trainNumber' | 'commuterLineID'>): string {
  if (train.commuterLineID) return `Lähijuna ${train.commuterLineID}`;
  return `${train.trainType ?? 'Juna'} ${train.trainNumber}`;
}

function clock(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
}

function dataLink(path: string): string {
  return `<a class="dt-link" href="${escapeHtml(API + path)}" target="_blank" rel="noopener">Avaa tiedot Digitrafficissa</a>`;
}

function causeTexts(rows: TimetableRow[], causes: Map<string, string>): string[] {
  const texts = new Set<string>();
  for (const row of rows) {
    for (const cause of row.causes ?? []) {
      const code = cause.detailedCategoryCode ?? cause.categoryCode;
      if (code) texts.add(causes.get(code) ?? causes.get(cause.categoryCode ?? '') ?? code);
    }
  }
  return [...texts];
}

/** Time cell of the stop list: actual time if passed, else estimate, else schedule. */
function stopTime(row?: TimetableRow): string {
  if (!row) return '';
  const scheduled = clock(row.scheduledTime);
  if (row.cancelled) return `<s>${escapeHtml(scheduled)}</s>`;
  const real = row.actualTime ?? row.liveEstimateTime;
  const late = (row.differenceInMinutes ?? 0) >= 1;
  if (!real || clock(real) === scheduled) return escapeHtml(scheduled);
  const cls = late ? 'rail-late' : 'dt-muted';
  return `${escapeHtml(scheduled)} <span class="${cls}">${escapeHtml(clock(real))}</span>`;
}

/** Every stop of the train with arrival and departure, in a collapsible list. */
function stopListHtml(rows: TimetableRow[], names: Map<string, Station>): string {
  const stops: { code: string; arrival?: TimetableRow; departure?: TimetableRow }[] = [];
  for (const row of rows) {
    if (row.trainStopping === false) continue;
    const last = stops[stops.length - 1];
    if (row.type === 'DEPARTURE' && last && last.code === row.stationShortCode && !last.departure) {
      last.departure = row;
    } else {
      stops.push({ code: row.stationShortCode, [row.type === 'ARRIVAL' ? 'arrival' : 'departure']: row });
    }
  }
  if (stops.length === 0) return '';
  const body = stops
    .map((stop) => {
      const passed = !!(stop.departure ?? stop.arrival)?.actualTime;
      return (
        `<tr${passed ? ' class="rail-passed"' : ''}><td>${escapeHtml(stationName(names, stop.code))}</td>` +
        `<td>${stopTime(stop.arrival)}</td><td>${stopTime(stop.departure)}</td>` +
        `<td>${escapeHtml((stop.departure ?? stop.arrival)?.commercialTrack ?? '')}</td></tr>`
      );
    })
    .join('');
  return (
    `<details class="rail-stops"><summary>Pysähdykset (${stops.length})</summary>` +
    '<table class="dt-table rail-table"><thead><tr><th>Asema</th><th>Saapuu</th><th>Lähtee</th><th>Raide</th></tr></thead>' +
    `<tbody>${body}</tbody></table></details>`
  );
}

function trainPopup(train: Train, meta: Metadata, speed?: number): string {
  const { names } = meta;
  const rows = train.timetableRows ?? [];
  const passed = rows.filter((r) => r.actualTime);
  const previous = passed[passed.length - 1];
  const next = rows.find((r) => !r.actualTime && r.trainStopping !== false && !r.cancelled);
  const delay = currentDelay(rows);

  const previousText = previous
    ? `${stationName(names, previous.stationShortCode)} ${clock(previous.actualTime)}`
    : undefined;
  const nextTime = next ? clock(next.liveEstimateTime ?? next.scheduledTime) : '';
  const nextText = next
    ? `${stationName(names, next.stationShortCode)} ${nextTime}${next.liveEstimateTime ? ' (arvio)' : ''}`
    : undefined;

  const route =
    rows.length > 0
      ? `${stationName(names, rows[0].stationShortCode)} – ${stationName(names, rows[rows.length - 1].stationShortCode)}`
      : undefined;
  const operator = train.operatorShortCode
    ? (meta.operators.get(train.operatorShortCode) ?? train.operatorShortCode.toUpperCase())
    : undefined;
  const causes = causeTexts(rows, meta.causes);

  return (
    `<strong>${escapeHtml(trainName(train))}</strong>` +
    (train.commuterLineID ? ` <span class="dt-type">(${train.trainNumber})</span>` : '') +
    (train.cancelled ? '<p><strong>Peruttu</strong></p>' : '') +
    factTable([
      ['Reitti', route],
      ['Myöhästymä', delayText(delay)],
      ['Syy', causes.length > 0 ? causes.join('; ') : undefined],
      ['Edellinen asema', previousText],
      ['Seuraava asema', nextText],
      ['Nopeus', speed != null ? `${Math.round(speed)} km/h` : undefined],
      ['Operaattori', operator],
    ]) +
    stopListHtml(rows, names)
  );
}

function trainLayer(map: L.Map): L.LayerGroup {
  const markers = new Map<string, L.CircleMarker>();
  const speeds = new Map<string, number | undefined>();
  let delays = new Map<string, number>();
  let delaysLoadedAt = 0;

  return liveLayer(
    map,
    'Junat',
    async (group) => {
      // Positions update every few seconds at the source; delays change only
      // when a train passes a station, so they are refreshed less often.
      const delayRequest =
        Date.now() - delaysLoadedAt > 60_000
          ? loadDelays()
              .then((d) => {
                delays = d;
                delaysLoadedAt = Date.now();
              })
              .catch((error) => console.warn('Junien myöhästymät:', error))
          : Promise.resolve();
      const [locations] = await Promise.all([
        railFetch<TrainLocation[]>('/api/v1/train-locations/latest/'),
        delayRequest,
      ]);

      const cutoff = Date.now() - 15 * 60_000;
      const seen = new Set<string>();
      for (const loc of locations) {
        const coords = loc.location?.coordinates;
        if (!coords || new Date(loc.timestamp).getTime() < cutoff) continue;
        const key = trainKey(loc.departureDate, loc.trainNumber);
        const latlng = L.latLng(coords[1], coords[0]);
        const color = delayColor(delays.get(key));
        seen.add(key);
        speeds.set(key, loc.speed);

        const existing = markers.get(key);
        if (existing) {
          existing.setLatLng(latlng).setStyle({ fillColor: color });
          continue;
        }

        const marker = L.circleMarker(latlng, {
          radius: 7,
          color: '#fff',
          weight: 2,
          fillColor: color,
          fillOpacity: 0.95,
        });
        const path = `/api/v1/trains/${encodeURIComponent(loc.departureDate)}/${loc.trainNumber}`;
        const link = dataLink(path);
        marker.bindTooltip(`Juna ${loc.trainNumber}`, { direction: 'top', offset: [0, -6] });
        marker.bindPopup(`<strong>Juna ${loc.trainNumber}</strong><p>Ladataan…</p>${link}`, {
          maxWidth: 360,
          minWidth: 280,
        });
        marker.on('popupopen', async () => {
          try {
            const [trains, meta] = await Promise.all([railFetch<Train[]>(path), loadMetadata()]);
            const train = trains[0];
            if (!train) throw new Error('Junaa ei löytynyt');
            marker.setPopupContent(`${trainPopup(train, meta, speeds.get(key))}${link}`);
            marker.setTooltipContent(trainName(train));
          } catch {
            marker.setPopupContent(`<strong>Juna ${loc.trainNumber}</strong><p>Junan tietojen haku epäonnistui.</p>${link}`);
          }
        });
        markers.set(key, marker);
        group.addLayer(marker);
      }

      // Trains that finished their run or stopped reporting.
      for (const [key, marker] of markers) {
        if (seen.has(key)) continue;
        group.removeLayer(marker);
        markers.delete(key);
        speeds.delete(key);
      }
    },
    20_000,
  );
}

// --- Station departures -----------------------------------------------------

/** Next departures or arrivals at a station, soonest first. */
function stationTableHtml(
  code: string,
  type: TimetableRow['type'],
  trains: Train[],
  names: Map<string, Station>,
): string {
  const now = Date.now();
  const entries = trains
    .map((train) => {
      const row = (train.timetableRows ?? []).find(
        (r) => r.stationShortCode === code && r.type === type && r.commercialStop !== false,
      );
      return { train, row };
    })
    .filter(
      (d): d is { train: Train; row: TimetableRow } =>
        !!d.row &&
        !d.row.actualTime &&
        new Date(d.row.liveEstimateTime ?? d.row.scheduledTime).getTime() > now - 60_000,
    )
    .sort((a, b) => a.row.scheduledTime.localeCompare(b.row.scheduledTime))
    .slice(0, 8);

  const heading = type === 'DEPARTURE' ? 'Lähtevät junat' : 'Saapuvat junat';
  if (entries.length === 0) return `<div class="dt-type">${heading}</div><p class="dt-muted">Ei junia lähiaikoina.</p>`;

  const rows = entries
    .map(({ train, row }) => {
      const timetable = train.timetableRows ?? [];
      // Departures show where the train goes, arrivals where it comes from.
      const other = type === 'DEPARTURE' ? timetable[timetable.length - 1] : timetable[0];
      const late = (row.differenceInMinutes ?? 0) >= 1;
      const estimate =
        row.cancelled || train.cancelled
          ? '<strong class="rail-late">Peruttu</strong>'
          : row.liveEstimateTime && late
            ? `<span class="rail-late">${escapeHtml(clock(row.liveEstimateTime))}</span>`
            : '';
      return (
        `<tr><td>${escapeHtml(clock(row.scheduledTime))}</td><td>${estimate}</td>` +
        `<td>${escapeHtml(trainName(train))}</td><td>${escapeHtml(stationName(names, other?.stationShortCode))}</td>` +
        `<td>${escapeHtml(row.commercialTrack ?? '')}</td></tr>`
      );
    })
    .join('');

  return (
    `<div class="dt-type">${heading}</div>` +
    '<table class="dt-table rail-table"><thead><tr><th>Aika</th><th>Arvio</th>' +
    `<th>Juna</th><th>${type === 'DEPARTURE' ? 'Minne' : 'Mistä'}</th><th>Raide</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function stationLayer(map: L.Map): L.LayerGroup {
  return liveLayer(map, 'Rautatieasemat', async (group) => {
    const names = await loadStations();
    for (const station of names.values()) {
      if (!station.passengerTraffic || (station.countryCode && station.countryCode !== 'FI')) continue;

      const marker = L.circleMarker([station.latitude, station.longitude], {
        radius: 5,
        color: '#fff',
        weight: 1.5,
        fillColor: '#3949ab',
        fillOpacity: 0.9,
      });
      const code = encodeURIComponent(station.stationShortCode);
      const path =
        `/api/v1/live-trains/station/${code}` +
        '?arrived_trains=0&arriving_trains=15&departed_trains=0&departing_trains=15&include_nonstopping=false';
      const link = dataLink(path);
      const title = `<strong>${escapeHtml(stationName(names, station.stationShortCode))}</strong>`;
      marker.bindTooltip(stationName(names, station.stationShortCode), { direction: 'top', offset: [0, -4] });
      marker.bindPopup(`${title}<p>Ladataan…</p>${link}`, { maxWidth: 380, minWidth: 280 });
      marker.on('popupopen', async () => {
        try {
          const trains = await railFetch<Train[]>(path);
          marker.setPopupContent(
            title +
              stationTableHtml(station.stationShortCode, 'DEPARTURE', trains, names) +
              stationTableHtml(station.stationShortCode, 'ARRIVAL', trains, names) +
              link,
          );
        } catch {
          marker.setPopupContent(`${title}<p>Junatietojen haku epäonnistui.</p>${link}`);
        }
      });
      group.addLayer(marker);
    }
  });
}

export function createRailOverlays(map: L.Map): OverlayGroup {
  return {
    title: 'Rautatieliikenne',
    source: 'Fintraffic / Digitraffic',
    items: [
      {
        name: 'Junat',
        description: 'Kulkevat junat ja myöhästymät nyt',
        layer: trainLayer(map),
        legend: [
          { color: DELAY_COLORS.onTime, label: 'Ajallaan' },
          { color: DELAY_COLORS.small, label: '1–5 min myöhässä' },
          { color: DELAY_COLORS.medium, label: '6–15 min myöhässä' },
          { color: DELAY_COLORS.large, label: 'Yli 15 min myöhässä' },
          { color: DELAY_COLORS.unknown, label: 'Myöhästymä ei tiedossa' },
        ],
      },
      {
        name: 'Rautatieasemat',
        description: 'Lähdöt, saapumiset ja myöhästymät',
        layer: stationLayer(map),
        legend: [{ color: '#3949ab', label: 'Henkilöliikenteen asema' }],
      },
    ],
  };
}
