// Fiche actif : 6 onglets (Merit, Prévision, Pricing, Couverture, Valo, JSON) et liste des tranches.
import { bars, col, fmt, heatmap as heatSvg, lines, tornadoChart, waterfall } from './charts.js';
import { dcf, heatmap, hedge, kpis, marginalSeries, rankSeries, srmc, srmcParts, tech, tornado } from './finance.js';
import { hourDate } from './data.js';
import { mcAt, parisMidnight } from './forward.js';
import { CONSTRAINTS, exportJson, methodOf, parseScenarios, priceIt } from './pricing.js';
import { icon } from './icons.js';

const LBL = { nucleaire: 'Nucléaire', hydraulique: 'Hydraulique', gaz: 'Gaz', charbon: 'Charbon', fioul: 'Fioul', eolien: 'Éolien', solaire: 'Solaire', bioenergies: 'Bioénergies' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
const dMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'Europe/Paris' });
const dFull = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** « AAAA-MM-JJTHH:MM » à l'heure de Paris → instant UTC. */
function parisLocalToUtc(s) {
  const [d, t = '00:00'] = s.split('T'), [y, m, dd] = d.split('-').map(Number), [hh, mm] = t.split(':').map(Number);
  return parisMidnight(y, m - 1, dd) + (hh * 60 + (mm || 0)) * 60e3;
}

export function createPanel(el, D, { onClose, onPick, emit }) {
  let ent = null, tab = 'merit', hour = D.now;
  const sim = {};   // réglages des curseurs, par entité
  const fwdSt = { from: '2026-11', to: '2027-12', mo: '2027-01' };
  const px = {};    // formulaire de pricing, par entité
  let scen = null, lastPrice = null;

  /** Entité affichée : une tranche, ou un site/actif (somme de ses unités). */
  function entity(id) {
    if (id.startsWith('fil-')) {
      const f = id.slice(4), units = D.byFil[f] || [];
      const prod = new Float32Array(D.H);
      for (const u of units) { const p = D.prod[u.idx]; for (let h = 0; h < D.H; h++) prod[h] += p[h]; }
      const p_mw = D.filCap[f];
      const cmg = units.reduce((s, u) => s + D.cmg[u.idx] * u.p_mw, 0) / p_mw;
      const nom = `Parc ${LBL[f].toLowerCase()}`;
      return { id, nom, units, prod, cmg, fil: true,
        u: { filiere: f, p_mw, id, nom, type: null, tranche: null, exploitant: f === 'nucleaire' ? 'EDF' : null } };
    }
    const u0 = D.unitById[id];
    if (u0 && (u0.tranche || !u0.mapId || u0.mapId === u0.id)) {
      return { id, nom: u0.nom, units: [u0], u: u0, prod: D.prod[u0.idx], cmg: D.cmg[u0.idx], asset: D.assets.find((a) => a.id === u0.mapId) };
    }
    const units = D.byMap[id] || [];
    const asset = D.assets.find((a) => a.id === id);
    const prod = new Float32Array(D.H);
    for (const u of units) { const p = D.prod[u.idx]; for (let h = 0; h < D.H; h++) prod[h] += p[h]; }
    const p_mw = units.reduce((s, u) => s + u.p_mw, 0);
    const cmg = units.reduce((s, u) => s + D.cmg[u.idx] * u.p_mw, 0) / p_mw;
    return { id, nom: asset.nom, units, asset, prod, cmg, u: { ...units[0], p_mw, id, nom: asset.nom, tranche: null } };
  }

  function window12() { return [Math.max(0, D.now - 365 * 24 + 1), D.now + 1]; }

  function marg() {
    if (!D.marg) D.marg = marginalSeries(D.units, D.cmg, D.prod, D.now + 1);
    return D.marg;
  }

  function sourceNote(e) {
    if (D.meta.mode === 'demo') return '<span class="tag warn">Données de démonstration</span>';
    const src = { rte: 'RTE Data', entsoe: 'ENTSO-E' }[D.meta.sources?.units?.source] || 'source officielle';
    const cov = e.units.reduce((s, u) => s + (u.realHours || 0) * u.p_mw, 0) / (e.units.reduce((s, u) => s + u.p_mw, 0) * (D.now + 1));
    if (cov > 0.95) return `<span class="tag ok">Production mesurée par groupe (${src})</span>`;
    if (cov > 0.01) return `<span class="tag">Production mesurée (${src}) sur ${fmt(cov * 100)} % des heures, estimée ailleurs</span>`;
    return '<span class="tag">Production estimée : part du mix national de la filière</span>';
  }

  function header(e) {
    const u = e.u, a = e.asset || {};
    const nSites = e.fil ? new Set(e.units.map((x) => x.mapId).filter(Boolean)).size : 0;
    const bits = e.fil
      ? [u.filiere === 'nucleaire' ? `${e.units.length} tranches · ${nSites} sites` : `${nSites} centrales ou parcs suivis`, `${fmt(u.p_mw / 1000, 1)} GW installés`, u.exploitant]
      : [LBL[u.filiere], u.type && u.type !== 'diffus' ? u.type : null, u.palier, `${fmt(u.p_mw)} MW`, u.exploitant, a.commune, a.region];
    const crumb = u.tranche ? `<button class="crumb" data-pick="${u.mapId}">← ${esc(e.asset?.nom)}</button>`
      : !e.fil ? `<button class="crumb" data-pick="fil-${u.filiere}">← Parc ${esc(LBL[u.filiere].toLowerCase())}</button>` : '';
    const now = e.prod[hour];
    return `<div class="p-head">
      <button class="icon close" aria-label="Fermer la fiche">✕</button>
      ${crumb}
      <div class="p-title">${icon(u.filiere, 34)}<h2>${esc(e.nom)}</h2></div>
      <p class="p-sub mono">${bits.filter(Boolean).map(esc).join(' · ')}</p>
      <p class="p-now"><span>${dFull.format(hourDate(D, hour))}</span> <b>${e.fil ? `${fmt(now / 1000, 1)} GW` : `${fmt(now)} MW`}</b> <span class="muted">soit ${fmt(now / u.p_mw * 100)} % · CMg ${fmt(e.cmg)} €/MWh</span></p>
      ${a.statut && a.statut !== 'en service' ? `<p class="tag warn">${esc(a.statut)}</p>` : ''}
      ${a.note ? `<p class="muted small">${esc(a.note)}</p>` : ''}
    </div>
    <div class="tabs" role="tablist">${[['merit', 'Merit'], ['fwd', 'Prévision'], ['price', 'Pricing'], ['hedge', 'Couverture'], ['valo', 'Valo'], ['json', 'JSON']]
      .map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('')}</div>`;
  }

  const statusOf = (p, pmw) => { const r = p / pmw; return r > 0.9 ? ['ok', 'marche'] : r > 0.02 ? ['mod', 'modulation'] : ['off', 'arrêt']; };

  /** Fiche d'une filière : ce que la maquette représente (sites et tranches, ou centrales). */
  function membersList(e) {
    if (!e.fil) return '';
    const f = e.u.filiere;
    const sites = [...new Set(e.units.map((u) => u.mapId).filter(Boolean))].map((id) => D.assets.find((a) => a.id === id))
      .sort((a, b) => b.p_mw - a.p_mw);
    const diffus = e.units.filter((u) => !u.mapId);
    const row = (id, nom, p, pmw, extra = '') => {
      const st = statusOf(p, pmw);
      return `<li><button data-pick="${id}"><i class="st ${st[0]}"></i><b>${esc(nom)}</b><span>${extra}</span><span class="mono r">${fmt(p)} / ${fmt(pmw)} MW</span></button></li>`;
    };
    const items = sites.map((a) => {
      const us = D.byMap[a.id] || [];
      const extra = f === 'nucleaire' ? us.map((u) => `<i class="st ${statusOf(D.prod[u.idx][hour], u.p_mw)[0]}" title="${u.id}"></i>`).join('') : esc(a.type || '');
      return row(a.id, a.nom, D.siteProd(a.id, hour), a.p_mw, extra);
    }).join('') + diffus.map((u) => row(u.id, u.nom, D.prod[u.idx][hour], u.p_mw, 'petites installations')).join('');
    const title = f === 'nucleaire' ? `Les ${sites.length} sites et leurs ${e.units.length} tranches` : 'Ce que regroupe cette maquette';
    return `<section><h3>${title}</h3><p class="muted small">Sur la carte, la filière s'est éclatée en ses sites réels, posés à leur vraie position. Clique un site, sur la carte ou dans la liste, pour sa fiche.</p><ul class="tranches members">${items}</ul></section>`;
  }

  function tranchesList(e) {
    if (e.fil) return '';
    const ts = e.units.filter((u) => u.tranche);
    if (ts.length < 2 && !(e.u.tranche)) return '';
    const list = e.u.tranche ? D.units.filter((u) => u.mapId === e.u.mapId) : ts;
    return `<section><h3>Tranches du site</h3><ul class="tranches">${list.map((u) => {
      const p = D.prod[u.idx][hour];
      const st = statusOf(p, u.p_mw);
      return `<li><button data-pick="${u.id}" class="${u.id === e.id ? 'cur' : ''}"><i class="st ${st[0]}"></i><b class="mono">${u.id}</b><span>${st[1]} · ${u.palier} · ${u.couplage}</span><span class="mono r">${fmt(p)} / ${fmt(u.p_mw)} MW</span></button></li>`;
    }).join('')}</ul></section>`;
  }

  function tabMerit(e) {
    const [h0, h1] = window12();
    const k = kpis(e.u, e.prod, D.price, e.cmg, h0, h1, marg(), D.units);
    const weeks = Math.floor((h1 - h0) / 168), hs = h1 - weeks * 168;
    const cells = heatmap(e.u, e.prod, D.price, e.cmg, hs, h1, D.t0);
    const labels = cells.map((_, w) => dShort.format(hourDate(D, hs + w * 168)));
    const r0 = Math.max(0, hour - 84), r1 = Math.min(D.now + 1, r0 + 168);
    const rk = rankSeries(e.u.tranche ? e.u : e.units[0], D.units, D.cmg, D.prod, r0, r1);
    const xl = [0, 48, 96, 144].filter((i) => i < r1 - r0).map((i) => [i, dShort.format(hourDate(D, r0 + i))]);
    const parts = e.fil ? [{ k: 'Moyenne du parc, pondérée par la puissance', v: e.cmg }] : srmcParts(e.u, D.params);
    return `${membersList(e)}<section>
      <h3>Quand est-il appelé ? <span class="muted">12 derniers mois</span></h3>
      <p class="muted small">Chaque case = une heure de la journée, une semaine. Vert : il tourne et le prix dépasse son coût marginal. Rouge : il tourne à perte. Gris : à l'arrêt.</p>
      ${heatSvg(cells, { labels })}
    </section>
    <section class="kgrid">
      <div><span>Facteur de charge</span><b>${fmt(k.facteur_charge * 100)} %</b></div>
      <div><span>Heures où le prix couvre son CMg</span><b>${fmt(k.part_heures_en_marge * 100)} %</b></div>
      <div><span>Prix capté</span><b>${fmt(k.prix_capte, 1)} €</b><small>base ${fmt(k.prix_moyen_base, 1)} €</small></div>
      <div><span>Heures où sa filière fixe le prix</span><b>${fmt(k.heures_filiere_marginale / Math.max(1, k.heures) * 100, 1)} %</b><small>modèle</small></div>
    </section>
    <section>
      <h3>Coût marginal ${fmt(e.cmg, 1)} €/MWh</h3>
      <div class="cmg">${parts.map((p) => `<span style="flex:${Math.max(0.5, p.v)}"><b>${fmt(p.v, 1)}</b> ${esc(p.k)}</span>`).join('')}</div>
    </section>
    <section>
      <h3>Sa place dans l'escalier <span class="muted">7 jours</span></h3>
      <p class="muted small">Ligne jaune : GW de capacité moins chère devant lui. Tant qu'elle reste sous la production (blanc), il est appelé.</p>
      ${lines([{ v: rk.dem, color: 'var(--fg)', label: 'Production' }, { v: rk.pos, color: 'var(--c-nucleaire)', area: true, label: 'Position' }], { yLabel: 'GW', xLabels: xl, marker: hour - r0 })}
    </section>
    <section>
      <h3>Production et prix spot <span class="muted">7 jours</span></h3>
      ${lines([{ v: Array.from(e.prod.slice(r0, r1)), color: col(e.u.filiere), area: true }], { yLabel: 'MW', xLabels: xl, zero: true, marker: hour - r0, h: 100 })}
      ${lines([{ v: Array.from(D.price.slice(r0, r1)), color: 'var(--accent)' }, { v: new Array(r1 - r0).fill(e.cmg), color: 'var(--muted)', dash: true }], { yLabel: '€/MWh (pointillé : CMg)', xLabels: xl, marker: hour - r0, h: 100 })}
    </section>
    ${outagesSection(e)}
    ${registreSection(e)}
    ${tranchesList(e)}
    <p class="src">${sourceNote(e)}</p>`;
  }

  function monthly(e) {
    const out = [];
    let cur = null;
    for (let h = Math.max(0, D.now - 365 * 24 + 1); h <= D.now; h++) {
      const key = dMonth.format(hourDate(D, h));
      if (!cur || cur.k !== key) { cur = { k: key, e: 0, r: 0, b: 0, n: 0 }; out.push(cur); }
      const p = e.prod[h], pr = D.price[h];
      if (Number.isNaN(pr)) continue;
      cur.e += p; cur.r += p * pr; cur.b += pr; cur.n++;
    }
    return out.map((m) => ({ k: m.k.replace('.', ''), capte: m.e ? m.r / m.e : NaN, base: m.n ? m.b / m.n : NaN }));
  }

  function simState(e) {
    const [h0, h1] = window12();
    const k = kpis(e.u, e.prod, D.price, e.cmg, h0, h1, null, D.units);
    const isEdfNuc = e.u.filiere === 'nucleaire';
    const cov = D.params.couverture_edf_nucleaire;
    const s = sim[e.id] || (sim[e.id] = {
      annee: '2027', part: isEdfNuc ? cov['2027'].part : 0.5,
      terme: isEdfNuc ? cov['2027'].prix : Math.round((k.prix_moyen_base || 60) * (k.taux_capture || 1)),
      spot: Math.round(k.prix_moyen_base || 60), lf: Math.round((k.facteur_charge || 0.5) * 100) / 100,
      prixLT: D.params.valorisation.prix_long_terme, wacc: D.params.valorisation.wacc, co2: D.params.combustibles.co2_eua_eur_t,
    });
    return { s, k, isEdfNuc };
  }

  const slider = (id, label, v, min, max, step, unit) =>
    `<label class="sl"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><output for="${id}">${unit === '%' ? fmt(v * 100, step < 0.01 ? 1 : 0) : fmt(v, step < 1 ? 1 : 0)} ${unit}</output></label>`;

  function tabHedge(e) {
    const { s, k, isEdfNuc } = simState(e);
    const m = monthly(e);
    const cap = Number.isNaN(k.taux_capture) ? 1 : k.taux_capture;
    const vol = e.u.p_mw * 8760 * s.lf;
    const res = hedge({ volume_mwh: vol, part: s.part, prix_terme: s.terme, spot: s.spot, capture: cap, cmg: e.cmg,
      cout_mwh: isEdfNuc ? D.params.vnu.cout_complet_cre : null, vnu: isEdfNuc ? D.params.vnu : null });
    const up = hedge({ volume_mwh: vol, part: s.part, prix_terme: s.terme, spot: s.spot + 10, capture: cap, cmg: e.cmg,
      cout_mwh: isEdfNuc ? D.params.vnu.cout_complet_cre : null, vnu: isEdfNuc ? D.params.vnu : null });
    const cov = D.params.couverture_edf_nucleaire;
    return `<section>
      <h3>Prix capté et prix moyen, par mois</h3>
      <p class="muted small">Barres : prix moyen obtenu par l'actif. Trait : prix moyen du marché. Taux de capture sur 12 mois : <b>${fmt(cap * 100)} %</b>.</p>
      ${bars(m.map((x) => ({ k: x.k.slice(0, 3), v: x.capte, color: col(e.u.filiere) })), { unit: '€/MWh', ref: k.prix_moyen_base })}
    </section>
    <section>
      <h3>Simulateur de couverture <span class="muted">1 an de production</span></h3>
      ${isEdfNuc ? `<div class="seg" role="group" aria-label="Année de livraison">${Object.keys(cov).filter((y) => !y.startsWith('_')).map((y) => `<button data-year="${y}" aria-pressed="${s.annee === y}">${y}</button>`).join('')}</div>
      <p class="muted small">${esc(cov._statut)} <br>Source : ${esc(cov._source)}</p>` : '<p class="muted small">Exemple : vendre une partie de la production à terme pour fixer le prix, le reste au spot.</p>'}
      ${slider('h-part', 'Vendu à terme', s.part, 0, 1, 0.01, '%')}
      ${slider('h-terme', 'Prix à terme', s.terme, 0, 200, 1, '€/MWh')}
      ${slider('h-spot', 'Prix spot moyen (scénario)', s.spot, -10, 250, 1, '€/MWh')}
      ${slider('h-lf', 'Facteur de charge', s.lf, 0.02, 1, 0.01, '%')}
      ${waterfall(res.items, res.marge)}
      <p class="small">Prix moyen obtenu <b>${fmt(res.prix_moyen, 1)} €/MWh</b> sur ${fmt(vol / 1e6, 2)} TWh. Avec 10 €/MWh de spot en plus, la marge varie de <b>${fmt(up.marge - res.marge, 1)} M€</b> : c'est l'exposition qui reste après couverture.</p>
      ${isEdfNuc ? `<p class="muted small">VNU : seuils ${fmt(D.params.vnu.seuil1)} et ${fmt(D.params.vnu.seuil2)} €/MWh, reversement ${fmt(D.params.vnu.taux1 * 100)} % puis ${fmt(D.params.vnu.taux2 * 100)} %. ${esc(D.params.vnu._source)} Coût complet ${fmt(D.params.vnu.cout_complet_cre, 1)} €/MWh : ${esc(D.params.vnu._source_cout_complet)}</p>` : ''}
    </section>`;
  }

  function lifeYears(e) {
    const y = new Date().getFullYear(), t = tech(e.u, D.params);
    let end;
    if (e.u.filiere === 'nucleaire') end = Math.round(e.units.reduce((s, u) => s + (u.fin_vie || y + 20) * u.p_mw, 0) / e.u.p_mw);
    else if (e.asset?.note?.includes('2027')) end = 2027;
    else end = (e.asset?.mise_service || y - 10) + (t.vie || 30);
    return Math.max(1, Math.min(D.params.valorisation.horizon_max_ans, end - y));
  }

  function tabValo(e) {
    const { s, k } = simState(e);
    const cap = Number.isNaN(k.taux_capture) ? 1 : k.taux_capture;
    const P2 = { ...D.params, combustibles: { ...D.params.combustibles, co2_eua_eur_t: s.co2 } };
    const cmg = e.units.reduce((acc, u) => acc + srmc(u, P2) * u.p_mw, 0) / e.u.p_mw;
    const base = { p_mw: e.u.p_mw, lf: s.lf, prix: s.prixLT, capture: cap, cmg, cout_fixe_kw_an: tech(e.u, D.params).cout_fixe_kw_an || 30, annees: lifeYears(e), wacc: s.wacc };
    const r = dcf(base), tor = tornado(base);
    const y0 = new Date().getFullYear();
    return `<section class="npv"><span>Valeur actuelle nette (modèle)</span><b>${fmt(r.npv)} M€</b><small>${base.annees} ans restants · ${fmt(r.npv / e.u.p_mw * 1000)} €/kW</small></section>
    <section>
      ${slider('v-prix', 'Prix long terme', s.prixLT, 20, 200, 1, '€/MWh')}
      ${slider('v-wacc', 'Taux d\'actualisation (WACC)', s.wacc, 0.02, 0.15, 0.005, '%')}
      ${slider('h-lf', 'Facteur de charge', s.lf, 0.02, 1, 0.01, '%')}
      ${slider('v-co2', 'Prix du CO2', s.co2, 0, 250, 1, '€/t')}
    </section>
    <section>
      <h3>Flux annuels <span class="muted">M€, non actualisés</span></h3>
      ${bars(r.flows.map((v, i) => ({ k: i % 5 === 0 ? String(y0 + i + 1).slice(2) : '', v, color: v >= 0 ? 'var(--good)' : 'var(--bad)' })), { unit: 'M€' })}
    </section>
    <section><h3>Ce qui fait bouger la valeur</h3>${tornadoChart(tor)}</section>
    <section class="small muted">
      <p>Marge annuelle = production × (prix long terme × taux de capture ${fmt(cap * 100)} % − CMg ${fmt(cmg, 1)} €/MWh) − coûts fixes ${fmt(base.cout_fixe_kw_an)} €/kW/an. Pas de capex de prolongation, pas d'impôt : un ordre de grandeur pour comparer les actifs, pas une évaluation.</p>
    </section>`;
  }



  // ---------------------------------------------------------------- indisponibilités déclarées (ENTSO-E A80)
  /** Événements des tranches ou de la centrale de l'entité. */
  function outagesOf(e) {
    const P = D.indispos?.par_id;
    if (!P || e.fil) return [];
    const ids = e.u.tranche ? [e.u.id] : [...new Set([e.id, ...e.units.map((u) => u.id)])];
    return ids.flatMap((id) => (P[id] || []).map((ev) => ({ ...ev, id })));
  }
  /** Motif REMIT : première langue seulement, tronqué. */
  const shortReason = (m) => { const t = m.split(/-{5,}/)[0].trim(); return t.length > 140 ? `${t.slice(0, 137)}…` : t; };
  const dDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Europe/Paris' });
  function outagesSection(e) {
    if (!D.indispos || e.fil) return '';
    const evs = outagesOf(e);
    const t0 = Date.parse(D.indispos.fenetre[0]), t1 = Date.parse(D.indispos.fenetre[1]), now = hourDate(D, D.now).getTime();
    const ids = [...new Set(evs.map((v) => v.id))].sort();
    const W = 340, L = ids.length > 1 ? 40 : 8, X = (t) => L + (Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0) * (W - L - 8);
    const rowH = 14, H = Math.max(1, ids.length) * rowH + 22;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Indisponibilités">`;
    ids.forEach((id, r) => {
      if (ids.length > 1) svg += `<text x="2" y="${r * rowH + 11}" class="ax">${esc(id)}</text>`;
      for (const v of evs.filter((x) => x.id === id)) {
        const a = Date.parse(v.debut), b = Date.parse(v.fin), x0 = X(a), w = Math.max(1.5, X(b) - x0);
        const op = v.pn ? 0.35 + 0.65 * Math.min(1, Math.max(0, 1 - (v.dispo_mw ?? 0) / v.pn)) : 0.9;
        svg += `<rect x="${x0.toFixed(1)}" y="${r * rowH + 2}" width="${w.toFixed(1)}" height="${rowH - 4}" rx="2" fill="${v.type === 'fortuite' ? 'var(--bad)' : 'var(--accent)'}" opacity="${op.toFixed(2)}"><title>${esc(v.nom || id)} · ${v.type} · ${dDay.format(a)} → ${dDay.format(b)} · dispo ${fmt(v.dispo_mw)} / ${fmt(v.pn)} MW</title></rect>`;
      }
    });
    const xn = X(now);
    svg += `<line x1="${xn}" x2="${xn}" y1="0" y2="${H - 16}" stroke="var(--fg)"/><text x="${xn}" y="${H - 4}" class="ax" text-anchor="middle">aujourd'hui</text>`;
    svg += `<text x="${L}" y="${H - 4}" class="ax">${dDay.format(t0)}</text><text x="${W - 8}" y="${H - 4}" class="ax" text-anchor="end">${dDay.format(t1)}</text></svg>`;
    const next = evs.filter((v) => Date.parse(v.fin) > now).sort((a, b) => a.debut.localeCompare(b.debut)).slice(0, 6);
    return `<section><h3>Indisponibilités déclarées <span class="muted">ENTSO-E (REMIT)</span></h3>
      ${evs.length ? `<p class="muted small">Barres bleues : arrêts planifiés ; rouges : fortuits. Plus la barre est opaque, plus la puissance perdue est grande. Survol : détail.</p>${svg}
      ${next.length ? `<ul class="files small">${next.map((v) => `<li><b>${esc(v.nom || v.id)}</b> · ${v.type} · ${dDay.format(Date.parse(v.debut))} → ${dDay.format(Date.parse(v.fin))} · reste ${fmt(v.dispo_mw)} MW${v.motif ? ` · <span class="muted">${esc(shortReason(v.motif))}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Aucune indisponibilité en cours ou annoncée.</p>'}`
        : '<p class="muted small">Aucune indisponibilité déclarée sur la période (ou groupe non publié sur ENTSO-E).</p>'}
    </section>`;
  }

  // ---------------------------------------------------------------- registre national
  function registreSection(e) {
    const r = e.u.tranche?.registre || e.asset?.registre;
    if (!r || e.fil) return '';
    const row = (k, v) => (v == null || v === '' ? '' : `<li>${k}<b class="mono">${v}</b></li>`);
    const h = r.hydro || {};
    return `<section><h3>Registre national <span class="muted">ODRÉ</span></h3><ul class="qmix">
      ${row('Facteur de charge 12 mois', r.facteur_charge_12m != null ? `${fmt(r.facteur_charge_12m * 100)} %` : null)}
      ${row('Énergie injectée 12 mois', r.e_injectee_12m_mwh != null ? `${fmt(r.e_injectee_12m_mwh / 1e3)} GWh` : null)}
      ${row('Puissance au registre', r.pmax_mw != null ? `${fmt(r.pmax_mw)} MW` : null)}
      ${row('Groupes', r.nb_groupes)}
      ${row('Pompage', r.pompage_mw != null ? `${fmt(r.pompage_mw)} MW` : null)}
      ${row('Énergie stockable', r.energie_stockable_mwh != null ? `${fmt(r.energie_stockable_mwh)} MWh` : null)}
      ${row('Réservoir', h.reservoir_mm3 != null ? `${fmt(h.reservoir_mm3, 1)} Mm³` : null)}
      ${row('Hauteur de chute', h.chute_m != null ? `${fmt(h.chute_m)} m` : null)}
      ${row('Productible', h.productible_gwh != null ? `${fmt(h.productible_gwh)} GWh` : null)}
      ${row('Débit maximal', h.debit_m3s != null ? `${fmt(h.debit_m3s)} m³/s` : null)}
      ${row('Poste de raccordement', r.poste_source?.join(', '))}
      ${row('Tension', r.tension?.join(', '))}
      ${row('Régime', r.regime?.join(', '))}
      ${row('Gestionnaire', r.gestionnaire?.join(', '))}
    </ul><p class="muted small">${esc(r.installations.length > 1 ? `${r.installations.length} installations du registre` : r.installations[0])}</p></section>`;
  }

  // ---------------------------------------------------------------- prévision (HPFC)
  const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const monthRange = (k0, k1) => {
    const F = D.FWD, a = F.months.findIndex((o) => o.k === k0), b = F.months.findIndex((o) => o.k === k1);
    let i0 = -1, i1 = -1;
    for (let i = 0; i < F.n; i++) { const mi = F.MI[i]; if (mi >= a && i0 < 0) i0 = i; if (mi <= b) i1 = i + 1; }
    return [i0, i1];
  };
  /** Unité de référence (techno) de l'entité, ou null pour un agrégat de filière. */
  const refUnit = (e) => (e.fil ? null : e.units[0]);
  const cmLabel = (u) => (u.filiere === 'hydraulique' && u.type !== 'fil' ? "valeur de l'eau (hypothèse)" : 'coût marginal');

  function tabFwd(e) {
    const F = D.FWD, u = refUnit(e) || { ...e.u, type: e.u.filiere === 'gaz' ? 'CCG' : null };
    const opts = (sel) => F.months.map((o) => `<option value="${o.k}" ${o.k === sel ? 'selected' : ''}>${MOIS[o.m]} ${o.y}</option>`).join('');
    const [i0, i1] = monthRange(fwdSt.from, fwdSt.to);
    if (!(i1 > i0)) return `<section>${fwdForm(opts)}<p class="muted">Choisis une fin postérieure au début.</p></section>`;
    const days = [], lo = [], hi = [], cms = [], xl = [];
    let itm = 0, intr = 0, n = 0;
    const every = Math.max(1, Math.ceil((F.MI[i1 - 1] - F.MI[i0] + 1) / 5));
    for (let i = i0; i < i1;) {
      const d0 = i; let s = 0, mn = Infinity, mx = -Infinity, cs = 0, c = 0;
      do {
        const v = F.F[i], m = mcAt(u, i, D.params, F); s += v; mn = Math.min(mn, v); mx = Math.max(mx, v); cs += m; c++;
        n++; if (v > m) { itm++; intr += v - m; } i++;
      } while (i < i1 && F.HR[i] !== 0);
      days.push(s / c); lo.push(mn); hi.push(mx); cms.push(cs / c);
      const o = F.months[F.MI[d0]];
      if ((d0 === i0 || F.MI[d0] !== F.MI[d0 - 1]) && (F.MI[d0] - F.MI[i0]) % every === 0) xl.push([days.length - 1, `${MOIS[o.m].replace('.', '')} ${String(o.y).slice(2)}`]);
    }
    // forme journalière du mois choisi
    const [j0, j1] = monthRange(fwdSt.mo, fwdSt.mo);
    const wd = new Array(24).fill(0), we = new Array(24).fill(0), cw = new Array(24).fill(0), ce = new Array(24).fill(0);
    for (let i = j0; i < j1; i++) { const h = F.HR[i]; if (F.WE[i]) { we[h] += F.F[i]; ce[h]++; } else { wd[h] += F.F[i]; cw[h]++; } }
    const cm = mcAt(u, j0, D.params, F), mo = F.months.find((o) => o.k === fwdSt.mo);
    const edited = (k) => { const a = D.market0.electricite[k], b = D.market.electricite[k]; return a && b && (a.base !== b.base || a.pointe !== b.pointe); };
    const st = (k) => (F.flags[k] ? `<span class="tag">${F.flags[k]}</span>` : edited(k) ? '<span class="tag warn">saisi</span>' : '<span class="tag ok">EEX 15/10</span>');
    const rows = Object.keys(D.market.electricite).filter((k) => !k.startsWith('_')).concat(Object.keys(F.flags).filter((k) => !D.market.electricite[k]));
    const chk = Object.fromEntries(F.check.map((c) => [c.produit, c]));
    return `<section>${fwdForm(opts)}
      ${lines([{ v: days, band: [lo, hi], color: 'var(--accent)' }, { v: cms, color: col(e.u.filiere), dash: true }], { yLabel: `€/MWh · jour (pointillé : ${cmLabel(u)})`, xLabels: xl, h: 150 })}
      <div class="kgrid"><div><span>Base de la période</span><b>${fmt(days.reduce((a, b) => a + b, 0) / days.length, 1)} €</b></div>
        <div><span>Heures où le prix couvre le CMg</span><b>${fmt(itm / n * 100)} %</b></div>
        ${e.fil || !methodOf(u) ? '' : `<div><span>Valeur intrinsèque</span><b>${fmtE(intr * e.u.p_mw)}</b><small>Σ (F − CMg)⁺ × ${fmt(e.u.p_mw)} MW</small></div>`}
        <div><span>Spot 30 derniers jours</span><b>${fmt(F.m30, 1)} €</b><small>proxy nov.-déc. 26</small></div></div>
    </section>
    <section><h3>Forme journalière prévue · ${MOIS[mo.m]} ${mo.y}</h3>
      ${lines([{ v: wd.map((v, h) => v / cw[h]), color: 'var(--accent)' }, { v: we.map((v, h) => v / ce[h]), color: 'var(--muted)', dash: true }, { v: new Array(24).fill(cm), color: col(e.u.filiere), dash: true }],
        { yLabel: '€/MWh · trait : semaine, pointillé gris : week-end', xLabels: [[0, '0 h'], [6, '6 h'], [12, '12 h'], [18, '18 h'], [23, '23 h']], h: 120 })}
    </section>
    <section><h3>Produits utilisés et contrôle de la courbe</h3>
      <table class="rel small"><thead><tr><th>Produit</th><th>Base</th><th>Pointe</th><th>Courbe (base / pointe)</th><th>Statut</th></tr></thead><tbody>
      ${rows.map((k) => { const v = F.pw[k], c = chk[k];
        return `<tr><td><b>${k}</b></td><td class="mono">${v ? fmt(v.b, 2) : '–'}</td><td class="mono">${v?.p != null ? fmt(v.p, 2) : '–'}</td><td class="mono">${c ? `${fmt(c.base_courbe, 2)} / ${c.pointe_courbe != null ? fmt(c.pointe_courbe, 2) : '–'}` : '–'}</td><td>${v ? st(k) : '<span class="tag warn">proxy spot 30 j</span>'}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="muted small">Courbe horaire (HPFC) de novembre 2026 à décembre 2029, à l'heure de Paris (changements d'heure compris). Niveaux tirés des seuls produits liquides : Cal-27/28/29 et Q1 à Q3-27, Q4-27 déduit par arbitrage. Saisonnalité mensuelle standard, forme horaire estimée sur ${fmt((D.now + 1) / 24)} jours de spot réel (ENTSO-E), puis calage exact base et pointe de chaque produit. Gaz : PEG du mois. Produits modifiables dans Hypothèses.</p>
    </section>`;
  }
  function fwdForm(opts) {
    return `<div class="form3"><label>Début<select data-fwd="from">${opts(fwdSt.from)}</select></label><label>Fin<select data-fwd="to">${opts(fwdSt.to)}</select></label><label>Mois (forme)<select data-fwd="mo">${opts(fwdSt.mo)}</select></label></div>`;
  }
  const fmtE = (x) => { if (x == null || Number.isNaN(x)) return '–'; const a = Math.abs(x); return a >= 1e6 ? `${fmt(x / 1e6, 2)} M€` : a >= 1e3 ? `${fmt(x / 1e3, 1)} k€` : `${fmt(x)} €`; };

  // ---------------------------------------------------------------- pricing de contraintes
  /** Unités pricables de l'entité : tranches, ou groupes ENTSO-E d'une centrale. */
  function pricingUnits(e) {
    if (e.fil) return [];
    if (e.u.tranche) return [{ id: e.u.id, nom: e.u.nom, p_mw: e.u.p_mw }];
    if (e.units.some((x) => x.tranche)) return e.units.filter((x) => x.tranche).map((x) => ({ id: x.id, nom: x.nom, p_mw: x.p_mw }));
    const us = e.asset?.unites;
    return us?.length ? us.map((x) => ({ id: x.nom, nom: x.nom, p_mw: x.p_mw })) : [{ id: e.id, nom: e.nom, p_mw: e.u.p_mw }];
  }
  const parcRev = (y) => D.market.revenu_parc_nucleaire[y] ?? D.FWD.pw[`Cal-${String(y).slice(2)}`]?.b ?? null;
  const vnu = () => ({ s1: D.params.vnu.seuil1, s2: D.params.vnu.seuil2, t1: D.params.vnu.taux1, t2: D.params.vnu.taux2 });
  function pxState(e) {
    const u = refUnit(e), all = pricingUnits(e);
    const pm = D.market.pmin_pct, tk = u.filiere === 'gaz' && u.type === 'TAC' ? 'gaz:TAC' : u.filiere;
    return px[e.id] || (px[e.id] = { c: 'int', from: '2027-01-01', to: '2027-01-31', sel: all.map((x) => x.id), pminPct: pm[tk] ?? 40, lim: Math.round(e.u.p_mw / 2), hourly: false });
  }
  function tabPrice(e) {
    if (e.fil) return '<section><p>Le pricing se fait sur une centrale ou une tranche. Ouvre un site depuis la liste ci-dessous ou la recherche.</p></section>' + membersList(e);
    const u = refUnit(e), m = methodOf(u);
    if (!m) {
      const why = u.filiere === 'hydraulique' && u.type === 'fil' ? "Fil de l'eau : coût = production fatale perdue × prix ; il faut un débit de référence."
        : u.filiere === 'hydraulique' ? "Hydro à réservoir ou STEP : la valeur dépend du stock et de la valeur d'usage de l'eau (cotes, apports). Pas de méthode déterministe simple sans le modèle de gestion du stock."
          : 'Production fatale (éolien, solaire, cogénération) : la contrainte se valorise au prix capté perdu, méthode à définir.';
      return `<section><div class="result"><b>Méthode de pricing à définir</b><p class="muted small">${why} La courbe forward et l'historique restent disponibles dans les autres onglets.</p></div></section>`;
    }
    const st = pxState(e), all = pricingUnits(e);
    return `<section>
      <p class="muted small">${m === 'deterministic_nuclear_vnu' ? 'Nucléaire : pricing déterministe sur la courbe, valeur marginale après VNU (seuils ' + vnu().s1 + ' et ' + vnu().s2 + ' €/MWh).' : 'Thermique : valeur intrinsèque horaire sur la courbe (en marche si F > CMg). Démarrages et durées minimales : à traiter dans Astral / M2F avec l\'export ci-dessous.'}</p>
      <div class="form3">
        <label>Contrainte<select data-px="c">${Object.entries(CONSTRAINTS).map(([k, l]) => `<option value="${k}" ${k === st.c ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Pmin (% de Pn)<input data-px="pminPct" type="number" min="0" max="100" step="1" value="${st.pminPct}"></label>
        ${st.c === 'lim' ? `<label>Limite X (MW)<input data-px="lim" type="number" min="0" step="10" value="${st.lim}"></label>` : ''}
        <label>Du<input data-px="from" type="date" min="2026-11-01" max="2029-12-31" value="${st.from}"></label>
        <label>Au (inclus)<input data-px="to" type="date" min="2026-11-01" max="2029-12-31" value="${st.to}"></label>
      </div>
      <div class="units">${all.map((x) => `<label class="unit"><input type="checkbox" data-pxu="${esc(x.id)}" ${st.sel.includes(x.id) ? 'checked' : ''}> ${esc(x.nom)} · ${fmt(x.p_mw)} MW</label>`).join('')}</div>
      <div class="px-row"><button class="btn" data-act="price">Pricer</button>
        <label class="btn ghost small">Importer des scénarios (JSON)<input type="file" accept=".json,application/json" data-act="scen" hidden></label>
        <span class="muted small">${scen ? `${scen.paths.length} trajectoires chargées` : 'Sans scénarios : intrinsèque seul'}</span></div>
      ${(() => {
        const ov = outagesOf(e).filter((v) => v.fin.slice(0, 10) >= st.from && v.debut.slice(0, 10) <= st.to);
        return ov.length ? `<p class="tag warn">Indisponibilités déjà déclarées sur la période : ${ov.slice(0, 3).map((v) => `${esc(v.nom || v.id)} ${dDay.format(Date.parse(v.debut))} → ${dDay.format(Date.parse(v.fin))}`).join(' ; ')}${ov.length > 3 ? '…' : ''}</p>` : '';
      })()}
      <div id="px-out">${lastPrice && lastPrice.id === e.id ? priceResult(e, st, lastPrice.r) : ''}</div>
    </section>`;
  }
  function priceResult(e, st, r) {
    if (r.err) return `<p class="tag warn">${esc(r.err)}</p>`;
    const nuc = r.method === 'deterministic_nuclear_vnu', ms = Object.keys(r.byM);
    const years = [...new Set(ms.map((k) => k.slice(0, 4)))];
    const j = JSON.stringify(exportJson({ asset: e.asset || { id: e.id, nom: e.nom, exploitant: e.u.exploitant }, u: refUnit(e), st: { ...st, units: chosen(e, st) }, r,
      ctx: { params: D.params, FWD: D.FWD, vnu: vnu() }, market: D.market, hourly: st.hourly }), null, 1);
    return `<div class="result">
      <span class="muted small">${CONSTRAINTS[st.c]} · ${fmt(r.Pn)} MW (Pmin ${fmt(r.Pmin)} MW) · ${fmt(r.n)} h · ${nuc ? 'déterministe nucléaire + VNU' : 'intrinsèque horaire'}</span>
      <div class="big">${fmtE(r.cost)}</div>
      <span class="small">${r.cost >= 0 ? 'Coût pour EDF (manque à gagner)' : 'Gain pour EDF'} · ${r.mwh ? fmt(r.cost / r.mwh, 2) : '–'} €/MWh contraint · ${fmt(r.mwh / 1e3, 1)} GWh déplacés · ${fmt(r.itm / r.n * 100)} % d'heures où F > CMg</span>
      ${nuc ? `<p class="small">Avant VNU : ${fmtE(r.costGross)}. Revenu du parc retenu : ${years.map((y) => `${y} ${fmt(parcRev(+y), 1)}`).join(' · ')} €/MWh (seuils ${vnu().s1} / ${vnu().s2}).</p>` : ''}
      ${r.ext ? `<p class="small">${r.ext.n ? `Scénarios (${r.ext.n} trajectoires complètes) : <b>${fmtE(r.ext.mean)}</b> · extrinsèque ${fmtE(r.ext.extrinseque)}` : 'Les scénarios importés ne couvrent pas toute la période.'}</p>` : ''}
    </div>
    ${(() => { const big = Math.max(...ms.map((k) => Math.abs(r.byM[k]))) >= 1e6, d = big ? 1e6 : 1e3;
      return bars(ms.map((k) => ({ k: MOIS[+k.slice(5) - 1].slice(0, 3), v: r.byM[k] / d, color: col(e.u.filiere) })), { unit: `${big ? 'M€' : 'k€'} par mois` }); })()}
    <h3>Export vers Astral / M2F</h3>
    <label class="small"><input type="checkbox" data-px="hourly" ${st.hourly ? 'checked' : ''}> inclure la courbe horaire (F et CMg)</label>
    <pre class="json" tabindex="0">${esc(j)}</pre>
    <div class="px-row"><button class="btn small" data-act="copy-px">Copier le JSON</button></div>`;
  }
  const chosen = (e, st) => pricingUnits(e).filter((x) => st.sel.includes(x.id));
  function runPricing() {
    const e = ent, st = pxState(e);
    const r = priceIt({ ...st, units: chosen(e, st) }, { u: refUnit(e), P: D.params, FWD: D.FWD, vnu: vnu(), parcRev, scen });
    lastPrice = { id: e.id, r };
    emit('price', e);
    render();
  }

  function jsonOf(e) {
    const [h0, h1] = window12();
    const k = kpis(e.u, e.prod, D.price, e.cmg, h0, h1, marg(), D.units);
    const r = (v, d = 2) => (v == null || Number.isNaN(v) ? null : +v.toFixed(d));
    const { s } = simState(e);
    const lastMonth = D.meta.mois[D.meta.mois.length - 1];
    return {
      id: e.id, nom: e.nom, filiere: e.u.filiere, type: e.u.type, exploitant: e.u.exploitant, region: e.asset?.region ?? e.u.region,
      p_mw: e.u.p_mw, geo: e.asset ? [e.asset.lat, e.asset.lon] : null, commune: e.asset?.commune,
      mise_service: e.asset?.mise_service, statut: e.asset?.statut, eic: (e.u.tranche?.eic ? [e.u.tranche.eic] : e.asset?.eic) || undefined,
      groupes_entsoe: e.asset?.groupes_entsoe,
      tranches: e.u.tranche ? undefined : e.units.filter((u) => u.tranche).map((u) => ({ id: u.id, palier: u.palier, p_net_mw: u.p_mw, couplage: u.couplage })),
      tranche: e.u.tranche || undefined,
      cmg_eur_mwh: r(e.cmg, 1), cmg_detail: srmcParts(e.u, D.params).map((p) => ({ [p.k]: r(p.v, 1) })),
      heure_affichee: { t: hourDate(D, hour).toISOString(), production_mw: r(e.prod[hour], 0), prix_spot: r(D.price[hour], 1) },
      kpi_12_mois: Object.fromEntries(Object.entries(k).map(([kk, v]) => [kk, r(v, 3)])),
      simulation: s,
      registre: (e.u.tranche?.registre || e.asset?.registre) ?? undefined,
      indisponibilites: D.indispos ? outagesOf(e).slice(-20) : undefined,
      sources_verifiees: (e.u.tranche?.verif || e.asset?.verif) ?? undefined,
      donnees: { mode: D.meta.mode, production: e.units.every((u) => u.real) ? 'mesurée' : 'modélisée', genere: D.meta.genere },
      fichiers: ['data/assets.json', 'data/edf_tranches.json', 'data/params.json', 'data/meta.json', `data/series/${lastMonth}.json`],
    };
  }

  function tabJson(e) {
    const j = JSON.stringify(jsonOf(e), null, 2);
    const lastMonth = D.meta.mois[D.meta.mois.length - 1];
    return `<section><div class="row"><h3 class="mono">fiche ${esc(e.id)}.json</h3><button class="btn small" data-copy>Copier</button></div>
      <pre class="json" tabindex="0">${esc(j).replace(/&quot;([^&]+)&quot;:/g, '<span class="k">"$1"</span>:')}</pre></section>
      <section><h3>Fichiers sources</h3><ul class="files">
        ${['data/assets.json', 'data/edf_tranches.json', 'data/params.json', 'data/meta.json', `data/series/${lastMonth}.json`, 'data/live.json']
          .map((f) => `<li><a href="${f}" target="_blank" rel="noopener" class="mono">${f}</a></li>`).join('')}
      </ul></section>${membersList(e)}${tranchesList(e)}`;
  }

  function render() {
    if (!ent) return;
    const body = { merit: tabMerit, fwd: tabFwd, price: tabPrice, hedge: tabHedge, valo: tabValo, json: tabJson }[tab](ent);
    const scroll = el.querySelector('.p-body')?.scrollTop || 0;
    el.innerHTML = header(ent) + `<div class="p-body">${body}</div>`;
    el.querySelector('.p-body').scrollTop = scroll;
  }

  // délégation d'événements
  el.addEventListener('click', (ev) => {
    const t = ev.target.closest('button,a');
    if (!t) return;
    if (t.classList.contains('close')) return onClose();
    if (t.dataset.tab) { tab = t.dataset.tab; emit('tab', tab); el.querySelector('.p-body').scrollTop = 0; render(); return; }
    if (t.dataset.pick) return onPick(t.dataset.pick);
    if (t.dataset.year) {
      const s = sim[ent.id], c = D.params.couverture_edf_nucleaire[t.dataset.year];
      Object.assign(s, { annee: t.dataset.year, part: c.part, terme: c.prix });
      render(); return;
    }
    if (t.dataset.act === 'price') return runPricing();
    if (t.dataset.act === 'copy-px') {
      const pre = t.closest('#px-out').querySelector('pre.json');
      navigator.clipboard?.writeText(pre.textContent).then(() => { t.textContent = 'Copié'; }, () => {
        const sel = getSelection(), r = document.createRange(); r.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(r);
      });
      return;
    }
    if (t.hasAttribute('data-copy')) {
      const txt = JSON.stringify(jsonOf(ent), null, 2);
      navigator.clipboard?.writeText(txt).then(() => { t.textContent = 'Copié'; }, () => {
        const sel = getSelection(), r = document.createRange(); r.selectNodeContents(el.querySelector('pre.json')); sel.removeAllRanges(); sel.addRange(r);
      });
    }
  });
  el.addEventListener('change', (ev) => {
    const i = ev.target;
    if (!ent) return;
    if (i.dataset.fwd) { fwdSt[i.dataset.fwd] = i.value; render(); return; }
    if (i.dataset.act === 'scen' && i.files?.[0]) {
      i.files[0].text().then((txt) => {
        try { scen = parseScenarios(JSON.parse(txt), parisLocalToUtc); emit('toast', `${scen.paths.length} trajectoires chargées`); }
        catch (err) { emit('toast', err.message || 'Fichier de scénarios illisible'); }
        render();
      });
      return;
    }
    const st = ent && !ent.fil && px[ent.id];
    if (!st) return;
    if (i.dataset.pxu) { st.sel = i.checked ? [...new Set([...st.sel, i.dataset.pxu])] : st.sel.filter((x) => x !== i.dataset.pxu); return; }
    if (i.dataset.px === 'hourly') { st.hourly = i.checked; render(); return; }
    if (i.dataset.px) {
      st[i.dataset.px] = i.type === 'number' ? +i.value : i.value;
      if (i.dataset.px === 'c') render();
    }
  });
  el.addEventListener('input', (ev) => {
    const i = ev.target;
    if (i.type !== 'range' || !ent) return;
    const s = sim[ent.id], v = +i.value;
    ({ 'h-part': () => { s.part = v; }, 'h-terme': () => { s.terme = v; }, 'h-spot': () => { s.spot = v; }, 'h-lf': () => { s.lf = v; },
      'v-prix': () => { s.prixLT = v; }, 'v-wacc': () => { s.wacc = v; }, 'v-co2': () => { s.co2 = v; } })[i.id]?.();
    emit(i.id.startsWith('h') ? 'hedge' : 'valo');
    cancelAnimationFrame(render.raf);
    render.raf = requestAnimationFrame(() => {
      const id = i.id; render();
      const n = el.querySelector('#' + id); if (n) n.focus({ preventScroll: true });
    });
  });

  return {
    open(id) {
      ent = entity(id);
      el.hidden = false;
      el.classList.add('on');
      document.body.classList.add('panel-open');
      render();
      emit('visit', ent);
    },
    close() { ent = null; el.classList.remove('on'); document.body.classList.remove('panel-open'); setTimeout(() => { if (!ent) el.hidden = true; }, 300); },
    setHour(h) { hour = h; if (ent && tab === 'merit') render(); else if (ent) el.querySelector('.p-now') && (el.querySelector('.p-now').outerHTML = header(ent).match(/<p class="p-now">[\s\S]*?<\/p>/)[0]); },
    refresh() { if (ent) { ent = entity(ent.id); render(); } },
    get current() { return ent?.id; },
  };
}
