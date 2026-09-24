import L from 'leaflet';

/** One colour in a layer's legend, e.g. red dots for accidents. */
export interface LegendEntry {
  color: string;
  label: string;
}

/** A data layer the user can switch on and off in the side panel. */
export interface OverlayItem {
  name: string;
  layer: L.Layer;
  /** Short explanation under the name. */
  description?: string;
  /** Colours shown next to the name; the first one is the item's swatch. */
  legend?: LegendEntry[];
}

/** A themed group of data layers, e.g. "Tieliikenne". */
export interface OverlayGroup {
  title: string;
  /** Where the data comes from, shown under the group title. */
  source?: string;
  items: OverlayItem[];
}

const MOBILE_QUERY = '(max-width: 768px)';

/**
 * Builds the layer panel next to the map: base maps as radio buttons and data
 * layers as checkboxes grouped by theme. New layers are added by passing
 * another group or item; nothing else here needs to change.
 */
export function createLayerPanel(
  map: L.Map,
  panel: HTMLElement,
  toggle: HTMLButtonElement,
  baseLayers: Record<string, L.Layer>,
  overlayGroups: OverlayGroup[],
): void {
  panel.replaceChildren();

  const header = el('div', 'panel-header');
  header.append(el('h2', 'panel-title', 'Karttatasot'));
  const close = el('button', 'panel-close', '×');
  close.type = 'button';
  close.title = 'Sulje paneeli';
  close.setAttribute('aria-label', 'Sulje paneeli');
  header.append(close);
  panel.append(header);

  const body = el('div', 'panel-body');
  panel.append(body);

  body.append(baseSection(map, baseLayers));
  for (const group of overlayGroups) body.append(overlaySection(map, group));

  // Open by default on wide screens; on phones the panel is a drawer over the
  // map and starts closed so the map stays usable.
  const mobile = window.matchMedia(MOBILE_QUERY);
  const setOpen = (open: boolean) => {
    document.body.classList.toggle('panel-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // The map changes width when the panel opens or closes on wide screens.
    window.setTimeout(() => map.invalidateSize(), 220);
  };
  setOpen(!mobile.matches);
  mobile.addEventListener('change', (e) => setOpen(!e.matches));

  toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('panel-open')));
  close.addEventListener('click', () => setOpen(false));
  document.querySelector('.panel-backdrop')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobile.matches) setOpen(false);
  });
}

function baseSection(map: L.Map, baseLayers: Record<string, L.Layer>): HTMLElement {
  const section = el('section', 'panel-section');
  section.append(el('h3', 'panel-section-title', 'Taustakartta'));
  const list = el('div', 'base-list');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Taustakartta');

  for (const [name, layer] of Object.entries(baseLayers)) {
    const label = el('label', 'base-option');
    const input = el('input');
    input.type = 'radio';
    input.name = 'base-layer';
    input.checked = map.hasLayer(layer);
    input.addEventListener('change', () => {
      for (const other of Object.values(baseLayers)) if (other !== layer) map.removeLayer(other);
      map.addLayer(layer);
    });
    label.append(input, el('span', 'base-name', name));
    list.append(label);
  }

  section.append(list);
  return section;
}

function overlaySection(map: L.Map, group: OverlayGroup): HTMLElement {
  const section = el('section', 'panel-section');
  section.append(el('h3', 'panel-section-title', group.title));
  if (group.source) section.append(el('p', 'panel-source', group.source));

  for (const item of group.items) {
    const row = el('label', 'overlay-option');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = map.hasLayer(item.layer);
    input.addEventListener('change', () => {
      if (input.checked) map.addLayer(item.layer);
      else map.removeLayer(item.layer);
      row.classList.toggle('is-on', input.checked);
    });
    row.classList.toggle('is-on', input.checked);

    const swatch = el('span', 'overlay-swatch');
    swatch.style.background = item.legend?.[0]?.color ?? 'var(--color-primary)';

    const text = el('span', 'overlay-text');
    text.append(el('span', 'overlay-name', item.name));
    if (item.description) text.append(el('span', 'overlay-description', item.description));
    if (item.legend && item.legend.length > 1) {
      const legend = el('ul', 'overlay-legend');
      for (const entry of item.legend) {
        const li = el('li');
        const dot = el('span', 'legend-dot');
        dot.style.background = entry.color;
        li.append(dot, entry.label);
        legend.append(li);
      }
      text.append(legend);
    }

    row.append(input, swatch, text);
    section.append(row);
  }

  return section;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
