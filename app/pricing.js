// Pricing de contraintes d'exploitation (interruption, Pmin, Pmax, limitation) sur la courbe forward horaire.
// Repris de Parc EDF Command (priceIt, vnuMarg). Calculs purs : testables avec `node --test`.
import { mcAt, fwdRangeDays } from './forward.js';
import { techKey } from './finance.js';

export const CONSTRAINTS = {
  int: 'Interruption (indisponibilité)',
  pmin: 'Imposition à Pmin (bloqué)',
  mustrun: 'Must-run ≥ Pmin (libre au-dessus)',
  pmax: 'Imposition à Pmax (bloqué)',
  lim: 'Limitation à X MW',
};

/** Méthode applicable : thermique hors nucléaire → intrinsèque (Astral + M2F pour l'extrinsèque) ; nucléaire → déterministe avec VNU. */
export function methodOf(u) {
  if (u.filiere === 'nucleaire') return 'deterministic_nuclear_vnu';
  if (['gaz', 'charbon', 'fioul'].includes(u.filiere) && techKey(u) !== 'gaz:diffus') return 'intrinsic_hourly';
  return null;
}

/**
 * Valeur marginale d'un MWh nucléaire après VNU, selon le revenu moyen R du parc sur l'année.
 * Prélèvement = V × [t1 × (min(R, s2) − s1)⁺ + t2 × (R − s2)⁺], proportionnel au volume V (t1 = 50 %, t2 = 90 %).
 * Bande 1 (s1 < R ≤ s2) : dérivée = F − t1 (F − s1), soit 0,5 F + 0,5 s1.
 * Bande 2 (R > s2) : dérivée = F − t1 (s2 − s1) − t2 (F − s2), soit 0,1 F + 0,9 s2 − 0,5 (s2 − s1).
 */
export function vnuMarg(F, R, { s1, s2, t1 = 0.5, t2 = 0.9 }) {
  if (R == null || R <= s1) return F;
  if (R <= s2) return F - t1 * (F - s1);
  return F - t1 * (s2 - s1) - t2 * (F - s2);
}

/**
 * st : { c: contrainte, from, to (AAAA-MM-JJ, inclus), units: [{id, p_mw}], pminPct, lim }
 * ctx : { u (unité de référence pour la techno), P (params), FWD, vnu: {s1, s2}, parcRev(y), scen? }
 * Retour : coût pour EDF (manque à gagner, > 0) en €, avant/après VNU, et détail mensuel.
 */
export function priceIt(st, ctx) {
  const { u, P: params, FWD, vnu, parcRev, scen } = ctx;
  const method = methodOf(u);
  if (!method) return { err: 'Méthode de pricing à définir pour cette filière.' };
  const Pn = st.units.reduce((s, x) => s + x.p_mw, 0);
  if (!Pn) return { err: 'Sélectionne au moins une unité.' };
  if (!(st.to >= st.from)) return { err: 'La date de fin doit suivre la date de début.' };
  const [i0, i1] = fwdRangeDays(FWD, st.from, st.to);
  if (i1 <= i0) return { err: 'Période hors de la courbe (novembre 2026 → décembre 2029).' };
  const nuc = method === 'deterministic_nuclear_vnu';
  const Pmin = Pn * st.pminPct / 100, X = Math.min(Pn, st.lim ?? Pn);
  // [production de référence, production sous contrainte]
  const gens = (F, c) => {
    if (nuc) {
      const b = F >= c ? Pn : Pmin;
      return [b, { int: 0, pmin: Pmin, mustrun: b, pmax: Pn, lim: Math.min(X, b) }[st.c]];
    }
    const on = F > c, b = on ? Pn : 0;
    return [b, { int: 0, pmin: Pmin, mustrun: on ? Pn : Pmin, pmax: Pn, lim: on ? X : 0 }[st.c]];
  };
  const year = (i) => FWD.months[FWD.MI[i]].y;
  const val = (F, c, y) => (nuc ? vnuMarg(F, parcRev(y), vnu) - c : F - c);
  const MC = new Float32Array(i1 - i0);
  for (let i = i0; i < i1; i++) MC[i - i0] = mcAt(u, i, params, FWD);
  let cost = 0, costGross = 0, mwh = 0, itm = 0;
  const byM = {};
  for (let i = i0; i < i1; i++) {
    const F = FWD.F[i], c = MC[i - i0], [b, k] = gens(F, c), d = (b - k) * val(F, c, year(i));
    cost += d; costGross += (b - k) * (F - c); mwh += Math.abs(b - k); if (F > c) itm++;
    const mk = FWD.months[FWD.MI[i]].k; byM[mk] = (byM[mk] || 0) + d;
  }
  // scénarios importés : même calcul sur chaque trajectoire couvrant toute la période
  let ext = null;
  if (scen) {
    const off = Math.round((scen.t0 - FWD.t0) / 3600e3);
    let tot = 0, cnt = 0;
    for (const path of scen.paths) {
      if (i0 - off < 0 || i1 - off > path.length) continue;
      let s = 0;
      for (let i = i0; i < i1; i++) { const F = path[i - off], c = MC[i - i0], [b, k] = gens(F, c); s += (b - k) * val(F, c, year(i)); }
      tot += s; cnt++;
    }
    ext = cnt ? { mean: tot / cnt, n: cnt, extrinseque: tot / cnt - cost } : { n: 0 };
  }
  return { method, Pn, Pmin, X, cost, costGross, mwh, itm, n: i1 - i0, byM, ext, i0, i1, MC };
}

/** Lecture d'un fichier de scénarios { start, paths: [[€/MWh horaires]] } ; start sans fuseau = heure de Paris. */
export function parseScenarios(j, parisToUtc) {
  if (!j || !Array.isArray(j.paths) || !j.start) throw new Error('Format attendu : { "start": "AAAA-MM-JJTHH:MM", "paths": [[…], …] }');
  const s = String(j.start);
  const t0 = /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : parisToUtc(s);
  if (!Number.isFinite(t0)) throw new Error('Date de début illisible.');
  return { t0, paths: j.paths.map((p) => Float32Array.from(p, Number)) };
}

/** JSON d'échange pour Astral / M2F. */
export function exportJson({ asset, u, st, r, ctx, market, hourly = false }) {
  const P = ctx.params || ctx.P;
  const o = {
    format: 'parc3d.pricing/1',
    asset: { id: asset.id, nom: asset.nom, filiere: u.filiere, type: u.type, exploitant: asset.exploitant },
    units: st.units.map((x) => ({ id: x.id, mw: x.p_mw })),
    constraint: st.c, constraint_label: CONSTRAINTS[st.c], pmax_mw: r.Pn, pmin_mw: +r.Pmin.toFixed(1), limit_mw: st.c === 'lim' ? r.X : undefined,
    period: { from: st.from, to: st.to, tz: 'Europe/Paris' }, hours: r.n,
    method: r.method, result_eur: Math.round(r.cost), result_eur_pre_vnu: r.method === 'deterministic_nuclear_vnu' ? Math.round(r.costGross) : undefined,
    eur_per_mwh_constrained: r.mwh ? +(r.cost / r.mwh).toFixed(2) : null, mwh_constrained: Math.round(r.mwh),
    scenarios: r.ext && r.ext.n ? { n: r.ext.n, mean_eur: Math.round(r.ext.mean), extrinsic_eur: Math.round(r.ext.extrinseque) } : undefined,
    market: {
      asof: market.asof, products: Object.fromEntries(Object.entries(ctx.FWD.pw).map(([k, v]) => [k, { base: +v.b.toFixed(2), pointe: v.p != null ? +v.p.toFixed(2) : null, statut: ctx.FWD.flags[k] || 'coté' }])),
      fuels: { eua_eur_t: P.combustibles.co2_eua_eur_t, charbon_eur_mwh_th: P.combustibles.charbon_eur_mwh_th, fioul_eur_mwh_th: P.combustibles.fioul_eur_mwh_th, gaz: 'PEG mensuel de la courbe' },
      vnu: ctx.vnu,
    },
  };
  if (hourly) {
    o.hourly = { start: new Date(ctx.FWD.t0 + r.i0 * 3600e3).toISOString(), step_h: 1,
      F: Array.from(ctx.FWD.F.slice(r.i0, r.i1), (v) => +v.toFixed(2)), MC: Array.from(r.MC, (v) => +v.toFixed(2)) };
  }
  return o;
}
