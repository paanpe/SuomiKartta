import 'leaflet/dist/leaflet.css';
import './style.css';
import { createMap } from './map';
import { setupSearch } from './search';

const map = createMap(
  document.getElementById('map')!,
  document.getElementById('layer-panel')!,
  document.getElementById('panel-toggle') as HTMLButtonElement,
);

setupSearch(
  map,
  document.getElementById('search-form') as HTMLFormElement,
  document.getElementById('search-input') as HTMLInputElement,
  document.getElementById('search-results') as HTMLUListElement,
);
