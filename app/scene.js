// Carte 3D : la France en plateau, une colonne par actif (fantôme = puissance, plein = production à l'heure choisie).
/* global maplibregl */

export const COLORS = {
  nucleaire: '#F2C94C', hydraulique: '#3BA3F0', gaz: '#EB5757', charbon: '#A88671',
  fioul: '#B07CF0', eolien: '#2CC5A8', solaire: '#F28C38', bioenergies: '#7BC67E',
};
const SLAB = 4000;   // épaisseur du plateau (m)
const K = 42;        // mètres de colonne par MW

function circle(lon, lat, km, n = 20) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([lon + (km / (111.3 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (km / 111.3) * Math.sin(a)]);
  }
  return [pts];
}

export function createScene(el, D, { onPick, onHover }) {
  const entities = [...new Set(D.units.filter((u) => u.mapId).map((u) => u.mapId))].map((id) => {
    const a = D.assets.find((x) => x.id === id);
    return { id, a, km: 3.2 + Math.sqrt(a.p_mw) / 11 };
  });
  const small = matchMedia('(max-width: 720px)').matches;
  const colorExpr = ['match', ['get', 'f'], ...Object.entries(COLORS).flat(), '#999'];

  const map = new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      light: { anchor: 'viewport', color: '#ffffff', intensity: 0.35, position: [1.2, 200, 35] },
      sources: {
        regions: { type: 'geojson', data: D.regions },
        cols: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' },
        ghost: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        pts: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#060b14' } },
        { id: 'slab', type: 'fill-extrusion', source: 'regions', paint: {
          'fill-extrusion-color': ['match', ['%', ['to-number', ['get', 'code']], 3], 0, '#121d31', 1, '#152238', '#101a2c'],
          'fill-extrusion-height': SLAB, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1 } },
        { id: 'glow', type: 'circle', source: 'pts', paint: {
          'circle-color': colorExpr, 'circle-blur': 1, 'circle-pitch-alignment': 'map',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['*', 14, ['get', 'r']], 8, ['*', 70, ['get', 'r']]],
          'circle-opacity': ['*', 0.55, ['get', 'r']] } },
        { id: 'ghost', type: 'fill-extrusion', source: 'ghost', paint: {
          'fill-extrusion-color': colorExpr, 'fill-extrusion-opacity': 0.14,
          'fill-extrusion-base': SLAB, 'fill-extrusion-height': ['+', SLAB, ['*', K, ['get', 'cap']]] } },
        { id: 'solid', type: 'fill-extrusion', source: 'cols', paint: {
          'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'sel'], false], '#ffffff', colorExpr],
          'fill-extrusion-opacity': 0.95, 'fill-extrusion-vertical-gradient': true,
          'fill-extrusion-base': SLAB, 'fill-extrusion-height': ['+', SLAB + 300, ['*', K, ['get', 'prod']]] } },
        { id: 'ring', type: 'circle', source: 'pts', filter: ['==', ['get', 'id'], ''], paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 40], 'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } },
      ],
    },
    center: small ? [2.5, 46.0] : [2.4, 46.3], zoom: small ? 4.3 : 4.95, pitch: small ? 45 : 52, bearing: -12,
    minZoom: 3.6, maxZoom: 9, maxPitch: 70, attributionControl: false,
    maxBounds: [[-40, 25], [45, 65]],
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Fond : IGN/INSEE · Données : RTE, ENTSO-E' }), 'bottom-left');

  let hour = D.now, filter = null, selected = null;
  const ready = new Promise((res) => map.on('load', res));

  function features() {
    const cols = [], pts = [], ghost = [];
    for (const e of entities) {
      if (filter && !filter.has(e.a.filiere)) continue;
      const prod = D.siteProd(e.id, hour), cap = e.a.p_mw;
      const props = { id: e.id, f: e.a.filiere, cap, prod: Math.max(0, prod), r: Math.min(1, prod / cap) };
      cols.push({ type: 'Feature', id: e.id, properties: props, geometry: { type: 'Polygon', coordinates: circle(e.a.lon, e.a.lat, e.km) } });
      ghost.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: circle(e.a.lon, e.a.lat, e.km * 1.18) } });
      pts.push({ type: 'Feature', id: e.id, properties: props, geometry: { type: 'Point', coordinates: [e.a.lon, e.a.lat] } });
    }
    return { cols, pts, ghost };
  }
  function refresh() {
    if (!map.getSource('cols')) return;
    const { cols, pts, ghost } = features();
    map.getSource('ghost').setData({ type: 'FeatureCollection', features: ghost });
    map.getSource('cols').setData({ type: 'FeatureCollection', features: cols });
    map.getSource('pts').setData({ type: 'FeatureCollection', features: pts });
  }
  ready.then(() => {
    refresh();
    for (const layer of ['solid', 'ghost']) {
      map.on('click', layer, (ev) => { const f = ev.features[0]; if (f) onPick(f.properties.id); });
      map.on('mousemove', layer, (ev) => { map.getCanvas().style.cursor = 'pointer'; const f = ev.features[0]; if (f) onHover?.(f.properties.id, ev.point); });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; onHover?.(null); });
    }
  });

  return {
    map, ready,
    setHour(h) { hour = h; refresh(); },
    setFilter(set) { filter = set; refresh(); },
    select(id) {
      if (selected && map.getSource('cols')) map.setFeatureState({ source: 'cols', id: selected }, { sel: false });
      selected = id;
      if (!map.getSource('cols')) return;
      map.setFilter('ring', ['==', ['get', 'id'], id || '']);
      if (id) {
        map.setFeatureState({ source: 'cols', id }, { sel: true });
        const a = D.assets.find((x) => x.id === id);
        if (a) map.easeTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 5.6), duration: 900, padding: panelPadding() });
      }
    },
    project(lon, lat) { return map.project([lon, lat]); },
    resize() { map.resize(); },
  };
}

function panelPadding() {
  const wide = matchMedia('(min-width: 900px)').matches;
  return wide ? { right: 440, left: 0, top: 0, bottom: 0 } : { bottom: Math.round(innerHeight * 0.5), top: 0, left: 0, right: 0 };
}
