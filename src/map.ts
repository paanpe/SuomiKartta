import L from 'leaflet';
import { MML_PROXY_URL } from './config';
import { createDigitrafficOverlays } from './digitraffic';
import { createLayerPanel } from './layer-panel';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Leaflet resolves its default marker images from CSS paths, which breaks under
// a bundler. Point it at the bundled assets instead.
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

/** Roughly the bounding box of Finland, with some margin. */
export const FINLAND_BOUNDS = L.latLngBounds([58.5, 18.0], [70.5, 33.0]);
const FINLAND_CENTER: L.LatLngTuple = [64.9, 26.0];

function mmlLayer(proxyUrl: string, layer: string): L.TileLayer {
  return L.tileLayer(`${proxyUrl}/tiles/${layer}/{z}/{y}/{x}`, {
    maxNativeZoom: 16,
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.maanmittauslaitos.fi/avoindata-lisenssi-cc40">Maanmittauslaitos</a>',
  });
}

function createBaseLayers(): Record<string, L.TileLayer> {
  const openStreetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> -tekijät',
  });

  if (MML_PROXY_URL) {
    return {
      Taustakartta: mmlLayer(MML_PROXY_URL, 'taustakartta'),
      Maastokartta: mmlLayer(MML_PROXY_URL, 'maastokartta'),
      Selkokartta: mmlLayer(MML_PROXY_URL, 'selkokartta'),
      Ilmakuva: mmlLayer(MML_PROXY_URL, 'ortokuva'),
      OpenStreetMap: openStreetMap,
    };
  }

  return {
    OpenStreetMap: openStreetMap,
    Maastokartta: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> -tekijät, ' +
        '<a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
  };
}

export function formatLatLng(latlng: L.LatLng): string {
  const lat = `${Math.abs(latlng.lat).toFixed(5)}° ${latlng.lat >= 0 ? 'P' : 'E'}`;
  const lng = `${Math.abs(latlng.lng).toFixed(5)}° ${latlng.lng >= 0 ? 'I' : 'L'}`;
  return `${lat}, ${lng}`;
}

export function createMap(
  container: HTMLElement,
  panel: HTMLElement,
  panelToggle: HTMLButtonElement,
): L.Map {
  const map = L.map(container, {
    center: FINLAND_CENTER,
    zoom: 5,
    minZoom: 4,
    maxBounds: FINLAND_BOUNDS.pad(0.5),
    // Canvas draws the thousands of Digitraffic markers much faster than SVG.
    preferCanvas: true,
  });

  const baseLayers = createBaseLayers();
  Object.values(baseLayers)[0].addTo(map);
  createLayerPanel(map, panel, panelToggle, baseLayers, [createDigitrafficOverlays(map)]);
  L.control.scale({ metric: true, imperial: false }).addTo(map);

  addLocateControl(map);

  map.on('click', (e) => {
    L.popup().setLatLng(e.latlng).setContent(formatLatLng(e.latlng)).openOn(map);
  });

  return map;
}

function addLocateControl(map: L.Map): void {
  const LocateControl = L.Control.extend({
    onAdd() {
      const button = L.DomUtil.create('button', 'leaflet-bar locate-button');
      button.type = 'button';
      button.title = 'Näytä sijaintini';
      button.setAttribute('aria-label', 'Näytä sijaintini');
      button.textContent = '◎';
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, 'click', () => map.locate({ setView: true, maxZoom: 14 }));
      return button;
    },
  });
  new LocateControl({ position: 'topleft' }).addTo(map);

  let accuracyCircle: L.Circle | undefined;
  map.on('locationfound', (e) => {
    accuracyCircle?.remove();
    accuracyCircle = L.circle(e.latlng, { radius: e.accuracy }).addTo(map);
  });
  map.on('locationerror', (e) => {
    alert(`Sijaintia ei saatu: ${e.message}`);
  });
}
