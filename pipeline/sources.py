"""Connecteurs vers les sources publiques. Chaque fonction renvoie des séries horaires UTC.

- éCO2mix (RTE, via ODRÉ) : mix national, sans clé.
- ENTSO-E Transparency : prix day-ahead France, jeton gratuit (ENTSOE_TOKEN).
- Energy-Charts (Fraunhofer ISE) : prix day-ahead France sans clé, plan B.
- RTE Data : production réalisée par groupe, OAuth2 gratuit (RTE_CLIENT_ID / RTE_CLIENT_SECRET).
"""
import base64
import os
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

from common import MIX_KEYS, hour_floor, hourly_mean, http, http_json, norm, parse_iso

ODRE = "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/{ds}/exports/json"


# ---------------------------------------------------------------- éCO2mix
def eco2mix(start, end, fine=False):
    """Mix national. Combine le jeu temps réel et le jeu définitif (prioritaire).

    fine=True renvoie aussi les points au pas natif (15 min) pour le bandeau live.
    """
    pts = {}
    for ds in ("eco2mix-national-tr", "eco2mix-national-cons-def"):
        where = f"date_heure >= date'{start:%Y-%m-%d}' and date_heure < date'{(end + timedelta(days=1)):%Y-%m-%d}'"
        q = urllib.parse.urlencode({"where": where, "order_by": "date_heure", "timezone": "UTC"})
        try:
            rows = http_json(ODRE.format(ds=ds) + "?" + q, timeout=180)
        except Exception as e:  # le jeu définitif peut ne rien couvrir de la fenêtre
            print(f"  éCO2mix {ds}: {e}")
            continue
        for r in rows:
            if not r.get("date_heure"):
                continue
            t = parse_iso(r["date_heure"])
            vals = {k: r.get(k) for k in MIX_KEYS}
            if all(v is None for k, v in vals.items() if k != "consommation"):
                continue
            cur = pts.setdefault(t, {})
            for k, v in vals.items():
                if v is not None:
                    cur[k] = float(v)
        print(f"  éCO2mix {ds}: {len(rows)} lignes")
    if not pts:
        raise RuntimeError("éCO2mix : aucune donnée")
    hourly = {k: hourly_mean({t: p.get(k) for t, p in pts.items()}) for k in MIX_KEYS}
    out = {}
    for k, ser in hourly.items():
        for h, v in ser.items():
            out.setdefault(h, {})[k] = v
    return (out, pts) if fine else out


# ---------------------------------------------------------------- Prix day-ahead
FR_EIC = "10YFR-RTE------C"


def _strip_ns(root):
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _dur(res):
    return {"PT15M": 15, "PT30M": 30, "PT60M": 60, "P1D": 1440}.get(res, 60)


def entsoe_prices(start, end, token):
    pts = {}
    cur = start
    while cur < end:
        stop = min(cur + timedelta(days=90), end)
        q = urllib.parse.urlencode({"securityToken": token, "documentType": "A44",
                                    "in_Domain": FR_EIC, "out_Domain": FR_EIC,
                                    "periodStart": f"{cur:%Y%m%d%H%M}", "periodEnd": f"{stop:%Y%m%d%H%M}"})
        root = _strip_ns(ET.fromstring(http("https://web-api.tp.entsoe.eu/api?" + q, timeout=120)))
        for ts in root.findall("TimeSeries"):
            for per in ts.findall("Period"):
                t0 = parse_iso(per.find("timeInterval/start").text)
                step = _dur(per.find("resolution").text)
                t_end = parse_iso(per.find("timeInterval/end").text)
                vals = {int(p.find("position").text): float(p.find("price.amount").text)
                        for p in per.findall("Point")}
                n = int((t_end - t0).total_seconds() // 60 // step)
                last = None
                for pos in range(1, n + 1):  # courbe A03 : les points répétés sont omis
                    last = vals.get(pos, last)
                    if last is not None:
                        pts[t0 + timedelta(minutes=step * (pos - 1))] = last
        cur = stop
    if not pts:
        raise RuntimeError("ENTSO-E : aucun prix")
    return hourly_mean(pts)


def energycharts_prices(start, end):
    q = urllib.parse.urlencode({"bzn": "FR", "start": f"{start:%Y-%m-%d}", "end": f"{end:%Y-%m-%d}"})
    d = http_json("https://api.energy-charts.info/price?" + q, timeout=120)
    pts = {}
    for t, p in zip(d.get("unix_seconds", []), d.get("price", [])):
        if p is not None:
            pts[datetime.fromtimestamp(t, tz=timezone.utc)] = float(p)
    if not pts:
        raise RuntimeError("Energy-Charts : aucun prix")
    return hourly_mean(pts)


def entsoe_units(start, end, token):
    """Production réalisée par groupe ≥ 100 MW (ENTSO-E 16.1.A, A73), un appel par jour.

    Renvoie {nom de groupe normalisé: {heure: MW}} et {nom: type de production}.
    """
    out, types = {}, {}
    cur = start.replace(hour=0)
    while cur < end:
        stop = cur + timedelta(days=1)
        q = urllib.parse.urlencode({"securityToken": token, "documentType": "A73", "processType": "A16",
                                    "in_Domain": FR_EIC, "periodStart": f"{cur:%Y%m%d%H%M}", "periodEnd": f"{stop:%Y%m%d%H%M}"})
        try:
            root = _strip_ns(ET.fromstring(http("https://web-api.tp.entsoe.eu/api?" + q, timeout=180)))
        except Exception as e:  # un jour manquant ne doit pas tout arrêter
            print(f"  ENTSO-E A73 {cur:%Y-%m-%d} : {e}")
            cur = stop
            continue
        for ts in root.findall("TimeSeries"):
            name = norm(ts.findtext("MktPSRType/PowerSystemResources/name") or "")
            if not name:
                continue
            types[name] = ts.findtext("MktPSRType/psrType")
            pts = {}
            for per in ts.findall("Period"):
                t0 = parse_iso(per.find("timeInterval/start").text)
                step = _dur(per.find("resolution").text)
                for p in per.findall("Point"):
                    pts[t0 + timedelta(minutes=step * (int(p.find("position").text) - 1))] = float(p.find("quantity").text)
            out.setdefault(name, {}).update(hourly_mean(pts))
        cur = stop
    if not out:
        raise RuntimeError("ENTSO-E A73 : aucun groupe")
    return out, types


# ---------------------------------------------------------------- RTE production par groupe
RTE_BASE = "https://digital.iservices.rte-france.com"


def rte_token(cid, secret):
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    d = http_json(RTE_BASE + "/token/oauth/", data=b"",
                  headers={"Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"})
    return d["access_token"]


def rte_units(start, end, cid, secret):
    """{nom de groupe normalisé: {heure: MW}} et types de production."""
    tok = rte_token(cid, secret)
    out, types = {}, {}
    cur = start
    while cur < end:
        stop = min(cur + timedelta(days=7), end)
        q = urllib.parse.urlencode({"start_date": cur.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                                    "end_date": stop.strftime("%Y-%m-%dT%H:%M:%S+00:00")})
        d = http_json(f"{RTE_BASE}/open_api/actual_generation/v1/actual_generations_per_unit?{q}",
                      headers={"Authorization": "Bearer " + tok}, timeout=120)
        for block in d.get("actual_generations_per_unit", []):
            u = block.get("unit", {})
            name = norm(u.get("name", ""))
            types[name] = u.get("production_type")
            pts = {parse_iso(v["start_date"]): v.get("value") for v in block.get("values", [])}
            out.setdefault(name, {}).update(hourly_mean(pts))
        cur = stop
    if not out:
        raise RuntimeError("RTE : aucun groupe")
    return out, types


def match_units(rte, catalog):
    """Rapproche les noms RTE des identifiants du catalogue.

    Tranches nucléaires : nom du site + numéro final. Autres actifs : somme des groupes
    dont le nom contient la clé (ex. MARTIGUES 5 + MARTIGUES 6).
    """
    series, used = {}, set()
    for t in catalog["tranches"]:
        key = norm(t["rte"])
        site, num = key.rsplit(" ", 1)
        for name, ser in rte.items():
            toks = name.split()
            if toks and toks[-1] == num and all(w in toks for w in site.split()):
                series[t["id"]] = ser
                used.add(name)
                break
    for a in catalog["assets"]:
        if a["filiere"] == "nucleaire" or "rte" not in a:
            continue
        key = norm(a["rte"])
        names = [n for n in rte if key in n and n not in used]
        if not names:
            continue
        acc = {}
        for n in names:
            used.add(n)
            for h, v in rte[n].items():
                acc[h] = acc.get(h, 0) + (v or 0)
        series[a["id"]] = acc
    return series, sorted(set(rte) - used)


def env(name):
    v = os.environ.get(name, "").strip()
    return v or None


__all__ = ["eco2mix", "entsoe_prices", "entsoe_units", "energycharts_prices", "rte_units", "match_units", "env", "hour_floor"]
