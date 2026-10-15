// Point d'entrée : charge les données et relie carte, merit order, fiche, jeu et frise.
import { hourDate, loadAll, recomputeCosts } from './data.js';
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
  const merit = createMerit($('#merit'), D, {
    project: (lon, lat) => scene.project(lon, lat),
    onPick: pick,
    onHover: (u, ev) => {
      if (!u) return showTip(null);
      showTip(`<b>${u.nom}</b>CMg ${fmt(D.cmg[u.idx], 1)} €/MWh · ${fmt(D.prod[u.idx][hour])} / ${fmt(u.p_mw)} MW`, ev.clientX, ev.clientY);
    },
  });
  const panel = createPanel($('#panel'), D, {
    onClose: () => { panel.close(); scene.select(null); merit.select(null); setHash(''); },
    onPick: pick,
    emit: (t, d) => game.event(t, d),
  });

  function pick(id) {
    showTip(null);
    const u = D.unitById[id];
    const mapId = u ? u.mapId : id;
    scene.select(mapId);
    merit.select(id);
    panel.open(id);
    setHash(id);
  }
  function setHash(id) {
    try { history.replaceState(null, '', id ? `#${id}` : location.pathname + location.search); } catch { /* cadre restreint */ }
  }

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
      <p class="muted small">Les réglages s'appliquent à toute l'app (merit order, fiches, jeu) jusqu'au rechargement de la page. Valeurs par défaut : <a href="data/params.json" target="_blank" rel="noopener">data/params.json</a>.</p></div>`;
  }
  $('#hyp').addEventListener('input', (e) => {
    const i = e.target;
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
  function renderAbout() {
    const m = D.meta, s = m.sources || {};
    const line = (k, l) => {
      const v = s[k];
      if (typeof v === 'string') return `<li>${l} : <b>${v}</b></li>`;
      return `<li>${l} : <b>${v?.ok ? (v.source || 'ok') : 'indisponible'}</b>${v?.note ? ` <span class="muted">${v.note}</span>` : ''}</li>`;
    };
    $('#about').innerHTML = `<div class="inner"><div class="d-head"><h2>Sources et méthode</h2><button class="icon close" aria-label="Fermer">✕</button></div>
      ${m.mode === 'demo' ? `<p class="tag warn">Données de démonstration</p><p>${m.note}</p>` : `<p>Données mises à jour le <b>${new Date(m.genere).toLocaleString('fr-FR')}</b>.</p>`}
      <ul class="files">${line('mix', 'Mix national (RTE éCO2mix)')}${line('prix', 'Prix spot day-ahead')}${line('units', 'Production par groupe (RTE)')}</ul>
      <h3>Comment lire l'app</h3>
      <p>Chaque colonne est une centrale. La partie pleine est sa production à l'heure choisie, la partie transparente sa puissance. La frise en bas permet de changer d'heure et de rejouer une journée.</p>
      <p>La vue <b>Merit order</b> range toutes les capacités disponibles par coût marginal croissant. La centrale la plus chère encore en marche est marginale : c'est elle qui fixe le prix dans ce modèle simplifié, qui ignore le couplage avec les pays voisins.</p>
      <h3>Limites</h3>
      <p class="small">Sans les identifiants RTE, la production de chaque centrale est estimée comme une part du mix national de sa filière. Les prix du gaz, du CO2 et les couvertures EDF sont des hypothèses réglables. La valorisation est un ordre de grandeur pédagogique, pas une évaluation financière.</p>
      <h3>Données brutes</h3>
      <ul class="files">${['data/meta.json', 'data/assets.json', 'data/edf_tranches.json', 'data/params.json', 'data/live.json'].map((f) => `<li><a class="mono" href="${f}" target="_blank" rel="noopener">${f}</a></li>`).join('')}</ul>
      ${m.licences ? `<h3>Licences</h3><ul class="files small">${Object.values(m.licences).map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
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
  if (id && (D.unitById[id] || D.byMap[id])) pick(id);
  else if (D.meta.mode === 'demo') toast('Mode démo : données synthétiques en attendant le pipeline');
  addEventListener('hashchange', () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && h !== panel.current && (D.unitById[h] || D.byMap[h])) pick(h);
  });
}

boot();
