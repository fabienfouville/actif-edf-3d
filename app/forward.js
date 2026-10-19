// Courbe forward horaire (HPFC) et coût marginal à terme. Calculs purs : testables avec `node --test`.
// Repris de Parc EDF Command (buildHPFC) et adapté : historique réel du site, heure de Paris avec changement d'heure.
import { srmc } from './finance.js';

const H = 3600e3;
const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

/** Dernier dimanche du mois m (0-11) à 01:00 UTC : bascule heure d'été / d'hiver en Europe. */
function lastSunday1h(y, m) {
  const d = new Date(Date.UTC(y, m + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
const dstCache = {};
/** Décalage de l'heure de Paris sur UTC, en heures (1 ou 2). */
export function parisOffset(t) {
  const y = new Date(t).getUTCFullYear();
  const [a, b] = dstCache[y] || (dstCache[y] = [lastSunday1h(y, 2), lastSunday1h(y, 9)]);
  return t >= a && t < b ? 2 : 1;
}
/** Date et heure locales à Paris d'un instant UTC. */
export function parisParts(t) {
  const d = new Date(t + parisOffset(t) * H);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), dow: d.getUTCDay() };
}
/** Instant UTC du minuit local à Paris du jour donné. */
export function parisMidnight(y, m, d) {
  const guess = Date.UTC(y, m, d) - H;
  return guess - (parisOffset(guess) - 1) * H;
}
export const isPeak = (p) => p.dow >= 1 && p.dow <= 5 && p.h >= 8 && p.h < 20;
const isWE = (p) => p.dow === 0 || p.dow === 6;

/**
 * Profil horaire relatif par mois × (semaine, week-end) estimé sur l'historique réel :
 * (prix − moyenne du jour) / max(|moyenne du jour|, 30), moyenné sur les jours du mois.
 */
export function estimateProfiles(t0, prices) {
  const days = new Map();
  for (let i = 0; i < prices.length; i++) {
    const v = prices[i];
    if (!Number.isFinite(v)) continue;
    const p = parisParts(t0 + i * H);
    const k = `${p.y}-${p.m}-${p.d}`;
    let day = days.get(k);
    if (!day) days.set(k, (day = { m: p.m, we: isWE(p) ? 1 : 0, s: new Float64Array(24), c: new Float64Array(24) }));
    day.s[p.h] += v; day.c[p.h]++;
  }
  const acc = [...Array(12)].map(() => [0, 1].map(() => ({ s: new Float64Array(24), n: 0 })));
  for (const day of days.values()) {
    if ([...day.c].some((c) => !c)) continue; // jour incomplet
    const hv = [...day.s].map((s, h) => s / day.c[h]);
    const mean = hv.reduce((a, b) => a + b, 0) / 24, den = Math.max(Math.abs(mean), 30);
    const a = acc[day.m][day.we];
    hv.forEach((v, h) => { a.s[h] += (v - mean) / den; });
    a.n++;
  }
  // repli : moyenne de tous les mois pour le même type de jour
  const all = [0, 1].map((we) => {
    const s = new Float64Array(24); let n = 0;
    acc.forEach((row) => { if (row[we].n) { row[we].s.forEach((v, h) => { s[h] += v; }); n += row[we].n; } });
    return n ? [...s].map((v) => v / n) : new Array(24).fill(0);
  });
  return acc.map((row) => row.map((a, we) => (a.n >= 2 ? [...a.s].map((v) => v / a.n) : all[we])));
}

/** Prix du gaz d'un mois : produit mensuel, sinon trimestre (diminué des mois cotés), sinon calendaire (diminué des trimestres cotés). */
export function gasForMonth(g, y, m) {
  const k = monthKey(y, m);
  if (g[k] != null) return g[k];
  const days = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const qi = Math.floor(m / 3), q = `Q${qi + 1}-${String(y).slice(2)}`, cal = `Cal-${String(y).slice(2)}`;
  if (g[q] != null) {
    const ms = [qi * 3, qi * 3 + 1, qi * 3 + 2];
    const known = ms.filter((mm) => g[monthKey(y, mm)] != null);
    if (!known.length) return g[q];
    const tot = ms.reduce((s, mm) => s + days(y, mm), 0);
    const kn = known.reduce((s, mm) => s + g[monthKey(y, mm)] * days(y, mm), 0);
    const nd = ms.filter((mm) => !known.includes(mm)).reduce((s, mm) => s + days(y, mm), 0);
    return (g[q] * tot - kn) / nd;
  }
  if (g[cal] != null) {
    const qd = (i) => [0, 1, 2].reduce((s, j) => s + days(y, i * 3 + j), 0);
    const known = [0, 1, 2, 3].filter((i) => g[`Q${i + 1}-${String(y).slice(2)}`] != null);
    if (!known.length) return g[cal];
    const tot = [0, 1, 2, 3].reduce((s, i) => s + qd(i), 0);
    const kn = known.reduce((s, i) => s + g[`Q${i + 1}-${String(y).slice(2)}`] * qd(i), 0);
    const nd = [0, 1, 2, 3].filter((i) => !known.includes(i)).reduce((s, i) => s + qd(i), 0);
    return (g[cal] * tot - kn) / nd;
  }
  const prev = Object.keys(g).filter((x) => /^\d{4}-\d\d$/.test(x) && x < k).sort().pop();
  return prev ? g[prev] : null;
}

/**
 * Construit la HPFC horaire de novembre 2026 à décembre 2029 (heure de Paris).
 * 1. Q4-27 déduit par arbitrage Cal-27 − Q1..Q3 (base et pointe, pondéré en heures).
 * 2. Niveau mensuel : produit mensuel, sinon trimestre ou calendaire réparti par la saisonnalité ; nov./déc. 26 sans cotation : spot 30 j.
 * 3. Forme horaire estimée sur l'historique réel, recalée sur la base de chaque mois.
 * 4. Calage base/pointe exact sur chaque produit coté.
 */
export function buildHPFC(market, hist, { from = [2026, 10], to = [2029, 11] } = {}) {
  const E = market.electricite, S = market.saisonnalite.mois;
  const prof = estimateProfiles(hist.t0, hist.prices);
  const t0 = parisMidnight(from[0], from[1], 1);
  const t1 = parisMidnight(to[1] === 11 ? to[0] + 1 : to[0], (to[1] + 1) % 12, 1);
  const n = Math.round((t1 - t0) / H);
  const F = new Float32Array(n), MI = new Uint16Array(n), PK = new Uint8Array(n), HR = new Uint8Array(n), WE = new Uint8Array(n);
  const months = [];
  for (let y = from[0]; y <= to[0]; y++) for (let m = 0; m < 12; m++) {
    if ((y === from[0] && m < from[1]) || (y === to[0] && m > to[1])) continue;
    months.push({ y, m, k: monthKey(y, m), q: `Q${Math.floor(m / 3) + 1}-${String(y).slice(2)}`, cal: `Cal-${String(y).slice(2)}`,
      mo: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]}-${String(y).slice(2)}` });
  }
  const idx = Object.fromEntries(months.map((o, i) => [o.k, i]));
  for (let i = 0; i < n; i++) {
    const p = parisParts(t0 + i * H);
    MI[i] = idx[monthKey(p.y, p.m)]; PK[i] = isPeak(p) ? 1 : 0; HR[i] = p.h; WE[i] = isWE(p) ? 1 : 0;
  }
  // heures et heures de pointe par produit
  const cnt = {};
  const bump = (k, pk) => { const c = cnt[k] || (cnt[k] = { n: 0, p: 0 }); c.n++; c.p += pk; };
  for (let i = 0; i < n; i++) { const o = months[MI[i]]; bump(o.mo, PK[i]); bump(o.q, PK[i]); bump(o.cal, PK[i]); }

  const pw = {}, flags = {};
  for (const [k, v] of Object.entries(E)) if (!k.startsWith('_') && v && v.base != null) pw[k] = { b: v.base, p: v.pointe };
  // trimestre manquant d'une année calendaire cotée : arbitrage sur les heures
  for (const cal of Object.keys(pw).filter((k) => k.startsWith('Cal-'))) {
    const yy = cal.slice(4), qs = [1, 2, 3, 4].map((i) => `Q${i}-${yy}`);
    const missing = qs.filter((q) => !pw[q] && cnt[q]);
    if (missing.length !== 1 || qs.some((q) => !cnt[q])) continue;
    const q = missing[0], C = pw[cal];
    let sb = C.b * cnt[cal].n, sp = C.p != null ? C.p * cnt[cal].p : null;
    for (const o of qs.filter((x) => x !== q)) { sb -= pw[o].b * cnt[o].n; if (sp != null) sp = pw[o].p != null ? sp - pw[o].p * cnt[o].p : null; }
    pw[q] = { b: sb / cnt[q].n, p: sp != null ? sp / cnt[q].p : null };
    flags[q] = 'dérivé';
  }
  // spot moyen des 30 derniers jours mesurés : proxy des mois sans cotation
  let m30 = NaN;
  { let s = 0, c = 0; for (let i = hist.prices.length - 1; i >= 0 && c < 720; i--) if (Number.isFinite(hist.prices[i])) { s += hist.prices[i]; c++; } if (c) m30 = s / c; }

  const sAvg = (ms) => ms.reduce((a, m) => a + S[m], 0) / ms.length;
  for (const o of months) {
    if (pw[o.mo]) { o.base = pw[o.mo].b; o.src = o.mo; o.flag = flags[o.mo] || 'coté'; continue; }
    if (pw[o.q]) { const qi = Math.floor(o.m / 3); o.base = pw[o.q].b * S[o.m] / sAvg([qi * 3, qi * 3 + 1, qi * 3 + 2]); o.src = o.q; o.flag = flags[o.q] || 'trimestre'; continue; }
    if (pw[o.cal]) { o.base = pw[o.cal].b * S[o.m] / sAvg([...Array(12).keys()]); o.src = o.cal; o.flag = 'calendaire saisonnalisé'; continue; }
    o.base = m30; o.src = 'spot 30 j'; o.flag = 'proxy';
  }
  for (let i = 0; i < n; i++) { const o = months[MI[i]]; F[i] = o.base * (1 + prof[o.m][WE[i]][HR[i]]); }
  // recale chaque mois sur son niveau de base
  const sum = new Float64Array(months.length), c = new Float64Array(months.length);
  for (let i = 0; i < n; i++) { sum[MI[i]] += F[i]; c[MI[i]]++; }
  for (let i = 0; i < n; i++) F[i] += months[MI[i]].base - sum[MI[i]] / c[MI[i]];
  // calage base/pointe exact, du produit le plus long au plus court
  const inP = (k) => (o) => o.mo === k || o.q === k || o.cal === k;
  const order = Object.keys(pw).filter((k) => cnt[k]).sort((a, b) => cnt[b].n - cnt[a].n);
  for (const k of order) {
    const { b: B, p: P } = pw[k], sel = inP(k);
    let sp = 0, np = 0, so = 0, no = 0;
    for (let i = 0; i < n; i++) { if (!sel(months[MI[i]])) continue; if (PK[i]) { sp += F[i]; np++; } else { so += F[i]; no++; } }
    if (P == null || !np || !no) { const d = B - (sp + so) / (np + no); for (let i = 0; i < n; i++) if (sel(months[MI[i]])) F[i] += d; continue; }
    const O = (B * (np + no) - P * np) / no, dp = P - sp / np, dO = O - so / no;
    for (let i = 0; i < n; i++) if (sel(months[MI[i]])) F[i] += PK[i] ? dp : dO;
  }
  // contrôle : moyenne base et pointe de la courbe sur chaque produit
  const check = Object.keys(pw).filter((k) => cnt[k]).map((k) => {
    const sel = inP(k); let sb = 0, nb = 0, sp = 0, np = 0;
    for (let i = 0; i < n; i++) if (sel(months[MI[i]])) { sb += F[i]; nb++; if (PK[i]) { sp += F[i]; np++; } }
    return { produit: k, base: pw[k].b, base_courbe: sb / nb, pointe: pw[k].p, pointe_courbe: np ? sp / np : null, statut: flags[k] || 'coté' };
  });
  const gas = Object.fromEntries(months.map((o) => [o.k, gasForMonth(market.gaz_peg, o.y, o.m)]));
  return { t0, n, F, MI, PK, HR, WE, months, pw, flags, check, gas, m30, prof };
}

/** Index horaire de la courbe pour un instant UTC. */
export const fwdIndex = (FWD, t) => Math.round((t - FWD.t0) / H);
/** [début, fin) d'une période de dates locales (AAAA-MM-JJ, fin incluse). */
export function fwdRangeDays(FWD, fromISO, toISO) {
  const [y0, m0, d0] = fromISO.split('-').map(Number), [y1, m1, d1] = toISO.split('-').map(Number);
  const s = parisMidnight(y0, m0 - 1, d0), e = parisMidnight(y1, m1 - 1, d1 + 1);
  return [Math.max(0, fwdIndex(FWD, s)), Math.min(FWD.n, fwdIndex(FWD, e))];
}

/** Coût marginal à terme d'une unité à l'heure i de la courbe : gaz au PEG du mois, autres combustibles aux hypothèses. */
export function mcAt(u, i, P, FWD) {
  if (u.filiere === 'gaz') {
    const g = FWD.gas[FWD.months[FWD.MI[i]].k];
    return srmc(u, { ...P, combustibles: { ...P.combustibles, gaz_ttf_eur_mwh: g ?? P.combustibles.gaz_ttf_eur_mwh } });
  }
  return srmc(u, P);
}
