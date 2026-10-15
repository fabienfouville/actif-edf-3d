// Vue merit order : les colonnes de la carte s'envolent et se rangent par coût marginal croissant.
import { stack } from './finance.js';
import { fmt } from './charts.js';
import { COLORS } from './scene.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createMerit(el, D, { project, onPick, onHover }) {
  el.innerHTML = '<svg class="m-axes" aria-hidden="true"></svg><div class="m-blocks"></div><div class="m-note"></div>';
  const svg = el.querySelector('.m-axes'), box = el.querySelector('.m-blocks'), note = el.querySelector('.m-note');
  const blocks = new Map();
  let open = false, hour = D.now, selected = null;

  function geom() {
    const w = el.clientWidth, h = el.clientHeight;
    const small = w < 720;
    return { w, h, l: small ? 40 : 64, r: small ? 12 : 28, t: small ? 210 : 140, b: small ? 150 : 130 };
  }

  function layout(animate, fromMap) {
    const S = stack(D.units, D.cmg, (u) => D.prod[u.idx][hour]);
    const g = geom(), iw = g.w - g.l - g.r, ih = g.h - g.t - g.b;
    const real = D.price[hour];
    const ymax = 240, ymin = Math.min(0, Number.isNaN(real) ? 0 : Math.max(-40, real - 5));
    const X = (mw) => g.l + mw / S.total * iw, Y = (v) => g.t + ih - (Math.min(v, ymax) - ymin) / (ymax - ymin) * ih;
    // axes
    let a = '';
    for (let v = 0; v <= ymax; v += 50) a += `<line x1="${g.l}" x2="${g.w - g.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${g.l - 6}" y="${Y(v) + 4}" class="ax" text-anchor="end">${v}</text>`;
    const step = S.total > 100000 ? 20000 : 10000;
    for (let mw = 0; mw <= S.total; mw += step) a += `<text x="${X(mw)}" y="${Y(ymin) + 16}" class="ax" text-anchor="middle">${mw / 1000}</text>`;
    a += `<text x="${g.l}" y="${g.t - 10}" class="ax">€/MWh · coût marginal</text><text x="${g.w - g.r}" y="${Y(ymin) + 32}" class="ax" text-anchor="end">GW disponibles, du moins cher au plus cher</text>`;
    const xd = X(S.demand);
    a += `<line x1="${xd}" x2="${xd}" y1="${g.t - 4}" y2="${Y(ymin)}" class="m-demand"/><text x="${xd + 6}" y="${g.t + 10}" class="ax strong">Production ${fmt(S.demand / 1000, 1)} GW</text>`;
    a += `<line x1="${g.l}" x2="${g.w - g.r}" y1="${Y(S.priceModel)}" y2="${Y(S.priceModel)}" class="m-model"/>`;
    if (!Number.isNaN(real)) a += `<line x1="${g.l}" x2="${g.w - g.r}" y1="${Y(real)}" y2="${Y(real)}" class="m-real"/>`;
    svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
    svg.innerHTML = a;
    const m = S.marginal?.u;
    note.innerHTML = `<b>Prix spot réel ${fmt(real, 1)} €/MWh</b> <span class="m-k real"></span>
      <span>Prix du modèle ${fmt(S.priceModel, 1)} €/MWh <span class="m-k model"></span></span>
      <span>Marginal : <b>${m ? m.nom : '–'}</b></span>`;

    const seen = new Set();
    S.rows.forEach((r, i) => {
      const u = r.u;
      seen.add(u.id);
      let b = blocks.get(u.id);
      if (!b) {
        b = document.createElement('button');
        b.className = 'm-block';
        b.type = 'button';
        b.setAttribute('aria-label', u.nom);
        b.addEventListener('click', () => onPick(u.id));
        b.addEventListener('mouseenter', (ev) => onHover?.(u, ev));
        b.addEventListener('mouseleave', () => onHover?.(null));
        box.appendChild(b);
        blocks.set(u.id, b);
      }
      const x = X(r.x0), w = Math.max(1, X(r.x1) - X(r.x0));
      const top = Math.min(Y(r.cmg), Y(0) - 4), hgt = Math.max(4, Y(ymin) - top);
      const called = r.cap ? Math.min(1, r.prod / r.cap) : 0;
      const c = COLORS[u.filiere];
      b.style.background = `linear-gradient(90deg, ${c} ${called * 100}%, color-mix(in oklab, ${c} 28%, transparent) ${called * 100}%)`;
      b.classList.toggle('sel', u.id === selected || u.mapId === selected);
      b.classList.toggle('marg', S.marginal && S.marginal.u === u);
      const target = `translate(${x}px, ${top}px)`;
      if (fromMap && !reduced) {
        const p = u.lat != null ? project(u.lon, u.lat) : { x: g.w / 2, y: g.h - 40 };
        b.style.transition = 'none';
        b.style.width = '7px'; b.style.height = '7px';
        b.style.transform = `translate(${p.x}px, ${p.y}px)`;
        b.style.opacity = '0';
        b.getBoundingClientRect();
        const delay = Math.min(600, i * 4);
        b.style.transition = `transform 900ms cubic-bezier(.2,.8,.2,1) ${delay}ms, width 900ms ${delay}ms, height 900ms ${delay}ms, opacity 300ms ${delay}ms`;
      } else {
        b.style.transition = animate && !reduced ? 'transform 350ms ease, width 350ms ease, height 350ms ease' : 'none';
      }
      b.style.opacity = '1';
      b.style.transform = target;
      b.style.width = `${w}px`;
      b.style.height = `${hgt}px`;
      b.title = `${u.nom}\n${fmt(r.cmg)} €/MWh · ${fmt(r.prod)} / ${fmt(r.cap)} MW`;
    });
    for (const [id, b] of blocks) if (!seen.has(id)) { b.remove(); blocks.delete(id); }
    return S;
  }

  return {
    get open() { return open; },
    show(h) {
      hour = h; open = true;
      el.hidden = false;
      requestAnimationFrame(() => { el.classList.add('on'); layout(false, true); });
    },
    hide() {
      if (!open) return;
      open = false;
      el.classList.remove('on');
      if (!reduced) {
        for (const [id, b] of blocks) {
          const u = D.unitById[id];
          const p = u.lat != null ? project(u.lon, u.lat) : { x: el.clientWidth / 2, y: el.clientHeight };
          b.style.transition = 'transform 600ms ease-in, width 600ms, height 600ms, opacity 600ms';
          b.style.transform = `translate(${p.x}px, ${p.y}px)`;
          b.style.width = '6px'; b.style.height = '6px'; b.style.opacity = '0';
        }
      }
      setTimeout(() => { if (!open) el.hidden = true; }, reduced ? 0 : 620);
    },
    setHour(h) { hour = h; if (open) layout(true, false); },
    select(id) { selected = id; if (open) layout(false, false); },
    relayout() { if (open) layout(false, false); },
    stackAt: (h) => stack(D.units, D.cmg, (u) => D.prod[u.idx][h]),
  };
}
