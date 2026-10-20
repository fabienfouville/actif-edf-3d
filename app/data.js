// Chargement des JSON et construction des séries horaires (réelles ou modélisées).
import { srmc } from './finance.js';
import { buildHPFC } from './forward.js';

const get = async (path) => {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path} : ${r.status}`);
  return r.json();
};

const MIX = ['consommation', 'nucleaire', 'hydraulique', 'gaz', 'charbon', 'fioul', 'eolien', 'solaire', 'bioenergies', 'pompage', 'ech_physiques'];

export async function loadAll(onProgress = () => {}) {
  const [assetsF, tranchesF, params, meta, regions, market] = await Promise.all(
    ['data/assets.json', 'data/edf_tranches.json', 'data/params.json', 'data/meta.json', 'data/geo/regions.json', 'data/market.json'].map(get));
  const [live, indispos, grid] = await Promise.all(['data/live.json', 'data/indispos.json', 'data/grid.json'].map((f) => get(f).catch(() => null)));
  const keys = (meta.mois || []).slice(-13);
  let done = 0;
  const months = await Promise.all(keys.map((k) => get(`data/series/${k}.json`).then((m) => { onProgress(++done / keys.length); return m; })));

  const t0 = Date.parse(months[0].debut);
  const H = months.reduce((s, m) => s + m.n, 0);
  const price = new Float32Array(H).fill(NaN);
  const mix = Object.fromEntries(MIX.map((k) => [k, new Float32Array(H).fill(NaN)]));
  const real = {};
  const srcs = {};
  let off = 0;
  for (const m of months) {
    m.prix.forEach((v, i) => { if (v != null) price[off + i] = v; });
    for (const [k, arr] of Object.entries(m.mix || {})) {
      if (!mix[k]) continue;
      arr.forEach((v, i) => { if (v != null) mix[k][off + i] = v; });
    }
    for (const [id, arr] of Object.entries(m.units || {})) {
      const a = real[id] || (real[id] = new Float32Array(H).fill(NaN));
      arr.forEach((v, i) => { if (v != null) a[off + i] = v; });
    }
    Object.assign(srcs, m.sources);
    off += m.n;
  }
  // dernière heure avec un mix mesuré = « maintenant »
  let now = H - 1;
  while (now > 0 && Number.isNaN(mix.nucleaire[now])) now--;

  const D = { params, meta, live, regions, market, indispos, grid, t0, H, now, price, mix, real, sources: srcs };
  D.assets = assetsF.assets;
  D.tranches = tranchesF.tranches;
  buildUnits(D);
  buildProduction(D);
  recomputeCosts(D);
  D.market0 = JSON.parse(JSON.stringify(market)); // valeurs publiées, avant réglages
  applyMarketEdits(D);
  rebuildForward(D);
  return D;
}

const MKT_KEY = 'parc3d.market.v1';
/** Réglages de marché saisis par l'utilisateur (navigateur seulement). */
function applyMarketEdits(D) {
  try {
    const saved = JSON.parse(localStorage.getItem(MKT_KEY) || 'null');
    if (saved && saved.asof === D.market.asof) {
      for (const [k, v] of Object.entries(saved.electricite || {})) if (D.market.electricite[k]) Object.assign(D.market.electricite[k], v);
      Object.assign(D.market.revenu_parc_nucleaire, saved.revenu_parc_nucleaire || {});
    }
  } catch { /* stockage indisponible : valeurs par défaut */ }
}
export function saveMarketEdits(D) {
  try {
    const e = Object.fromEntries(Object.entries(D.market.electricite).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, { base: v.base, pointe: v.pointe }]));
    localStorage.setItem(MKT_KEY, JSON.stringify({ asof: D.market.asof, electricite: e, revenu_parc_nucleaire: D.market.revenu_parc_nucleaire }));
  } catch { /* ignoré */ }
}
/** Courbe forward horaire, forme estimée sur les prix spot réels chargés. */
export function rebuildForward(D) {
  D.FWD = buildHPFC(D.market, { t0: D.t0, prices: D.price });
}

/** Une « unité » = une ligne du merit order : chaque tranche nucléaire, chaque autre actif, plus des blocs diffus. */
function buildUnits(D) {
  const units = [];
  const site = Object.fromEntries(D.assets.map((a) => [a.id, a]));
  for (const t of D.tranches) {
    const s = site[t.site];
    units.push({ id: t.id, nom: t.nom, filiere: 'nucleaire', type: 'REP', palier: t.palier, p_mw: t.p_net_mw,
      couplage: t.couplage, fin_vie: t.fin_vie_hyp, lat: s.lat, lon: s.lon, mapId: s.id, exploitant: 'EDF', region: s.region, tranche: t });
  }
  for (const a of D.assets) {
    if (a.filiere === 'nucleaire') continue;
    units.push({ ...a, mapId: a.id });
  }
  const cap = D.params.capacite_nationale_mw;
  for (const [f, total] of Object.entries(cap)) {
    if (f.startsWith('_')) continue;
    const listed = units.filter((u) => u.filiere === f).reduce((s, u) => s + u.p_mw, 0);
    const rest = total - listed;
    if (rest < 50) continue;
    const base = { filiere: f, diffus: true, exploitant: 'multiples', mapId: null, region: 'France' };
    if (f === 'hydraulique') {
      units.push({ ...base, id: 'diff-hyd-fil', nom: "Petite hydraulique au fil de l'eau", type: 'fil', p_mw: Math.round(rest * 0.55) });
      units.push({ ...base, id: 'diff-hyd-lac', nom: 'Autres lacs et éclusées', type: 'lac', p_mw: Math.round(rest * 0.45) });
    } else {
      const noms = { gaz: 'Cogénérations et petites centrales gaz', fioul: 'Autres turbines fioul', bioenergies: 'Bioénergies diffuses',
        eolien: 'Éolien non affecté', solaire: 'Solaire non affecté', nucleaire: 'Nucléaire non affecté', charbon: 'Charbon non affecté' };
      units.push({ ...base, id: `diff-${f}`, nom: noms[f] || `${f} diffus`, type: 'diffus', p_mw: Math.round(rest) });
    }
  }
  units.forEach((u, i) => { u.idx = i; u.real = !!D.real[u.id]; });
  D.units = units;
  D.unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  D.byMap = {};
  for (const u of units) if (u.mapId) (D.byMap[u.mapId] ||= []).push(u);
}

/**
 * Production horaire de chaque unité : la série mesurée si elle existe, sinon une part du mix national
 * de sa filière (reste après les unités mesurées), répartie au prorata de la puissance.
 * Pour l'hydraulique, le fil de l'eau est servi d'abord, les lacs et STEP prennent le reste.
 */
function buildProduction(D) {
  const { H, units, mix, real } = D;
  D.prod = units.map(() => new Float32Array(H));
  const byF = {};
  for (const u of units) (byF[u.filiere] ||= []).push(u);
  for (const u of units) u.realHours = 0;
  for (const [f, us] of Object.entries(byF)) {
    const isFil = (u) => f === 'hydraulique' && u.type === 'fil';
    for (let h = 0; h < H; h++) {
      // heure par heure : les groupes mesurés gardent leur valeur, les autres se partagent le reste du mix
      let rest = mix[f] ? mix[f][h] : NaN;
      let capFil = 0, capOther = 0;
      for (const u of us) {
        const v = real[u.id] ? real[u.id][h] : NaN;
        if (!Number.isNaN(v)) { D.prod[u.idx][h] = Math.max(0, v); rest -= Math.max(0, v); u.realHours++; }
        else if (isFil(u)) capFil += u.p_mw; else capOther += u.p_mw;
      }
      if (Number.isNaN(rest)) continue;
      rest = Math.max(0, rest);
      const toFil = capFil ? Math.min(rest, capFil * 0.6) : 0;
      const r2 = rest - toFil;
      for (const u of us) {
        if (real[u.id] && !Number.isNaN(real[u.id][h])) continue;
        if (isFil(u)) D.prod[u.idx][h] = toFil * u.p_mw / capFil;
        else if (capOther) D.prod[u.idx][h] = Math.min(u.p_mw, r2 * u.p_mw / capOther);
      }
    }
  }
  // « mesurée » si la série réelle couvre au moins la moitié de l'historique chargé
  for (const u of units) u.real = u.realHours > 0.5 * (D.now + 1);
  D.siteProd = (mapId, h) => (D.byMap[mapId] || []).reduce((s, u) => s + D.prod[u.idx][h], 0);
  // une maquette par filière : production et puissance de tout le parc de la filière
  D.byFil = {};
  for (const u of units) (D.byFil[u.filiere] ||= []).push(u);
  D.filCap = Object.fromEntries(Object.entries(D.byFil).map(([f, us]) => [f, us.reduce((s, u) => s + u.p_mw, 0)]));
  D.filProd = (f, h) => (D.byFil[f] || []).reduce((s, u) => s + D.prod[u.idx][h], 0);
}

export function recomputeCosts(D) {
  D.cmg = D.units.map((u) => srmc(u, D.params));
  D.marg = null; // recalculé à la demande
}

export const hourDate = (D, h) => new Date(D.t0 + h * 3600e3);
export const hourOf = (D, date) => Math.round((date.getTime() - D.t0) / 3600e3);
