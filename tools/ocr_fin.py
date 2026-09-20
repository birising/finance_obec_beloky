"""OCR fallback for FIN 2-12 M statements printed without a text layer
("Microsoft Print to PDF" converts glyphs to outlines, so pdfplumber sees no text).

The table grid is still present as vector lines, so cell boundaries are exact.
Approach: render the page, paint the grid lines white (tesseract handles the
sparse table far better without them), run whole-page OCR with word boxes at
two resolutions, and assign every word to a grid cell by its centre. Cells whose
two readings disagree are reported on stderr. The result mimics the pdfplumber
API (pages[i].extract_text() / extract_tables()) expected by extract_budget.py.
"""
import csv, io, os, re, subprocess, sys, tempfile
import pdfplumber
from PIL import Image, ImageDraw

DPIS = (300, 450)

def _ocr_words(img, psm="6"):
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        img.save(f.name)
        try:
            out = subprocess.run(["tesseract", f.name, "stdout", "--psm", psm, "-l", "eng", "tsv"],
                                 capture_output=True, text=True, check=True).stdout
        finally:
            os.unlink(f.name)
    words = []
    for r in csv.DictReader(io.StringIO(out), delimiter="\t"):
        if r["level"] == "5" and r["text"].strip():
            words.append((int(r["left"]), int(r["top"]), int(r["width"]), int(r["height"]), r["text"]))
    return words

def _clean_num(s):
    """'4 000,00' / '4000,00' / '-561 468,00' -> canonical '4000,00' or None."""
    s = s.replace(" ", "").replace(".", ",")
    m = re.fullmatch(r"(-?\d+),(\d{2})", s)
    return s if m else None

class _Page:
    def __init__(self, text, tables):
        self._text, self._tables = text, tables
    def extract_text(self): return self._text
    def extract_tables(self): return self._tables

class OcrPdf:
    def __init__(self, path):
        self.pages, self.totals, self.warnings = [], {}, []
        with tempfile.TemporaryDirectory() as tmp, pdfplumber.open(path) as pdf:
            for i, pg in enumerate(pdf.pages):
                self.pages.append(self._page(pg, i, path, tmp))

    def _render(self, path, tmp, idx, dpi, pg):
        base = f"{tmp}/p{idx}_{dpi}"
        subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", "-png", "-f", str(idx + 1), "-l", str(idx + 1),
                        "-singlefile", path, base], check=True)
        im = Image.open(base + ".png").convert("L"); im.load()
        s = dpi / 72
        d = ImageDraw.Draw(im)
        for l in pg.lines:
            if max(l["x1"] - l["x0"], l["bottom"] - l["top"]) < 5: continue  # keep minus signs etc.
            d.rectangle((l["x0"] * s - 4, l["top"] * s - 4, l["x1"] * s + 4, l["bottom"] * s + 4), fill=255)
        return im

    def _grid(self, pg):
        vlines = [l for l in pg.lines if abs(l["x0"] - l["x1"]) < 0.5 and l["bottom"] - l["top"] > 5]
        htops = sorted(set(round(l["top"], 1) for l in pg.lines
                           if abs(l["top"] - l["bottom"]) < 0.5 and l["x1"] - l["x0"] > 5))
        rows = []
        for y0, y1 in zip(htops, htops[1:]):
            if not 8 <= y1 - y0 <= 24: continue
            xs = sorted(set(round(l["x0"], 1) for l in vlines if l["top"] <= y0 + 1.5 and l["bottom"] >= y1 - 1.5))
            xs = [x for j, x in enumerate(xs) if j == 0 or x - xs[j - 1] > 3]
            if len(xs) >= 3: rows.append((y0, y1, xs))
        return rows, (rows[0][0] if rows else 60)

    def _fill(self, rows, words, s):
        """Assign OCR words (pixel boxes) to grid cells (pt) -> {row_idx: [cell texts]}."""
        cells = {i: [[] for _ in range(len(xs) - 1)] for i, (_, _, xs) in enumerate(rows)}
        for (l, t, w, h, txt) in words:
            cx, cy = (l + w / 2) / s, (t + h / 2) / s
            for i, (y0, y1, xs) in enumerate(rows):
                if y0 <= cy <= y1 and xs[0] <= cx <= xs[-1]:
                    for j in range(len(xs) - 1):
                        if xs[j] <= cx <= xs[j + 1]:
                            cells[i][j].append((l, txt)); break
                    break
        return {i: [" ".join(t for _, t in sorted(c)) for c in row] for i, row in cells.items()}

    def _page(self, pg, idx, path, tmp):
        rows, table_top = self._grid(pg)
        readings = []
        header_text = ""
        for dpi in DPIS:
            im = self._render(path, tmp, idx, dpi, pg)
            s = dpi / 72
            words = _ocr_words(im)
            readings.append(self._fill(rows, words, s))
            if idx == 0 and not header_text:
                hdr = im.crop((0, 0, im.width, int(table_top * s)))
                header_text = " ".join(w[4] for w in _ocr_words(hdr, "4"))
                if os.environ.get("OCR_DEBUG"): print("HEADER:", header_text, file=sys.stderr)
        text_lines, table = [], []
        if idx == 0:
            m = re.search(r"obdob\S*:?\s*(\d{1,2}/\d{4})", header_text, re.I)
            if m: text_lines.append(f"Za období: {m.group(1)}")
            m = re.search(r"Sestaven\S*\s*k:?\s*(\d{1,2}\.\d{1,2}\.\d{4})", header_text, re.I)
            if m: text_lines.append(f"Sestavený k: {m.group(1)}")
            text_lines.append("Část I. Příjmy, výdaje a financování")
        for i, (y0, y1, xs) in enumerate(rows):
            n = len(xs) - 1
            variants = [r[i] for r in readings]
            def pick(j, numeric):
                vals = [(_clean_num(v[j]) if numeric else v[j].replace(" ", "")) for v in variants]
                if numeric and all(v == "" for v in (x[j] for x in variants)): return ""
                if len(set(vals)) != 1 or (numeric and vals[0] is None):
                    self.warnings.append(f"page {idx + 1} row@{y0:.0f}pt col {j}: {[v[j] for v in variants]}")
                    return next((v for v in vals if v), variants[0][j])
                return vals[0]
            if n == 10:  # Part I row: par, pol, ÚZ, unit, tool, event, partner, approved, amended, actual
                pol = pick(1, False)
                if not pol.isdigit(): continue  # header row
                row = [pick(0, False), pol, pick(2, False), "", "", "", pick(6, False),
                       pick(7, True), pick(8, True), pick(9, True)]
                table.append(row)
            elif n == 4 and xs[0] < 50 and xs[1] > 300:  # totals row: label + 3 numbers
                lab = variants[0][0].lower()
                key = ("prijmy" if lab.startswith("p") else "vydaje" if lab.startswith("v")
                       else "financovani" if lab.startswith("f") else lab)
                nums = [pick(j, True) for j in (1, 2, 3)]
                self.totals[key] = nums
                table.append([key + " celkem"] + [""] * 6 + nums)
            elif n == 6 and xs[2] > 250:  # Part II: bank accounts / cash
                su = pick(2, False)
                name = {"231": "Základní běžný účet ÚSC", "261": "Pokladna"}.get(su)
                if name:
                    text_lines.append(f"{pick(0, False)} {name} {su} {pick(3, True)} {pick(4, True)} {pick(5, True)}")
        return _Page("\n".join(text_lines), [table] if table else [])

    def __enter__(self): return self
    def __exit__(self, *a): pass

def has_text(path):
    with pdfplumber.open(path) as pdf:
        return bool((pdf.pages[0].extract_text() or "").strip())

if __name__ == "__main__":
    p = OcrPdf(sys.argv[1])
    for w in p.warnings: print("WARN", w, file=sys.stderr)
    for i, pg in enumerate(p.pages):
        print(f"--- page {i + 1}\n{pg.extract_text()}")
        for t in pg.extract_tables():
            for r in t: print(r)
    print("TOTALS", p.totals)
