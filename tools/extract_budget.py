#!/usr/bin/env python3
"""Extract FIN 2-12 M budget statements (municipality of Běloky) into web/budget.json.

Two statement layouts are supported:
  * legacy export (2022–2025): sections I./II. with row names and "XXXX" subtotal rows,
  * compact export (2026+): a single "Část I." table without row names — names are
    filled in from the years that have them.
Statements printed without a text layer are read via OCR (see ocr_fin.py).
Budget amendments (KEO4 "Rozpočtové změny s důvodovou zprávou") approved after the
latest statement date are applied on top of the "budget after changes" column.
"""
import pdfplumber
import ocr_fin, json, re, sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
OUT = BASE / "web" / "budget.json"

# One statement per year: the latest available period wins.
FILES = {
    DATA / "fin" / "FIN_2-12_M_2022-12.pdf": 2022,
    DATA / "fin" / "FIN_2-12_M_2023-12.pdf": 2023,
    DATA / "fin" / "FIN_2-12_M_2024-12.pdf": 2024,
    DATA / "fin" / "FIN_2-12_M_2025-12.pdf": 2025,
    DATA / "fin" / "FIN_2-12_M_2026-09.pdf": 2026,
}

# Budget amendments approved after the latest statement was compiled. An amendment
# whose approval date is on or before the statement date is skipped automatically
# (it is already reflected in the statement).
RO_FILES = [
    # data/ro/RO_2026-01.pdf (+940k, draft without an approval date) is already included
    # in the 8/2026 statement and is therefore not listed here.
    DATA / "ro" / "RO_2026-02.pdf",  # +390k expenditure, approved 2026-09-15
]

def num(s):
    """Parse a Czech-formatted number: space = thousands separator, comma = decimal."""
    if s is None: return 0.0
    s = s.replace("\xa0", "").replace(" ", "").replace(" ", "")
    s = s.replace(".", "").replace(",", ".")
    s = s.strip()
    if s in ("", "-"): return 0.0
    try: return float(s)
    except ValueError: return 0.0

HEADERS = {"paragraf", "a", ""}

def parse_date(s):
    d, m, y = (int(x) for x in s.split("."))
    return (y, m, d)

def parse_ro(path):
    """Return (number, year, [{sekce, par, pol, zmena}], approval date) from a KEO4 amendment."""
    with pdfplumber.open(path) as pdf:
        txt = "\n".join(pg.extract_text() or "" for pg in pdf.pages)
    m = re.search(r"opatření č\.\s*(\d+)\s*/\s*(\d{4})", txt)
    cislo, rok = (m.group(1), m.group(2)) if m else ("?", None)
    m = re.search(r"Na zasedání dne:\s*(\d{1,2}\.\d{1,2}\.\d{4})", txt)
    schvaleno = m.group(1) if m else None
    zmeny, sekce = [], None
    for line in txt.splitlines():
        l = line.strip()
        if l.startswith("Změna závazných ukazatelů"): break  # repeats the changes per paragraph
        if l == "Výdaje": sekce = "vydaje"; continue
        if l == "Příjmy": sekce = "prijmy"; continue
        if l.startswith("Financování"): sekce = None; continue
        if sekce is None or l.lower().startswith(("celkem", "par ", "výdaje celkem", "příjmy celkem")): continue
        m = re.match(r"(\d{4})(\d{4})\s+(.*)", l)
        if not m: continue
        nums = re.findall(r"-?[\d\s\xa0]+,\d{2}", m.group(3))
        if len(nums) < 3: continue  # original / change / after change
        zmeny.append({"sekce": sekce, "par": m.group(1), "pol": m.group(2), "zmena": num(nums[1])})
    return cislo, rok, zmeny, schvaleno

def parse_ucty(pdf):
    """Bank account and cash balances (legacy layout part VI., compact layout part II.).
    Returns (opening balance, closing balance) = main bank account + cash."""
    poc = kon = 0.0
    rx = re.compile(r"^(?:\d+(?:,\d+)?\s+)?(Základní běžný účet ÚSC|Pokladna)\s+\d{3,4}\s+(-?[\d\s\xa0]+,\d{2})\s+(-?[\d\s\xa0]+,\d{2})")
    for page in pdf.pages:
        for line in (page.extract_text() or "").splitlines():
            l = line.strip()
            if l.lower().startswith("v tom"): continue
            m = rx.match(l)
            if m:
                poc += num(m.group(2)); kon += num(m.group(3))
    return round(poc, 2), round(kon, 2)

def parse_pdf_novy(pdf, meta):
    """Compact export (2026+): one "Část I." table without row names and without XXXX
    subtotals; the item class decides the section (1-4 revenue, 5-6 expenditure, 8 financing)."""
    merged = {}  # (section, paragraph, item) -> record; rows with purpose code / partner are summed
    order = []
    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                if not row or len(row) < 10: continue
                joined = " ".join((c or "") for c in row).lower()
                if "celkem" in joined: continue
                par = (row[0] or "").strip()
                pol = (row[1] or "").strip()
                if not pol.isdigit(): continue
                trida = int(pol[0])
                if 1 <= trida <= 4: sec = "prijmy"
                elif 5 <= trida <= 6: sec = "vydaje"
                else: continue  # 8xxx financing
                key = (sec, par, pol)
                rec = merged.get(key)
                if rec is None:
                    rec = merged[key] = {"paragraf": par, "polozka": pol, "text": "",
                                         "schvaleny": 0.0, "rozpocet": 0.0, "skutecnost": 0.0, "_sec": sec}
                    order.append(key)
                rec["schvaleny"] += num(row[-3])
                rec["rozpocet"] += num(row[-2])
                rec["skutecnost"] += num(row[-1])
    sections = {"prijmy": [], "vydaje": []}
    for key in order:
        rec = merged[key]
        sections[rec.pop("_sec")].append(rec)
    return meta, sections

def parse_pdf(path):
    sections = {"prijmy": [], "vydaje": []}
    current = None
    meta = {}
    path = str(path)
    opener = pdfplumber.open if ocr_fin.has_text(path) else ocr_fin.OcrPdf
    with opener(path) as pdf:
        if isinstance(pdf, ocr_fin.OcrPdf):
            for w in pdf.warnings: print("OCR WARN", w, file=sys.stderr)
            meta["ocr_totals"] = pdf.totals
        full_text = pdf.pages[0].extract_text() or ""
        m = re.search(r"Za období:\s*\d+/(\d{4})", full_text)
        if m: meta["rok"] = int(m.group(1))
        m = re.search(r"Sestavený k:\s*([\d\.]+)", full_text)
        if m: meta["k"] = m.group(1)
        meta["ucty_pocatek"], meta["ucty_konec"] = parse_ucty(pdf)
        if "Část I. Příjmy, výdaje a financování" in full_text:
            return parse_pdf_novy(pdf, meta)
        # legacy layout
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if not row or all(c is None for c in row): continue
                    first = (row[0] or "").strip()
                    if first.startswith("I. Rozpočtové příjmy"):
                        current = "prijmy"; continue
                    if first.startswith("II. Rozpočtové výdaje"):
                        current = "vydaje"; continue
                    if first.startswith("III.") or first.startswith("IV."):
                        current = None; continue
                    if first.lower().startswith("celkem"): continue
                    if current is None: continue
                    if len(row) < 7: continue
                    par = (row[0] or "").strip()
                    pol = (row[1] or "").strip()
                    text = (row[2] or "").strip().replace("\n", " ")
                    # skip header/label rows
                    low = par.lower()
                    if low in HEADERS and pol.lower() in ("položka", "b"): continue
                    if par == "" and pol == "" and text == "": continue
                    if text.lower().startswith("celkem"): continue
                    schvaleny = num(row[3]); po_zmenach = num(row[4]); vysledek = num(row[5])
                    rec = {
                        "paragraf": par, "polozka": pol, "text": text,
                        "schvaleny": schvaleny, "rozpocet": po_zmenach, "skutecnost": vysledek,
                    }
                    sections[current].append(rec)
    return meta, sections

PARAGRAF_NAMES = {}

def aggregate(rows, is_prijmy):
    """Group rows into paragraphs with their items; XXXX rows carry the name + subtotal."""
    groups = {}  # key -> {paragraf, nazev, rozpocet, skutecnost, schvaleny, polozky:[]}
    order = []
    for r in rows:
        par = r["paragraf"]
        pol = r["polozka"]
        # revenue items without a paragraph -> bucket "Bez paragrafu" (no paragraph)
        key = par if par else ("BEZ" if is_prijmy else par)
        if pol == "XXXX":
            g = groups.setdefault(key, {"paragraf": par, "nazev": "", "schvaleny":0,"rozpocet":0,"skutecnost":0,"polozky":[]})
            if key not in order: order.append(key)
            g["nazev"] = r["text"]
            g["schvaleny"] = r["schvaleny"]; g["rozpocet"] = r["rozpocet"]; g["skutecnost"] = r["skutecnost"]
            if par: PARAGRAF_NAMES[par] = r["text"]
        else:
            g = groups.setdefault(key, {"paragraf": par, "nazev": "", "schvaleny":0,"rozpocet":0,"skutecnost":0,"polozky":[]})
            if key not in order: order.append(key)
            g["polozky"].append({"kod": pol, "text": r["text"], "schvaleny": r["schvaleny"], "rozpocet": r["rozpocet"], "skutecnost": r["skutecnost"]})
    result = []
    for key in order:
        g = groups[key]
        if not g["nazev"]:
            g["nazev"] = "Bez paragrafu" if key == "BEZ" else g["paragraf"]
        # no XXXX subtotal captured -> sum the items
        if g["rozpocet"] == 0 and g["skutecnost"] == 0 and g["polozky"]:
            g["rozpocet"] = round(sum(p["rozpocet"] for p in g["polozky"]),2)
            g["skutecnost"] = round(sum(p["skutecnost"] for p in g["polozky"]),2)
            g["schvaleny"] = round(sum(p["schvaleny"] for p in g["polozky"]),2)
        result.append(g)
    return result

# Population as of 1 January (2022–2025 Czech Statistical Office, 2026 municipality's own figure)
OBYVATELE = {"2022": 190, "2023": 189, "2024": 184, "2025": 184, "2026": 181}

out = {"obec": "Běloky", "ico": "00234125", "obyvatele": OBYVATELE, "roky": {}}
for path, rok in FILES.items():
    meta, sections = parse_pdf(path)
    y = meta.get("rok", rok)
    prijmy = aggregate(sections["prijmy"], True)
    vydaje = aggregate(sections["vydaje"], False)
    out["roky"][str(y)] = {
        "k": meta.get("k",""),
        "prijmy": prijmy,
        "vydaje": vydaje,
        "prijmy_celkem": round(sum(g["skutecnost"] for g in prijmy),2),
        "vydaje_celkem": round(sum(g["skutecnost"] for g in vydaje),2),
        "prijmy_rozpocet": round(sum(g["rozpocet"] for g in prijmy),2),
        "vydaje_rozpocet": round(sum(g["rozpocet"] for g in vydaje),2),
        "prijmy_schvaleny": round(sum(g["schvaleny"] for g in prijmy),2),
        "vydaje_schvaleny": round(sum(g["schvaleny"] for g in vydaje),2),
        "ucty": {"pocatek": meta.get("ucty_pocatek", 0), "konec": meta.get("ucty_konec", 0)},
    }
    if meta.get("ocr_totals"):
        # OCR sanity check: the sum of the recognised items must equal the statement's total rows
        r = out["roky"][str(y)]
        for sec, tot in meta["ocr_totals"].items():
            if sec not in ("prijmy", "vydaje"): continue
            got = (r[sec + "_schvaleny"], r[sec + "_rozpocet"], r[sec + "_celkem"])
            exp = tuple(num(t) for t in tot)
            status = "OK" if all(abs(a - b) < 0.01 for a, b in zip(got, exp)) else "!!! MISMATCH"
            print(f"{y} OCR check {sec}: item sum {got} vs. total row {exp} -> {status}", file=sys.stderr)
    print(f"{y}: revenue {len(prijmy)} groups / actual {out['roky'][str(y)]['prijmy_celkem']:,.0f}  |  expenditure {len(vydaje)} groups / actual {out['roky'][str(y)]['vydaje_celkem']:,.0f}", file=sys.stderr)

# Apply budget amendments not yet reflected in the latest statement
for path in RO_FILES:
    cislo, rok, zmeny, schvaleno = parse_ro(path)
    y = out["roky"].get(rok or "")
    if not y or not zmeny:
        print(f"RO {path.name}: year {rok} not found or no changes — skipped", file=sys.stderr)
        continue
    if schvaleno and y.get("k") and parse_date(schvaleno) <= parse_date(y["k"]):
        print(f"RO no. {cislo}/{rok} approved {schvaleno} <= statement as of {y['k']} — already included, skipped", file=sys.stderr)
        y.setdefault("opatreni", []).append(f"RO č. {cislo}/{rok} (již ve výkazu)")
        continue
    for z in zmeny:
        groups = y[z["sekce"]]
        g = next((g for g in groups if g["paragraf"] == z["par"]), None)
        if g is None:
            g = {"paragraf": z["par"], "nazev": PARAGRAF_NAMES.get(z["par"], z["par"]),
                 "schvaleny": 0, "rozpocet": 0, "skutecnost": 0, "polozky": []}
            groups.append(g)
        p = next((p for p in g["polozky"] if p["kod"] == z["pol"]), None)
        if p is None:
            p = {"kod": z["pol"], "text": "", "schvaleny": 0, "rozpocet": 0, "skutecnost": 0}
            g["polozky"].append(p)
        p["rozpocet"] = round(p["rozpocet"] + z["zmena"], 2)
        g["rozpocet"] = round(g["rozpocet"] + z["zmena"], 2)
        y[z["sekce"] + "_rozpocet"] = round(y[z["sekce"] + "_rozpocet"] + z["zmena"], 2)
    y.setdefault("opatreni", []).append(f"RO č. {cislo}/{rok}")
    print(f"RO no. {cislo}/{rok}: {len(zmeny)} changes, sum {sum(z['zmena'] for z in zmeny):,.0f} CZK", file=sys.stderr)

# Standard budget-classification names for codes that never appear in a year with row names
PARAGRAF_FALLBACK = {
    "6409": "Ostatní činnosti jinde nezařazené",
}
POLOZKA_FALLBACK = {
    "2322": "Přijaté pojistné náhrady",
    "4213": "Investiční přijaté transfery ze státních fondů",
    "4216": "Ostatní investiční přijaté transfery ze státního rozpočtu",
    "5221": "Neinvestiční transfery fundacím, ústavům a obecně prospěšným společnostem",
    "5134": "Prádlo, oděv a obuv",
    "5492": "Dary obyvatelstvu",
}

# The compact layout has no row names -> fill them in from years that have them
pol_names = dict(POLOZKA_FALLBACK)
for y in out["roky"].values():
    for sec in ("prijmy", "vydaje"):
        for g in y[sec]:
            for p in g["polozky"]:
                if p["text"]: pol_names.setdefault(p["kod"], p["text"])
for y in out["roky"].values():
    for sec in ("prijmy", "vydaje"):
        for g in y[sec]:
            if g["nazev"] == g["paragraf"]:
                g["nazev"] = PARAGRAF_NAMES.get(g["paragraf"]) or PARAGRAF_FALLBACK.get(g["paragraf"], g["nazev"])
            for p in g["polozky"]:
                if not p["text"]:
                    p["text"] = pol_names.get(p["kod"], "Položka " + p["kod"])

out["paragraf_nazvy"] = PARAGRAF_NAMES
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"WROTE {OUT}", file=sys.stderr)
