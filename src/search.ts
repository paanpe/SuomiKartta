import L from 'leaflet';
import { FINLAND_BOUNDS } from './map';

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

async function searchPlaces(query: string, signal: AbortSignal): Promise<NominatimResult[]> {
  const bounds = FINLAND_BOUNDS;
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    countrycodes: 'fi',
    limit: '8',
    'accept-language': 'fi',
    viewbox: [bounds.getWest(), bounds.getNorth(), bounds.getEast(), bounds.getSouth()].join(','),
  });
  const response = await fetch(`${NOMINATIM_URL}?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`Haku epäonnistui (${response.status})`);
  }
  return response.json();
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

  const selectResult = (result: NominatimResult) => {
    const latlng = L.latLng(Number(result.lat), Number(result.lon));
    const [south, north, west, east] = result.boundingbox.map(Number);
    map.fitBounds([[south, west], [north, east]], { maxZoom: 15 });
    marker?.remove();
    marker = L.marker(latlng).addTo(map).bindPopup(result.display_name).openPopup();
    input.value = result.display_name.split(',')[0];
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
        button.textContent = result.display_name;
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
