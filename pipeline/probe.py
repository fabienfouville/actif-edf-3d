"""Sonde de sources : interroge ENTSO-E et ODRÉ et écrit un résumé dans probe/.

Sert à explorer les jeux de données (noms de groupes, champs, volumes) depuis GitHub Actions,
qui a accès au réseau. Usage : python pipeline/probe.py
"""
import io
import json
import os
import traceback
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from datetime import timedelta

from common import ROOT, days_ago, http, http_json, now, save_json
from sources import FR_EIC, _strip_ns, env

OUT = os.path.join(ROOT, "probe")
ODRE = "https://odre.opendatasoft.com/api/explore/v2.1"


def entsoe(params, timeout=180):
    q = urllib.parse.urlencode({"securityToken": env("ENTSOE_TOKEN"), **params})
    return http("https://web-api.tp.entsoe.eu/api?" + q, timeout=timeout)


def series_units(raw):
    """Résumé des TimeSeries par groupe : nom, type, puissance moyenne."""
    root = _strip_ns(ET.fromstring(raw))
    out = {}
    for ts in root.findall("TimeSeries"):
        res = ts.find("MktPSRType/PowerSystemResources")
        name = res.findtext("name") if res is not None else None
        mrid = res.findtext("mRID") if res is not None else None
        psr = ts.findtext("MktPSRType/psrType")
        qs = [float(p.findtext("quantity")) for p in ts.iter("Point") if p.findtext("quantity")]
        key = mrid or name
        u = out.setdefault(key, {"name": name, "mrid": mrid, "psr": psr, "n": 0, "sum": 0.0, "max": 0.0})
        u["n"] += len(qs)
        u["sum"] += sum(qs)
        u["max"] = max([u["max"]] + qs)
    for u in out.values():
        u["mean"] = round(u["sum"] / u["n"], 1) if u["n"] else None
        del u["sum"]
    return sorted(out.values(), key=lambda u: (u["psr"] or "", u["name"] or ""))


def probe_entsoe(report):
    d0 = days_ago(2).replace(hour=0)
    d1 = d0 + timedelta(days=1)
    fmt = lambda t: f"{t:%Y%m%d%H%M}"
    # 1. production réalisée par groupe (16.1.A)
    try:
        raw = entsoe({"documentType": "A73", "processType": "A16", "in_Domain": FR_EIC,
                      "periodStart": fmt(d0), "periodEnd": fmt(d1)})
        report["entsoe_A73_bytes"] = len(raw)
        report["entsoe_A73_units"] = series_units(raw)
    except Exception as e:
        report["entsoe_A73_error"] = f"{e}"[:400]
    # 2. puissance installée par groupe (14.1.B)
    try:
        y = now().year
        raw = entsoe({"documentType": "A71", "processType": "A33", "in_Domain": FR_EIC,
                      "periodStart": f"{y}01010000", "periodEnd": f"{y}01020000"})
        report["entsoe_A71_units"] = series_units(raw)
    except Exception as e:
        report["entsoe_A71_error"] = f"{e}"[:400]
    # 3. puissance installée agrégée par filière (14.1.A)
    try:
        y = now().year
        raw = entsoe({"documentType": "A68", "processType": "A33", "in_Domain": FR_EIC,
                      "periodStart": f"{y}01010000", "periodEnd": f"{y}01020000"})
        report["entsoe_A68"] = [{"psr": u["psr"], "mw": u["max"]} for u in series_units(raw)]
    except Exception as e:
        report["entsoe_A68_error"] = f"{e}"[:400]
    # 4. indisponibilités des groupes de production (15.1.A/B)
    try:
        raw = entsoe({"documentType": "A80", "BiddingZone_Domain": FR_EIC,
                      "periodStart": fmt(d0), "periodEnd": fmt(d0 + timedelta(days=30))}, timeout=300)
        report["entsoe_A80_bytes"] = len(raw)
        docs = []
        if raw[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for nm in z.namelist()[:400]:
                    root = _strip_ns(ET.fromstring(z.read(nm)))
                    for ts in root.findall("TimeSeries"):
                        docs.append({
                            "unit": ts.findtext("production_RegisteredResource.pSRType.powerSystemResources.name")
                            or ts.findtext("production_RegisteredResource.name"),
                            "mrid": ts.findtext("production_RegisteredResource.pSRType.powerSystemResources.mRID"),
                            "psr": ts.findtext("production_RegisteredResource.pSRType.psrType"),
                            "nominal": ts.findtext("production_RegisteredResource.pSRType.powerSystemResources.nominalP"),
                            "start": ts.findtext("start_DateAndOrTime.date"),
                            "end": ts.findtext("end_DateAndOrTime.date"),
                            "reason": root.findtext("Reason/code"),
                            "avail": [p.findtext("quantity") for p in ts.iter("Point")][:3],
                        })
                report["entsoe_A80_files"] = len(z.namelist())
        else:
            report["entsoe_A80_head"] = raw[:600].decode("utf-8", "replace")
        report["entsoe_A80_sample"] = docs[:250]
    except Exception as e:
        report["entsoe_A80_error"] = f"{e}"[:400]


def probe_odre(report):
    found = {}
    for kw in ["registre", "installations", "parc", "puissance installée", "eco2mix"]:
        try:
            q = urllib.parse.urlencode({"where": f'search("{kw}")', "limit": 40, "select": "dataset_id"})
            d = http_json(f"{ODRE}/catalog/datasets?{q}")
            for r in d.get("results", []):
                found[r["dataset_id"]] = None
        except Exception as e:
            report.setdefault("odre_errors", []).append(f"{kw}: {e}"[:300])
    for ds in list(found):
        try:
            d = http_json(f"{ODRE}/catalog/datasets/{ds}")
            found[ds] = {"title": d.get("metas", {}).get("default", {}).get("title"),
                         "records": d.get("metas", {}).get("default", {}).get("records_count"),
                         "modified": d.get("metas", {}).get("default", {}).get("modified"),
                         "fields": [f["name"] for f in d.get("fields", [])][:40]}
        except Exception as e:
            found[ds] = {"error": f"{e}"[:200]}
    report["odre_datasets"] = found


def main():
    report = {"genere": now().isoformat()}
    for fn in (probe_entsoe, probe_odre):
        try:
            fn(report)
        except Exception:
            report[f"{fn.__name__}_crash"] = traceback.format_exc()[-800:]
    save_json(os.path.join(OUT, "report.json"), report, pretty=True)
    print(json.dumps({k: (v if not isinstance(v, (list, dict)) else f"{type(v).__name__}[{len(v)}]") for k, v in report.items()}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
