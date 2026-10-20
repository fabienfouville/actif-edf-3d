// Maquette 3D : la France en plateau blanc, une maquette par filière. Un clic sur une filière l'éclate en
// ses vrais sites, qui s'envolent vers leur position réelle ; un clic sur un site ouvre sa fiche.
// L'anneau au sol indique la charge à l'heure choisie ; vapeur, pales et eau s'animent quand le site produit.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildModel, COLORS } from './models.js';

export { COLORS };

const SCALE = 10, LON0 = 2.5, LAT0 = 46.4, KX = Math.cos(LAT0 * Math.PI / 180);
const TOP = 0.8; // épaisseur du plateau France
export const SPOTS = {
  nucleaire: { lon: 1.6, lat: 47.35, nom: 'Parc nucléaire' },
  hydraulique: { lon: 6.2, lat: 45.1, nom: 'Parc hydraulique' },
  eolien: { lon: 2.9, lat: 49.85, nom: 'Parc éolien' },
  solaire: { lon: 0.0, lat: 44.2, nom: 'Parc solaire' },
  gaz: { lon: 4.6, lat: 43.75, nom: 'Parc gaz' },
  charbon: { lon: -1.6, lat: 47.6, nom: 'Parc charbon' },
  fioul: { lon: -3.6, lat: 48.3, nom: 'Parc fioul' },
  bioenergies: { lon: 4.3, lat: 46.6, nom: 'Parc bioénergies' },
};
export const toXZ = (lon, lat) => [(lon - LON0) * KX * SCALE, -(lat - LAT0) * SCALE];

function franceSlab(regions) {
  const shapes = [], lines = [];
  for (const f of regions.features) {
    for (const poly of f.geometry.coordinates) {
      const ring = (r) => r.map(([lon, lat]) => { const [x, z] = toXZ(lon, lat); return new THREE.Vector2(x, -z); });
      const shape = new THREE.Shape(ring(poly[0]));
      for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(ring(hole)));
      shapes.push(shape);
      for (const r of poly) {
        const pts = ring(r);
        for (let i = 0; i < pts.length - 1; i++) lines.push(pts[i].x, TOP + 0.01, -pts[i].y, pts[i + 1].x, TOP + 0.01, -pts[i + 1].y);
      }
    }
  }
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: TOP, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const slab = new THREE.Mesh(geo, [
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ color: '#e4e0d8', roughness: 0.95 }),
  ]);
  slab.receiveShadow = true; slab.castShadow = true;
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const border = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#dcd6cb' }));
  return [slab, border];
}

/** Écarte les sites trop proches pour que les maquettes ne se chevauchent pas. */
function relax(items) {
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const min = 2.3 * (a.s + b.s);
        let dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz) || 0.01;
        if (d < min) {
          const push = (min - d) / 2;
          dx /= d; dz /= d;
          a.x -= dx * push; a.z -= dz * push; b.x += dx * push; b.z += dz * push;
        }
      }
    }
  }
}

export function createScene(el, D, { onPick, onHover }) {
  const small = matchMedia('(max-width: 720px)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 2 : 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#efece6');

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: '#ebe7e0', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground, ...franceSlab(D.regions));

  scene.add(new THREE.HemisphereLight('#ffffff', '#d9d3c8', 1.35));
  const sun = new THREE.DirectionalLight('#fff7ea', 1.9);
  sun.position.set(-45, 90, 35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 260 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // ---------------------------------------------------------------- sites
  // Une seule maquette par filière, posée dans une région emblématique ; sa taille suit la puissance installée.
  const sites = Object.entries(SPOTS).filter(([f]) => D.filCap[f]).map(([f, { lon, lat, nom }]) => {
    const [x, z] = toXZ(lon, lat);
    const p = D.filCap[f];
    return { id: `fil-${f}`, f, a: { filiere: f, nom, p_mw: p }, x, z, s: 1.7 + Math.sqrt(p / 1000) * 0.34, load: 0 };
  });
  relax(sites);

  const ringBg = new THREE.MeshBasicMaterial({ color: '#ddd7cc' });
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitGeo = new THREE.CylinderGeometry(2.3, 2.3, 4, 10);
  const selRing = new THREE.Mesh(new THREE.RingGeometry(2.75, 2.95, 64), new THREE.MeshBasicMaterial({ color: '#2457e6', transparent: true }));
  selRing.rotation.x = -Math.PI / 2; selRing.visible = false;
  scene.add(selRing);

  for (const st of sites) {
    const model = buildModel(st.a.filiere);
    st.model = model;
    const root = new THREE.Group();
    root.position.set(st.x, TOP, st.z);
    root.rotation.y = st.f === 'eolien' ? 0.4 : -0.1;
    model.g.scale.setScalar(st.s);
    root.add(model.g);
    const bg = new THREE.Mesh(new THREE.RingGeometry(2.4 * st.s, 2.75 * st.s, 64), ringBg);
    bg.rotation.x = -Math.PI / 2; bg.position.y = 0.02;
    root.add(bg);
    st.ringMat = new THREE.MeshBasicMaterial({ color: COLORS[st.a.filiere] });
    st.ring = new THREE.Mesh(new THREE.BufferGeometry(), st.ringMat);
    st.ring.rotation.x = -Math.PI / 2; st.ring.position.y = 0.03;
    root.add(st.ring);
    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.scale.setScalar(st.s); hit.position.y = 2 * st.s; hit.userData.site = st;
    root.add(hit);
    st.hit = hit; st.root = root;
    scene.add(root);
  }

  // ---------------------------------------------------------------- caméra
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const home = { target: new THREE.Vector3(small ? 1 : 4, 0, small ? 1 : -2), pos: new THREE.Vector3(38, 120, 105), zoom: 1 };
  camera.position.copy(home.pos).add(home.target);
  controls.target.copy(home.target);
  Object.assign(controls, {
    enableDamping: true, dampingFactor: 0.09, screenSpacePanning: false,
    minPolarAngle: 0.25, maxPolarAngle: 1.12, minZoom: 0.6, maxZoom: 7, zoomSpeed: 1.1,
  });
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

  function resize() {
    const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight, asp = w / h;
    const viewH = Math.max(98, 92 / asp);
    Object.assign(camera, { left: -viewH * asp / 2, right: viewH * asp / 2, top: viewH / 2, bottom: -viewH / 2 });
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(resize).observe(el);
  resize();

  // ---------------------------------------------------------------- étiquette
  const tag = document.createElement('div');
  tag.className = 'tag3d'; tag.hidden = true;
  el.appendChild(tag);
  let hovered = null, selected = null;
  const v = new THREE.Vector3();
  const screenOf = (x, y, z) => {
    v.set(x, y, z).project(camera);
    return { x: (v.x + 1) / 2 * el.clientWidth, y: (1 - v.y) / 2 * el.clientHeight };
  };
  function placeTag() {
    const st = hovered || selected;
    if (!st || !st.root.visible) { tag.hidden = true; return; }
    const r = st.root.position, k = st.root.scale.x;
    const p = screenOf(r.x, r.y + 4.6 * st.s * k, r.z);
    tag.hidden = false;
    tag.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
  }
  function fillTag(st) {
    if (st.mini) {
      const mw = (v) => Math.round(v).toLocaleString('fr-FR');
      tag.innerHTML = `<i style="background:${COLORS[st.f]}"></i><b>${st.a.nom}</b><span>${mw(D.siteProd(st.id, hour))} / ${mw(st.a.p_mw)} MW</span>`;
      return;
    }
    const prod = D.filProd(st.f, hour);
    const gw = (v) => (v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    tag.innerHTML = `<i style="background:${COLORS[st.f]}"></i><b>${st.a.nom}</b><span>${gw(prod)} / ${gw(st.a.p_mw)} GW</span>`;
  }

  // ---------------------------------------------------------------- interactions
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function siteAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const pool = [...minis.filter((m) => m.root.visible && !m.leaving), ...sites.filter((s) => s.root.visible && !s.gone)];
    const hits = ray.intersectObjects(pool.map((s) => s.hit), false);
    return hits[0]?.object.userData.site || null;
  }
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const st = siteAt(e);
    if (st) onPick(st.id);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const st = siteAt(e);
    renderer.domElement.style.cursor = st ? 'pointer' : '';
    if (st !== hovered) { hovered = st; if (st) fillTag(st); else if (selected) fillTag(selected); onHover?.(st?.id || null); }
  });

  // ---------------------------------------------------------------- état
  let hour = D.now, filter = null, fly = null;
  const ringArc = (st, load) => {
    st.ring.geometry.dispose();
    const arc = Math.max(0.0001, load) * Math.PI * 2;
    st.ring.geometry = new THREE.RingGeometry(2.4 * st.s, 2.75 * st.s, 48, 1, Math.PI / 2 - arc, arc);
  };
  function setLoads() {
    for (const st of sites) {
      st.load = Math.max(0, Math.min(1, D.filProd(st.f, hour) / st.a.p_mw));
      ringArc(st, st.load);
    }
    for (const m of minis) {
      m.load = Math.max(0, Math.min(1, D.siteProd(m.id, hour) / m.a.p_mw));
      ringArc(m, m.load);
    }
    const st = hovered || selected;
    if (st) fillTag(st);
  }

  // ---------------------------------------------------------------- éclatement d'une filière en sites réels
  // La maquette de la filière rétrécit ; chaque site part de là en arc et se pose à sa position réelle.
  const minis = [];
  let expanded = null;
  const ease = (k) => 1 - (1 - k) ** 3;
  function expand(f) {
    if (expanded === f) return;
    collapse();
    const big = sites.find((s) => s.f === f);
    if (!big) return;
    expanded = f;
    const t0 = clock.getElapsedTime();
    big.anim = { t0, from: big.root.scale.x, to: 0.001 };
    // les autres filières se font discrètes pour ne pas masquer les sites
    for (const o of sites) if (o !== big) o.anim = { t0, from: o.root.scale.x, to: 0.4 };
    const list = D.assets.filter((a) => a.filiere === f && Number.isFinite(a.lat) && Number.isFinite(a.lon) && (D.byMap[a.id] || []).length)
      .sort((a, b) => b.p_mw - a.p_mw);
    list.forEach((a, i) => {
      const [x, z] = toXZ(a.lon, a.lat);
      const m = { id: a.id, f, a, x, z, mini: true, s: 0.32 + 0.3 * Math.sqrt(a.p_mw / 1000), load: 0,
        from: new THREE.Vector3(big.x, TOP, big.z), to: new THREE.Vector3(x, TOP, z), t0: t0 + 0.12 + i * Math.min(0.035, 1 / list.length), dur: 0.9 };
      m.model = buildModel(f);
      m.model.g.scale.setScalar(m.s);
      const root = new THREE.Group();
      root.position.copy(m.from);
      root.rotation.y = f === 'eolien' ? 0.4 : -0.1;
      root.scale.setScalar(0.001);
      root.add(m.model.g);
      m.ringMat = new THREE.MeshBasicMaterial({ color: COLORS[f] });
      m.ring = new THREE.Mesh(new THREE.BufferGeometry(), m.ringMat);
      m.ring.rotation.x = -Math.PI / 2; m.ring.position.y = 0.03;
      root.add(m.ring);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.scale.setScalar(Math.max(m.s, 0.45)); hit.position.y = 2 * m.s; hit.userData.site = m;
      root.add(hit);
      m.hit = hit; m.root = root;
      root.visible = !filter || filter.has(f);
      scene.add(root);
      minis.push(m);
    });
    setLoads();
  }
  function collapse() {
    if (!expanded) return;
    const big = sites.find((s) => s.f === expanded);
    const t0 = clock.getElapsedTime();
    for (const m of minis) {
      if (m.leaving) continue;
      m.leaving = true;
      m.from = m.root.position.clone(); m.to = new THREE.Vector3(big.x, TOP, big.z); m.t0 = t0; m.dur = 0.55;
    }
    big.gone = false;
    big.root.visible = !filter || filter.has(big.f);
    big.anim = { t0: t0 + 0.25, from: big.root.scale.x, to: 1 };
    for (const o of sites) if (o !== big) o.anim = { t0, from: o.root.scale.x, to: 1 };
    expanded = null;
    if (hovered?.mini) hovered = null;
  }
  function animateSplit(t) {
    for (const st of sites) {
      if (!st.anim) continue;
      const k = Math.max(0, Math.min(1, (t - st.anim.t0) / 0.45));
      st.root.scale.setScalar(st.anim.from + (st.anim.to - st.anim.from) * ease(k));
      if (k >= 1) { if (st.anim.to < 0.01) { st.root.visible = false; st.gone = true; } st.anim = null; }
    }
    for (let i = minis.length - 1; i >= 0; i--) {
      const m = minis[i];
      const k = Math.max(0, Math.min(1, (t - m.t0) / m.dur));
      if (k === 0 && !m.leaving) continue;
      const e = ease(k);
      m.root.position.lerpVectors(m.from, m.to, e);
      m.root.position.y = TOP + Math.sin(Math.PI * k) * (m.leaving ? 2 : 6);
      m.root.scale.setScalar(m.leaving ? Math.max(0.001, 1 - e) : Math.max(0.001, e));
      if (m.leaving && k >= 1) {
        scene.remove(m.root);
        m.ring.geometry.dispose(); m.ringMat.dispose();
        minis.splice(i, 1);
      }
    }
  }

  const clock = new THREE.Clock();
  setLoads();
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    if (fly) {
      const k = Math.min(1, (t - fly.t0) / 0.8), e = 1 - (1 - k) ** 3;
      controls.target.lerpVectors(fly.fromT, fly.toT, e);
      camera.position.copy(controls.target).add(fly.fromO.clone().lerp(fly.toO, e).setLength(fly.toO.length()));
      camera.zoom = fly.fromZ + (fly.toZ - fly.fromZ) * e;
      camera.updateProjectionMatrix();
      if (k >= 1) fly = null;
    }
    controls.update();
    animateSplit(t);
    for (const st of sites) if (st.root.visible) st.model.tick(t, st.load);
    for (const m of minis) if (m.root.visible) m.model.tick(t, m.load);
    if (selRing.visible && selected) {
      const p = (1 + 0.05 * Math.sin(t * 4)) * selected.s * selected.root.scale.x;
      selRing.scale.set(p, p, 1);
      selRing.position.set(selected.root.position.x, TOP + 0.04, selected.root.position.z);
    }
    placeTag();
    renderer.render(scene, camera);
    if (ready) { ready(); ready = null; }
  });

  return {
    ready: readyP,
    setHour(h) { hour = h; setLoads(); },
    setFilter(set) {
      filter = set;
      for (const st of sites) st.root.visible = !st.gone && (!filter || filter.has(st.a.filiere));
      for (const m of minis) m.root.visible = !filter || filter.has(m.f);
    },
    /** id = fil-<filière> : éclate la filière ; id d'un site ou d'une tranche : éclate sa filière et vise le site. */
    select(id) {
      if (!id) { collapse(); selected = null; selRing.visible = false; if (!hovered) tag.hidden = true; return; }
      const u = D.unitById[id], a = D.assets.find((x) => x.id === (u?.mapId || id));
      const f = u?.filiere || a?.filiere || id.replace(/^fil-/, '');
      expand(f);
      const siteId = id.startsWith('fil-') ? null : (u?.mapId || id);
      const target = siteId && minis.find((m) => m.id === siteId && !m.leaving);
      selected = target || null;
      selRing.visible = !!selected;
      if (selected) fillTag(selected); else if (!hovered) tag.hidden = true;
      const wide = matchMedia('(min-width: 900px)').matches;
      let cx, cz, toZ;
      if (selected) {
        cx = selected.x; cz = selected.z; toZ = Math.max(camera.zoom, 2.4);
      } else {
        // cadre l'ensemble des sites de la filière
        const pts = minis.filter((m) => !m.leaving).map((m) => m.to);
        if (!pts.length) return;
        const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
        cx = (Math.min(...xs) + Math.max(...xs)) / 2; cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const span = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...zs) - Math.min(...zs)) * 1.4, 12);
        toZ = Math.max(1, Math.min(3, 70 / span));
      }
      // décale la cible pour que les sites restent visibles à côté de la fiche
      const shift = new THREE.Vector3(wide ? 9 / toZ * 2.2 : 0, 0, wide ? 0 : 14 / toZ * 2.2);
      fly = { t0: clock.getElapsedTime(), fromT: controls.target.clone(), toT: new THREE.Vector3(cx, 0, cz).add(shift),
        fromO: camera.position.clone().sub(controls.target), toO: camera.position.clone().sub(controls.target), fromZ: camera.zoom, toZ };
    },
    home() {
      fly = { t0: clock.getElapsedTime(), fromT: controls.target.clone(), toT: home.target.clone(), fromO: camera.position.clone().sub(controls.target), toO: home.pos.clone(), fromZ: camera.zoom, toZ: 1 };
    },
    rotate(a) {
      const off = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      fly = { t0: clock.getElapsedTime(), fromT: controls.target.clone(), toT: controls.target.clone(), fromO: camera.position.clone().sub(controls.target), toO: off, fromZ: camera.zoom, toZ: camera.zoom };
    },
    zoom(f) { camera.zoom = Math.min(7, Math.max(0.6, camera.zoom * f)); camera.updateProjectionMatrix(); },
    project(lon, lat) { const [x, z] = toXZ(lon, lat); return screenOf(x, TOP + 1, z); },
    projectFiliere(f) { const st = sites.find((s) => s.f === f); return st ? screenOf(st.x, TOP + 2 * st.s, st.z) : { x: el.clientWidth / 2, y: el.clientHeight }; },
    resize,
  };
}
