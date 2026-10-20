// Point d'entrée : charge les données et relie carte, merit order, fiche, jeu et frise.
import { hourDate, loadAll, rebuildForward, recomputeCosts, saveMarketEdits } from './data.js';
import { createScene, COLORS } from './scene.js';
import { createMerit } from './merit.js';
import { createPanel } from './panel.js';
import { createGame } from './game.js';
import { fmt, stackedArea } from './charts.js';
import { icon } from './icons.js';

const $ = (s) => document.querySelector(s);
const LBL = { nucleaire: 'Nucléaire', hydraulique: 'Hydraulique', gaz: 'Gaz', charbon: 'Charbon', fioul: 'Fioul', eolien: 'Éolien', solaire: 'Solaire', bioenergies: 'Bioénergies' };
const ORDER = ['nucleaire', 'hydraulique', 'eolien', 'solaire', 'gaz', 'bioenergies', 'charbon', 'fioul'];
const TZ = 'Europe/Paris';
const fHour = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const fH = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ });
const localHour = (d) => +fH.formatToParts(d).find((x) => x.type === 'hour').value;

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3300);
}

async function boot() {
  let D;
  try {
    D = await loadAll((p) => { $('#load-bar').style.width = `${Math.round(p * 100)}%`; });
  } catch (e) {
    $('#load-msg').textContent = `Impossible de charger les données : ${e.message}`;
    return;
  }

  let hour = D.now, playTimer = null, filter = new Set(ORDER);

  // ---------------------------------------------------------------- modules
  const tip = $('#tip');
  const showTip = (html, x, y) => {
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html; tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - 270, x + 14)}px`; tip.style.top = `${y + 14}px`;
  };
  const game = createGame($('#game'), D, { stackAt: (h) => merit.stackAt(h), toast });
  let scene;
  try {
    scene = createScene($('#map'), D, { onPick: pick });
  } catch (e) {
    $('#load-msg').textContent = `La maquette 3D ne peut pas s'afficher sur cet appareil (WebGL indisponible) : ${e.message}`;
    return;
  }
  $('#c-in').addEventListener('click', () => scene.zoom(1.35));
  $('#c-out').addEventListener('click', () => scene.zoom(1 / 1.35));
  $('#c-rot').addEventListener('click', () => scene.rotate(Math.PI / 4));
  $('#c-home').addEventListener('click', () => scene.home());
  if (D.grid?.lignes?.length) {
    const b = $('#c-grid');
    b.hidden = false;
    b.title = `Réseau 400 et 225 kV · ${D.grid.source || 'RTE'}`;
    b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); scene.showGrid(on); });
  }
  const merit = createMerit($('#merit'), D, {
    project: (u) => scene.projectFiliere(u.filiere),
    onPick: pick,
    onHover: (u, ev) => {
      if (!u) return showTip(null);
      showTip(`<b>${u.nom}</b>CMg ${fmt(D.cmg[u.idx], 1)} €/MWh · ${fmt(D.prod[u.idx][hour])} / ${fmt(u.p_mw)} MW`, ev.clientX, ev.clientY);
    },
  });
  const panel = createPanel($('#panel'), D, {
    onClose: () => { panel.close(); scene.select(null); merit.select(null); setHash(''); },
    onPick: pick,
    emit: (t, d) => (t === 'toast' ? toast(d) : game.event(t, d)),
  });

  function pick(id) {
    showTip(null);
    const u = D.unitById[id];
    scene.select(id);
    merit.select(id);
    panel.open(id);
    setHash(id);
  }
  function setHash(id) {
    try { history.replaceState(null, '', id ? `#${id}` : location.pathname + location.search); } catch { /* cadre restreint */ }
  }

  // ---------------------------------------------------------------- recherche
  const fold = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const INDEX = [
    ...D.assets.filter((a) => !/agrégat/.test(a.type || '')).map((a) => ({ id: a.id, nom: a.nom, f: a.filiere,
      sub: [a.type, a.commune, a.exploitant].filter(Boolean).join(' · '), key: fold([a.nom, a.id, a.commune, a.region, a.exploitant, a.type, LBL[a.filiere]].join(' ')) })),
    ...D.units.filter((u) => u.tranche).map((u) => ({ id: u.id, nom: u.nom, f: u.filiere, sub: `${u.palier} · ${fmt(u.p_mw)} MW`,
      key: fold([u.nom, u.id, u.palier, 'tranche reacteur'].join(' ')) })),
    ...ORDER.map((f) => ({ id: `fil-${f}`, nom: `Parc ${LBL[f].toLowerCase()}`, f, sub: 'toute la filière', key: fold(`parc ${LBL[f]} filiere`) })),
  ];
  const qIn = $('#q'), qList = $('#q-list');
  let qHits = [], qSel = 0;
  function qRender() {
    const words = fold(qIn.value).split(/\s+/).filter(Boolean);
    qHits = words.length ? INDEX.filter((x) => words.every((w) => x.key.includes(w))).slice(0, 12) : [];
    qSel = Math.min(qSel, Math.max(0, qHits.length - 1));
    qList.hidden = !words.length;
    qIn.setAttribute('aria-expanded', String(!qList.hidden));
    qList.innerHTML = qHits.length ? qHits.map((x, i) => `<li role="option" data-id="${x.id}" aria-selected="${i === qSel}">${icon(x.f, 18)}<b>${x.nom}</b><span>${x.sub}</span></li>`).join('')
      : '<li class="none">Aucun résultat</li>';
  }
  function qGo(id) { qIn.value = ''; qRender(); qIn.blur(); pick(id); }
  qIn.addEventListener('input', () => { qSel = 0; qRender(); });
  qIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); qSel = (qSel + (e.key === 'ArrowDown' ? 1 : -1) + qHits.length) % Math.max(1, qHits.length); qRender(); }
    else if (e.key === 'Enter' && qHits[qSel]) qGo(qHits[qSel].id);
    else if (e.key === 'Escape') { qIn.value = ''; qRender(); qIn.blur(); }
  });
  qList.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-id]'); if (li) { e.preventDefault(); qGo(li.dataset.id); } });
  qIn.addEventListener('blur', () => setTimeout(() => { qList.hidden = true; }, 120));
  addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); qIn.focus(); } });

  // ---------------------------------------------------------------- en-tête
  function renderLive() {
    const L = D.live;
    const demo = D.meta.mode === 'demo';
    const last = L?.points?.[L.points.length - 1];
    const p = L?.prix_dernier;
    const when = last ? fHour.format(new Date(last.t)) : '–';
    $('#live').innerHTML = `${demo ? '<span class="demo">DÉMO</span>' : '<span class="rec" aria-hidden="true"></span><span>LIVE</span>'}
      <span>${when}</span><span>conso ${fmt((last?.consommation ?? NaN) / 1000, 1)} GW</span><span>spot ${fmt(p?.eur_mwh ?? NaN, 1)} €/MWh</span>`;
    $('#live').title = demo ? 'Données de démonstration synthétiques : le pipeline de données ne les a pas encore remplacées.' : `Données générées le ${new Date(D.meta.genere).toLocaleString('fr-FR')}`;
  }
  function renderLevel() {
    $('#lvl').textContent = game.level;
    $('.ring').style.setProperty('--p', game.progress);
  }
  game.on(renderLevel);

  // ---------------------------------------------------------------- filtres
  $('#chips').innerHTML = ORDER.map((f) => `<button class="chip" data-f="${f}" aria-pressed="true" style="--cc:${COLORS[f]}">${icon(f, 20)}${LBL[f]}</button>`).join('');
  $('#chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    const f = b.dataset.f;
    if (filter.size === ORDER.length) filter = new Set([f]);           // premier clic : isoler la filière
    else if (filter.has(f)) filter.delete(f); else filter.add(f);
    if (!filter.size) filter = new Set(ORDER);
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', filter.has(c.dataset.f)));
    scene.setFilter(filter.size === ORDER.length ? null : filter);
  });

  // ---------------------------------------------------------------- mix à l'heure choisie
  function renderMix() {
    const vals = ORDER.map((f) => [f, Math.max(0, D.mix[f][hour] || 0)]);
    const max = Math.max(...vals.map((v) => v[1]), 1);
    $('#mix').innerHTML = `<h3>Production · ${fHour.format(hourDate(D, hour))}</h3><ul>${vals.map(([f, v]) =>
      `<li><span>${icon(f, 16)}${LBL[f]}</span><i style="width:${Math.max(2, v / max * 100)}%;background:${COLORS[f]}"></i><b>${fmt(v / 1000, 1)}</b></li>`).join('')}</ul>
      <div class="kv"><span>Spot</span><b>${fmt(D.price[hour], 1)} €/MWh</b></div>
      <div class="kv"><span>Consommation</span><b>${fmt(D.mix.consommation[hour] / 1000, 1)} GW</b></div>`;
  }

  // ---------------------------------------------------------------- frise
  const dayStart = (h) => h - localHour(hourDate(D, h));
  function renderTimeline() {
    const s = dayStart(hour);
    $('#d-label').textContent = fDay.format(hourDate(D, s + 12));
    $('#h-label').textContent = `${fHour.format(hourDate(D, hour))} · ${fmt(D.price[hour], 1)} €`;
    $('#hour').value = hour - s;
    $('#hour').max = 23;
    const n = Math.max(1, Math.min(24, D.now - s + 1));
    const layers = ORDER.map((f) => ({ color: COLORS[f], v: Array.from({ length: n }, (_, i) => D.mix[f][s + i]) }));
    $('#tl-area').innerHTML = stackedArea(layers, { max: 95000, slots: 24 });
    $('#d-next').disabled = s + 24 > D.now;
  }
  function setHour(h, { fromPlay = false } = {}) {
    hour = Math.max(0, Math.min(D.now, h));
    scene.setHour(hour); merit.setHour(hour); panel.setHour(hour);
    renderMix(); renderTimeline();
    if (!fromPlay) stop();
  }
  $('#hour').addEventListener('input', (e) => setHour(dayStart(hour) + +e.target.value));
  $('#d-prev').addEventListener('click', () => setHour(hour - 24));
  $('#d-next').addEventListener('click', () => setHour(hour + 24));
  $('#d-now').addEventListener('click', () => setHour(D.now));
  function stop() { if (playTimer) { clearInterval(playTimer); playTimer = null; $('#play').classList.remove('on'); $('#play').textContent = '▶'; } }
  $('#play').addEventListener('click', () => {
    if (playTimer) return stop();
    if (hour >= D.now) hour = dayStart(D.now) - 24;
    $('#play').classList.add('on'); $('#play').textContent = '❚❚';
    game.event('play');
    playTimer = setInterval(() => {
      if (hour >= D.now) return stop();
      setHour(hour + 1, { fromPlay: true });
    }, 650);
  });

  // ---------------------------------------------------------------- vues
  function setView(v) {
    $('#v-map').setAttribute('aria-pressed', v === 'map');
    $('#v-merit').setAttribute('aria-pressed', v === 'merit');
    document.body.classList.toggle('merit-open', v === 'merit');
    if (v === 'merit') { merit.show(hour); game.event('merit'); } else merit.hide();
  }
  $('#v-map').addEventListener('click', () => setView('map'));
  $('#v-merit').addEventListener('click', () => setView('merit'));
  addEventListener('resize', () => { merit.relayout(); });

  // ---------------------------------------------------------------- tiroirs
  const drawers = ['#game', '#hyp', '#about'];
  function openDrawer(sel) {
    for (const d of drawers) if (d !== sel) closeDrawer(d);
    const el = $(sel);
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('on'));
  }
  function closeDrawer(sel) {
    const el = $(sel);
    if (el.hidden) return;
    el.classList.remove('on');
    setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 350);
  }
  $('#b-game').addEventListener('click', () => { game.render(); openDrawer('#game'); });
  $('#game').addEventListener('close', () => closeDrawer('#game'));
  $('#b-hyp').addEventListener('click', () => { renderHyp(); openDrawer('#hyp'); });
  $('#b-about').addEventListener('click', () => { renderAbout(); openDrawer('#about'); });
  for (const sel of ['#hyp', '#about']) {
    $(sel).addEventListener('click', (e) => { if (e.target.closest('.close')) closeDrawer(sel); });
  }
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawers.some((d) => !$(d).hidden)) drawers.forEach(closeDrawer);
    else if (panel.current) panel.close();
    else if (merit.open) setView('map');
  });

  // ---------------------------------------------------------------- hypothèses
  const HYP = [
    ['gaz_ttf_eur_mwh', 'Gaz TTF', 5, 120, 1, '€/MWh'],
    ['co2_eua_eur_t', 'CO2 (EUA)', 0, 250, 1, '€/t'],
    ['charbon_eur_mwh_th', 'Charbon', 3, 40, 0.5, '€/MWh th'],
    ['fioul_eur_mwh_th', 'Fioul', 20, 120, 1, '€/MWh th'],
  ];
  function renderHyp() {
    const c = D.params.combustibles, t = D.params.technos;
    $('#hyp').innerHTML = `<div class="inner"><div class="d-head"><h2>Hypothèses</h2><button class="icon close" aria-label="Fermer">✕</button></div>
      <p class="muted small">${c._statut}</p>
      <div class="hyp-group">${HYP.map(([k, l, mn, mx, st, u]) => `<label class="sl"><span>${l}</span><input type="range" id="hy-${k}" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${c[k]}"><output>${fmt(c[k], st < 1 ? 1 : 0)} ${u}</output></label>`).join('')}
      <label class="sl"><span>Valeur de l'eau (lacs)</span><input type="range" id="hy-lac" data-t="hydraulique:lac" min="0" max="200" step="1" value="${t['hydraulique:lac'].valeur_eau}"><output>${t['hydraulique:lac'].valeur_eau} €/MWh</output></label>
      <label class="sl"><span>Valeur de l'eau (STEP)</span><input type="range" id="hy-step" data-t="hydraulique:STEP" min="0" max="250" step="1" value="${t['hydraulique:STEP'].valeur_eau}"><output>${t['hydraulique:STEP'].valeur_eau} €/MWh</output></label>
      <label class="sl"><span>Coût variable nucléaire</span><input type="range" id="hy-nuc" data-t="nucleaire" min="0" max="40" step="1" value="${t.nucleaire.cmg_fixe}"><output>${t.nucleaire.cmg_fixe} €/MWh</output></label></div>
      <h3>Coûts marginaux qui en découlent</h3>
      <ul class="qmix">${[['gaz-MAR', 'CCG (Martigues)'], ['cha-COR', 'Charbon (Cordemais)'], ['fio-VAI', 'TAC fioul (Vaires)'], ['TRI1', 'Nucléaire']].map(([id, l]) => {
        const u = D.unitById[id]; return u ? `<li>${l}<b class="mono">${fmt(D.cmg[u.idx], 1)} €/MWh</b></li>` : '';
      }).join('')}</ul>
      <p class="muted small">Les réglages s'appliquent à toute l'app (merit order, fiches, jeu) jusqu'au rechargement de la page. Valeurs par défaut : <a href="data/params.json" target="_blank" rel="noopener">data/params.json</a>.</p>
      <h3>Produits forward <span class="muted">${D.market.asof.split('-').reverse().join('/')}</span></h3>
      <p class="muted small">${D.market._source} Laisser vide = proxy spot 30 j. Gardé dans ce navigateur.</p>
      <table class="rel small mkt"><thead><tr><th>Produit</th><th>Base</th><th>Pointe</th></tr></thead><tbody>
      ${Object.entries(D.market.electricite).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `<tr><td><b>${k}</b></td>
        <td><input type="number" step="0.01" data-mk="${k}" data-f="base" value="${v.base ?? ''}" placeholder="${k.endsWith('-26') ? fmt(D.FWD.m30, 1) : ''}"></td>
        <td><input type="number" step="0.01" data-mk="${k}" data-f="pointe" value="${v.pointe ?? ''}"></td></tr>`).join('')}
      </tbody></table>
      <h3>Revenu du parc nucléaire (VNU)</h3>
      <div class="form3">${Object.entries(D.market.revenu_parc_nucleaire).filter(([k]) => !k.startsWith('_')).map(([y, v]) => `<label>${y}<input type="number" step="0.1" data-rev="${y}" value="${v ?? ''}" placeholder="Cal ${fmt(D.FWD.pw['Cal-' + y.slice(2)]?.b, 1)}"></label>`).join('')}</div>
      <p class="muted small">${D.market.revenu_parc_nucleaire._doc}</p>
      <div class="px-row"><button class="btn small" data-mk-reset>Revenir aux valeurs publiées</button></div></div>`;
  }
  $('#hyp').addEventListener('change', (e) => {
    const i = e.target, val = i.value === '' ? null : +i.value;
    if (i.dataset.mk) D.market.electricite[i.dataset.mk][i.dataset.f] = val;
    else if (i.dataset.rev) D.market.revenu_parc_nucleaire[i.dataset.rev] = val;
    else return;
    saveMarketEdits(D); rebuildForward(D); panel.refresh();
    toast('Courbe forward recalculée');
  });
  $('#hyp').addEventListener('click', (e) => {
    if (!e.target.closest('[data-mk-reset]')) return;
    try { localStorage.removeItem('parc3d.market.v1'); } catch { /* ignoré */ }
    location.reload();
  });
  $('#hyp').addEventListener('input', (e) => {
    const i = e.target;
    if (i.type !== 'range') return;
    if (i.dataset.k) D.params.combustibles[i.dataset.k] = +i.value;
    else if (i.dataset.t === 'nucleaire') D.params.technos.nucleaire.cmg_fixe = +i.value;
    else if (i.dataset.t) D.params.technos[i.dataset.t].valeur_eau = +i.value;
    recomputeCosts(D);
    const id = i.id;
    renderHyp();
    $('#' + id)?.focus({ preventScroll: true });
    merit.relayout(); panel.refresh();
  });

  // ---------------------------------------------------------------- sources
  /** Tableau de fiabilité : source, date et niveau de confiance de chaque famille de données. */
  function reliability() {
    const s = D.meta.sources || {}, P = D.params, A = D.assets;
    const listed = D.units.filter((u) => u.mapId);
    const measured = listed.filter((u) => u.real);
    const pMeas = measured.reduce((t, u) => t + u.p_mw, 0), pAll = listed.reduce((t, u) => t + u.p_mw, 0);
    const offi = A.filter((a) => /^ENTSO-E|somme des tranches|ODRÉ/.test(a.verif?.puissance || '')).length;
    const sites = A.filter((a) => !/agrégat/.test(a.type || '')), com = sites.filter((a) => a.commune).length;
    const src = s.units?.source === 'entsoe' ? 'ENTSO-E 16.1.A' : s.units?.source === 'rte' ? 'RTE Data' : null;
    const rows = [
      ['Mix national par filière', 'RTE éCO2mix (ODRÉ), temps réel puis consolidé', s.mix?.ok ? 'mesuré' : 'indisponible', s.mix?.ok ? 3 : 0],
      ['Prix spot day-ahead', s.prix?.source === 'entsoe' ? 'ENTSO-E Transparency' : (s.prix?.source || '—'), s.prix?.ok ? 'mesuré' : 'indisponible', s.prix?.ok ? 3 : 0],
      ['Production par centrale', src ? `${src}, groupes ≥ 100 MW` : 'part du mix de la filière',
        src ? `mesurée pour ${measured.length} centrales et tranches (${fmt(pMeas / Math.max(pAll, 1) * 100)} % de la puissance listée)` : 'modélisée', src ? (pMeas / pAll > 0.6 ? 3 : 2) : 1],
      ['Puissance des centrales', 'ENTSO-E 14.1.B (par unité) ; ODRÉ pour les agrégats régionaux', `${offi} / ${A.length} actifs sur source officielle`, 3],
      ['Tranches nucléaires', 'ENTSO-E 14.1.B ; couplage WNA / IAEA PRIS', `${D.units.filter((u) => u.tranche).length} réacteurs`, 3],
      ['Commune d\'implantation', 'Registre national des installations (ODRÉ)', `${com} / ${sites.length} sites`, 3],
      ['Position sur la carte', 'relevée à la main, recoupée avec le centre de la commune (geo.api.gouv.fr)',
        `${A.filter((a) => /km du centre/.test(a.verif?.coordonnees || '')).length} sites à moins de 15 km ; agrégats régionaux placés au centre de la région`, 2],
      ['Parc national installé', P.capacite_nationale_mw?._statut || 'ODRÉ', 'officiel, fin 2025', 3],
      ['Combustibles et CO2', P.combustibles?._statut || '', 'niveau de marché daté, réglable', 2],
      ['Mécanisme VNU', P.vnu?._source || 'loi de finances 2025, CRE', 'texte officiel', 3],
      ['Revenu nucléaire EDF', P.couverture_edf_nucleaire?._source?.split('http')[0] || 'CRE', 'estimation CRE ; part couverte = hypothèse', 2],
      ['Rendements, valeurs de l\'eau, coûts fixes', 'ordres de grandeur (GIEC pour les facteurs CO2)', 'hypothèse', 1],
      ['Produits forward (Cal, Q)', D.market._source.split('.')[0], `${Object.values(D.market.electricite).filter((v) => v?.base != null).length} produits cotés au ${D.market.asof.split('-').reverse().join('/')}`, 2],
      ['Nov. et déc. 2026', 'pas de cotation relevée', `proxy : spot moyen des 30 derniers jours (${fmt(D.FWD.m30, 1)} €/MWh)`, 1],
      ['Courbe horaire (HPFC)', 'forme estimée sur le spot réel, calage exact sur chaque produit', 'modèle ; heure de Paris', 2],
      ['Pricing des contraintes', 'intrinsèque (thermique) ; déterministe + VNU (nucléaire)', 'sans démarrages ni durées minimales : Astral / M2F', 1],
    ];
    const lvl = ['indisponible', 'hypothèse', 'estimé', 'officiel'], cls = ['off', 'off', 'mod', 'ok'];
    return `<table class="rel small"><thead><tr><th>Donnée</th><th>Source</th><th>Fiabilité</th></tr></thead><tbody>${rows.map(([k, src, note, n]) =>
      `<tr><td><b>${k}</b></td><td>${src}</td><td><i class="st ${cls[n]}"></i>${lvl[n]}<br><span class="muted">${note}</span></td></tr>`).join('')}</tbody></table>`;
  }

  function renderAbout() {
    const m = D.meta, s = m.sources || {};
    const line = (k, l) => {
      const v = s[k];
      if (typeof v === 'string') return `<li>${l} : <b>${v}</b></li>`;
      return `<li>${l} : <b>${v?.ok ? (v.source || 'ok') : 'indisponible'}</b>${v?.note ? ` <span class="muted">${v.note}</span>` : ''}</li>`;
    };
    $('#about').innerHTML = `<div class="inner"><div class="d-head"><h2>Sources et méthode</h2><button class="icon close" aria-label="Fermer">✕</button></div>
      ${m.mode === 'demo' ? `<p class="tag warn">Données de démonstration</p><p>${m.note}</p>` : `<p>Données mises à jour le <b>${new Date(m.genere).toLocaleString('fr-FR')}</b>.</p>`}
      <ul class="files">${line('mix', 'Mix national (RTE éCO2mix)')}${line('prix', 'Prix spot day-ahead')}${line('units', 'Production par groupe (RTE ou ENTSO-E)')}</ul>
      <h3>Fiabilité des données</h3>${reliability()}
      <h3>Comment lire l'app</h3>
      <p>Chaque colonne est une centrale. La partie pleine est sa production à l'heure choisie, la partie transparente sa puissance. La frise en bas permet de changer d'heure et de rejouer une journée.</p>
      <p>La vue <b>Merit order</b> range toutes les capacités disponibles par coût marginal croissant. La centrale la plus chère encore en marche est marginale : c'est elle qui fixe le prix dans ce modèle simplifié, qui ignore le couplage avec les pays voisins.</p>
      <h3>Limites</h3>
      <p class="small">Quand un groupe n'est pas publié heure par heure (moins de 100 MW, ou donnée manquante), sa production est estimée comme une part du mix national de sa filière. Les prix du gaz, du CO2 et la part couverte d'EDF sont des hypothèses réglables. La valorisation est un ordre de grandeur pédagogique, pas une évaluation financière.</p>
      <h3>Données brutes</h3>
      <ul class="files">${['data/meta.json', 'data/assets.json', 'data/edf_tranches.json', 'data/params.json', 'data/market.json', 'data/live.json'].map((f) => `<li><a class="mono" href="${f}" target="_blank" rel="noopener">${f}</a></li>`).join('')}</ul>
      ${m.licences ? `<h3>Licences</h3><ul class="files small">${Object.values(m.licences).map((l) => `<li>${l}</li>`).join('')}${D.grid?.source ? `<li>Réseau haute tension : ${D.grid.source}</li>` : ''}</ul>` : ''}
      <p class="small muted">Fond de carte : régions IGN / INSEE (Licence Ouverte). Code : <a href="https://github.com/fabienfouville/actif-edf-3d" target="_blank" rel="noopener">github.com/fabienfouville/actif-edf-3d</a></p></div>`;
  }

  // ---------------------------------------------------------------- démarrage
  renderLive(); renderLevel(); renderMix(); renderTimeline();
  await scene.ready;
  scene.setHour(hour);
  game.resolveBets();
  $('#loader').classList.add('done');
  setTimeout(() => $('#loader').remove(), 600);
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && (D.unitById[id] || D.byMap[id] || D.byFil[id.replace(/^fil-/, '')])) pick(id);
  else if (D.meta.mode === 'demo') toast('Mode démo : données synthétiques en attendant le pipeline');
  addEventListener('hashchange', () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && h !== panel.current && (D.unitById[h] || D.byMap[h] || D.byFil[h.replace(/^fil-/, '')])) pick(h);
  });
}

boot();
