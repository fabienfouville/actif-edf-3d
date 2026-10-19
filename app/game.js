// Couche de jeu : XP, niveaux, badges, missions du jour, quiz, dispatcher, pari sur le prix.
// L'état reste dans le navigateur (localStorage), rien n'est envoyé.
import { fmt } from './charts.js';
import { hourDate } from './data.js';
import { isFatal } from './finance.js';

const KEY = 'parc3d-jeu-v1';
const LBL = { nucleaire: 'Nucléaire', hydraulique: 'Hydraulique', gaz: 'Gaz', charbon: 'Charbon', fioul: 'Fioul', eolien: 'Éolien', solaire: 'Solaire', bioenergies: 'Bioénergies' };
const today = () => new Date().toISOString().slice(0, 10);

const BADGES = [
  { id: 'tour', nom: 'Tour de France nucléaire', desc: 'Ouvrir les 18 sites nucléaires.' },
  { id: 'hydro', nom: 'Hydraulicien', desc: 'Ouvrir 5 barrages ou STEP.' },
  { id: 'epr', nom: 'Fan d\'EPR', desc: 'Ouvrir la tranche Flamanville 3.' },
  { id: 'trader', nom: 'Trader', desc: 'Basculer 5 fois en vue merit order.' },
  { id: 'couvreur', nom: 'Couvreur', desc: 'Jouer avec le simulateur de couverture.' },
  { id: 'analyste', nom: 'Analyste', desc: 'Ouvrir l\'onglet JSON d\'un actif.' },
  { id: 'oracle', nom: 'Oracle', desc: 'Prédire un prix spot à 10 €/MWh près.' },
  { id: 'dispatcher', nom: 'Dispatcher', desc: 'Faire 90 points ou plus au dispatcher.' },
  { id: 'quiz5', nom: 'Œil du marché', desc: '5 bonnes réponses au quiz.' },
  { id: 'atomiste', nom: 'Atomiste', desc: 'Pricer une contrainte sur une tranche nucléaire.' },
  { id: 'pricer', nom: 'Pricer', desc: 'Pricer 3 centrales différentes.' },
];
const MISSIONS = [
  { id: 'm-nuc3', txt: 'Ouvre 3 sites nucléaires', test: (s) => s.day.nuc >= 3, xp: 60 },
  { id: 'm-merit', txt: 'Passe en vue merit order', test: (s) => s.day.merit >= 1, xp: 40 },
  { id: 'm-quiz', txt: 'Trouve qui fixe le prix (quiz)', test: (s) => s.day.quizOk >= 1, xp: 80 },
  { id: 'm-disp', txt: 'Joue une partie de dispatcher', test: (s) => s.day.disp >= 1, xp: 80 },
  { id: 'm-hedge', txt: 'Simule la couverture d\'un actif', test: (s) => s.day.hedge >= 1, xp: 50 },
  { id: 'm-json', txt: 'Ouvre le JSON d\'une fiche', test: (s) => s.day.json >= 1, xp: 30 },
  { id: 'm-replay', txt: 'Rejoue une journée avec ▶', test: (s) => s.day.play >= 1, xp: 40 },
  { id: 'm-pari', txt: 'Parie sur le prix de demain 19 h', test: (s) => s.day.bet >= 1, xp: 40 },
  { id: 'm-ren', txt: 'Ouvre un parc éolien en mer', test: (s) => s.day.offshore >= 1, xp: 40 },
  { id: 'm-price', txt: 'Price une contrainte (interruption, Pmin, Pmax)', test: (s) => s.day.price >= 1, xp: 60 },
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

export function createGame(el, D, { stackAt, toast }) {
  let s = load() || { xp: 0, visited: [], badges: [], quizOk: 0, trader: 0, bets: [], best: 0 };
  if (s.dayKey !== today()) { s.dayKey = today(); s.day = { nuc: 0, merit: 0, quizOk: 0, disp: 0, hedge: 0, json: 0, play: 0, bet: 0, offshore: 0, done: [] }; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ } };
  const level = () => Math.floor(Math.sqrt(s.xp / 60)) + 1;
  const nextXp = (l) => 60 * l * l;
  const listeners = new Set();

  // missions du jour : 3 tirées selon la date
  const seed = [...today()].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const missions = [...MISSIONS].sort((a, b) => ((seed ^ a.id.length * 97 ^ a.id.charCodeAt(2)) % 13) - ((seed ^ b.id.length * 97 ^ b.id.charCodeAt(2)) % 13)).slice(0, 3);

  function gain(n, why) {
    const before = level();
    s.xp += n;
    toast(`+${n} XP · ${why}`);
    if (level() > before) toast(`Niveau ${level()} atteint`, 'big');
    save(); listeners.forEach((f) => f());
  }
  function badge(id) {
    if (s.badges.includes(id)) return;
    s.badges.push(id);
    const b = BADGES.find((x) => x.id === id);
    toast(`Badge débloqué : ${b.nom}`, 'big');
    gain(100, 'badge');
  }
  function checkMissions() {
    for (const m of missions) {
      if (!s.day.done.includes(m.id) && m.test(s)) { s.day.done.push(m.id); gain(m.xp, `mission « ${m.txt} »`); }
    }
  }
  function resolveBets() {
    for (const b of s.bets) {
      if (b.ok != null) continue;
      const h = Math.round((Date.parse(b.t) - D.t0) / 3600e3);
      const p = D.price[h];
      if (h >= 0 && h < D.H && !Number.isNaN(p)) {
        b.real = p; b.ok = Math.abs(p - b.guess) <= 10;
        const err = Math.abs(p - b.guess);
        gain(Math.max(10, Math.round(120 - err * 4)), `pari : ${fmt(b.guess)} € contre ${fmt(p, 1)} € réels`);
        if (b.ok) badge('oracle');
      }
    }
    save();
  }

  const api = {
    on(f) { listeners.add(f); },
    get level() { return level(); },
    get progress() { const l = level(); return (s.xp - nextXp(l - 1)) / (nextXp(l) - nextXp(l - 1)); },
    get xp() { return s.xp; },
    event(type, data) {
      if (type === 'visit') {
        const e = data;
        const key = e.id;
        const fresh = !s.visited.includes(key);
        if (fresh) { s.visited.push(key); gain(10, `découverte de ${e.nom}`); }
        if (e.u.filiere === 'nucleaire' && !e.u.tranche) s.day.nuc++;
        if (e.u.type === 'offshore') s.day.offshore++;
        const nucSites = D.assets.filter((a) => a.filiere === 'nucleaire').map((a) => a.id);
        if (nucSites.every((id) => s.visited.includes(id))) badge('tour');
        if (s.visited.filter((id) => id.startsWith('hyd-')).length >= 5) badge('hydro');
        if (key === 'FLA3') badge('epr');
      } else if (type === 'merit') { s.trader++; s.day.merit++; if (s.trader >= 5) badge('trader'); }
      else if (type === 'tab' && data === 'json') { s.day.json++; badge('analyste'); }
      else if (type === 'hedge') { if (!s.day.hedge++) badge('couvreur'); }
      else if (type === 'play') s.day.play++;
      else if (type === 'price') {
        const e = data; s.priced = s.priced || [];
        s.day.price = (s.day.price || 0) + 1;
        if (!s.priced.includes(e.id)) { s.priced.push(e.id); gain(30, `dossier pricé : ${e.nom}`); }
        if (e.u.filiere === 'nucleaire') badge('atomiste');
        if (s.priced.length >= 3) badge('pricer');
      }
      checkMissions(); save(); listeners.forEach((f) => f());
    },
    resolveBets,
    render,
  };

  // ------------------------------------------------------------ rendu du panneau de jeu
  let mode = 'home', quiz = null, disp = null;

  function render() {
    const l = level();
    const head = `<div class="g-head"><button class="icon close" aria-label="Fermer">✕</button>
      <div class="g-level"><span class="lvl">${l}</span><div><b>Dispatcher · niveau ${l}</b>
      <div class="xpbar"><i style="width:${Math.round(api.progress * 100)}%"></i></div><small class="mono">${fmt(s.xp)} / ${fmt(nextXp(l))} XP</small></div></div>
      <div class="seg">${[['home', 'Missions'], ['quiz', 'Quiz'], ['disp', 'Dispatcher'], ['bet', 'Pari']].map(([k, t]) => `<button data-mode="${k}" aria-pressed="${mode === k}">${t}</button>`).join('')}</div></div>`;
    const body = { home: renderHome, quiz: renderQuiz, disp: renderDisp, bet: renderBet }[mode]();
    el.innerHTML = head + `<div class="g-body">${body}</div>`;
  }

  function renderHome() {
    return `<h3>Missions du jour</h3><ul class="missions">${missions.map((m) => `<li class="${s.day.done.includes(m.id) ? 'done' : ''}"><i></i><span>${m.txt}</span><b class="mono">+${m.xp}</b></li>`).join('')}</ul>
      <h3>Badges <span class="muted">${s.badges.length} / ${BADGES.length}</span></h3>
      <ul class="badges">${BADGES.map((b) => `<li class="${s.badges.includes(b.id) ? 'got' : ''}"><b>${b.nom}</b><span>${b.desc}</span></li>`).join('')}</ul>
      <p class="muted small">Ta progression reste dans ce navigateur.</p>`;
  }

  // Quiz : à une heure tirée au hasard, quelle filière fixe le prix d'après le modèle ?
  function newQuiz() {
    const h = Math.max(0, D.now - Math.floor(Math.random() * 24 * 300));
    const S = stackAt(h);
    const ans = S.marginal ? S.marginal.u.filiere : 'solaire';
    const pool = ['nucleaire', 'hydraulique', 'gaz', 'charbon', 'fioul', 'eolien'];
    const opts = [ans, ...pool.filter((f) => f !== ans).sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5);
    const mix = ['nucleaire', 'hydraulique', 'eolien', 'solaire', 'gaz'].map((f) => [f, D.mix[f][h]]);
    quiz = { h, ans, opts, mix, price: D.price[h], S, picked: null };
  }
  function renderQuiz() {
    if (!quiz) newQuiz();
    const q = quiz, d = hourDate(D, q.h);
    const when = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(d);
    return `<h3>Qui fixe le prix ?</h3><p>${when}. Production et prix spot réel :</p>
      <ul class="qmix">${q.mix.map(([f, v]) => `<li><i class="dot" style="background:var(--c-${f})"></i>${LBL[f]} <b class="mono">${fmt(v / 1000, 1)} GW</b></li>`).join('')}
      <li>Prix spot <b class="mono">${fmt(q.price, 1)} €/MWh</b></li></ul>
      <p>D'après le merit order, quelle filière est marginale ?</p>
      <div class="qopts">${q.opts.map((f) => `<button data-ans="${f}" class="${q.picked ? (f === q.ans ? 'right' : f === q.picked ? 'wrong' : '') : ''}" ${q.picked ? 'disabled' : ''}>${LBL[f]}</button>`).join('')}</div>
      ${q.picked ? `<p>${q.picked === q.ans ? 'Bien vu.' : 'Raté.'} Le modèle place <b>${q.S.marginal?.u.nom || '–'}</b> en marginal, à ${fmt(q.S.priceModel, 1)} €/MWh.</p><button class="btn" data-next>Question suivante</button>` : ''}
      <p class="muted small">Le modèle empile les capacités françaises par coût marginal, sans couplage européen : il peut se tromper quand les imports fixent le prix.</p>`;
  }

  // Dispatcher : couvrir la demande résiduelle au moindre coût avec des blocs pilotables.
  function newDisp() {
    const h = Math.max(0, D.now - Math.floor(Math.random() * 24 * 120));
    const S = stackAt(h);
    const fixed = (r) => r.cmg <= 15 || isFatal(r.u);
    const must = S.rows.filter(fixed).reduce((a, r) => a + r.prod, 0);
    const need = Math.max(2000, Math.round((S.demand - must) / 100) * 100);
    const groups = {};
    for (const r of S.rows) {
      if (fixed(r) || r.cap <= 0) continue;
      const k = `${r.u.filiere}:${r.u.type === 'STEP' ? 'STEP' : r.u.type === 'lac' ? 'lac' : r.u.diffus ? 'diffus' : 'centrales'}`;
      const g = groups[k] || (groups[k] = { k, f: r.u.filiere, cap: 0, cost: 0, n: 0 });
      g.cap += r.cap; g.cost += r.cmg * r.cap; g.n++;
    }
    const cards = Object.values(groups).map((g) => ({ ...g, cmg: g.cost / g.cap, on: false }));
    cards.push({ k: 'import', f: 'import', cap: 6000, cmg: 60 + Math.round(Math.random() * 90), on: false });
    cards.push({ k: 'effacement', f: 'effacement', cap: 1500, cmg: 180, on: false });
    cards.sort((a, b) => a.cmg - b.cmg);
    disp = { h, need, cards, done: false };
  }
  const cardName = (c) => ({ import: 'Importations', effacement: 'Effacement de consommation' }[c.k] ||
    `${LBL[c.f]} ${c.k.split(':')[1] === 'centrales' ? '' : c.k.split(':')[1]}`.trim());
  function dispCost(cards, need) {
    let left = need, cost = 0, price = 0;
    for (const c of [...cards].filter((x) => x.on).sort((a, b) => a.cmg - b.cmg)) {
      const take = Math.min(c.cap, left);
      if (take <= 0) break;
      cost += take * c.cmg; left -= take; price = c.cmg;
    }
    return { cost, left, price };
  }
  function renderDisp() {
    if (!disp) newDisp();
    const d = disp, r = dispCost(d.cards, d.need);
    const opt = dispCost(d.cards.map((c) => ({ ...c, on: true })), d.need);
    const score = r.left > 0 ? 0 : Math.round(opt.cost / r.cost * 100);
    const when = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(hourDate(D, d.h));
    return `<h3>Dispatcher · ${when}</h3>
      <p>Le nucléaire, les renouvelables et le fil de l'eau sont déjà en route. Il manque <b class="mono">${fmt(d.need / 1000, 1)} GW</b>. Démarre les moyens nécessaires au moindre coût.</p>
      <div class="cards">${d.cards.map((c, i) => `<button class="card ${c.on ? 'on' : ''}" data-card="${i}" ${d.done ? 'disabled' : ''} style="--cc:var(--c-${c.f}, #8aa0c0)">
        <b>${cardName(c)}</b><span class="mono big">${fmt(c.cap / 1000, 1)} GW</span><span class="mono">${fmt(c.cmg)} €/MWh</span></button>`).join('')}</div>
      <p class="mono">${r.left > 0 ? `Encore ${fmt(r.left / 1000, 1)} GW à trouver` : `Demande couverte · prix de marché ${fmt(r.price)} €/MWh · coût ${fmt(r.cost / 1e3)} k€/h`}</p>
      ${d.done ? `<p><b>Score ${score} / 100.</b> L'optimum (merit order) coûte ${fmt(opt.cost / 1e3)} k€/h avec un prix de ${fmt(opt.price)} €/MWh.</p><button class="btn" data-newdisp>Nouvelle partie</button>`
        : `<button class="btn" data-validate ${r.left > 0 ? 'disabled' : ''}>Valider</button>`}`;
  }

  function renderBet() {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const ds = tomorrow.toISOString().slice(0, 10);
    const target = new Date(`${ds}T17:00:00Z`); // 19 h heure d'été, 18 h l'hiver : on vise 17 h UTC
    const have = s.bets.find((b) => b.t === target.toISOString());
    return `<h3>Parie sur le prix spot de demain, 17 h UTC</h3>
      <p class="muted small">Le pari est vérifié dès que le prix est dans les données. Plus tu es près, plus tu gagnes d'XP.</p>
      ${have ? `<p>Ton pari : <b class="mono">${fmt(have.guess)} €/MWh</b>.</p>` : `<label class="sl"><span>Ton estimation</span><input id="bet" type="number" inputmode="decimal" value="${Math.round(D.price[D.now] || 60)}"> <span>€/MWh</span></label><button class="btn" data-bet="${target.toISOString()}">Parier</button>`}
      <h3>Historique</h3><ul class="bets">${s.bets.slice(-8).reverse().map((b) => `<li class="mono">${b.t.slice(0, 10)} · pari ${fmt(b.guess)} € · ${b.real == null ? 'en attente' : `réel ${fmt(b.real, 1)} €`}</li>`).join('') || '<li class="muted">Aucun pari.</li>'}</ul>`;
  }

  el.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.classList.contains('close')) { el.dispatchEvent(new CustomEvent('close')); return; }
    if (t.dataset.mode) { mode = t.dataset.mode; render(); return; }
    if (t.dataset.ans && quiz && !quiz.picked) {
      quiz.picked = t.dataset.ans;
      if (quiz.picked === quiz.ans) { s.quizOk++; s.day.quizOk++; gain(30, 'bonne réponse'); if (s.quizOk >= 5) badge('quiz5'); }
      checkMissions(); save(); render(); return;
    }
    if (t.hasAttribute('data-next')) { newQuiz(); render(); return; }
    if (t.dataset.card != null) { const c = disp.cards[+t.dataset.card]; c.on = !c.on; render(); return; }
    if (t.hasAttribute('data-validate')) {
      disp.done = true; s.day.disp++;
      const r = dispCost(disp.cards, disp.need), opt = dispCost(disp.cards.map((c) => ({ ...c, on: true })), disp.need);
      const score = Math.round(opt.cost / r.cost * 100);
      gain(Math.max(10, Math.round(score * 0.8)), `dispatcher ${score}/100`);
      if (score >= 90) badge('dispatcher');
      checkMissions(); save(); render(); return;
    }
    if (t.hasAttribute('data-newdisp')) { newDisp(); render(); return; }
    if (t.dataset.bet) {
      const v = +el.querySelector('#bet').value;
      if (Number.isFinite(v)) { s.bets.push({ t: t.dataset.bet, guess: v }); s.day.bet++; gain(15, 'pari enregistré'); checkMissions(); save(); render(); }
    }
  });

  return api;
}
