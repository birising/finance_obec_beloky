#!/usr/bin/env python3
"""Computations for the internal economic analysis page (see build_hospodareni.py).

Everything here is derived from repository data:
  data/monitor/hospodareni.json  MONITOR open data, consolidated, item level (fetch_hospodareni.py)
  web/budget.json                FIN 2-12 M statements 2022–2026 (extract_budget.py)
  web/interni/data.json          monthly cumulatives from MONITOR (fetch_interni.py)
  web/odpady.json                waste management series
  data/odpady/*denik*            accounting journals 2023–2025 (local only, via parse_deniky.py)

Run directly to print the key figures for a sanity check.
"""
import json, re, sys, collections
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE / "tools"))
import parse_deniky as PD  # noqa: E402

M = json.load(open(BASE / "data" / "monitor" / "hospodareni.json"))
B = json.load(open(BASE / "web" / "budget.json"))["roky"]
D = json.load(open(BASE / "web" / "interni" / "data.json"))
O = json.load(open(BASE / "web" / "odpady.json"))

CUR = "2026"
R = B[CUR]
ASOF = "30. 9. 2026"
MONTHS = 9
GRANT = 672000.0                       # 4213 SZIF grant reported in the 9/2026 statement (receipt to be confirmed)
INTERNAL_REV, INTERNAL_EXP = ("4134",), ("5348",)   # transfers between own accounts (cash desk)

# Average annual CPI (ČSÚ), used to express amounts in 2025 prices; 2026 = 12-month average to 8/2026
CPI = {2010: 1.5, 2011: 1.9, 2012: 3.3, 2013: 1.4, 2014: 0.4, 2015: 0.3, 2016: 0.7, 2017: 2.5, 2018: 2.1,
       2019: 2.8, 2020: 3.2, 2021: 3.8, 2022: 15.1, 2023: 10.7, 2024: 2.4, 2025: 2.5, 2026: 2.0}
DEFL = {2025: 1.0}
for _y in range(2024, 2009, -1):
    DEFL[_y] = DEFL[_y + 1] * (1 + CPI[_y + 1] / 100)
DEFL[2026] = 1 / (1 + CPI[2026] / 100)

YEARS = [y for y in sorted(M["druhove"]) if len(y) == 4]   # full years 2010–2025
PREV_YTD = M["druhove"][f"{int(CUR) - 1}-{MONTHS:02d}"]      # same period of the previous year (MONITOR)
POP = {y: M["obyvatele"][y] for y in YEARS}
POP[CUR] = B[CUR].get("obyvatele") or 181

# ---------- classification ----------
REV_GROUPS = [  # key, label
    ("dpfo", "Daně z příjmů fyzických osob"), ("dppo", "Daň z příjmů právnických osob"), ("dph", "DPH"),
    ("dnem", "Daň z nemovitých věcí"), ("popl", "Místní poplatky a ostatní daně"), ("neda", "Nedaňové příjmy"),
    ("transb", "Neinvestiční dotace"), ("kap", "Kapitálové příjmy a investiční dotace"),
]
EXP_GROUPS = [
    ("sluzby", "Nakupované služby (516x)"), ("osobni", "Osobní výdaje a odměny (50xx)"),
    ("material", "Materiál a drobný majetek (513x)"), ("energie", "Energie a PHM (515x)"),
    ("opravy", "Opravy a údržba (517x)"), ("ostatni", "Transfery a ostatní"), ("invest", "Investice (6xxx)"),
]


def rev_group(code):
    if code in ("1111", "1112", "1113"): return "dpfo"
    if code in ("1121",): return "dppo"
    if code == "1211": return "dph"
    if code == "1511": return "dnem"
    if code[0] == "1": return "popl"
    if code[0] == "2": return "neda"
    if code[0] == "3" or code[:2] == "42": return "kap"
    if code[:2] == "41": return "transb"
    return "neda"


def exp_group(code):
    if code[0] == "6": return "invest"
    if code[:2] == "50": return "osobni"
    if code[:3] == "513": return "material"
    if code[:3] == "515": return "energie"
    if code[:3] == "516": return "sluzby"
    if code[:3] == "517": return "opravy"
    return "ostatni"


def fin_items(year, sec):
    """FIN statement items -> {code: actual}, internal transfers removed (= consolidated like MONITOR)."""
    out = collections.Counter()
    for g in B[year][sec]:
        for p in g["polozky"]:
            if p["kod"] in INTERNAL_REV + INTERNAL_EXP:
                continue
            out[p["kod"]] += p["skutecnost"]
    return out


def series():
    """Yearly consolidated figures 2010–2025 (MONITOR) + 2026 year-to-date (FIN)."""
    rows = {}
    src = {y: (M["druhove"][y]["prijmy"], M["druhove"][y]["vydaje"]) for y in YEARS}
    src[CUR] = (fin_items(CUR, "prijmy"), fin_items(CUR, "vydaje"))
    for y, (pi, vi) in src.items():
        rg, eg = collections.Counter(), collections.Counter()
        for c, v in pi.items(): rg[rev_group(c)] += v
        for c, v in vi.items(): eg[exp_group(c)] += v
        P, V = sum(pi.values()), sum(vi.values())
        inv = eg["invest"]
        cur_rev = P - rg["kap"]
        cur_exp = V - inv
        rows[y] = {"P": P, "V": V, "inv": inv, "opex": cur_exp, "cur_rev": cur_rev,
                   "provozni_saldo": cur_rev - cur_exp, "saldo": P - V, "rev": dict(rg), "exp": dict(eg),
                   "pop": POP[y], "defl": DEFL[int(y)], "items_p": dict(pi), "items_v": dict(vi)}
    return rows


S = series()

# ---------- balances ----------
BAL = {y: v["zustatek"] for y, v in M["stav_uctu"].items() if y in YEARS}
BAL_FIN_2025 = B["2025"]["ucty"]["konec"]
BAL_OPEN_2026 = R["ucty"]["pocatek"]
BAL_NOW = R["ucty"]["konec"]

# ---------- functional areas (paragraph groups) ----------
AREAS = [
    ("zelen", "Zeleň a vzhled obce §3745", lambda p: p == "3745"),
    ("sprava", "Místní správa §6171", lambda p: p == "6171"),
    ("zastup", "Zastupitelstvo §6112", lambda p: p == "6112"),
    ("odpady", "Odpady §372x", lambda p: p.startswith("372")),
    ("doprava", "Komunikace a doprava §22xx", lambda p: p.startswith("22")),
    ("vo", "Veřejné osvětlení §3631", lambda p: p == "3631"),
    ("kultura", "Kultura, sport, volný čas §33–34", lambda p: p[:2] in ("33", "34")),
    ("voda", "Voda a kanalizace §23xx", lambda p: p.startswith("23")),
    ("ostatni", "Ostatní", lambda p: True),
]


def area_of(par):
    for key, _, fn in AREAS:
        if fn(par):
            return key


def areas_by_year():
    out = {}
    for y, pars in D["odvetvi"].items():
        if y == CUR:
            continue
        a = collections.Counter()
        for par, v in pars.items():
            if par.startswith("63") or par.startswith("64") and par != "6409":
                continue  # financial operations / settlements
            a[area_of(par)] += v["s"]
        out[y] = dict(a)
    a = collections.Counter()
    for g in R["vydaje"]:
        if g["paragraf"].startswith("63"):
            continue
        a[area_of(g["paragraf"])] += g["skutecnost"]
    out[CUR] = dict(a)
    return out


AREA_Y = areas_by_year()

# ---------- neighbours (average 2023–2025, per inhabitant) ----------
BENCH_AREAS = [("sprava", "Místní správa §6171", ("6171",)), ("zastup", "Zastupitelstvo §6112", ("6112",)),
               ("zelen", "Zeleň §3745", ("3745",)), ("odpady", "Odpady §372x", ("372",)),
               ("doprava", "Komunikace §22xx", ("22",)), ("skoly", "Školství §31xx", ("31",))]


def bench():
    res = []
    for ico, b in M["bench"].items():
        yrs = b["roky"]
        def avg(fn):
            return sum(fn(r) / r["obyvatele"] for r in yrs.values()) / len(yrs)
        rec = {"nazev": b["nazev"], "ico": ico, "ob": yrs["2025"]["obyvatele"],
               "P": avg(lambda r: sum(r["prijmy"].values())),
               "V": avg(lambda r: sum(r["vydaje"].values())),
               "inv": avg(lambda r: sum(v for k, v in r["vydaje"].items() if k[0] == "6")),
               "sluzby": avg(lambda r: sum(v for k, v in r["vydaje"].items() if k[:3] == "516")),
               "osobni": avg(lambda r: sum(v for k, v in r["vydaje"].items() if k[:2] == "50")),
               "rud": avg(lambda r: sum(v for k, v in r["prijmy"].items() if k in ("1111", "1112", "1113", "1121", "1211"))),
               "dnem": avg(lambda r: r["prijmy"].get("1511", 0)),
               "uroky": avg(lambda r: r["prijmy"].get("2141", 0))}
        rec["opex"] = rec["V"] - rec["inv"]
        for key, _, pref in BENCH_AREAS:
            rec[key] = avg(lambda r, pref=pref: sum(v for k, v in r["paragrafy"].items() if k.startswith(pref)))
        res.append(rec)
    return res


BENCH = bench()

# ---------- journals 2023–2025 ----------
def journal(year):
    gen = {"2023": PD.rows_2023, "2024": PD.rows_2024, "2025": PD.rows_2025}[year]
    return [r for r in gen() if r["par"] and r["pol"][:1] in "56" and r["su"] in ("231", "261")]


J = {y: journal(y) for y in ("2023", "2024", "2025")}


def j_sum(year, cond, months=12):
    return sum(r["dal"] - r["md"] for r in J[year] if cond(r) and r["mesic"] and r["mesic"] <= months)


def kat_5166(pozn):
    p = pozn.lower()
    if "účet" in p or "ucet" in p or "dppo" in p or "závěrk" in p: return "ucetnictvi"
    if "práv" in p or "prav" in p or "advok" in p: return "pravni"
    return "ostatni"


SLUZBY_5166 = {}
for y in J:
    c = collections.Counter()
    for r in J[y]:
        if r["pol"] == "5166":
            c[kat_5166(r["pozn"])] += r["dal"] - r["md"]
    SLUZBY_5166[y] = dict(c)


def kat_3745(r):
    p, pol = r["pozn"].lower(), r["pol"]
    if pol[0] == "6": return "investice"
    if pol in ("5011", "5021", "5031", "5032"): return "dohody"
    if pol in ("5139", "5137", "5134", "5156"): return "material"
    if "arborist" in p or "kácen" in p or "strom" in p and pol == "5169": return "arborista"
    if pol == "5169" and ("sekání" in p or "zelen" in p or "zahrad" in p or "zalév" in p): return "udrzba"
    if pol == "5169" and ("staveb" in p or "úklid" in p or "pomocn" in p): return "stavebni"
    return "ostatni"


Z3745 = {}
for y in J:
    c = collections.Counter()
    for r in J[y]:
        if r["par"] == "3745":
            c[kat_3745(r)] += r["dal"] - r["md"]
    Z3745[y] = dict(c)

# year-over-year: January–September 2025 (journal) vs January–September 2026 (statement)
YOY = []
_a25 = collections.Counter()
for r in J["2025"]:
    if r["mesic"] and r["mesic"] <= MONTHS:
        _a25[(r["par"], r["pol"])] += r["dal"] - r["md"]
_a26 = {(g["paragraf"], p["kod"]): (p["skutecnost"], p["text"]) for g in R["vydaje"] for p in g["polozky"]}
_names = {(g["paragraf"], p["kod"]): p["text"] for y in B for g in B[y]["vydaje"] for p in g["polozky"]}
for key in set(_a25) | set(_a26):
    a, b = _a25.get(key, 0.0), _a26.get(key, (0.0, ""))[0]
    if abs(b - a) > 0.5:
        YOY.append({"par": key[0], "pol": key[1], "text": _names.get(key, ""), "y25": a, "y26": b, "d": b - a})
YOY.sort(key=lambda r: r["d"])
Y25_9M = sum(_a25.values())
Y25_9M_INV = sum(v for (p, pol), v in _a25.items() if pol[0] == "6")
Y25_9M_INT = sum(v for (p, pol), v in _a25.items() if pol in INTERNAL_EXP)
OPEX25_9M = Y25_9M - Y25_9M_INV - Y25_9M_INT
OPEX26_9M = S[CUR]["opex"]

# ---------- forecast for 2026 ----------
OPEX25 = S["2025"]["opex"]
# year-to-date totals of the previous year from MONITOR (official, consolidated); the journal is used only
# for the item-level comparison above (its months are accounting periods and it lacks December)
OPEX25_9M_J = OPEX25_9M
OPEX25_9M = sum(v for k, v in PREV_YTD["vydaje"].items() if k[0] != "6")
OPEX25_Q4 = OPEX25 - OPEX25_9M
REV25_9M = sum(PREV_YTD["prijmy"].values())
REV25_9M_ONEOFF = PREV_YTD["prijmy"].get("4122", 0)          # regional grant 2025, one-off
REV25 = S["2025"]["P"]
REV25_Q4 = REV25 - REV25_9M
REV26_9M_REC = S[CUR]["P"] - GRANT                 # recurring revenue without the disputed grant
fc = {
    "rev_lo": REV26_9M_REC + REV25_Q4 * 0.97, "rev_hi": REV26_9M_REC + REV25_Q4 * 1.07,
    "opex_lo": OPEX26_9M + OPEX25_Q4 * OPEX26_9M / OPEX25_9M, "opex_hi": OPEX26_9M + OPEX25_Q4,
}
fc["inv"] = S[CUR]["inv"]
fc["saldo_lo"] = fc["rev_lo"] - fc["opex_hi"] - fc["inv"]
fc["saldo_hi"] = fc["rev_hi"] - fc["opex_lo"] - fc["inv"]
fc["res_lo"] = BAL_OPEN_2026 + fc["saldo_lo"]
fc["res_hi"] = BAL_OPEN_2026 + fc["saldo_hi"]
fc["prov_lo"] = fc["rev_lo"] - fc["opex_hi"]
fc["prov_hi"] = fc["rev_hi"] - fc["opex_lo"]
FC = fc

# ---------- outlook 2027–2029 ----------
REV_GROWTH, COST_GROWTH = 0.035, 0.03
# one-off revenue of 2026 that will not repeat: donation §3745/2321 and the election grant 4111
ONEOFF26 = sum(p["skutecnost"] for g in R["prijmy"] for p in g["polozky"] if p["kod"] in ("2321", "4111"))
rev27 = ((fc["rev_lo"] + fc["rev_hi"]) / 2 - ONEOFF26) * (1 + REV_GROWTH)
SCEN = {
    "A": {"label": "Provoz jako v roce 2025", "opex27": OPEX25 * (1 + COST_GROWTH) ** 2},
    "B": {"label": "Provoz jako v roce 2026", "opex27": (fc["opex_lo"] + fc["opex_hi"]) / 2 * (1 + COST_GROWTH)},
}
for k, sc in SCEN.items():
    res = (fc["res_lo"] + fc["res_hi"]) / 2
    sc["rows"] = []
    rev, opex = rev27, sc["opex27"]
    for y in (2027, 2028, 2029):
        res += rev - opex
        sc["rows"].append({"rok": y, "rev": rev, "opex": opex, "prov": rev - opex, "res": res})
        rev *= 1 + REV_GROWTH
        opex *= 1 + COST_GROWTH
RES_START = (fc["res_lo"] + fc["res_hi"]) / 2


def months_cover(balance, opex_year):
    return balance / (opex_year / 12)


if __name__ == "__main__":
    for y in YEARS + [CUR]:
        s = S[y]
        print(f"{y} pop {s['pop']} P {s['P']:>10,.0f} V {s['V']:>10,.0f} inv {s['inv']:>9,.0f} opex {s['opex']:>10,.0f} "
              f"prov {s['provozni_saldo']:>10,.0f} real opex/obyv {s['opex'] * s['defl'] / s['pop']:>8,.0f} bal {BAL.get(y, 0):>12,.0f}")
    print("balances FIN 2025 end", BAL_FIN_2025, "open 2026", BAL_OPEN_2026, "now", BAL_NOW)
    print("5166", SLUZBY_5166)
    print("3745", {y: {k: round(v) for k, v in d.items()} for y, d in Z3745.items()})
    print(f"opex 9M 2025 {OPEX25_9M:,.0f} 2026 {OPEX26_9M:,.0f} ({OPEX26_9M / OPEX25_9M - 1:+.1%}); Q4 2025 {OPEX25_Q4:,.0f}; rev 9M 2025 {REV25_9M:,.0f} Q4 {REV25_Q4:,.0f}")
    print({k: round(v) for k, v in FC.items()})
    for k, sc in SCEN.items():
        print(k, sc["label"], [(r["rok"], round(r["prov"]), round(r["res"])) for r in sc["rows"]])
    for b in BENCH:
        print(b["nazev"], {k: round(v) for k, v in b.items() if isinstance(v, float)})
    print("areas", {y: {k: round(v) for k, v in a.items()} for y, a in AREA_Y.items() if y >= "2019"})
