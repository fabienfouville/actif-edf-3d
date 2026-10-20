"""python -m unittest discover -s tests  (réponses HTTP simulées, pas de réseau)."""
import os
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import sources  # noqa: E402
from common import norm  # noqa: E402

UTC = timezone.utc
XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Publication_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:3">
 <TimeSeries><Period>
  <timeInterval><start>2026-10-14T22:00Z</start><end>2026-10-14T23:00Z</end></timeInterval>
  <resolution>PT15M</resolution>
  <Point><position>1</position><price.amount>40</price.amount></Point>
  <Point><position>3</position><price.amount>60</price.amount></Point>
 </Period></TimeSeries>
</Publication_MarketDocument>"""


class Pipeline(unittest.TestCase):
    def test_entsoe_courbe_a03(self):
        # position 2 omise = même prix que la 1 ; position 4 omise = même que la 3
        with mock.patch.object(sources, "http", return_value=XML):
            p = sources.entsoe_prices(datetime(2026, 10, 14, 22, tzinfo=UTC), datetime(2026, 10, 14, 23, tzinfo=UTC), "tok")
        self.assertEqual(p, {datetime(2026, 10, 14, 22, tzinfo=UTC): 50.0})

    def test_rapprochement_rte(self):
        h = datetime(2026, 10, 14, 0, tzinfo=UTC)
        raw = {norm(n): {h: v} for n, v in [("TRICASTIN 1", 900), ("TRICASTIN 2", 910), ("ST ALBAN 2", 1300),
                                             ("MARTIGUES 5", 400), ("MARTIGUES 6", 420), ("INCONNU 1", 5)]}
        cat = {"tranches": [{"id": "TRI1", "rte": "TRICASTIN 1"}, {"id": "TRI2", "rte": "TRICASTIN 2"}, {"id": "SAL2", "rte": "ST ALBAN 2"}],
               "assets": [{"id": "gaz-MAR", "filiere": "gaz", "rte": "MARTIGUES"}]}
        ser, unmatched = sources.match_units(raw, cat)
        self.assertEqual(ser["TRI2"][h], 910)
        self.assertEqual(ser["SAL2"][h], 1300)
        self.assertEqual(ser["gaz-MAR"][h], 820)
        self.assertEqual(unmatched, ["INCONNU 1"])

    def test_eco2mix_horaire(self):
        rows = [{"date_heure": "2026-10-14T10:00:00+00:00", "nucleaire": 40000, "consommation": 50000},
                {"date_heure": "2026-10-14T10:15:00+00:00", "nucleaire": 42000, "consommation": 52000},
                {"date_heure": "2026-10-14T10:30:00+00:00", "nucleaire": None, "consommation": 51000}]
        with mock.patch.object(sources, "http_json", side_effect=[rows, []]):
            out = sources.eco2mix(datetime(2026, 10, 14, tzinfo=UTC), datetime(2026, 10, 14, 23, tzinfo=UTC))
        h = datetime(2026, 10, 14, 10, tzinfo=UTC)
        self.assertEqual(out[h]["nucleaire"], 41000)
        self.assertEqual(out[h]["consommation"], 51000)


    def test_rapprochement_groupes_exacts(self):
        h = datetime(2026, 10, 14, 0, tzinfo=UTC)
        raw = {norm(n): {h: v} for n, v in [("SEYSSEL", 30), ("CHAUTAGNE", 60), ("SEYSSEL BIS", 9)]}
        cat = {"tranches": [], "assets": [{"id": "hyd-CNR", "filiere": "hydraulique", "rte": "SEYSSEL", "groupes_entsoe": ["SEYSSEL", "CHAUTAGNE"]}]}
        ser, unmatched = sources.match_units(raw, cat)
        self.assertEqual(ser["hyd-CNR"][h], 99)  # SEYSSEL BIS contient la clé
        self.assertEqual(unmatched, [])
        raw = {norm(n): {h: v} for n, v in [("BAYET", 300), ("FR GA MORANT1", 100), ("CERNAY", 5)]}
        cat = {"tranches": [], "assets": [{"id": "gaz-BAY", "filiere": "gaz", "rte": "BAYET", "cles_entsoe": ["BAYET", "MORANT"], "groupes_entsoe": ["BAYET"]}]}
        ser, unmatched = sources.match_units(raw, cat)
        self.assertEqual(ser["gaz-BAY"][h], 400)
        self.assertEqual(unmatched, ["CERNAY"])


class Indispos(unittest.TestCase):
    def test_lecture_message_a80(self):
        import indispos
        xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<Unavailability_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-6:outagedocument:3:0">
 <mRID>DOC1</mRID><revisionNumber>3</revisionNumber><docStatus><value>A05</value></docStatus>
 <TimeSeries><businessType>A53</businessType>
  <start_DateAndOrTime.date>2027-03-01</start_DateAndOrTime.date><start_DateAndOrTime.time>22:00:00Z</start_DateAndOrTime.time>
  <end_DateAndOrTime.date>2027-05-10</end_DateAndOrTime.date><end_DateAndOrTime.time>06:00:00Z</end_DateAndOrTime.time>
  <production_RegisteredResource.pSRType.powerSystemResources.mRID>17W100P100P0090I</production_RegisteredResource.pSRType.powerSystemResources.mRID>
  <production_RegisteredResource.pSRType.powerSystemResources.name>BELLEVILLE 1</production_RegisteredResource.pSRType.powerSystemResources.name>
  <production_RegisteredResource.pSRType.powerSystemResources.nominalP>1310</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
  <Available_Period><Point><position>1</position><quantity>0</quantity></Point></Available_Period>
 </TimeSeries>
 <Reason><code>B19</code><text>Visite partielle</text></Reason>
</Unavailability_MarketDocument>"""
        ev = indispos.parse(xml)
        self.assertEqual(len(ev), 1)
        e = ev[0]
        self.assertEqual((e["eic"], e["type"], e["rev"], e["dispo_mw"], e["pn"]), ("17W100P100P0090I", "planifiée", 3, 0.0, 1310.0))
        self.assertEqual((e["debut"], e["fin"], e["motif"]), ("2027-03-01T22:00Z", "2027-05-10T06:00Z", "Visite partielle"))


if __name__ == "__main__":
    unittest.main()
