// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHPFC, parisParts, parisOffset, gasForMonth, mcAt } from '../app/forward.js';
import { priceIt, vnuMarg } from '../app/pricing.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const P = load('params.json'), M = load('market.json');

// historique synthétique d'un an, forme horaire marquée
const t0 = Date.UTC(2025, 9, 1);
const prices = Float32Array.from({ length: 365 * 24 }, (_, i) => 80 + 30 * Math.sin((i % 24) / 24 * 2 * Math.PI));
const FWD = buildHPFC(M, { t0, prices });

test('heure de Paris : changements d\'heure 2027', () => {
  assert.equal(parisOffset(Date.UTC(2027, 2, 28, 0, 59)), 1);
  assert.equal(parisOffset(Date.UTC(2027, 2, 28, 1, 0)), 2);
  assert.equal(parisOffset(Date.UTC(2027, 9, 31, 0, 59)), 2);
  assert.equal(parisOffset(Date.UTC(2027, 9, 31, 1, 0)), 1);
  assert.deepEqual(parisParts(Date.UTC(2027, 0, 4, 7)), { y: 2027, m: 0, d: 4, h: 8, dow: 1 });
});

test('HPFC : 2027 compte 8 760 heures et la courbe retombe sur chaque produit', () => {
  const h27 = [...FWD.MI].filter((mi) => FWD.months[mi].y === 2027).length;
  assert.equal(h27, 8760);
  assert.equal(FWD.n, 8760 * 2 + 8784 + 61 * 24); // 2028 bissextile
  assert.equal(FWD.flags['Q4-27'], 'dérivé');
  for (const c of FWD.check) {
    assert.ok(Math.abs(c.base_courbe - c.base) < 1e-3, `${c.produit} base ${c.base_courbe} ≠ ${c.base}`);
    if (c.pointe != null) assert.ok(Math.abs(c.pointe_courbe - c.pointe) < 1e-3, `${c.produit} pointe ${c.pointe_courbe} ≠ ${c.pointe}`);
  }
  const q4 = FWD.pw['Q4-27'].b;
  assert.ok(q4 > 100 && q4 < 125, `Q4-27 ${q4}`);
});

test('gaz : juin 2027 déduit du Q2 et d\'avril-mai, mois de 2029 au Cal', () => {
  const g = M.gaz_peg, jun = gasForMonth(g, 2027, 5);
  assert.ok(Math.abs((g['2027-04'] * 30 + g['2027-05'] * 31 + jun * 30) / 91 - g['Q2-27']) < 1e-9);
  assert.equal(gasForMonth(g, 2029, 6), g['Cal-29']);
});

test('VNU : valeur marginale par bande de revenu', () => {
  const v = { s1: 78, s2: 110 };
  assert.equal(vnuMarg(100, 70, v), 100);
  assert.equal(vnuMarg(100, 90, v), 89);
  assert.equal(vnuMarg(100, 120, v), 10 + 99 - 16);
});

test('pricing : interruption d\'un CCG = somme des marges horaires positives', () => {
  const u = { filiere: 'gaz', type: 'CCG', p_mw: 400 };
  const ctx = { u, P, FWD, vnu: { s1: 78, s2: 110 }, parcRev: () => 60 };
  const r = priceIt({ c: 'int', from: '2027-01-01', to: '2027-01-31', units: [{ id: 'U1', p_mw: 400 }], pminPct: 40 }, ctx);
  let ref = 0;
  for (let i = r.i0; i < r.i1; i++) { const c = mcAt(u, i, P, FWD); if (FWD.F[i] > c) ref += 400 * (FWD.F[i] - c); }
  assert.equal(r.n, 31 * 24);
  assert.ok(Math.abs(r.cost - ref) < 1, `${r.cost} vs ${ref}`);
  const pmax = priceIt({ c: 'pmax', from: '2027-07-01', to: '2027-07-31', units: [{ id: 'U1', p_mw: 400 }], pminPct: 40 }, ctx);
  assert.ok(pmax.cost >= 0, 'imposer Pmax coûte au moins autant que le dispatch libre');
});

test('pricing : nucléaire sous le seuil VNU = avant VNU', () => {
  const u = { filiere: 'nucleaire', p_mw: 900 };
  const r = priceIt({ c: 'int', from: '2027-03-01', to: '2027-03-07', units: [{ id: 'TRI1', p_mw: 900 }], pminPct: 25 },
    { u, P, FWD, vnu: { s1: 78, s2: 110 }, parcRev: () => 63.82 });
  assert.ok(Math.abs(r.cost - r.costGross) < 1e-6);
  assert.ok(r.cost > 0);
  assert.equal(priceIt({ c: 'int', from: '2027-03-01', to: '2027-03-07', units: [{ id: 'x', p_mw: 1 }], pminPct: 0 },
    { u: { filiere: 'hydraulique', type: 'lac' }, P, FWD }).err.startsWith('Méthode'), true);
});
