#!/usr/bin/env python3
"""Download the municipality's budget history from MONITOR (Czech State Treasury)
JSON API into web/historie.json and validate overlapping years against budget.json
(which is extracted from the FIN 2-12 M PDF statements).

API: https://monitor.statnipokladna.gov.cz/api (undocumented, used by their SPA).
Period = loadID in YYMM format; full-year data = YY12.
"""
import json, sys, urllib.request
from pathlib import Path

ICO = "00234125"
API = "https://monitor.statnipokladna.gov.cz/api"
FROM_YEAR = 2010
WEB = Path(__file__).resolve().parent.parent / "web"
OUT = WEB / "historie.json"
BUDGET = WEB / "budget.json"


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "beloky-rozpocet/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def investice(loadid):
    """Capital expenditure (budget class 6) from the economic breakdown."""
    try:
        d = get(f"/rozpocet/druhovy?obdobi={loadid}&ic={ICO}&cast=v")
        for ch in d.get("children", []):
            if ch.get("code") == "6":
                return ch["budget"]["reality"]
    except Exception:
        pass
    return 0.0


roky_api = sorted({o["year"] for o in get("/obdobi")
                   if o["year"] >= FROM_YEAR and o.get("loadID", 0) % 100 == 12})
hist = {}
for y in roky_api:
    lid = (y % 100) * 100 + 12
    try:
        d = get(f"/rozpocet?obdobi={lid}&ic={ICO}")
    except Exception as e:
        print(f"{y}: skipped ({e})", file=sys.stderr)
        continue
    inc, out = (d or {}).get("incomes"), (d or {}).get("outgoings")
    if not inc or not (inc["reality"] or out["reality"]):
        continue
    hist[str(y)] = {
        "prijmy_celkem": inc["reality"], "vydaje_celkem": out["reality"],
        "prijmy_rozpocet": inc["afterChanges"], "vydaje_rozpocet": out["afterChanges"],
        "prijmy_schvaleny": inc["approved"], "vydaje_schvaleny": out["approved"],
        "vydaje_investice": investice(lid),
    }
    print(f"{y}: revenue {inc['reality']:,.0f}  expenditure {out['reality']:,.0f}"
          f"  capital {hist[str(y)]['vydaje_investice']:,.0f}", file=sys.stderr)

json.dump({"ico": ICO, "zdroj": "monitor.statnipokladna.gov.cz", "roky": hist},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"WROTE {OUT} ({len(hist)} years)", file=sys.stderr)

# Validate overlapping years against the PDF extraction. MONITOR figures are
# consolidated (internal transfers between the municipality's funds removed),
# so a difference of the same amount on both sides is expected.
try:
    b = json.load(open(BUDGET))["roky"]
except FileNotFoundError:
    sys.exit(0)
for y, h in hist.items():
    if y not in b:
        continue
    for bk, hk in [("prijmy_celkem", "prijmy_celkem"), ("vydaje_celkem", "vydaje_celkem")]:
        dif = abs(b[y][bk] - h[hk])
        if dif > 1 and not (y == max(b) and b[y]["k"] and not b[y]["k"].startswith("31.12")):
            print(f"VALIDATION {y} {bk}: PDF {b[y][bk]:,.2f} vs MONITOR {h[hk]:,.2f} (Δ {dif:,.2f})",
                  file=sys.stderr)
