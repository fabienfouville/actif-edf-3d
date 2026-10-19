// Petits graphiques SVG. Chaque fonction renvoie une chaîne SVG.

export const nf = (d = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '–' : nf(d).format(v));
export const col = (f) => `var(--c-${f})`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceTicks(min, max, n = 4) {
  const span = max - min || 1;
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** Carte de chaleur semaine × heure. cells[w][h] = marge €/MWh ou null (arrêt). */
export function heatmap(cells, { w = 340, labels = [] } = {}) {
  const W = cells.length, cw = (w - 28) / W, ch = 7, H = 24 * ch;
  let s = `<svg viewBox="0 0 ${w} ${H + 18}" class="chart" role="img" aria-label="Carte heure par semaine">`;
  for (let i = 0; i < W; i++) {
    for (let h = 0; h < 24; h++) {
      const v = cells[i][h];
      let fill;
      if (v == null) fill = 'var(--off)';
      else if (v >= 0) { const r = Math.min(1, v / 80); fill = `color-mix(in oklab, var(--good) ${Math.round(30 + 70 * r)}%, var(--panel))`; }
      else { const r = Math.min(1, -v / 40); fill = `color-mix(in oklab, var(--bad) ${Math.round(35 + 65 * r)}%, var(--panel))`; }
      s += `<rect x="${(26 + i * cw).toFixed(1)}" y="${h * ch}" width="${(cw - 0.5).toFixed(2)}" height="${ch - 0.6}" fill="${fill}"><title>${esc(labels[i] || '')} ${h} h : ${v == null ? 'arrêt' : fmt(v) + ' €/MWh'}</title></rect>`;
    }
  }
  for (const h of [0, 6, 12, 18]) s += `<text x="22" y="${h * ch + 6}" class="ax" text-anchor="end">${h}h</text>`;
  if (labels.length) {
    s += `<text x="26" y="${H + 13}" class="ax">${esc(labels[0])}</text><text x="${w}" y="${H + 13}" class="ax" text-anchor="end">${esc(labels[labels.length - 1])}</text>`;
  }
  return s + '</svg>';
}

/** Courbes. series = [{v:[], color, label, area?, dash?}]. */
export function lines(series, { w = 340, h = 120, yLabel = '', xLabels = [], zero = false, marker = null } = {}) {
  const all = series.flatMap((s) => [...s.v, ...(s.band ? s.band.flat() : [])].filter((x) => x != null && !Number.isNaN(x)));
  if (!all.length) return '<p class="muted">Pas de données.</p>';
  let min = Math.min(...all), max = Math.max(...all);
  if (zero) min = Math.min(0, min);
  if (max === min) max = min + 1;
  const pad = { l: 34, r: 6, t: 8, b: 16 }, iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const n = Math.max(...series.map((s) => s.v.length));
  const X = (i) => pad.l + (n > 1 ? i / (n - 1) : 0) * iw, Y = (v) => pad.t + ih - (v - min) / (max - min) * ih;
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(yLabel)}">`;
  for (const t of niceTicks(min, max, 3)) s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${pad.l - 4}" y="${Y(t) + 3}" class="ax" text-anchor="end">${fmt(t)}</text>`;
  if (yLabel) s += `<text x="${pad.l}" y="${pad.t - 1}" class="ax">${esc(yLabel)}</text>`;
  xLabels.forEach(([i, lab]) => { s += `<text x="${X(i)}" y="${h - 3}" class="ax" text-anchor="middle">${esc(lab)}</text>`; });
  for (const se of series) {
    if (se.band) { // enveloppe min/max
      const [lo, hi] = se.band;
      s += `<path d="M${hi.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('L')}L${lo.map((v, i) => [i, v]).reverse().map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('L')}Z" fill="${se.color}" opacity=".14"/>`;
    }
    const pts = se.v.map((v, i) => (v == null || Number.isNaN(v) ? null : [X(i), Y(v)]));
    let d = '', open = false;
    pts.forEach((p) => { if (!p) { open = false; return; } d += (open ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); open = true; });
    if (se.area) {
      const first = pts.findIndex(Boolean), last = pts.length - 1 - [...pts].reverse().findIndex(Boolean);
      s += `<path d="${d}L${X(last)},${Y(Math.max(min, 0))}L${X(first)},${Y(Math.max(min, 0))}Z" fill="${se.color}" opacity=".16"/>`;
    }
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="1.6" ${se.dash ? 'stroke-dasharray="4 3"' : ''}/>`;
  }
  if (marker != null) s += `<line x1="${X(marker)}" x2="${X(marker)}" y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--fg)" stroke-width="1"/>`;
  return s + '</svg>';
}

/** Barres verticales simples. items = [{k, v, color}]. */
export function bars(items, { w = 340, h = 120, unit = '', ref = null } = {}) {
  const vals = items.map((i) => i.v).filter((v) => !Number.isNaN(v));
  const max = Math.max(1, ...vals, ref || 0), min = Math.min(0, ...vals);
  const pad = { l: 30, r: 4, t: 12, b: 16 }, iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const bw = iw / items.length, Y = (v) => pad.t + ih - (v - min) / (max - min) * ih;
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">`;
  for (const t of niceTicks(min, max, 3)) s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${pad.l - 4}" y="${Y(t) + 3}" class="ax" text-anchor="end">${fmt(t)}</text>`;
  items.forEach((it, i) => {
    if (Number.isNaN(it.v)) return;
    const y = Math.min(Y(it.v), Y(0)), hh = Math.abs(Y(it.v) - Y(0));
    s += `<rect x="${pad.l + i * bw + 1.5}" y="${y}" width="${bw - 3}" height="${Math.max(1, hh)}" rx="2" fill="${it.color || 'var(--accent)'}"><title>${esc(it.k)} : ${fmt(it.v, 1)} ${unit}</title></rect>`;
    if (items.length <= 14) s += `<text x="${pad.l + i * bw + bw / 2}" y="${h - 3}" class="ax" text-anchor="middle">${esc(it.k)}</text>`;
  });
  if (ref != null) s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(ref)}" y2="${Y(ref)}" stroke="var(--fg)" stroke-dasharray="3 3"/>`;
  return s + '</svg>';
}

/** Cascade : items = [{k, v}] puis total. */
export function waterfall(items, total, { w = 340, h = 170, unit = 'M€' } = {}) {
  let acc = 0;
  const steps = items.map((it) => { const a = acc; acc += it.v; return { ...it, a, b: acc }; });
  const all = steps.flatMap((s) => [s.a, s.b]).concat([0, total]);
  const min = Math.min(...all), max = Math.max(...all) || 1;
  const n = steps.length + 1, pad = { l: 8, r: 8, t: 16, b: 30 }, iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const bw = iw / n, Y = (v) => pad.t + ih - (v - min) / (max - min || 1) * ih;
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Revenu décomposé">`;
  s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(0)}" y2="${Y(0)}" class="grid"/>`;
  const bar = (i, a, b, fill, label, val) => {
    const y = Math.min(Y(a), Y(b)), hh = Math.max(1.5, Math.abs(Y(a) - Y(b)));
    const x = pad.l + i * bw + 4;
    s += `<rect x="${x}" y="${y}" width="${bw - 8}" height="${hh}" rx="3" fill="${fill}"/>`;
    s += `<text x="${x + (bw - 8) / 2}" y="${y - 4}" class="ax strong" text-anchor="middle">${val >= 0 ? '+' : ''}${fmt(val)}</text>`;
    const words = label.split(' ');
    words.slice(0, 2).forEach((wd, k) => { s += `<text x="${x + (bw - 8) / 2}" y="${h - 18 + k * 10}" class="ax" text-anchor="middle">${esc(wd)}</text>`; });
  };
  steps.forEach((st, i) => bar(i, st.a, st.b, st.v >= 0 ? 'var(--accent)' : 'var(--bad)', st.k, st.v));
  bar(steps.length, 0, total, total >= 0 ? 'var(--good)' : 'var(--bad)', 'Marge', total);
  return s + `<text x="${w - pad.r}" y="10" class="ax" text-anchor="end">${unit}</text></svg>`;
}

/** Tornado de sensibilité : items = [{k, lo, hi}]. */
export function tornadoChart(items, { w = 340, unit = 'M€' } = {}) {
  const m = Math.max(1, ...items.flatMap((i) => [Math.abs(i.lo), Math.abs(i.hi)]));
  const rowH = 24, h = items.length * rowH + 14, cx = w / 2 + 40, half = w - cx - 8;
  let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Sensibilités de la VAN">`;
  s += `<line x1="${cx}" x2="${cx}" y1="0" y2="${h - 10}" stroke="var(--line)"/>`;
  items.forEach((it, i) => {
    const y = i * rowH + 4;
    s += `<text x="4" y="${y + 13}" class="ax">${esc(it.k)}</text>`;
    for (const [v, c] of [[it.lo, 'var(--bad)'], [it.hi, 'var(--good)']]) {
      const x = v < 0 ? cx + v / m * half * 0.9 : cx, ww = Math.abs(v) / m * half * 0.9;
      s += `<rect x="${x}" y="${y + 2}" width="${Math.max(1, ww)}" height="14" rx="2" fill="${c}" opacity=".85"><title>${fmt(v)} ${unit}</title></rect>`;
    }
  });
  return s + `<text x="${w - 4}" y="${h - 1}" class="ax" text-anchor="end">écart de VAN, ${unit}</text></svg>`;
}

/** Aire empilée du mix (24 h) pour la frise. */
export function stackedArea(layers, { w = 600, h = 40, max = null, slots = null } = {}) {
  const n = layers[0]?.v.length || 0;
  if (!n) return '';
  const tot = Array.from({ length: n }, (_, i) => layers.reduce((s, l) => s + Math.max(0, l.v[i] || 0), 0));
  const M = max || Math.max(...tot) || 1;
  const span = (slots || n) - 1, X = (i) => (span > 0 ? i / span : 0) * w, Y = (v) => h - v / M * h;
  const acc = new Array(n).fill(0);
  let s = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="area" aria-hidden="true">`;
  for (const l of layers) {
    const top = acc.map((a, i) => a + Math.max(0, l.v[i] || 0));
    const d = top.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') +
      acc.map((v, i) => [i, v]).reverse().map(([i, v]) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') + 'Z';
    s += `<path d="${d}" fill="${l.color}" opacity=".9"/>`;
    top.forEach((v, i) => { acc[i] = v; });
  }
  return s + '</svg>';
}
