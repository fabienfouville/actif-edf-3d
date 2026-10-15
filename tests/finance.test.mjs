// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { srmc, stack, hedge, dcf, tornado, kpis } from '../app/finance.js';
import { readFileSync } from 'node:fs';

const P = JSON.parse(readFileSync(new URL('../data/params.json', import.meta.url)));

test('coût marginal CCG = gaz/rendement + CO2 + O&M', () => {
  const c = P.combustibles, t = P.technos.gaz;
  const v = srmc({ filiere: 'gaz', type: 'CCG' }, P);
  assert.equal(v.toFixed(3), (c.gaz_ttf_eur_mwh / t.rendement + c.co2_eua_eur_t * t.emission_t_mwh_th / t.rendement + t.om_var).toFixed(3));
  assert.equal(srmc({ filiere: 'hydraulique', type: 'STEP' }, P), P.technos['hydraulique:STEP'].valeur_eau);
  assert.equal(srmc({ filiere: 'eolien', type: 'offshore' }, P), 0);
});

test('merit order : la centrale pilotable la plus chère en marche est marginale', () => {
  const units = [
    { id: 'pv', idx: 0, filiere: 'solaire', p_mw: 1000 },
    { id: 'nuc', idx: 1, filiere: 'nucleaire', p_mw: 1000, real: true },
    { id: 'ccg', idx: 2, filiere: 'gaz', type: 'CCG', p_mw: 500 },
    { id: 'tac', idx: 3, filiere: 'fioul', type: 'TAC', p_mw: 200 },
  ];
  const cmg = [0, 12, 90, 200];
  const prod = { pv: 300, nuc: 950, ccg: 400, tac: 0 };
  const S = stack(units, cmg, (u) => prod[u.id]);
  assert.equal(S.marginal.u.id, 'ccg');
  assert.equal(S.priceModel, 90);
  assert.equal(S.demand, 1650);
  assert.deepEqual(S.rows.map((r) => r.u.id), ['pv', 'nuc', 'ccg', 'tac']);
  assert.equal(S.rows[0].cap, 300);           // fatal : capacité = production
  const off = stack(units, cmg, (u) => (u.id === 'nuc' ? 0 : prod[u.id]));
  assert.equal(off.rows.find((r) => r.u.id === 'nuc'), undefined); // tranche à l'arrêt : retirée
});

test('couverture : la part vendue à terme neutralise le spot', () => {
  const base = { volume_mwh: 1e6, prix_terme: 70, cmg: 10 };
  const full = hedge({ ...base, part: 1, spot: 200 }), full2 = hedge({ ...base, part: 1, spot: 20 });
  assert.equal(full.marge, full2.marge);
  const open = hedge({ ...base, part: 0, spot: 80 });
  assert.equal(open.marge.toFixed(6), ((80 - 10) * 1e6 / 1e6).toFixed(6));
});

test('VNU : reversement au-delà des seuils', () => {
  const vnu = { seuil1: 78, taux1: 0.5, seuil2: 110, taux2: 0.9 };
  const r = hedge({ volume_mwh: 1e6, part: 0, prix_terme: 0, spot: 120, cmg: 0, vnu });
  const tax = r.items.find((i) => i.k === 'Reversement VNU').v;
  assert.equal(tax.toFixed(6), (-((110 - 78) * 0.5 + (120 - 110) * 0.9)).toFixed(6));
});

test('VAN : une annuité actualisée', () => {
  const r = dcf({ p_mw: 1, lf: 1, prix: 60, capture: 1, cmg: 10, cout_fixe_kw_an: 0, annees: 1, wacc: 0.1 });
  assert.equal(r.npv.toFixed(6), (8760 * 50 / 1e6 / 1.1).toFixed(6));
  const t = tornado({ p_mw: 100, lf: 0.8, prix: 60, capture: 1, cmg: 10, cout_fixe_kw_an: 20, annees: 20, wacc: 0.07 });
  assert.equal(t.length, 4);
  assert.ok(t.find((x) => x.k.startsWith('Prix')).hi > 0);
});

test('indicateurs : facteur de charge et prix capté', () => {
  const u = { filiere: 'gaz', p_mw: 100 };
  const prod = Float32Array.from([100, 0, 50, 0]), price = Float32Array.from([100, 20, 60, 10]);
  const k = kpis(u, prod, price, 50, 0, 4, null, []);
  assert.equal(k.facteur_charge, 150 / 400);
  assert.equal(k.prix_capte.toFixed(4), ((100 * 100 + 50 * 60) / 150).toFixed(4));
  assert.equal(k.part_heures_en_marge, 1);
});
