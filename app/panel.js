// Fiche actif : 4 onglets (Merit, Couverture, Valo, JSON) et liste des tranches.
import { bars, col, fmt, heatmap as heatSvg, lines, tornadoChart, waterfall } from './charts.js';
import { dcf, heatmap, hedge, kpis, marginalSeries, rankSeries, srmc, srmcParts, tech, tornado } from './finance.js';
import { hourDate } from './data.js';
import { icon } from './icons.js';

const LBL = { nucleaire: 'Nucléaire', hydraulique: 'Hydraulique', gaz: 'Gaz', charbon: 'Charbon', fioul: 'Fioul', eolien: 'Éolien', solaire: 'Solaire', bioenergies: 'Bioénergies' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dShort = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
const dMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'Europe/Paris' });
const dFull = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

export function createPanel(el, D, { onClose, onPick, emit }) {
  let ent = null, tab = 'merit', hour = D.now;
  const sim = {};   // réglages des curseurs, par entité

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
      : [LBL[u.filiere], u.type && u.type !== 'diffus' ? u.type : null, u.palier, `${fmt(u.p_mw)} MW`, u.exploitant, a.region];
    const crumb = u.tranche ? `<button class="crumb" data-pick="${u.mapId}">← ${esc(e.asset?.nom)}</button>`
      : !e.fil ? `<button class="crumb" data-pick="fil-${u.filiere}">← Parc ${esc(LBL[u.filiere].toLowerCase())}</button>` : '';
    const now = e.prod[hour];
    return `<div class="p-head">
      <button class="icon close" aria-label="Fermer la fiche">✕</button>
      ${crumb}
      <div class="p-title">${icon(u.filiere, 34)}<h2>${esc(e.nom)}</h2></div>
      <p class="p-sub mono">${bits.filter(Boolean).map(esc).join(' · ')}</p>
      <p class="p-now"><span>${dFull.format(hourDate(D, hour))}</span> <b>${e.fil ? `${fmt(now / 1000, 1)} GW` : `${fmt(now)} MW`}</b> <span class="muted">soit ${fmt(now / u.p_mw * 100)} % · CMg ${fmt(e.cmg)} €/MWh</span></p>
      ${a.note ? `<p class="muted small">${esc(a.note)}</p>` : ''}
    </div>
    <div class="tabs" role="tablist">${[['merit', 'Merit'], ['hedge', 'Couverture'], ['valo', 'Valo'], ['json', 'JSON']]
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
    return `<section><h3>${title}</h3><p class="muted small">Une seule maquette représente toute la filière. Ouvre un site pour sa fiche détaillée.</p><ul class="tranches members">${items}</ul></section>`;
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

  function jsonOf(e) {
    const [h0, h1] = window12();
    const k = kpis(e.u, e.prod, D.price, e.cmg, h0, h1, marg(), D.units);
    const r = (v, d = 2) => (v == null || Number.isNaN(v) ? null : +v.toFixed(d));
    const { s } = simState(e);
    const lastMonth = D.meta.mois[D.meta.mois.length - 1];
    return {
      id: e.id, nom: e.nom, filiere: e.u.filiere, type: e.u.type, exploitant: e.u.exploitant, region: e.asset?.region ?? e.u.region,
      p_mw: e.u.p_mw, geo: e.asset ? [e.asset.lat, e.asset.lon] : null,
      tranches: e.u.tranche ? undefined : e.units.filter((u) => u.tranche).map((u) => ({ id: u.id, palier: u.palier, p_net_mw: u.p_mw, couplage: u.couplage })),
      tranche: e.u.tranche || undefined,
      cmg_eur_mwh: r(e.cmg, 1), cmg_detail: srmcParts(e.u, D.params).map((p) => ({ [p.k]: r(p.v, 1) })),
      heure_affichee: { t: hourDate(D, hour).toISOString(), production_mw: r(e.prod[hour], 0), prix_spot: r(D.price[hour], 1) },
      kpi_12_mois: Object.fromEntries(Object.entries(k).map(([kk, v]) => [kk, r(v, 3)])),
      simulation: s,
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
    const body = { merit: tabMerit, hedge: tabHedge, valo: tabValo, json: tabJson }[tab](ent);
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
    if (t.hasAttribute('data-copy')) {
      const txt = JSON.stringify(jsonOf(ent), null, 2);
      navigator.clipboard?.writeText(txt).then(() => { t.textContent = 'Copié'; }, () => {
        const sel = getSelection(), r = document.createRange(); r.selectNodeContents(el.querySelector('pre.json')); sel.removeAllRanges(); sel.addRange(r);
      });
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
