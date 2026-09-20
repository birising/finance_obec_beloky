# Finance of the municipality of Běloky

Open budget dashboard for the village of Běloky (Central Bohemia, ~180 inhabitants),
published at <https://rozpocet.obec-beloky.cz>. The site is a static single-page app
(vanilla JS + Chart.js) fed by JSON files that are generated from the municipality's
official budget statements and from open data of the Czech State Treasury.

The user interface is in Czech (it is meant for the village's residents); the code,
comments and this documentation are in English.

## What the site shows

* **Overview per year** — KPIs (revenue, expenditure, balance, reserve, budget execution),
  revenue and expenditure donuts, budget vs. actual bullet bars, capital vs. operating spend,
  drill-down to individual budget items, optional per-capita view.
* **Comparison of years** — 2010+ history from MONITOR plus detailed years from the statements.
* **Analytics page** — searchable, sortable table of all paragraphs and items.
* **Waste management tab** — cost of waste services, who pays for it (residents' fee,
  EKO-KOM rewards, the municipality), sorted-collection volumes and collection structure.
* **Internal dashboard** (`web/interni/`, served behind HTTP basic auth) — cash-flow,
  seasonal forecast, chapter heatmap 2010+, benchmark against neighbouring municipalities.

Deep links: `?rok=2024&pohled=srovnani&rezim=rozpocet`, `?pohled=odpady`.

## Repository layout

```
web/                 static site (index.html, app.js, budget.json, historie.json, odpady.json, vendor/)
web/interni/         internal dashboard (index.html, app.js, data.json)
tools/extract_budget.py   FIN 2-12 M PDF statements + budget amendments -> web/budget.json
tools/ocr_fin.py          OCR fallback for statements printed without a text layer
tools/fetch_monitor.py    yearly history 2010+ from the MONITOR API -> web/historie.json
tools/fetch_interni.py    monthly cumulatives, paragraph history, neighbour benchmark -> web/interni/data.json
tools/parse_deniky.py     accounting journals -> internal payments + public waste service categories
data/fin/            FIN 2-12 M statements (official "statement for the evaluation of budget execution")
data/ro/             budget amendments (KEO4 "Rozpočtové změny s důvodovou zprávou")
deploy.sh            scp the site to the web server (target given by DEPLOY_TARGET)
```

`data/odpady/` (accounting journals, waste-collection invoices) and `web/interni/denik.json`
are intentionally not committed — they contain bookkeeping notes and are internal only.

## Data sources

| Source | Used for |
| --- | --- |
| FIN 2-12 M statements (PDF exported from the KEO4 accounting system) | approved budget, budget after changes, actuals per paragraph/item, account balances |
| Budget amendments (KEO4 PDF) | changes approved after the latest statement |
| [MONITOR](https://monitor.statnipokladna.gov.cz) JSON API (`/api/rozpocet`, `/api/rozpocet/druhovy`, `/api/rozpocet/odvetvovy`, `/api/ucetni-jednotka/<ico>`) | history since 2010, monthly cumulatives, neighbour benchmark, population |
| EKO-KOM annual letter, waste-collection invoices, accounting journals | waste management tab |

MONITOR figures are consolidated (internal transfers between the municipality's funds are
removed), so they differ from the raw statements by the same amount on both the revenue
and the expenditure side. `fetch_monitor.py` reports these differences as a validation step.

## Statement layouts and OCR

The accounting system changed its export in 2026: the legacy layout had sections I./II. with
row names and `XXXX` subtotal rows, the compact layout is a single "Část I." table without
names. Row names for the compact layout are filled in from the years that have them.

Some statements arrive as "Microsoft Print to PDF" output where glyphs are converted to
outlines, so there is no text layer. `ocr_fin.py` handles those: the table grid is still
present as vector lines, so cell boundaries are exact. The page is rendered, the grid is
painted white (tesseract copes much better without it), the page is OCR'd with word boxes
at two resolutions and every word is assigned to its cell. Readings that differ between
resolutions are reported, and the extractor checks the sum of all recognised items against
the statement's own total rows (approved, after changes, actual) for both revenue and
expenditure.

## Updating the site

```bash
python3 -m venv .budget_venv && .budget_venv/bin/pip install -r requirements.txt
brew install tesseract poppler        # only needed for statements without a text layer

# 1. put the new statement into data/fin/ (and an amendment into data/ro/), register it in
#    FILES / RO_FILES in tools/extract_budget.py
.budget_venv/bin/python tools/extract_budget.py
# 2. refresh open data
.budget_venv/bin/python tools/fetch_monitor.py
.budget_venv/bin/python tools/fetch_interni.py
# 3. publish
DEPLOY_TARGET=user@host:/srv/rozpocet ./deploy.sh
```

Budget amendments are applied on top of the "budget after changes" column only when their
approval date is later than the statement date; otherwise they are already part of the
statement and are skipped. The site footer lists the amendments that were applied.

## Licence

Source code: MIT. The budget data are public information of the municipality of Běloky
(ID 00234125) and of the Czech State Treasury.
