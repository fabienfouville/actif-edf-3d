"""Reconstruit data/assets.json et data/edf_tranches.json à partir des sources officielles.

Entrées :
- data/reference.json : sources officielles collectées par catalog.py (ENTSO-E, registre, ODRÉ).
- data/catalog_map.json : la liste des centrales affichées, leurs clés de rapprochement avec les
  groupes ENTSO-E, et les champs vérifiés à la main (coordonnées, exploitant, statut) avec leur source.

Règles :
- puissance = somme des unités ENTSO-E 14.1.B rapprochées (source officielle), sinon valeur de la carte ;
- commune et région = registre national quand le code EIC y figure ;
- éolien terrestre et solaire par région = parc ODRÉ de la dernière année publiée.

Usage : python pipeline/build_catalog.py   (hors ligne, après catalog.py)
"""
import json
import math

from common import DATA, load_json, norm, save_json

REG_CODE = {"HDF": "Hauts-de-France", "NOR": "Normandie", "IDF": "Île-de-France", "GES": "Grand Est", "BRE": "Bretagne",
            "PDL": "Pays de la Loire", "CVL": "Centre-Val de Loire", "BFC": "Bourgogne-Franche-Comté",
            "NAQ": "Nouvelle-Aquitaine", "ARA": "Auvergne-Rhône-Alpes", "OCC": "Occitanie",
            "PAC": "Provence-Alpes-Côte d'Azur", "COR": "Corse"}
CENTRES = {"HDF": (49.97, 2.78), "NOR": (49.12, 0.11), "IDF": (48.70, 2.50), "GES": (48.70, 5.60), "BRE": (48.15, -2.85),
           "PDL": (47.40, -0.80), "CVL": (47.50, 1.70), "BFC": (47.20, 4.80), "NAQ": (45.20, 0.20), "ARA": (45.50, 4.50),
           "OCC": (43.70, 2.20), "PAC": (43.95, 6.10), "COR": (42.15, 9.10)}


def matches(keys, name):
    n = norm(name or "")
    return any(k in n for k in keys)


def main():
    ref = load_json(f"{DATA}/reference.json")
    cmap = load_json(f"{DATA}/catalog_map.json")
    a71 = list(ref["unites_entsoe"].values())
    a73 = list(ref["groupes_entsoe"].values())
    communes = ref.get("communes", {})
    date_ref = ref["genere"][:10]

    def official(keys, exclude=()):
        units = [u for u in a71 if matches(keys, u["nom_entsoe"]) and not matches(exclude, u["nom_entsoe"])]
        gens = [g for g in a73 if matches(keys, g["nom"]) and not matches(exclude, g["nom"])]
        insee = next((u.get("insee") for u in units + gens if u.get("insee")), None)
        return units, gens, insee

    fam = {"hydraulique": "Hydraulique", "gaz": "Thermique non renouvelable", "charbon": "Thermique non renouvelable",
           "fioul": "Thermique non renouvelable", "eolien": "Eolien", "solaire": "Solaire", "bioenergies": "Bioénergies"}

    def registre_rows(keys, filiere):
        return [r for r in ref["registre"] if r.get("filiere") == fam.get(filiere) and r.get("commune")
                and any(f"DE {k}" in norm(r.get("nominstallation") or "") for k in keys)]

    def registre_by_name(keys, filiere):
        rows = registre_rows(keys, filiere)
        return rows[0] if rows else None

    def check_position(a, verif, insee):
        """Écart entre la position de la carte et le centre de la commune d'implantation (geo.api.gouv.fr)."""
        c = communes.get(insee) or {}
        if "lat" not in c or a.get("type") == "offshore":
            return
        d = math.hypot(a["lat"] - c["lat"], (a["lon"] - c["lon"]) * math.cos(math.radians(c["lat"]))) * 111
        verif["coordonnees"] = (f"relevées à la main, à {d:.0f} km du centre de la commune ({c['nom']}, geo.api.gouv.fr)"
                                if d <= 15 else f"à vérifier : {d:.0f} km du centre de la commune {c['nom']}")

    assets, report = [], []
    # ------------------------------------------------------------ centrales hors nucléaire
    for c in cmap["centrales"]:
        keys = [norm(k) for k in c.get("cles", [])]
        units, gens, insee = official(keys, [norm(x) for x in c.get("exclure", [])]) if keys else ([], [], None)
        a = {k: v for k, v in c.items() if k not in ("cles", "cles_registre", "exclure", "verif")}
        verif = dict(c.get("verif", {}))
        rkeys = [norm(k) for k in c.get("cles_registre", [])] or keys or [norm(c["nom"].split(" (")[0])]
        rrows = registre_rows(rkeys, c["filiere"]) if len(rkeys) <= 2 else []
        if units and not c.get("p_mw_manuel"):
            a["p_mw"] = round(sum(u["p_mw"] for u in units))
            a["unites"] = [{"nom": u["nom_entsoe"], "eic": u["eic"], "p_mw": round(u["p_mw"])} for u in sorted(units, key=lambda u: u["nom_entsoe"])]
            verif["puissance"] = f"ENTSO-E 14.1.B (puissance installée par unité), relevé du {date_ref}"
        elif rrows and not c.get("p_mw_manuel"):
            # groupes de moins de 100 MW, absents d'ENTSO-E : puissance du registre national
            a["p_mw"] = round(sum(float(r.get("puismaxinstallee") or 0) for r in rrows) / 1000)
            verif["puissance"] = "Registre national des installations (ODRÉ) : " + " + ".join(r["nominstallation"] for r in rrows)
        elif "p_mw" in a:
            verif.setdefault("puissance", "valeur de la carte, non publiée par unité sur ENTSO-E")
        if keys:
            a["rte"] = c["cles"][0]
            a["cles_entsoe"] = keys
            a["groupes_entsoe"] = sorted({g["nom"] for g in gens}) or None
            a["eic"] = sorted({u["eic"] for u in units}) or None
        if insee and insee in communes and "nom" in communes[insee]:
            a["commune"] = communes[insee]["nom"]
            verif["commune"] = f"Registre national des installations (ODRÉ), code EIC rapproché"
        elif rrows:
            # le registre code l'hydraulique avec un autre EIC qu'ENTSO-E : rapprochement par le nom de l'installation
            r = rrows[0]
            if r:
                insee = r.get("codeinseecommuneimplantation") or r.get("codeinseecommune")
                a["commune"] = communes.get(insee, {}).get("nom") or r["commune"]
                verif["commune"] = f"Registre national des installations (ODRÉ), « {r['nominstallation']} »"
        check_position(a, verif, insee)
        a["verif"] = verif
        a = {k: v for k, v in a.items() if v is not None}
        assets.append(a)
        report.append((a["id"], a.get("p_mw"), len(units), len(gens), a.get("commune")))

    # ------------------------------------------------------------ nucléaire : sites et tranches
    tranches = []
    for s in cmap["nucleaire"]:
        ids = []
        for num, coupl in s["tranches"]:
            key = norm(f'{s["cle"]} {num}')
            u = next((x for x in a71 if norm(x["nom_entsoe"]) == key), None)
            tid = f'{s["code"]}{num}'
            ids.append(tid)
            tranches.append({
                "id": tid, "site": f'nuc-{s["code"]}', "nom": f'{s["nom"]} {num}', "num": num,
                "palier": s.get("paliers", {}).get(str(num), s["palier"]), "p_net_mw": round(u["p_mw"]) if u else s.get("p_defaut"),
                "couplage": coupl, "fin_vie_hyp": coupl + 60, "rte": f'{s["cle"]} {num}', "eic": u["eic"] if u else None,
                "verif": {"puissance": f"ENTSO-E 14.1.B, relevé du {date_ref}" if u else "non trouvée sur ENTSO-E",
                          "couplage": "WNA / IAEA PRIS, recoupé (vérification du 16/10/2026)",
                          "palier": "ASN, WNA (vérification du 16/10/2026)"}})
        units, gens, insee = official([norm(s["cle"])])
        assets.append({"id": f'nuc-{s["code"]}', "nom": s["nom"], "filiere": "nucleaire", "type": "REP", "exploitant": "EDF",
                       "region": REG_CODE[s["reg"]], "lat": s["lat"], "lon": s["lon"],
                       "p_mw": sum(t["p_net_mw"] for t in tranches if t["site"] == f'nuc-{s["code"]}'), "tranches": ids,
                       "commune": communes.get(insee, {}).get("nom"),
                       "verif": {"coordonnees": "Wikipédia / WNA, à ±0,01° (vérification du 16/10/2026)",
                                 "puissance": f"somme des tranches, ENTSO-E 14.1.B, relevé du {date_ref}",
                                 "commune": "Registre national des installations (ODRÉ)"}})
        check_position(assets[-1], assets[-1]["verif"], insee)

    # ------------------------------------------------------------ éolien terrestre et solaire par région (ODRÉ)
    # le parc régional ODRÉ inclut l'éolien en mer (somme des régions = total national) : on retire les
    # parcs en mer déjà listés et mis en service avant la fin de l'année publiée
    pr = ref.get("parc_regional", {})
    annee = int(pr.get("annee") or 0)
    en_mer = {}
    for a in assets:
        if a["filiere"] == "eolien" and a.get("type") == "offshore" and a.get("mise_service", 9999) <= annee:
            en_mer[a["region"]] = en_mer.get(a["region"], 0) + a.get("p_mw", 0)
    for code, nom in REG_CODE.items():
        r = pr.get("regions", {}).get(nom, {})
        la, lo = CENTRES[code]
        for f, typ, dx in (("eolien", "terrestre (agrégat régional)", -0.38), ("solaire", "photovoltaïque (agrégat régional)", 0.38)):
            mw = r.get(f)
            if not mw:
                continue
            if f == "eolien":
                mw -= en_mer.get(nom, 0)
            assets.append({"id": f'{"eol" if f == "eolien" else "sol"}-R{code}', "nom": f'{"Éolien terrestre" if f == "eolien" else "Solaire"} · {nom}',
                           "filiere": f, "type": typ, "exploitant": "multiples", "region": nom,
                           "lat": round(la + (0.12 if f == "eolien" else -0.12), 2), "lon": round(lo + dx, 2), "p_mw": round(mw),
                           "verif": {"puissance": f"ODRÉ, parc régional annuel éolien et solaire, fin {pr.get('annee')}"
                                     + (f", moins {round(en_mer[nom])} MW en mer listés à part" if f == "eolien" and en_mer.get(nom) else "")},
                           "note": f"Agrégat régional : parc installé fin {pr.get('annee')} (ODRÉ)."})
    save_json(f"{DATA}/assets.json", {"_doc": "Catalogue des actifs. Généré par pipeline/build_catalog.py depuis ENTSO-E, le registre national (ODRÉ) et data/catalog_map.json. Chaque actif porte ses sources dans « verif ».",
                                     "genere": date_ref, "assets": assets}, pretty=True)
    save_json(f"{DATA}/edf_tranches.json", {"_doc": "57 réacteurs EDF en exploitation. Puissance nette : ENTSO-E 14.1.B. Couplage : WNA / IAEA PRIS. fin_vie_hyp = hypothèse 60 ans.",
                                           "genere": date_ref, "tranches": tranches}, pretty=True)
    for row in report:
        print(*row)
    print("actifs :", len(assets), "· tranches :", len(tranches), "· nucléaire :", sum(t["p_net_mw"] for t in tranches), "MW")


if __name__ == "__main__":
    main()
