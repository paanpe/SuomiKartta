import 'leaflet/dist/leaflet.css';
import './style.css';
import { createMap } from './map';
import { setupSearch } from './search';

const map = createMap(document.getElementById('map')!);

setupSearch(
  map,
  document.getElementById('search-form') as HTMLFormElement,
  document.getElementById('search-input') as HTMLInputElement,
  document.getElementById('search-results') as HTMLUListElement,
);
