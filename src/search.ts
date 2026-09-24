import L from 'leaflet';
import { MML_PROXY_URL } from './config';
import { FINLAND_BOUNDS } from './map';

/** A search hit, in the same shape whichever service answered. */
interface Place {
  label: string;
  latlng: L.LatLng;
  bounds?: L.LatLngBounds;
}

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

/** A feature from MML's Pelias-style geocoding, in WGS84 (longitude, latitude). */
interface MmlFeature {
  geometry: { coordinates: [number, number] };
  bbox?: [number, number, number, number];
  properties: { label?: string; name?: string };
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Haku epäonnistui (${response.status})`);
  }
  return response.json();
}

async function searchNominatim(query: string, signal: AbortSignal): Promise<Place[]> {
  const bounds = FINLAND_BOUNDS;
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    countrycodes: 'fi',
    limit: '8',
    'accept-language': 'fi',
    viewbox: [bounds.getWest(), bounds.getNorth(), bounds.getEast(), bounds.getSouth()].join(','),
  });
  const results = await fetchJson<NominatimResult[]>(`${NOMINATIM_URL}?${params}`, signal);
  return results.map((result) => {
    const [south, north, west, east] = result.boundingbox.map(Number);
    return {
      label: result.display_name,
      latlng: L.latLng(Number(result.lat), Number(result.lon)),
      bounds: L.latLngBounds([south, west], [north, east]),
    };
  });
}

async function searchMml(proxyUrl: string, query: string, signal: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ text: query });
  const { features } = await fetchJson<{ features: MmlFeature[] }>(
    `${proxyUrl}/search?${params}`,
    signal,
  );
  return features.map((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const bbox = feature.bbox;
    return {
      label: feature.properties.label ?? feature.properties.name ?? `${lat}, ${lng}`,
      latlng: L.latLng(lat, lng),
      bounds: bbox ? L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]) : undefined,
    };
  });
}

function searchPlaces(query: string, signal: AbortSignal): Promise<Place[]> {
  return MML_PROXY_URL
    ? searchMml(MML_PROXY_URL, query, signal)
    : searchNominatim(query, signal);
}

export function setupSearch(
  map: L.Map,
  form: HTMLFormElement,
  input: HTMLInputElement,
  resultList: HTMLUListElement,
): void {
  let marker: L.Marker | undefined;
  let pending: AbortController | undefined;

  const hideResults = () => {
    resultList.hidden = true;
    resultList.replaceChildren();
  };

  const showMessage = (text: string) => {
    const item = document.createElement('li');
    item.className = 'search-message';
    item.textContent = text;
    resultList.replaceChildren(item);
    resultList.hidden = false;
  };

  const selectResult = (place: Place) => {
    if (place.bounds?.isValid() && !place.bounds.getNorthEast().equals(place.bounds.getSouthWest())) {
      map.fitBounds(place.bounds, { maxZoom: 15 });
    } else {
      map.setView(place.latlng, 14);
    }
    marker?.remove();
    marker = L.marker(place.latlng).addTo(map).bindPopup(place.label).openPopup();
    input.value = place.label.split(',')[0];
    hideResults();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    pending?.abort();
    pending = new AbortController();
    showMessage('Haetaan…');

    try {
      const results = await searchPlaces(query, pending.signal);
      if (results.length === 0) {
        showMessage('Ei tuloksia.');
        return;
      }
      const items = results.map((result) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = result.label;
        button.addEventListener('click', () => selectResult(result));
        item.append(button);
        return item;
      });
      resultList.replaceChildren(...items);
      resultList.hidden = false;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      showMessage((error as Error).message);
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideResults();
  });
  document.addEventListener('click', (event) => {
    if (!form.contains(event.target as Node)) hideResults();
  });
}
