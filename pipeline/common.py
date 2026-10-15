"""Outils partagés : HTTP, dates, fichiers mensuels. Bibliothèque standard uniquement."""
import json
import os
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SERIES = os.path.join(DATA, "series")
MIX_KEYS = ["consommation", "nucleaire", "hydraulique", "gaz", "charbon", "fioul",
            "eolien", "solaire", "bioenergies", "pompage", "ech_physiques"]
UA = "actif-edf-3d/1.0 (+https://github.com/fabienfouville/actif-edf-3d)"


def http(url, data=None, headers=None, tries=4, timeout=60):
    """GET/POST avec reprises exponentielles. Renvoie les octets de la réponse."""
    h = {"User-Agent": UA}
    h.update(headers or {})
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404) or i == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
        time.sleep(2 ** (i + 1))


def http_json(url, **kw):
    return json.loads(http(url, **kw).decode("utf-8"))


def utc(dt):
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_iso(s):
    return utc(datetime.fromisoformat(s.replace("Z", "+00:00")))


def iso(dt):
    return utc(dt).strftime("%Y-%m-%dT%H:%M:%SZ")


def hour_floor(dt):
    return utc(dt).replace(minute=0, second=0, microsecond=0)


def month_key(dt):
    return utc(dt).strftime("%Y-%m")


def month_start(key):
    y, m = map(int, key.split("-"))
    return datetime(y, m, 1, tzinfo=timezone.utc)


def month_hours(key):
    s = month_start(key)
    e = datetime(s.year + (s.month == 12), s.month % 12 + 1, 1, tzinfo=timezone.utc)
    return int((e - s).total_seconds() // 3600)


def norm(s):
    """Majuscules sans accents ni ponctuation, pour rapprocher les noms de groupes."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return " ".join("".join(c if c.isalnum() else " " for c in s.upper()).split())


def hourly_mean(points):
    """{datetime: valeur} à pas fin -> {heure: moyenne}."""
    acc = {}
    for t, v in points.items():
        if v is None:
            continue
        h = hour_floor(t)
        s, n = acc.get(h, (0.0, 0))
        acc[h] = (s + v, n + 1)
    return {h: s / n for h, (s, n) in acc.items()}


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj, pretty=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def empty_month(key):
    n = month_hours(key)
    return {"mois": key, "debut": iso(month_start(key)), "pas_s": 3600, "n": n,
            "sources": {}, "prix": [None] * n, "mix": {}, "units": {}}


def month_path(key):
    return os.path.join(SERIES, key + ".json")


def rnd(v, d=0):
    if v is None:
        return None
    return round(v, d) if d else int(round(v))


def months_between(start, end):
    keys, cur = [], datetime(start.year, start.month, 1, tzinfo=timezone.utc)
    while cur <= end:
        keys.append(month_key(cur))
        cur = datetime(cur.year + (cur.month == 12), cur.month % 12 + 1, 1, tzinfo=timezone.utc)
    return keys


def now():
    return datetime.now(timezone.utc)


def days_ago(n):
    return hour_floor(now() - timedelta(days=n))
