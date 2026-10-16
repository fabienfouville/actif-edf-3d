// Un modèle 3D par filière : une seule centrale nucléaire pour tous les sites nucléaires, un seul barrage, etc.
// Géométries simples, partagées entre toutes les copies. Chaque modèle expose animate(t, charge).
import * as THREE from 'three';

export const COLORS = {
  nucleaire: '#E8B416', hydraulique: '#2F8FE0', gaz: '#E5484D', charbon: '#8C6A52',
  fioul: '#8E5BD6', eolien: '#16A88E', solaire: '#F07A1A', bioenergies: '#3E9B4F',
};

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0, ...o });
const M = {
  white: mat('#ffffff'), paper: mat('#f3f1ec'), grey: mat('#d5d2cb'), mid: mat('#a7a39b'), dark: mat('#2b2f36'),
  glass: mat('#3a4656', { roughness: 0.3 }), water: mat('#8fcdf3', { roughness: 0.25 }), waterDeep: mat('#5fb2ea', { roughness: 0.25 }),
  steam: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: 0.85, depthWrite: false }),
  smoke: new THREE.MeshStandardMaterial({ color: '#b9b6b0', roughness: 1, transparent: true, opacity: 0.6, depthWrite: false }),
  panel: mat('#1f3f8f', { roughness: 0.25, metalness: 0.2, emissive: '#f5c66b', emissiveIntensity: 0 }),
  coal: mat('#2f2f33'), green: mat('#cfe5c4'), leaf: mat('#7cbf7f'),
};
const accent = {};
for (const [k, c] of Object.entries(COLORS)) accent[k] = mat(c);

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 24),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 10),
  sphere: new THREE.SphereGeometry(1, 14, 10),
  dome: new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  cone: new THREE.ConeGeometry(1, 1, 7),
  tower: new THREE.LatheGeometry([[0.98, 0], [0.86, 0.5], [0.7, 1.2], [0.64, 1.7], [0.66, 2.1], [0.74, 2.5]].map(([x, y]) => new THREE.Vector2(x, y)), 32),
  blade: (() => { const g = new THREE.BoxGeometry(0.12, 1.55, 0.03); g.translate(0, 0.78, 0); return g; })(),
};
G.tower.computeVertexNormals();

function part(geo, material, [sx, sy, sz], [x, y, z], rot) {
  const m = new THREE.Mesh(geo, material);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
const pad = (w, d, material = M.paper) => part(G.box, material, [w, 0.12, d], [0, 0.06, 0]);

/** Panache : bouffées qui montent et s'estompent. Leur nombre suit la charge. */
function plume(origin, material, n = 7, rise = 2.2, size = 0.42) {
  const g = new THREE.Group();
  const puffs = [];
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(G.sphere, material.clone());
    p.castShadow = false;
    g.add(p);
    puffs.push({ m: p, off: i / n, dx: (Math.random() - 0.5) * 0.3 });
  }
  g.position.set(...origin);
  return {
    g,
    tick(t, load) {
      for (const p of puffs) {
        const k = (t * 0.25 + p.off) % 1;
        const on = load > 0.03 && p.off < 0.25 + 0.75 * load;
        p.m.visible = on;
        if (!on) continue;
        const s = size * (0.6 + k * 1.6);
        p.m.scale.setScalar(s);
        p.m.position.set(p.dx + k * 0.6, k * rise, p.dx * 0.5);
        p.m.material.opacity = (1 - k) * 0.85;
      }
    },
  };
}

// ------------------------------------------------------------------ modèles
function nucleaire() {
  const g = new THREE.Group();
  g.add(pad(4.4, 3.4));
  const towers = [[-1.05, -0.55], [0.75, -0.75]];
  const plumes = [];
  for (const [x, z] of towers) {
    g.add(part(G.tower, M.white, [0.75, 1, 0.75], [x, 0.1, z]));
    g.add(part(G.cyl, accent.nucleaire, [0.56, 0.12, 0.56], [x, 2.3, z]));
    const pl = plume([x, 2.7, z], M.steam, 8, 2.6, 0.5);
    g.add(pl.g); plumes.push(pl);
  }
  g.add(part(G.cyl, M.grey, [0.55, 0.9, 0.55], [-0.4, 0.55, 1.0]));
  g.add(part(G.dome, M.grey, [0.55, 0.55, 0.55], [-0.4, 1.0, 1.0]));
  g.add(part(G.box, M.white, [1.3, 0.7, 0.7], [0.85, 0.45, 1.0]));
  g.add(part(G.box, M.glass, [1.1, 0.1, 0.02], [0.85, 0.55, 1.36]));
  return { g, tick: (t, l) => plumes.forEach((p) => p.tick(t, l)) };
}

function hydraulique() {
  const g = new THREE.Group();
  g.add(pad(4.2, 3.6, M.green));
  // collines derrière le barrage
  g.add(part(G.cone, M.green, [1.3, 1.6, 1.3], [-1.4, 0.8, -1.2]));
  g.add(part(G.cone, M.green, [1.1, 1.3, 1.1], [1.5, 0.65, -1.3]));
  // retenue
  g.add(part(G.cyl, M.water, [1.6, 0.05, 1.0], [0, 1.05, -0.9]));
  // voûte : arc de cercle extrudé
  const sh = new THREE.Shape();
  sh.absarc(0, 0, 1.9, Math.PI * 0.2, Math.PI * 0.8, false);
  sh.absarc(0, 0, 1.6, Math.PI * 0.8, Math.PI * 0.2, true);
  const arc = new THREE.ExtrudeGeometry(sh, { depth: 1.25, bevelEnabled: false, curveSegments: 24 });
  arc.rotateX(-Math.PI / 2);
  const dam = new THREE.Mesh(arc, M.grey);
  dam.position.set(0, 0.1, 1.2);
  dam.castShadow = dam.receiveShadow = true;
  g.add(dam);
  // déversoir : eau qui coule devant
  const fall = part(G.box, M.waterDeep, [0.5, 0.02, 1.0], [0, 0.14, 0.95]);
  g.add(fall);
  g.add(part(G.box, M.white, [0.8, 0.45, 0.5], [1.1, 0.33, 0.9]));
  const foam = [];
  for (let i = 0; i < 5; i++) { const f = part(G.box, M.white, [0.12, 0.05, 0.12], [0, 0.18, 0.6]); g.add(f); foam.push(f); }
  return {
    g,
    tick(t, l) {
      foam.forEach((f, i) => {
        const k = (t * 0.6 + i / 5) % 1;
        f.visible = l > 0.03;
        f.position.set((i - 2) * 0.1, 0.18, 0.5 + k * 1.0);
      });
      fall.material = l > 0.03 ? M.waterDeep : M.water;
    },
  };
}

function eolien() {
  const g = new THREE.Group();
  g.add(part(G.cyl, M.paper, [0.7, 0.12, 0.7], [0, 0.06, 0]));
  g.add(part(G.cyl, accent.eolien, [0.2, 0.25, 0.2], [0, 0.24, 0]));
  const mast = new THREE.CylinderGeometry(0.07, 0.15, 3.4, 12);
  const m = new THREE.Mesh(mast, M.white); m.position.y = 1.85; m.castShadow = true; g.add(m);
  g.add(part(G.box, M.white, [0.22, 0.22, 0.55], [0, 3.6, -0.05]));
  const rotor = new THREE.Group();
  rotor.position.set(0, 3.6, 0.26);
  rotor.add(part(G.sphere, M.white, [0.1, 0.1, 0.12], [0, 0, 0]));
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(G.blade, M.white);
    b.rotation.z = (i * 2 * Math.PI) / 3; b.castShadow = true;
    rotor.add(b);
  }
  g.add(rotor);
  let a = Math.random() * 6;
  let last = 0;
  return { g, tick(t, l) { a += (t - last) * (0.4 + 5 * l) * (l > 0.01 ? 1 : 0); last = t; rotor.rotation.z = a; } };
}

function solaire() {
  const g = new THREE.Group();
  g.add(pad(4.0, 3.0, M.green));
  const pm = M.panel.clone();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const p = new THREE.Group();
      p.position.set(-1.2 + c * 1.2, 0.5, -0.9 + r * 0.9);
      p.add(part(G.box, M.mid, [0.06, 0.4, 0.06], [0, -0.2, 0.1]));
      const pv = part(G.box, pm, [1.05, 0.05, 0.62], [0, 0, 0]);
      pv.rotation.x = -0.5;
      p.add(pv);
      g.add(p);
    }
  }
  g.add(part(G.box, M.white, [0.5, 0.4, 0.4], [1.7, 0.3, 1.2]));
  return { g, tick(t, l) { pm.emissiveIntensity = 0.45 * l; } };
}

function gaz() {
  const g = new THREE.Group();
  g.add(pad(4.2, 3.0));
  g.add(part(G.box, M.white, [1.9, 1.0, 1.2], [-0.8, 0.6, 0.5]));
  g.add(part(G.box, accent.gaz, [1.92, 0.1, 1.22], [-0.8, 1.12, 0.5]));
  g.add(part(G.box, M.grey, [1.0, 1.3, 0.8], [0.8, 0.75, 0.4]));
  const plumes = [];
  for (const x of [0.6, 1.05]) {
    g.add(part(G.cyl8, M.white, [0.12, 2.6, 0.12], [x, 1.4, -0.2]));
    g.add(part(G.cyl8, accent.gaz, [0.13, 0.18, 0.13], [x, 2.4, -0.2]));
    const pl = plume([x, 2.8, -0.2], M.smoke, 5, 1.4, 0.22); g.add(pl.g); plumes.push(pl);
  }
  g.add(part(G.sphere, M.grey, [0.42, 0.42, 0.42], [-1.4, 0.75, -0.8]));
  g.add(part(G.cyl8, M.mid, [0.05, 0.4, 0.05], [-1.4, 0.25, -0.8]));
  return { g, tick: (t, l) => plumes.forEach((p) => p.tick(t, l)) };
}

function charbon() {
  const g = new THREE.Group();
  g.add(pad(4.4, 3.2));
  g.add(part(G.box, M.white, [1.8, 1.2, 1.2], [-0.6, 0.7, 0.6]));
  g.add(part(G.cyl, M.grey, [0.32, 3.4, 0.32], [1.1, 1.8, -0.4]));
  for (const y of [2.9, 3.3]) g.add(part(G.cyl, accent.charbon, [0.33, 0.12, 0.33], [1.1, y, -0.4]));
  g.add(part(G.cone, M.coal, [1.0, 0.7, 1.0], [-1.2, 0.45, -0.9]));
  const conv = part(G.box, M.mid, [1.3, 0.08, 0.2], [-0.4, 0.75, -0.3]); conv.rotation.z = 0.4; g.add(conv);
  const pl = plume([1.1, 3.6, -0.4], M.smoke, 7, 2.2, 0.4); g.add(pl.g);
  return { g, tick: (t, l) => pl.tick(t, l) };
}

function fioul() {
  const g = new THREE.Group();
  g.add(pad(4.0, 3.0));
  for (const [x, z] of [[-1.1, -0.6], [0.2, -0.7], [-1.1, 0.7]]) {
    g.add(part(G.cyl, M.white, [0.55, 0.8, 0.55], [x, 0.5, z]));
    g.add(part(G.cyl, accent.fioul, [0.56, 0.1, 0.56], [x, 0.75, z]));
  }
  g.add(part(G.box, M.grey, [1.0, 0.6, 0.7], [1.0, 0.4, 0.6]));
  g.add(part(G.cyl8, M.white, [0.15, 1.6, 0.15], [1.3, 1.0, 0.3]));
  const pl = plume([1.3, 1.9, 0.3], M.smoke, 5, 1.2, 0.22); g.add(pl.g);
  return { g, tick: (t, l) => pl.tick(t, l) };
}

function bioenergies() {
  const g = new THREE.Group();
  g.add(pad(4.0, 3.0, M.green));
  for (const [x, z] of [[-1.0, -0.5], [0.4, -0.6]]) {
    g.add(part(G.cyl, M.white, [0.6, 0.5, 0.6], [x, 0.37, z]));
    g.add(part(G.dome, accent.bioenergies, [0.6, 0.45, 0.6], [x, 0.62, z]));
  }
  g.add(part(G.box, M.white, [1.0, 0.6, 0.7], [0.9, 0.4, 0.7]));
  g.add(part(G.cyl8, M.grey, [0.1, 1.4, 0.1], [1.25, 0.9, 0.5]));
  g.add(part(G.cone, M.leaf, [0.35, 0.8, 0.35], [-1.5, 0.5, 0.9]));
  const pl = plume([1.25, 1.65, 0.5], M.steam, 4, 1.0, 0.2); g.add(pl.g);
  return { g, tick: (t, l) => pl.tick(t, l) };
}

const BUILDERS = { nucleaire, hydraulique, eolien, solaire, gaz, charbon, fioul, bioenergies };

export function buildModel(filiere) {
  return (BUILDERS[filiere] || gaz)();
}
