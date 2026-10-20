"""Indisponibilités des groupes de production (ENTSO-E 15.1.A/B, document A80) → data/indispos.json.

Chaque message REMIT donne un groupe (code EIC), une période, le type (planifiée A53 / fortuite A54)
et la puissance encore disponible. On garde la dernière révision de chaque message, sans les
messages annulés, sur une fenêtre de 13 mois passés à 12 mois à venir, et on les rattache aux
tranches et centrales du catalogue par le code EIC (même identifiant que la production par unité).

Usage : python pipeline/indispos.py   (réseau et ENTSOE_TOKEN requis, lancé dans GitHub Actions)
"""
import io
import json
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from datetime import timedelta

from common import DATA, days_ago, http, iso, load_json, now, save_json
from sources import FR_EIC, _strip_ns, env

API = "https://web-api.tp.entsoe.eu/api"
TYPES = {"A53": "planifiée", "A54": "fortuite"}
PREFIX = "production_RegisteredResource.pSRType.powerSystemResources."


def fetch(doc, start, end, token, offset=0):
    q = urllib.parse.urlencode({"securityToken": token, "documentType": doc, "BiddingZone_Domain": FR_EIC,
                                "periodStart": f"{start:%Y%m%d%H%M}", "periodEnd": f"{end:%Y%m%d%H%M}", "offset": offset})
    try:
        return http(f"{API}?{q}", timeout=300)
    except urllib.error.HTTPError as e:
        body = e.read()[:600].decode("utf-8", "replace")
        if "No matching data" in body:
            return b""
        raise RuntimeError(f"HTTP {e.code} : {body}") from None


def xml_docs(raw):
    if not raw:
        return []
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            return [z.read(n) for n in z.namelist()]
    return [raw]


def text(el, path):
    v = el.find(path)
    return v.text if v is not None else None


def parse(xml):
    root = _strip_ns(ET.fromstring(xml))
    if root.tag != "Unavailability_MarketDocument":
        return []
    out = []
    for ts in root.findall("TimeSeries"):
        def dt(prefix):
            d, t = text(ts, f"{prefix}_DateAndOrTime.date"), text(ts, f"{prefix}_DateAndOrTime.time") or "00:00:00Z"
            return f"{d}T{t[:5]}Z" if d else None
        qs = [float(p.findtext("quantity")) for p in ts.iter("Point") if p.findtext("quantity")]
        out.append({
            "doc": text(root, "mRID"), "rev": int(text(root, "revisionNumber") or 0), "statut": text(root, "docStatus/value"),
            "eic": text(ts, PREFIX + "mRID"), "nom": text(ts, PREFIX + "name"), "pn": float(text(ts, PREFIX + "nominalP") or 0),
            "type": TYPES.get(text(ts, "businessType"), text(ts, "businessType")), "debut": dt("start"), "fin": dt("end"),
            "dispo_mw": min(qs) if qs else None, "motif": text(root, "Reason/text") or text(ts, "Reason/text"),
        })
    return out


def collect(token, start, end, doc="A80"):
    """Pages de 200 documents, par trimestre (fenêtre maximale d'un an, offset ≤ 4 800)."""
    events, t = [], start
    while t < end:
        t2 = min(t + timedelta(days=91), end)
        for off in range(0, 5000, 200):
            docs = xml_docs(fetch(doc, t, t2, token, off))
            for x in docs:
                events += parse(x)
            if len(docs) < 200:
                break
        t = t2
    return events


def main():
    token = env("ENTSOE_TOKEN")
    if not token:
        print("ENTSOE_TOKEN absent : rien à faire")
        return
    start, end = days_ago(400).replace(hour=0, minute=0), now().replace(hour=0, minute=0) + timedelta(days=366)
    raw = collect(token, start, end)
    # dernière révision de chaque message, hors messages annulés ou retirés
    last = {}
    for e in raw:
        k = (e["doc"], e["eic"])
        if k not in last or e["rev"] > last[k]["rev"]:
            last[k] = e
    events = [e for e in last.values() if e["statut"] not in ("A09", "A13") and e["debut"] and e["fin"] and e["eic"]]
    # rattachement aux tranches et aux centrales par l'EIC des groupes
    by_eic = {}
    for t in load_json(f"{DATA}/edf_tranches.json")["tranches"]:
        if t.get("eic"):
            by_eic[t["eic"]] = t["id"]
    for a in load_json(f"{DATA}/assets.json")["assets"]:
        for u in a.get("unites") or []:
            by_eic.setdefault(u["eic"], a["id"])
    par_id, hors = {}, {}
    for e in sorted(events, key=lambda e: e["debut"]):
        ev = {k: e[k] for k in ("debut", "fin", "type", "dispo_mw", "pn", "motif", "nom")}
        if e["eic"] in by_eic:
            par_id.setdefault(by_eic[e["eic"]], []).append(ev)
        else:
            hors[e["nom"] or e["eic"]] = hors.get(e["nom"] or e["eic"], 0) + 1
    save_json(f"{DATA}/indispos.json", {
        "_doc": "Indisponibilités des groupes (ENTSO-E 15.1.A/B, A80), dernière révision de chaque message. dispo_mw = puissance encore disponible.",
        "genere": iso(now()), "fenetre": [iso(start), iso(end)], "messages": len(raw), "evenements": len(events),
        "par_id": par_id, "non_rapproches": dict(sorted(hors.items(), key=lambda x: -x[1])[:40])}, pretty=False)
    print(json.dumps({"messages": len(raw), "evenements": len(events), "rattaches": sum(map(len, par_id.values())),
                      "ids": len(par_id), "non_rapproches": len(hors)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
