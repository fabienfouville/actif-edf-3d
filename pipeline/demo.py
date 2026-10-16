"""Données de DÉMONSTRATION synthétiques, pour que le site fonctionne avant le premier passage du pipeline.

Rien ici n'est mesuré : un modèle simple produit consommation, mix, prix et production par groupe
avec des formes plausibles. Tous les fichiers sont marqués "demo" et le site l'affiche.
Le premier passage réel du pipeline supprime ces fichiers.
"""
import math
import random
from datetime import timedelta

from common import (DATA, empty_month, hour_floor, iso, load_json, month_key, month_path, month_start,
                    now, rnd, save_json)


def sun(h_utc, doy):
    """Production solaire relative (0..1) à Paris, très simplifiée."""
    decl = 23.44 * math.sin(math.radians(360 / 365 * (doy - 81)))
    hour_angle = 15 * (h_utc + 1 - 12)
    lat = 46.5
    el = math.degrees(math.asin(math.sin(math.radians(lat)) * math.sin(math.radians(decl)) +
                                math.cos(math.radians(lat)) * math.cos(math.radians(decl)) * math.cos(math.radians(hour_angle))))
    return max(0.0, math.sin(math.radians(el))) ** 1.2


def build(params, catalog, months=12):
    rng = random.Random(42)
    end = hour_floor(now())
    start = (end.replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    hours = int((end - start).total_seconds() // 3600)
    cap = params["capacite_nationale_mw"]
    fu = params["combustibles"]

    # arrêts pour rechargement : un par tranche, 35 à 80 jours, plutôt l'été
    def summer_start(span):
        while True:
            k = rng.randint(0, hours - span)
            doy = (start + timedelta(hours=k)).timetuple().tm_yday
            if rng.random() < 0.35 + 0.65 * (1 - math.cos(2 * math.pi * (doy - 15) / 365)) / 2:
                return k

    outages = {}
    for t in catalog["tranches"]:
        span = 24 * rng.randint(50, 100)
        s0 = summer_start(span)
        outages[t["id"]] = [(s0, s0 + span)]
        if rng.random() < 0.5:
            s2 = rng.randint(0, hours - 24 * 20)
            outages[t["id"]].append((s2, s2 + 24 * rng.randint(5, 20)))
    if any(t["id"] == "FLA3" for t in catalog["tranches"]):
        outages["FLA3"].append((0, 24 * 40))

    def cmg_gaz(eff):
        return fu["gaz_ttf_eur_mwh"] / eff + fu["co2_eua_eur_t"] * 0.202 / eff + 3

    ccg = [a for a in catalog["assets"] if a["filiere"] == "gaz"]
    ccg_cost = {a["id"]: cmg_gaz(0.55 + rng.uniform(-0.04, 0.03)) for a in ccg}
    ccg_sorted = sorted(ccg, key=lambda a: ccg_cost[a["id"]])
    hyd = [a for a in catalog["assets"] if a["filiere"] == "hydraulique"]
    fio = [a for a in catalog["assets"] if a["filiere"] == "fioul"]
    cha = [a for a in catalog["assets"] if a["filiere"] == "charbon"]

    wind_state = 0.25
    cloud = 0.7
    rows = []
    for i in range(hours):
        t = start + timedelta(hours=i)
        doy = t.timetuple().tm_yday
        hl = (t.hour + 1) % 24  # heure locale approx.
        winter = math.cos(2 * math.pi * (doy - 15) / 365)  # 1 en janvier, -1 en juillet
        wkend = t.weekday() >= 5
        daily = 0.55 * math.exp(-((hl - 9) / 2.6) ** 2) + 0.75 * math.exp(-((hl - 19.5) / 2.2) ** 2) - 0.6 * math.exp(-((hl - 4) / 3) ** 2)
        cons = 52500 + 12500 * winter + 6500 * daily - (4500 if wkend else 0) + rng.gauss(0, 900)
        if t.hour == 0:
            cloud = min(1, max(0.15, 0.6 * cloud + 0.4 * rng.random() + 0.1 * (-winter)))
        sol = cap["solaire"] * 0.78 * sun(t.hour, doy) * cloud
        wind_state = min(0.8, max(0.03, wind_state + rng.gauss(0, 0.03) + 0.04 * (0.22 + 0.09 * winter - wind_state)))
        eol = cap["eolien"] * wind_state
        fil = 6500 + 2000 * math.sin(2 * math.pi * (doy - 60) / 365) + rng.gauss(0, 200)
        bio = 1300 + rng.gauss(0, 60)
        # nucléaire disponible
        nuc_av = {}
        for tr in catalog["tranches"]:
            off = any(a0 <= i < b0 for a0, b0 in outages[tr["id"]])
            nuc_av[tr["id"]] = 0 if off else tr["p_net_mw"] * rng.uniform(0.95, 1.0)
        nav = sum(nuc_av.values())
        lac_cap = sum(a["p_mw"] for a in hyd if a["type"] == "lac") + 9000
        step_cap = sum(a["p_mw"] for a in hyd if a["type"] == "STEP")
        exports = 6000 + 3500 * (-winter) + rng.gauss(0, 1500)
        exp_cap = 17500 + 1500 * (-winter)
        gap = cons + exports - (sol + eol + fil + bio + 1800 + nav)
        pomp, modul, glut = 0, 0, 0
        if gap < 0:  # excédent : pompage, exportations en plus, modulation nucléaire, écrêtement
            pomp = min(step_cap * 0.8, -gap) if (10 <= hl <= 17 or hl <= 5) else 0
            gap += pomp
            extra = min(max(0, exp_cap - exports), -gap)
            exports += extra
            gap += extra
            modul = min(-gap, 0.35 * nav) if gap < 0 else 0
            gap += modul
            glut = -gap if gap < 0 else 0
            if glut:
                cut = min(glut, sol * 0.6)
                sol -= cut
                eol -= min(glut - cut, eol * 0.5)
            gap = 0
        f = 1 - modul / nav if nav else 0
        nuc_units = {k: v * f * rng.uniform(0.985, 1.0) for k, v in nuc_av.items()}
        nuc = sum(nuc_units.values())
        resid = gap
        units = dict(nuc_units)
        lac = min(lac_cap * 0.85, max(0, resid * 0.5 + (1200 + 1500 * max(0, winter) if 7 <= hl <= 21 else 0)))
        resid -= lac
        step = min(step_cap * 0.9, max(0, resid * 0.5)) if hl in (7, 8, 9, 18, 19, 20, 21) else 0
        resid -= step
        pomp = -pomp
        midday_glut = 1 if (modul > 4000 or glut) else 0
        # thermique : gaz cogénération toujours, puis CCG dans l'ordre de coût, charbon, fioul
        gaz = 1800 + rng.gauss(0, 150)
        price_marg = None
        for a in ccg_sorted:
            take = min(a["p_mw"] * 0.97, max(0, resid))
            units[a["id"]] = take if take > 120 else 0
            resid -= units[a["id"]]
            gaz += units[a["id"]]
            if units[a["id"]] > 0:
                price_marg = ccg_cost[a["id"]]
        ch = 0
        for a in cha:
            take = min(a["p_mw"], max(0, resid)) if resid > 400 else 0
            units[a["id"]] = take
            resid -= take
            ch += take
            if take:
                price_marg = fu["charbon_eur_mwh_th"] / 0.38 + fu["co2_eua_eur_t"] * 0.341 / 0.38 + 4
        fi = 0
        for a in fio:
            take = min(a["p_mw"], max(0, resid)) if resid > 200 else 0
            units[a["id"]] = take
            resid -= take
            fi += take
            if take:
                price_marg = fu["fioul_eur_mwh_th"] / 0.33 + fu["co2_eua_eur_t"] * 0.279 / 0.33 + 5
        lac_assets = [a for a in hyd if a["type"] == "lac"]
        for a in lac_assets:
            units[a["id"]] = lac * a["p_mw"] / lac_cap
        for a in hyd:
            if a["type"] == "STEP":
                units[a["id"]] = step * a["p_mw"] / step_cap
            elif a["type"] == "fil":
                units[a["id"]] = fil * a["p_mw"] / 9000 * rng.uniform(0.9, 1.05)
        # prix : coût marginal de la dernière centrale appelée, couplage européen bruité
        if price_marg is None:
            if glut:
                price_marg = rng.uniform(-25, 0)
            elif modul > 4000:
                price_marg = rng.uniform(8, 32)
            elif step > 0 or lac > 3000:
                price_marg = params["technos"]["hydraulique:lac"]["valeur_eau"] + rng.gauss(0, 8)
            else:
                price_marg = rng.uniform(35, 60)
        price = price_marg + rng.gauss(0, 4) + (8 * daily if not midday_glut else 0)
        hydro = fil + lac + step
        ech = cons - (nuc + sol + eol + hydro + bio + gaz + ch + fi + pomp)
        rows.append((t, {"consommation": cons, "nucleaire": nuc, "hydraulique": hydro, "gaz": gaz, "charbon": ch,
                         "fioul": fi, "eolien": eol, "solaire": sol, "bioenergies": bio, "pompage": pomp,
                         "ech_physiques": ech}, price, units))
    return rows


def write(params, catalog, months=12):
    rows = build(params, catalog, months)
    by_month = {}
    for t, mix, price, units in rows:
        key = month_key(t)
        m = by_month.get(key)
        if m is None:
            m = by_month[key] = empty_month(key)
            m["sources"] = {"mix": "demo", "prix": "demo", "units": "demo"}
        i = int((t - month_start(key)).total_seconds() // 3600)
        m["prix"][i] = rnd(price, 1)
        for k, v in mix.items():
            m["mix"].setdefault(k, [None] * m["n"])[i] = rnd(v)
        for u, v in units.items():
            m["units"].setdefault(u, [None] * m["n"])[i] = rnd(v)
    for key, m in by_month.items():
        save_json(month_path(key), m)
    # live : 48 dernières heures au pas de 15 min (interpolation linéaire des valeurs horaires)
    last = rows[-49:]
    pts = []
    for (t0, a, p0, _), (t1, b, p1, _) in zip(last, last[1:]):
        for q in range(4):
            f = q / 4
            pts.append({"t": iso(t0 + timedelta(minutes=15 * q)),
                        **{k: rnd(a[k] + (b[k] - a[k]) * f) for k in a}})
    save_json(f"{DATA}/live.json", {"genere": iso(now()), "mode": "demo", "pas_min": 15, "points": pts,
                                    "prix_dernier": {"t": iso(last[-1][0]), "eur_mwh": rnd(last[-1][2], 1)}})
    return sorted(by_month)


if __name__ == "__main__":
    params = load_json(f"{DATA}/params.json")
    cat = {"assets": load_json(f"{DATA}/assets.json")["assets"], "tranches": load_json(f"{DATA}/edf_tranches.json")["tranches"]}
    keys = write(params, cat)
    save_json(f"{DATA}/meta.json", {"genere": iso(now()), "mode": "demo", "mois": keys,
                                    "sources": {"mix": "demo", "prix": "demo", "units": "demo"},
                                    "note": "Données de démonstration synthétiques. Lancez le pipeline (GitHub Actions) pour les remplacer par les données publiques."}, pretty=True)
    print("démo :", keys)
