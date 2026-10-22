#!/usr/bin/env python3
"""Parse the municipality's accounting journals (data/odpady/*denik*.xls[x]) into
supporting analytical data.

Outputs:
  1. web/interni/denik.json — INTERNAL (behind basic auth): payments per document,
     top payments of the year, monthly expenditure, totals per paragraph. Contains
     bookkeeping notes → NEVER deploy outside /interni/ (git-ignored).
  2. §372x categories for the public "Odpady" (waste) tab — yearly totals per kind
     of service only — written into web/odpady.json under the key "sluzby".

Sources (local only, never uploaded to the server, git-ignored):
  data/odpady/2023_denik.xlsx  (KEO "journal listing" — header on row 7, data from row 11)
  data/odpady/2024_denik.xlsx  (tabular export, header on row 0)
  data/odpady/denik_2025.xls   (same, xls)
"""
import json, re, collections, datetime
from pathlib import Path
import xlrd, openpyxl

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / "data" / "odpady"
OUT_INT = BASE / "web" / "interni" / "denik.json"
OUT_ODP = BASE / "web" / "odpady.json"


def rows_2023():
    ws = openpyxl.load_workbook(SRC / "2023_denik.xlsx", read_only=True).active
    for r in ws.iter_rows(values_only=True):
        if not r or not r[1] or r[8] is None:
            continue
        if not isinstance(r[23], (int, float)) or not isinstance(r[24], (int, float)):
            continue  # header / subtotal rows of the listing
        obd = str(r[4] or "")          # "1/2023"
        m = re.match(r"(\d+)/(\d{4})", obd)
        yield {"doklad": str(r[1]), "mesic": int(m.group(1)) if m else None,
               "su": str(r[8] or ""), "par": str(r[12] or "").strip(),
               "pol": str(r[14] or "").strip(), "md": float(r[23] or 0),
               "dal": float(r[24] or 0), "pozn": str(r[26] or "").strip()}


def rows_2024():
    ws = openpyxl.load_workbook(SRC / "2024_denik.xlsx", read_only=True).active
    it = ws.iter_rows(values_only=True)
    hdr = [str(x) for x in next(it)]
    for row in it:
        d = dict(zip(hdr, row))
        obd = d.get("Účetní období")
        mes = obd.month if isinstance(obd, datetime.datetime) else None
        yield {"doklad": str(d.get("Číslo dokladu") or ""), "mesic": mes,
               "su": str(d.get("SU") or ""), "par": str(d.get("Par") or "").strip(),
               "pol": str(d.get("Pol") or "").strip(), "md": float(d.get("MD") or 0),
               "dal": float(d.get("Dal") or 0), "pozn": str(d.get("Poznámka") or "").strip()}


def rows_2025():
    wb = xlrd.open_workbook(SRC / "denik_2025.xls")
    sh = wb.sheet_by_index(0)
    hdr = [str(c.value) for c in sh.row(0)]
    for r in range(1, sh.nrows):
        d = dict(zip(hdr, [c.value for c in sh.row(r)]))
        mes = None
        if d.get("Účetní období"):
            mes = xlrd.xldate_as_datetime(d["Účetní období"], wb.datemode).month
        yield {"doklad": str(d.get("Číslo dokladu") or ""), "mesic": mes,
               "su": str(d.get("SU") or ""), "par": str(d.get("Par") or "").strip(),
               "pol": str(d.get("Pol") or "").strip(), "md": float(d.get("MD") or 0),
               "dal": float(d.get("Dal") or 0), "pozn": str(d.get("Poznámka") or "").strip()}


def kat_odpady(pol, pozn):
    """Classify a waste-management (§372x) payment by its bookkeeping note."""
    p = pozn.lower()
    if "bio" in p: return "bioodpad"
    if "kontejner" in p or "velkoobjem" in p: return "kontejnery"
    if "nebezpe" in p: return "nebezpecny"
    if pol in ("5137", "5139", "6121", "6129") or "popelnic" in p or "nádob" in p: return "vybaveni"
    if re.search(r"svoz odpadu \d", p) or "fcc" in p: return "pausal"
    return "ostatni"


YEARS = {"2023": rows_2023, "2024": rows_2024, "2025": rows_2025}


def main():
    interni = {"generovano": datetime.date.today().isoformat(),
               "pozn": "Zdroj: účetní deníky obce. Jen pro interní použití (/interni/).", "roky": {}}
    odpady_sluzby = {}

    for rok, gen in YEARS.items():
        # budget expenditure entries: paragraph filled in, item 5xxx/6xxx, accounts 231/261
        vyd = [r for r in gen() if r["par"] and r["pol"][:1] in "56" and r["su"] in ("231", "261")]
        # (document, note) -> one payment; a document is often a whole bank statement and
        # the note distinguishes individual payments; an invoice split over several
        # paragraph/item pairs is summed up
        dokl = {}
        for r in vyd:
            key = (r["doklad"], r["pozn"] or f"§{r['par']}/{r['pol']}")
            d = dokl.setdefault(key, {"castka": 0.0, "mesic": r["mesic"], "pars": set(), "pozn": r["pozn"]})
            d["castka"] += r["dal"] - r["md"]
            d["pars"].add(r["par"])
        platby = sorted(({"castka": round(v["castka"], 2), "mesic": v["mesic"],
                          "par": sorted(v["pars"]), "pozn": v["pozn"][:120]}
                         for v in dokl.values() if v["castka"] > 0), key=lambda x: -x["castka"])
        mesicni = collections.Counter()
        par_sum = collections.Counter()
        for r in vyd:
            amt = r["dal"] - r["md"]
            if r["mesic"]: mesicni[r["mesic"]] += amt
            par_sum[r["par"]] += amt
        interni["roky"][rok] = {
            "vydaje_celkem": round(sum(v["castka"] for v in dokl.values()), 2),
            "top_platby": platby[:40],
            "mesicni": {str(m): round(v, 2) for m, v in sorted(mesicni.items())},
            "paragrafy": {p: round(v, 2) for p, v in par_sum.most_common() if abs(v) > 0.005},
            "odpady_platby": sorted(({"castka": round(r["dal"] - r["md"], 2), "mesic": r["mesic"],
                                      "par": r["par"], "kat": kat_odpady(r["pol"], r["pozn"]),
                                      "pozn": r["pozn"][:90]}
                                     for r in vyd if r["par"].startswith("372")), key=lambda x: -x["castka"]),
        }
        # public yearly §372x totals per category
        ksum = collections.Counter()
        for r in vyd:
            if r["par"].startswith("372"):
                ksum[kat_odpady(r["pol"], r["pozn"])] += r["dal"] - r["md"]
        odpady_sluzby[rok] = {k: round(v, 2) for k, v in ksum.items() if abs(v) > 0.005}
        print(f"{rok}: {len(dokl)} documents, expenditure {interni['roky'][rok]['vydaje_celkem']:,.0f}, "
              f"§372x categories {dict((k, round(v)) for k, v in ksum.items())}")

    json.dump(interni, open(OUT_INT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"WROTE {OUT_INT}")

    # add "sluzby" to odpady.json (unallocated remainder = difference against the FIN main series)
    odp = json.load(open(OUT_ODP))
    fin = {str(r["rok"]): r["vydaje"] for r in odp["roky"]}
    for rok, row in odpady_sluzby.items():
        zbytek = round(fin[rok] - sum(row.values()), 2)
        if abs(zbytek) > 1:
            row["nezauctovano"] = zbytek
    odp["sluzby"] = {"zdroj": "účetní deníky obce (souhrny po druzích služeb)", "roky": odpady_sluzby,
                     "pozn_2025": "deník 2025 exportován k 10. 12. 2025 — prosincové platby chybí"}
    json.dump(odp, open(OUT_ODP, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"WROTE {OUT_ODP} (sluzby)")


if __name__ == "__main__":
    main()
