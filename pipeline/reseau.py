"""Réseau de transport RTE (ODRÉ) → data/grid.json : lignes 400 et 225 kV simplifiées, postes associés.

Les jeux ODRÉ « lignes aériennes », « lignes souterraines » et « postes électriques » de RTE sont
trouvés par recherche dans le catalogue, leurs champs lus à la volée (rapport dans probe/reseau.json),
puis exportés en GeoJSON. Les tracés sont arrondis à 0,01° et décimés pour rester légers.

Usage : python pipeline/reseau.py   (réseau requis, lancé dans GitHub Actions)
"""
import json
import os
import re
import urllib.parse

from common import DATA, ROOT, http_json, iso, now, save_json

ODRE = "https://odre.opendatasoft.com/api/explore/v2.1"


def search(words):
    q = urllib.parse.urlencode({"where": " and ".join(f'search("{w}")' for w in words), "limit": 20, "select": "dataset_id"})
    return [r["dataset_id"] for r in http_json(f"{ODRE}/catalog/datasets?{q}").get("results", [])]


def fields(ds):
    d = http_json(f"{ODRE}/catalog/datasets/{ds}")
    return [(f["name"], f.get("type")) for f in d.get("fields", [])], d.get("metas", {}).get("default", {}).get("records_count")


def kv(v):
    """Tension en kV à partir d'un libellé (« 400kV », « 225 KV », 400…)."""
    m = re.search(r"(\d{2,3})", str(v or ""))
    return int(m.group(1)) if m else None


def geo_export(ds, where=None):
    q = {"limit": -1}
    if where:
        q["where"] = where
    return http_json(f"{ODRE}/catalog/datasets/{ds}/exports/geojson?{urllib.parse.urlencode(q)}", timeout=300)


def simplify(coords, step=0.01):
    out = []
    for lon, lat in coords:
        p = [round(lon, 2), round(lat, 2)]
        if not out or abs(p[0] - out[-1][0]) >= step or abs(p[1] - out[-1][1]) >= step:
            out.append(p)
    if out and coords and out[-1] != [round(coords[-1][0], 2), round(coords[-1][1], 2)]:
        out.append([round(coords[-1][0], 2), round(coords[-1][1], 2)])
    return out


def lines_of(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def main():
    report = {"genere": iso(now()), "candidats": {}}
    cands = {}
    for key, words in {"aerien": ["lignes", "aériennes", "RTE"], "souterrain": ["lignes", "souterraines", "RTE"],
                       "postes": ["postes", "électriques", "RTE"]}.items():
        try:
            ids = search(words)
        except Exception as e:  # noqa: BLE001
            report["candidats"][key] = f"erreur : {e}"[:200]
            continue
        report["candidats"][key] = ids
        for ds in ids:
            if ds in cands:
                continue
            try:
                f, n = fields(ds)
                cands[ds] = {"champs": f, "lignes": n}
            except Exception as e:  # noqa: BLE001
                cands[ds] = {"erreur": str(e)[:200]}
    report["jeux"] = cands
    pick = lambda pat: next((ds for ds in cands if re.search(pat, ds) and "champs" in cands[ds]), None)
    ds_air, ds_sout, ds_post = pick(r"ligne.*aerien"), pick(r"ligne.*souterrain"), pick(r"poste")
    report["choisis"] = {"aerien": ds_air, "souterrain": ds_sout, "postes": ds_post}

    lignes, postes = [], []
    for ds in (ds_air, ds_sout):
        if not ds:
            continue
        tfield = next((n for n, _ in cands[ds]["champs"] if "tension" in n.lower()), None)
        try:
            gj = geo_export(ds)
        except Exception as e:  # noqa: BLE001
            report[f"erreur_{ds}"] = str(e)[:300]
            continue
        report[f"exemple_{ds}"] = (gj.get("features") or [{}])[0].get("properties")
        for f in gj.get("features", []):
            t = kv((f.get("properties") or {}).get(tfield)) if tfield else None
            if t not in (400, 225):
                continue
            for c in lines_of(f.get("geometry")):
                s = simplify(c)
                if len(s) >= 2:
                    lignes.append({"kv": t, "c": s, "s": "souterrain" if ds == ds_sout else "aerien"})
    if ds_post:
        try:
            gj = geo_export(ds_post)
            report["exemple_postes"] = (gj.get("features") or [{}])[0].get("properties")
            for f in gj.get("features", []):
                p, g = f.get("properties") or {}, f.get("geometry") or {}
                tv = max([kv(v) or 0 for k, v in p.items() if "tension" in k.lower()] or [0])
                if tv < 225 or g.get("type") != "Point":
                    continue
                nom = next((v for k, v in p.items() if k.lower() in ("nom_poste", "nom", "libelle", "nom_du_poste")), None)
                lon, lat = g["coordinates"][:2]
                postes.append({"nom": nom, "kv": tv, "lon": round(lon, 3), "lat": round(lat, 3)})
        except Exception as e:  # noqa: BLE001
            report["erreur_postes"] = str(e)[:300]

    os.makedirs(os.path.join(ROOT, "probe"), exist_ok=True)
    save_json(os.path.join(ROOT, "probe", "reseau.json"), report, pretty=True)
    if lignes:
        save_json(f"{DATA}/grid.json", {
            "_doc": "Réseau de transport RTE 400 et 225 kV (ODRÉ, Licence Ouverte), tracés simplifiés à 0,01°.",
            "genere": iso(now()), "sources": report["choisis"], "lignes": lignes, "postes": postes}, pretty=False)
    print(json.dumps({"choisis": report["choisis"], "lignes": len(lignes), "postes": len(postes)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
