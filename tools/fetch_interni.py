#!/usr/bin/env python3
"""Data pump for the mayor's internal dashboard (web/interni/data.json).

Downloads from MONITOR (Czech State Treasury):
  1. monthly cumulative execution (cash flow) from 2022 on,
  2. expenditure history by budget paragraph from 2010 on (functional breakdown),
  3. benchmark of neighbouring municipalities (yearly totals, capital spend, population).

Note: MONITOR data are consolidated (internal transfers between funds removed).
"""
import json, sys, time, datetime, urllib.request
from pathlib import Path

API = "https://monitor.statnipokladna.gov.cz/api"
ICO = "00234125"
OUT = Path(__file__).resolve().parent.parent / "web" / "interni" / "data.json"

OBCE = [  # benchmark: Běloky + neighbours (company IDs verified in the ARES registry)
    {"ico": "00234125", "nazev": "Běloky"},
    {"ico": "00241695", "nazev": "Středokluky"},
    {"ico": "00234681", "nazev": "Makotřasy"},
    {"ico": "00234648", "nazev": "Lidice"},
    {"ico": "00234427", "nazev": "Hřebeč"},
    {"ico": "00241130", "nazev": "Číčovice"},
    {"ico": "00241377", "nazev": "Kněževes"},
]
ROKY_MESICNI = range(2022, 2027)
ROKY_ODVETVI = range(2010, 2027)
ROKY_BENCH = range(2019, 2026)


def get(path, quiet=False):
    req = urllib.request.Request(API + path, headers={"User-Agent": "beloky-interni/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except Exception as e:
        if not quiet:
            print(f"  ! {path}: {e}", file=sys.stderr)
        return None
    finally:
        time.sleep(0.12)


def lid(rok, mesic):
    return (rok % 100) * 100 + mesic


def rozpocet(ico, loadid):
    d = get(f"/rozpocet?obdobi={loadid}&ic={ico}", quiet=True)
    if not d or not d.get("incomes"):
        return None
    i, o = d["incomes"], d["outgoings"]
    if not (i["reality"] or o["reality"] or i["afterChanges"] or o["afterChanges"]):
        return None
    return {"p": i["reality"], "v": o["reality"], "p_rozp": i["afterChanges"], "v_rozp": o["afterChanges"],
            "p_schv": i["approved"], "v_schv": o["approved"]}


def investice(ico, loadid):
    d = get(f"/rozpocet/druhovy?obdobi={loadid}&ic={ico}&cast=v", quiet=True)
    for ch in (d or {}).get("children", []):
        if ch.get("code") == "6":
            return ch["budget"]["reality"]
    return 0.0


out = {"generovano": datetime.date.today().isoformat(), "ico": ICO}

# ---- 1) monthly cumulative figures ----
print("Monthly data…", file=sys.stderr)
mesicni = {}
for rok in ROKY_MESICNI:
    rada = []
    for m in range(1, 13):
        d = rozpocet(ICO, lid(rok, m))
        if d:
            rada.append({"m": m, **d})
    if rada:
        mesicni[str(rok)] = rada
        print(f"  {rok}: {len(rada)} months", file=sys.stderr)
out["mesicni"] = mesicni

# ---- 2) expenditure by paragraph 2010+ (functional breakdown) ----
print("Paragraph history…", file=sys.stderr)
posledni_mesic_2026 = max((r["m"] for r in mesicni.get("2026", [])), default=None)
odvetvi = {}
par_nazvy = {}
for rok in ROKY_ODVETVI:
    l = lid(rok, 12) if rok != 2026 else (lid(2026, posledni_mesic_2026) if posledni_mesic_2026 else None)
    if l is None:
        continue
    d = get(f"/rozpocet/odvetvovy?obdobi={l}&ic={ICO}&cast=v", quiet=True)
    if not d:
        continue
    leaves = {}
    def walk(n):
        code = str(n.get("code") or "")
        if len(code) == 4 and code.isdigit():
            b = n["budget"]
            if b["reality"] or b["afterChanges"]:
                leaves[code] = {"s": round(b["reality"], 2), "r": round(b["afterChanges"], 2)}
                par_nazvy.setdefault(code, n["name"])
            return
        for c in n.get("children", []):
            walk(c)
    walk(d)
    if leaves:
        odvetvi[str(rok)] = leaves
        print(f"  {rok}: {len(leaves)} paragraphs", file=sys.stderr)
out["odvetvi"] = odvetvi
out["par_nazvy"] = par_nazvy

# ---- 3) neighbour benchmark ----
print("Municipality benchmark…", file=sys.stderr)
sousede = []
for obec in OBCE:
    uj = get(f"/ucetni-jednotka/{obec['ico']}") or {}
    roky = {}
    for rok in ROKY_BENCH:
        d = rozpocet(obec["ico"], lid(rok, 12))
        if d:
            d["inv"] = round(investice(obec["ico"], lid(rok, 12)), 2)
            roky[str(rok)] = d
    sousede.append({**obec, "obyvatele": uj.get("population"), "roky": roky})
    print(f"  {obec['nazev']}: {len(roky)} years, population {uj.get('population')}", file=sys.stderr)
out["sousede"] = sousede

json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"WROTE {OUT}", file=sys.stderr)
