"""Met à jour data/ à partir des sources publiques.

Usage :
  python pipeline/update.py              # 3 derniers jours (passage horaire)
  python pipeline/update.py --days 400   # reprise d'historique
  python pipeline/update.py --demo       # régénère les données de démonstration

Chaque source est optionnelle : si elle échoue, les autres continuent et data/meta.json
indique ce qui a marché. Les clés viennent des variables d'environnement
ENTSOE_TOKEN, RTE_CLIENT_ID et RTE_CLIENT_SECRET (secrets GitHub).
"""
import argparse
import glob
import os
from datetime import timedelta

import demo
from common import (DATA, MIX_KEYS, SERIES, days_ago, empty_month, hour_floor, iso, load_json, month_key,
                    month_path, month_start, months_between, now, rnd, save_json)
from sources import eco2mix, energycharts_prices, entsoe_prices, env, match_units, rte_units


def catalog():
    return {"assets": load_json(f"{DATA}/assets.json")["assets"],
            "tranches": load_json(f"{DATA}/edf_tranches.json")["tranches"]}


def put(months, h, setter):
    key = month_key(h)
    m = months.get(key)
    if m is None:
        m = months[key] = load_json(month_path(key)) or empty_month(key)
    setter(m, int((h - month_start(key)).total_seconds() // 3600))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()
    params = load_json(f"{DATA}/params.json")
    cat = catalog()
    meta = load_json(f"{DATA}/meta.json", {}) or {}

    if args.demo:
        keys = demo.write(params, cat)
        save_json(f"{DATA}/meta.json", {"genere": iso(now()), "mode": "demo", "mois": keys,
                                        "sources": {"mix": "demo", "prix": "demo", "units": "demo"},
                                        "note": "Données de démonstration synthétiques."}, pretty=True)
        return

    first_real = meta.get("mode") != "reel"
    days = max(args.days, 400 if first_real else 0)
    start, end = days_ago(days), hour_floor(now())
    print(f"Fenêtre {iso(start)} → {iso(end)} ({days} j)")
    status = {}

    # 1. mix national (indispensable)
    try:
        mix, fine = eco2mix(start, end, fine=True)
        status["mix"] = {"ok": True, "source": "eco2mix", "heures": len(mix)}
    except Exception as e:
        print("éCO2mix KO :", e)
        status["mix"] = {"ok": False, "erreur": str(e)[:200]}
        mix, fine = {}, {}

    if first_real and not mix:
        print("Pas de données réelles : on garde la démonstration.")
        meta.setdefault("tentatives", []).append({"t": iso(now()), "sources": status})
        meta["tentatives"] = meta["tentatives"][-5:]
        save_json(f"{DATA}/meta.json", meta, pretty=True)
        return

    # 2. prix
    prices, src = {}, None
    tok = env("ENTSOE_TOKEN")
    for name, fn in ([("entsoe", lambda: entsoe_prices(start, end + timedelta(days=2), tok))] if tok else []) + \
                    [("energy-charts", lambda: energycharts_prices(start, end + timedelta(days=2)))]:
        try:
            prices, src = fn(), name
            break
        except Exception as e:
            print(f"Prix {name} KO :", e)
            status.setdefault("prix_erreurs", []).append(f"{name}: {str(e)[:150]}")
    status["prix"] = {"ok": bool(prices), "source": src, "heures": len(prices)}

    # 3. production par groupe (RTE, optionnel)
    units, unmatched = {}, []
    cid, sec = env("RTE_CLIENT_ID"), env("RTE_CLIENT_SECRET")
    if cid and sec:
        try:
            raw, _types = rte_units(start, end, cid, sec)
            units, unmatched = match_units(raw, cat)
            status["units"] = {"ok": True, "source": "rte", "groupes": len(units)}
        except Exception as e:
            print("RTE KO :", e)
            status["units"] = {"ok": False, "erreur": str(e)[:200]}
    else:
        status["units"] = {"ok": False, "source": None, "note": "Secrets RTE absents : production par groupe modélisée dans le navigateur."}

    # 4. écriture des fichiers mensuels
    if first_real:
        for f in glob.glob(os.path.join(SERIES, "*.json")):
            os.remove(f)
    months = {}
    for h, row in mix.items():
        def set_mix(m, i, row=row):
            for k in MIX_KEYS:
                if k in row:
                    m["mix"].setdefault(k, [None] * m["n"])[i] = rnd(row[k])
            m["sources"]["mix"] = "eco2mix"
        if start <= h <= end:
            put(months, h, set_mix)
    for h, p in prices.items():
        if h >= start:
            def set_p(m, i, p=p):
                m["prix"][i] = rnd(p, 1)
                m["sources"]["prix"] = src
            put(months, h, set_p)
    for uid, ser in units.items():
        for h, v in ser.items():
            if start <= h <= end:
                def set_u(m, i, uid=uid, v=v):
                    m["units"].setdefault(uid, [None] * m["n"])[i] = rnd(v)
                    m["sources"]["units"] = "rte"
                put(months, h, set_u)
    for key, m in months.items():
        save_json(month_path(key), m)

    # 5. bandeau live : 48 dernières heures au pas natif
    cutoff = end - timedelta(hours=48)
    pts = [{"t": iso(t), **{k: rnd(v) for k, v in row.items()}} for t, row in sorted(fine.items()) if t >= cutoff]
    last_p = max((h for h in prices if h <= end + timedelta(hours=1)), default=None)
    tomorrow = sorted((h, p) for h, p in prices.items() if h > end)
    save_json(f"{DATA}/live.json", {
        "genere": iso(now()), "mode": "reel", "pas_min": 15, "points": pts,
        "prix_dernier": {"t": iso(last_p), "eur_mwh": rnd(prices[last_p], 1)} if last_p else None,
        "prix_a_venir": [{"t": iso(h), "eur_mwh": rnd(p, 1)} for h, p in tomorrow]})

    keys = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(SERIES, "*.json")))
    save_json(f"{DATA}/meta.json", {
        "genere": iso(now()), "mode": "reel", "mois": keys[-14:], "sources": status,
        "rte_non_apparies": unmatched[:300],
        "licences": {"eco2mix": "RTE éCO2mix via ODRÉ, Licence Ouverte Etalab 2.0",
                     "entsoe": "ENTSO-E Transparency Platform, réutilisation avec attribution",
                     "energy-charts": "Fraunhofer ISE Energy-Charts ; prix FR à usage privé",
                     "rte": "RTE Data, conditions d'utilisation du portail"}}, pretty=True)
    print("OK :", status)


if __name__ == "__main__":
    main()
