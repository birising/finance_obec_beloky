#!/usr/bin/env python3
"""Open-data pump for the economic analysis page (web/interni/hospodareni-2026.html).

Downloads from MONITOR (Czech State Treasury, consolidated data):
  1. item-level economic breakdown (druhové členění) of revenue and expenditure, 2010+,
  2. population per year (as stored by MONITOR for each period),
  3. year-end bank balances and debt (vyvoj-dluh-stav-bu),
  4. functional breakdown (odvětvové členění, paragraphs) of the neighbouring
     municipalities used as a benchmark.

Output: data/monitor/hospodareni.json (public data only, safe to commit).
"""
import json, sys, time, datetime, urllib.request
from pathlib import Path

API = "https://monitor.statnipokladna.gov.cz/api"
ICO = "00234125"
FROM_YEAR = 2010
BENCH = {  # same neighbours as the internal dashboard (company IDs verified in ARES)
    "00234125": "Běloky", "00241695": "Středokluky", "00234681": "Makotřasy", "00234648": "Lidice",
    "00234427": "Hřebeč", "00241130": "Číčovice", "00241377": "Kněževes",
}
BENCH_YEARS = (2023, 2024, 2025)
OUT = Path(__file__).resolve().parent.parent / "data" / "monitor" / "hospodareni.json"


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "beloky-rozpocet/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception as e:
            err = e
            time.sleep(1 + attempt)
        finally:
            time.sleep(0.12)
    print(f"  ! {path}: {err}", file=sys.stderr)
    return None


def leaves(node, out):
    """Collect 4-digit items (leaf level) -> {code: actual}."""
    kids = node.get("children") or []
    code = str(node.get("code") or "")
    if len(code) == 4 and code.isdigit():
        out[code] = out.get(code, 0.0) + (node.get("budget") or {}).get("reality", 0.0)
        return out
    for k in kids:
        leaves(k, out)
    return out


def paragraphs(node, out):
    kids = node.get("children") or []
    code = str(node.get("code") or "")
    if len(code) == 4 and code.isdigit():
        b = node.get("budget") or {}
        out[code] = {"s": b.get("reality", 0.0), "r": b.get("afterChanges", 0.0)}
        return out
    for k in kids:
        paragraphs(k, out)
    return out


periods = get("/obdobi") or []
last_loaded = max((o["loadID"] for o in periods
                   if o.get("finM") and o["year"] == datetime.date.today().year), default=None)
years = sorted({o["year"] for o in periods if o["year"] >= FROM_YEAR and o["loadID"] % 100 == 12
                and o["year"] < datetime.date.today().year})

out = {"generovano": datetime.date.today().isoformat(), "ico": ICO, "zdroj": "monitor.statnipokladna.gov.cz",
       "druhove": {}, "obyvatele": {}, "stav_uctu": {}, "bench": {}}

print("Economic breakdown…", file=sys.stderr)
loads = [(str(y), (y % 100) * 100 + 12) for y in years]
if last_loaded:
    loads.append((f"{last_loaded // 100 + 2000}-{last_loaded % 100:02d}", last_loaded))
# same period of the previous year as the latest FIN statement (year-on-year comparison)
_k = json.load(open(Path(__file__).resolve().parent.parent / "web" / "budget.json"))["roky"]
_cur = int(max(_k))
_m = int(_k[str(_cur)]["k"].split(".")[1])
_extra = set()
if _m < 12:
    for _y in (_cur - 1, _cur - 2):
        _extra.add((_y, _m))
# split month of the comparison "before / after the mayor took office" (21 Apr 2026 -> end of April)
SPLIT_MONTH = 4
for _y in (_cur, _cur - 1, _cur - 2):
    _extra.add((_y, SPLIT_MONTH))
# all loaded months of the current year (cash trajectory)
for o in periods:
    if o["year"] == _cur and o.get("finM") and o["loadID"] % 100 < 12:
        _extra.add((_cur, o["loadID"] % 100))
for _y, _mm in sorted(_extra):
    key = f"{_y}-{_mm:02d}"
    if key not in dict(loads):
        loads.append((key, (_y % 100) * 100 + _mm))
for key, lid in loads:
    rec = {}
    for cast, sec in (("p", "prijmy"), ("v", "vydaje")):
        d = get(f"/rozpocet/druhovy?obdobi={lid}&ic={ICO}&cast={cast}")
        rec[sec] = {k: round(v, 2) for k, v in sorted(leaves(d or {}, {}).items()) if abs(v) > 0.004}
    if not rec["prijmy"] and not rec["vydaje"]:
        print(f"  {key}: no data, skipped", file=sys.stderr)
        continue
    if len(key) > 4:   # monthly periods: functional breakdown too
        d = get(f"/rozpocet/odvetvovy?obdobi={lid}&ic={ICO}&cast=v")
        rec["paragrafy"] = {k: round(v["s"], 2) for k, v in sorted(paragraphs(d or {}, {}).items()) if abs(v["s"]) > 0.004}
    out["druhove"][key] = rec
    ent = get(f"/ucetni-jednotka/{ICO}?obdobi={lid}") or {}
    if ent.get("population"):
        out["obyvatele"][key[:4]] = ent["population"]
    print(f"  {key}: {len(rec['prijmy'])} revenue items, {len(rec['vydaje'])} expenditure items, "
          f"population {ent.get('population')}", file=sys.stderr)

for r in get(f"/ucetni-jednotka/vyvoj-dluh-stav-bu?ic={ICO}") or []:
    out["stav_uctu"][str(r["year"])] = {"zustatek": r["balanceTotal"], "dluh": r["deptTotal"]}

print("Neighbour benchmark (functional breakdown)…", file=sys.stderr)
for ico, name in BENCH.items():
    b = {"nazev": name, "roky": {}}
    for y in BENCH_YEARS:
        lid = (y % 100) * 100 + 12
        d = get(f"/rozpocet/odvetvovy?obdobi={lid}&ic={ico}&cast=v")
        dp = get(f"/rozpocet/druhovy?obdobi={lid}&ic={ico}&cast=p")
        dv = get(f"/rozpocet/druhovy?obdobi={lid}&ic={ico}&cast=v")
        ent = get(f"/ucetni-jednotka/{ico}?obdobi={lid}") or {}
        b["roky"][str(y)] = {"obyvatele": ent.get("population"),
                             "paragrafy": {k: v["s"] for k, v in paragraphs(d or {}, {}).items() if abs(v["s"]) > 0.004},
                             "prijmy": {k: round(v, 2) for k, v in leaves(dp or {}, {}).items() if abs(v) > 0.004},
                             "vydaje": {k: round(v, 2) for k, v in leaves(dv or {}, {}).items() if abs(v) > 0.004}}
    out["bench"][ico] = b
    print(f"  {name}: {', '.join(f'{y}: {len(v['paragrafy'])} §' for y, v in b['roky'].items())}", file=sys.stderr)

OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"WROTE {OUT}", file=sys.stderr)
