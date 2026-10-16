// Calculs purs : coût marginal, merit order, indicateurs, couverture, valorisation.
// Aucune dépendance au DOM : testable avec `node --test`.

export const FILIERES = ['solaire', 'eolien', 'hydraulique', 'nucleaire', 'bioenergies', 'gaz', 'charbon', 'fioul'];
const ORDER = Object.fromEntries(FILIERES.map((f, i) => [f, i]));
const FUEL = { gaz: 'gaz_ttf_eur_mwh', charbon: 'charbon_eur_mwh_th', fioul: 'fioul_eur_mwh_th' };

export function techKey(u) {
  if (u.filiere === 'hydraulique') return `hydraulique:${u.type === 'STEP' ? 'STEP' : u.type === 'lac' ? 'lac' : 'fil'}`;
  if (u.filiere === 'gaz' && (u.diffus || u.type === 'cogénération')) return 'gaz:diffus';
  if (u.filiere === 'gaz' && u.type === 'TAC') return 'gaz:TAC';
  if (u.filiere === 'eolien' && u.type === 'offshore') return 'eolien:offshore';
  return u.filiere;
}

export function tech(u, P) {
  return P.technos[techKey(u)] || P.technos[u.filiere] || {};
}

/** Coût marginal court terme (€/MWh). */
export function srmc(u, P) {
  const t = tech(u, P), c = P.combustibles;
  if (t.rendement) {
    return c[FUEL[u.filiere]] / t.rendement + c.co2_eua_eur_t * t.emission_t_mwh_th / t.rendement + (t.om_var || 0);
  }
  if (t.valeur_eau != null) return t.valeur_eau;
  return t.cmg_fixe || 0;
}

/** Détail du coût marginal, pour l'afficher. */
export function srmcParts(u, P) {
  const t = tech(u, P), c = P.combustibles;
  if (!t.rendement) {
    return t.valeur_eau != null ? [{ k: "Valeur d'usage de l'eau", v: t.valeur_eau }] : [{ k: 'Coût variable', v: t.cmg_fixe || 0 }];
  }
  return [
    { k: 'Combustible', v: c[FUEL[u.filiere]] / t.rendement },
    { k: 'CO2', v: c.co2_eua_eur_t * t.emission_t_mwh_th / t.rendement },
    { k: 'O&M variable', v: t.om_var || 0 },
  ];
}

const isFatal = (u) => u.filiere === 'eolien' || u.filiere === 'solaire' || (u.filiere === 'hydraulique' && techKey(u) === 'hydraulique:fil')
  || (u.diffus && u.filiere === 'bioenergies') || techKey(u) === 'gaz:diffus';

/** Capacité offerte à l'heure h : production pour le fatal, 0 si la tranche est à l'arrêt, sinon la puissance. */
export { isFatal };

export function availCap(u, p) {
  if (isFatal(u)) return Math.max(0, p);
  if (u.filiere === 'nucleaire' && u.real) return p > 0.02 * u.p_mw ? u.p_mw : 0;
  return u.p_mw;
}

const running = (u, p) => p > Math.max(5, 0.02 * u.p_mw);

/** Escalier du merit order à l'heure h. prodAt(u) renvoie la production (MW). */
export function stack(units, cmg, prodAt) {
  const rows = units.map((u) => {
    const p = Math.max(0, prodAt(u) || 0);
    return { u, cmg: cmg[u.idx], prod: p, cap: availCap(u, p) };
  }).filter((r) => r.cap > 0 || r.prod > 0);
  rows.sort((a, b) => a.cmg - b.cmg || ORDER[a.u.filiere] - ORDER[b.u.filiere] || b.cap - a.cap);
  let x = 0, demand = 0, marginal = null;
  for (const r of rows) {
    r.x0 = x; x += r.cap; r.x1 = x;
    demand += r.prod;
    if (!isFatal(r.u) && running(r.u, r.prod) && (!marginal || r.cmg >= marginal.cmg)) marginal = r;
  }
  return { rows, total: x, demand, marginal, priceModel: marginal ? marginal.cmg : 0 };
}

/** Unité marginale (index) pour chaque heure. Boucle simple O(heures × unités). */
export function marginalSeries(units, cmg, prod, H) {
  const out = new Int16Array(H).fill(-1);
  const pool = units.filter((u) => !isFatal(u));
  for (let h = 0; h < H; h++) {
    let best = -1, bc = -Infinity;
    for (const u of pool) {
      const p = prod[u.idx][h];
      if (p > Math.max(5, 0.02 * u.p_mw) && cmg[u.idx] > bc) { bc = cmg[u.idx]; best = u.idx; }
    }
    out[h] = best;
  }
  return out;
}

/** Indicateurs d'un actif sur [h0, h1). */
export function kpis(u, prod, price, cmg, h0, h1, marg, units) {
  let e = 0, rev = 0, margin = 0, run = 0, itm = 0, n = 0, base = 0, nb = 0, marginalH = 0;
  for (let h = h0; h < h1; h++) {
    const p = prod[h], pr = price[h];
    if (Number.isNaN(p)) continue;
    n++;
    if (!Number.isNaN(pr)) { base += pr; nb++; }
    if (running(u, p)) {
      run++;
      if (!Number.isNaN(pr) && pr >= cmg) itm++;
      if (marg && marg[h] >= 0 && units[marg[h]].filiere === u.filiere) marginalH++;
    }
    e += p;
    if (!Number.isNaN(pr)) { rev += p * pr; margin += p * (pr - cmg); }
  }
  const baseAvg = nb ? base / nb : NaN;
  const captured = e ? rev / e : NaN;
  return {
    heures: n,
    energie_gwh: e / 1000,
    facteur_charge: n ? e / (n * u.p_mw) : 0,
    heures_en_marche: run,
    part_heures_en_marge: run ? itm / run : 0,
    prix_capte: captured,
    prix_moyen_base: baseAvg,
    taux_capture: captured / baseAvg,
    revenu_spot_meur: rev / 1e6,
    marge_sur_cmg_meur: margin / 1e6,
    heures_filiere_marginale: marginalH,
  };
}

/** Matrice semaine × heure locale de la marge (prix − CMg) quand l'actif tourne. */
export function heatmap(u, prod, price, cmg, h0, h1, t0, tz = 'Europe/Paris') {
  const weeks = Math.ceil((h1 - h0) / 168);
  const sum = Array.from({ length: weeks }, () => new Float64Array(24));
  const cnt = Array.from({ length: weeks }, () => new Float64Array(24));
  const tot = Array.from({ length: weeks }, () => new Float64Array(24));
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz });
  const offCache = new Map();
  for (let h = h0; h < h1; h++) {
    const p = prod[h], pr = price[h];
    if (Number.isNaN(p)) continue;
    const ms = t0 + h * 3600e3;
    const dayKey = Math.floor(ms / 864e5);
    let off = offCache.get(dayKey);
    if (off == null) {
      off = (+fmt.formatToParts(new Date(dayKey * 864e5 + 12 * 3600e3)).find((x) => x.type === 'hour').value - 12 + 24) % 24;
      offCache.set(dayKey, off);
    }
    const w = Math.floor((h - h0) / 168), lh = (new Date(ms).getUTCHours() + off) % 24;
    tot[w][lh]++;
    if (running(u, p) && !Number.isNaN(pr)) { sum[w][lh] += pr - cmg; cnt[w][lh]++; }
  }
  return sum.map((row, w) => Array.from(row, (s, k) => (cnt[w][k] >= tot[w][k] / 2 && cnt[w][k] ? s / cnt[w][k] : null)));
}

/** Position de l'actif dans l'escalier (GW de capacité moins chère devant lui) et demande servie. */
export function rankSeries(u, units, cmg, prodArr, h0, h1) {
  const pos = [], dem = [];
  const mine = cmg[u.idx];
  for (let h = h0; h < h1; h++) {
    let before = 0, d = 0;
    for (const v of units) {
      const p = Math.max(0, prodArr[v.idx][h] || 0);
      d += p;
      const c = cmg[v.idx];
      if (c < mine || (c === mine && ORDER[v.filiere] < ORDER[u.filiere])) before += availCap(v, p);
    }
    pos.push(before / 1000); dem.push(d / 1000);
  }
  return { pos, dem };
}

/** Revenu annuel décomposé avec couverture. Montants en M€. */
export function hedge({ volume_mwh, part, prix_terme, spot, capture = 1, cmg = 0, cout_mwh = null, vnu = null }) {
  const vt = volume_mwh * part, vs = volume_mwh * (1 - part);
  const terme = vt * prix_terme / 1e6;
  const spotRev = vs * spot * capture / 1e6;
  const items = [{ k: 'Vendu à terme', v: terme }, { k: 'Vendu au spot', v: spotRev }];
  let total = terme + spotRev;
  if (vnu) {
    const pAvg = volume_mwh ? total * 1e6 / volume_mwh : 0;
    const t1 = Math.max(0, Math.min(pAvg, vnu.seuil2) - vnu.seuil1) * vnu.taux1;
    const t2 = Math.max(0, pAvg - vnu.seuil2) * vnu.taux2;
    const v = -(t1 + t2) * volume_mwh / 1e6;
    items.push({ k: 'Reversement VNU', v });
    total += v;
  }
  const cost = -(cout_mwh != null ? cout_mwh : cmg) * volume_mwh / 1e6;
  items.push({ k: cout_mwh != null ? 'Coût complet' : 'Coût variable', v: cost });
  total += cost;
  return { items, marge: total, prix_moyen: volume_mwh ? (terme + spotRev) * 1e6 / volume_mwh : 0 };
}

/** VAN simplifiée sur la durée de vie restante. */
export function dcf({ p_mw, lf, prix, capture = 1, cmg, cout_fixe_kw_an, annees, wacc }) {
  const vol = p_mw * 8760 * lf;
  const unit = Math.max(0, prix * capture - cmg);
  const flows = [];
  let npv = 0;
  for (let t = 1; t <= annees; t++) {
    const cf = (vol * unit - cout_fixe_kw_an * p_mw * 1000) / 1e6;
    flows.push(cf);
    npv += cf / (1 + wacc) ** t;
  }
  return { flows, npv, volume_mwh: vol, marge_unitaire: unit };
}

/** Sensibilités de la VAN (tornado). */
export function tornado(base) {
  const ref = dcf(base).npv;
  const vary = (k, lo, hi, label) => ({
    k: label,
    lo: dcf({ ...base, [k]: lo }).npv - ref,
    hi: dcf({ ...base, [k]: hi }).npv - ref,
  });
  return [
    vary('prix', base.prix * 0.8, base.prix * 1.2, 'Prix ±20 %'),
    vary('wacc', Math.max(0.01, base.wacc - 0.02), base.wacc + 0.02, 'WACC ±2 pts'),
    vary('lf', Math.max(0, base.lf - 0.1), Math.min(1, base.lf + 0.1), 'Charge ±10 pts'),
    vary('cout_fixe_kw_an', base.cout_fixe_kw_an * 0.8, base.cout_fixe_kw_an * 1.2, 'Coût fixe ±20 %'),
  ].sort((a, b) => Math.abs(b.hi - b.lo) - Math.abs(a.hi - a.lo));
}
