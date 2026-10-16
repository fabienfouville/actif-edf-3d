"""Construit data/reference.json à partir des sources officielles.

- ENTSO-E 14.1.B (A71) : puissance installée de chaque unité de production ≥ 100 MW, avec son code EIC.
- ENTSO-E 16.1.A (A73) : noms des groupes publiés, pour relier la production réelle aux actifs.
- Registre national des installations (ODRÉ) : commune, filière, technologie, date de mise en service,
  pour toutes les installations de 50 MW et plus.
- geo.api.gouv.fr : coordonnées du centre de chaque commune d'implantation.
- ODRÉ : parc installé national et régional par filière (dernière année publiée).

Usage : python pipeline/catalog.py  (réseau et ENTSOE_TOKEN requis, lancé dans GitHub Actions)
"""
import json
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import timedelta

from common import DATA, days_ago, http, http_json, iso, norm, now, save_json
from sources import FR_EIC, _strip_ns, env

ODRE = "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets"
REG = "registre-national-installation-production-stockage-electricite-agrege"
PSR = {"B01": "bioenergies", "B04": "gaz", "B05": "charbon", "B06": "fioul", "B10": "hydraulique:STEP",
       "B11": "hydraulique:fil", "B12": "hydraulique:lac", "B14": "nucleaire", "B16": "solaire",
       "B18": "eolien:offshore", "B19": "eolien", "B20": "autre"}


def entsoe(params):
    q = urllib.parse.urlencode({"securityToken": env("ENTSOE_TOKEN"), **params})
    return _strip_ns(ET.fromstring(http("https://web-api.tp.entsoe.eu/api?" + q, timeout=180)))


def units_a71():
    y = now().year
    root = entsoe({"documentType": "A71", "processType": "A33", "in_Domain": FR_EIC,
                   "periodStart": f"{y}01010000", "periodEnd": f"{y}01020000"})
    out = {}
    for ts in root.findall("TimeSeries"):
        r = ts.find("MktPSRType/PowerSystemResources")
        if r is None:
            continue
        eic, name = r.findtext("mRID"), r.findtext("name")
        mw = max([float(p.findtext("quantity")) for p in ts.iter("Point")] or [0])
        out[eic] = {"eic": eic, "nom_entsoe": name, "psr": ts.findtext("MktPSRType/psrType"),
                    "filiere": PSR.get(ts.findtext("MktPSRType/psrType")), "p_mw": mw}
    return out


def units_a73():
    d0 = days_ago(2).replace(hour=0)
    root = entsoe({"documentType": "A73", "processType": "A16", "in_Domain": FR_EIC,
                   "periodStart": f"{d0:%Y%m%d%H%M}", "periodEnd": f"{d0 + timedelta(days=1):%Y%m%d%H%M}"})
    out = {}
    for ts in root.findall("TimeSeries"):
        r = ts.find("MktPSRType/PowerSystemResources")
        if r is not None:
            out[r.findtext("mRID")] = {"eic": r.findtext("mRID"), "nom": r.findtext("name"), "cle": norm(r.findtext("name") or ""),
                                       "psr": ts.findtext("MktPSRType/psrType")}
    return out


def registre(min_kw=50000):
    fields = ("nominstallation,codeeicresourceobject,commune,codeinseecommune,codeinseecommuneimplantation,region,"
              "codefiliere,filiere,technologie,combustible,datemiseenservice_date,puismaxinstallee,nbgroupes,regime,gestionnaire,"
              "energieannuelleglissanteinjectee")
    rows, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"where": f"maxpuis >= {min_kw}", "select": fields, "limit": 100, "offset": offset,
                                    "order_by": "maxpuis desc"})
        d = http_json(f"{ODRE}/{REG}/records?{q}")
        rows += d.get("results", [])
        offset += 100
        if offset >= d.get("total_count", 0) or offset >= 2000:
            break
    return rows


def communes(codes):
    out = {}
    for c in sorted(codes):
        try:
            d = http_json(f"https://geo.api.gouv.fr/communes/{c}?fields=nom,centre,codeDepartement", timeout=30)
            lon, lat = d["centre"]["coordinates"]
            out[c] = {"nom": d["nom"], "lat": round(lat, 4), "lon": round(lon, 4), "dep": d.get("codeDepartement")}
        except Exception as e:
            out[c] = {"erreur": str(e)[:120]}
    return out


def parcs():
    num = lambda v: float(str(v).replace(",", ".")) if v not in (None, "") else None
    nat = http_json(f"{ODRE}/parc-prod-par-filiere/records?order_by=annee%20desc&limit=1")["results"][0]
    reg = http_json(f"{ODRE}/parc-regional-annuel-prod-eolien-solaire/records?order_by=annee%20desc&limit=20")["results"]
    last = max(r["annee"] for r in reg)
    return ({"annee": nat["annee"], **{k.replace("parc_", ""): num(v) for k, v in nat.items() if k.startswith("parc_")}},
            {"annee": last, "regions": {r["region"]: {"eolien": num(r["parc_installe_eolien"]), "solaire": num(r["parc_installe_solaire"])}
                                        for r in reg if r["annee"] == last}})


def main():
    ref = {"genere": iso(now()), "sources": {}}
    for key, fn in (("unites_entsoe", units_a71), ("groupes_entsoe", units_a73), ("registre", registre)):
        try:
            ref[key] = fn()
            ref["sources"][key] = "ok"
        except Exception as e:
            ref["sources"][key] = f"erreur : {e}"[:300]
            ref[key] = {} if key != "registre" else []
    # rapprochement EIC registre ↔ ENTSO-E et géocodage des communes
    by_eic = {r.get("codeeicresourceobject"): r for r in ref["registre"] if r.get("codeeicresourceobject")}
    codes = {r.get("codeinseecommuneimplantation") or r.get("codeinseecommune") for r in ref["registre"]} - {None}
    ref["communes"] = communes(codes)
    for u in list(ref["unites_entsoe"].values()) + list(ref["groupes_entsoe"].values()):
        r = by_eic.get(u["eic"])
        if r:
            u["registre"] = r.get("nominstallation")
            u["insee"] = r.get("codeinseecommuneimplantation") or r.get("codeinseecommune")
    try:
        ref["parc_national"], ref["parc_regional"] = parcs()
        ref["sources"]["parcs"] = "ok"
    except Exception as e:
        ref["sources"]["parcs"] = f"erreur : {e}"[:300]
    save_json(f"{DATA}/reference.json", ref, pretty=True)
    print(json.dumps(ref["sources"], ensure_ascii=False, indent=1))
    print("unités A71 :", len(ref["unites_entsoe"]), "· groupes A73 :", len(ref["groupes_entsoe"]),
          "· registre ≥ 50 MW :", len(ref["registre"]), "· EIC rapprochés :",
          sum(1 for u in ref["unites_entsoe"].values() if u.get("insee")))


if __name__ == "__main__":
    main()
