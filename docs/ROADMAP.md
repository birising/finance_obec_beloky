# How the app handles data, and what to improve

Review of the budget dashboard as of October 2026 (statement 9/2026). The first part describes
how data flows from the sources to the site; the second lists problems found during the review;
the third proposes improvements ordered by priority.

## 1. Data flow today

```
FIN 2-12 M PDF (data/fin) ──extract_budget.py (+ ocr_fin.py)──► web/budget.json ─┐
budget amendments (data/ro) ─┘  applied only if approved after the statement      │
MONITOR API ──fetch_monitor.py──────► web/historie.json (2010+ totals) ───────────┼─► public SPA (index.html + app.js)
            ──fetch_interni.py──────► web/interni/data.json (monthly, paragraphs, │
            ──fetch_hospodareni.py──► data/monitor/hospodareni.json   neighbours) ├─► internal dashboard (/interni/)
accounting journals ──parse_deniky.py──► web/interni/denik.json                   │
                                     └─► web/odpady.json["sluzby"]                 │
EKO-KOM letter, FCC invoices ──(ad hoc, no script)──► web/odpady.json ─────────────┘
transparent bank account ──fetch_kb_ucet.py (outside the repo)──► internal JSON
build_audit.py, build_hospodareni.py ──► internal HTML reports (git-ignored)
deploy.sh ──scp──► web server (static files served by Caddy)
```

* `budget.json` keeps **one statement per year** (the latest wins). Revenue and expenditure totals
  are the sums of the extracted items; they are **not consolidated** (internal transfers 4134/5348
  between the municipality's own accounts are included on both sides).
* `historie.json` and everything from MONITOR are **consolidated**. The public "comparison of
  years" chart therefore mixes consolidated years (2010–2021) with unconsolidated ones (2022+).
* Population for per-capita figures is hard-coded in `extract_budget.py`.
* The public SPA loads three JSON files with `cache: "no-store"` and renders everything client-side.
  State (year, view, mode) can be read from the URL but is never written back to it.

## 2. Problems found

### Data correctness

1. **No integrity checks for statements with a text layer.** Item sums are compared with the
   statement's total rows only on the OCR path. Nothing checks that the change of bank balances
   equals the budget balance, or that the opening balance equals the previous closing balance.
   Two consequences in this review: the 9/2026 statement printed row numbers as `2,00`, the
   account-row regex did not match and the reserve was silently written as 0; and a six-figure
   difference between a year's closing balance and the next year's opening balance went unnoticed.
2. **Unconsolidated totals on the public site.** Internal transfers add 0.2–0.35 mil. CZK a year to
   both revenue and expenditure (up to 8 % of revenue) and break the 2010+ series.
3. **The statement is taken at face value.** Revenue booked in a statement but not (yet) seen
   on the bank account flows straight to the KPIs. There is no reconciliation
   with bank data.
4. **`web/odpady.json` is not reproducible.** The deployed file splits regular waste collection into
   mixed/sorted/other; no script produces that split. Running `parse_deniky.py` overwrites it with an
   older categorisation and would break the public waste tab on the next deploy.
5. **Population is hard-coded**, although MONITOR returns the population for every period.
6. **Monthly history is lost**: only the latest statement per year is kept in `budget.json`, so a
   month-over-month comparison needs manual snapshots (`data/snapshots/`).
7. **Narratives in the internal reports are hand-written** around computed numbers, with dates
   embedded in the text; every new statement needs manual edits in two scripts.

### Pipeline and operations

8. **Updating is manual and multi-step** (edit `FILES`, run 3–5 scripts, deploy, upload internal
   pages separately, commit). `deploy.sh` does not upload the internal reports.
9. **No tests and no CI.** A regression in the extractor is only visible on the live site.
10. **Stale files are publicly reachable** under the web root (an old copy of the app in a
    dot-directory and a diagnostic page).
11. **Visitor statistics are wrong by a factor of ~50.** About 97 % of "page views" in the stats
    script come from the server's own monitoring. Real use in the last 30 days: ~60 app loads from
    ~40 IP addresses.
12. **Raw internal data on the server.** The internal area holds raw exports that the dashboard
    does not need; only aggregates should be deployed.
13. **Missing security headers** for a static site: Content-Security-Policy and Permissions-Policy.

### Public site (UX)

14. URL is not updated on navigation, so a view cannot be shared or bookmarked.
15. The footer shows the statement date of the latest year even when another year is selected.
16. Budget terms (paragraf, položka, rozpočet po změnách) are not explained; there is no plain
    language summary of what the numbers mean.
17. The key sustainability indicator (operating balance = current revenue − current expenditure)
    is not shown; neither are inflation-adjusted series.
18. Clickable rows and legend items are `div`s without keyboard focus; charts have no text
    alternative besides the tables below them.
19. No data download and no "last updated" date.

### Code

20. `app.js` (55 kB) builds HTML from strings with `innerHTML`; safe only because the data are
    trusted. Colors and helpers are duplicated between the public and internal apps.

## 3. Proposed improvements

### P0 — correctness (do first)

* **Validation step in `extract_budget.py`** (fail the run, not just print):
  item sums = total rows for every statement; Δ(bank + cash) = revenue − expenditure;
  opening balance = previous year's closing balance; reserve > 0; known item names.
* **Consolidate the public totals** (drop 4134/5348 pairs) and label it; keep the raw totals in
  the detailed tables. This also removes the series break in the comparison chart.
* **Make `odpady.json` reproducible**: move the mixed/sorted split into `parse_deniky.py` (or a
  separate `build_odpady.py`) and stop writing to the public file from the journal parser
  unless explicitly asked (`--write-public`).
* **Bank reconciliation report (internal)**: monthly inflows/outflows of the transparent account
  vs. statement deltas; flag statement revenue without a matching bank credit.

### P1 — automation and operations

* `make update` / `update.sh`: detect new PDFs in `data/fin` and `data/ro`, extract, validate,
  refresh MONITOR, rebuild internal reports, print a diff summary (totals, reserve, new items),
  then deploy on confirmation. Keep every statement and derive a monthly series.
* `deploy.sh` with `rsync --files-from` (explicit allow-list, so internal scratch files can never
  be uploaded) and asset versioning (`app.js?v=<hash>`).
* Tests: golden totals for all PDFs in `data/fin`, unit tests for revenue classification and
  the amendment logic; GitHub Actions on push (public data only).
* Remove stale files from the web root; add CSP and Permissions-Policy headers.
* Fix the stats script: exclude the server's own IP and monitoring user agents; report app loads
  (`/app.js`) rather than `/` hits.
* Monthly scheduled MONITOR refresh with a notification when a new period appears.

### P2 — public site

A detailed UI review with screenshots and a prioritised fix list is in [UI-REVIEW.md](UI-REVIEW.md).

* Write view state to the URL (`history.replaceState`) and update the footer per year.
* "What it means" box per year: operating balance, reserve in months of spending, biggest
  changes against the previous year, in plain Czech.
* Operating balance chart and an inflation toggle (prices of the latest full year).
* Per-capita series back to 2010 using MONITOR population.
* Public neighbour benchmark (all MONITOR data are public).
* Glossary tooltips; keyboard-accessible rows (`button`/`tabindex`, `aria-expanded`).
* CSV/JSON download and a visible "data updated on" date.

### P3 — code

* Split `app.js` into modules (data, formatting, charts, views); one escape helper for every
  value inserted into HTML; shared theme tokens and helpers for the public and internal apps.
* Move the internal reports' narratives to per-statement text files with placeholders, so a new
  statement means editing text, not code.
