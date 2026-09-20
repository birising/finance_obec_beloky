"use strict";

const fmt = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kc = (v) => fmt.format(Math.round(v)) + " Kč";
const kcShort = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: 2 }) + " mil.";
  if (a >= 1e3) return Math.round(v / 1e3) + " tis.";
  return fmt.format(Math.round(v));
};

const PALETTE = [
  "#38bdf8","#34d399","#fbbf24","#fb7185","#a78bfa","#f472b6","#22d3ee","#4ade80",
  "#facc15","#fb923c","#818cf8","#e879f9","#2dd4bf","#a3e635","#f87171","#60a5fa",
  "#c084fc","#fdba74","#5eead4","#bef264","#fca5a5","#93c5fd","#d8b4fe","#fcd34d",
  "#6ee7b7","#f9a8d4"
];

// income classification by položka code -> category key
const PRIJEM_CATS = {
  dan_prijmy:     { label: "Daně z příjmů (FO + PO)", color: "#a78bfa" },
  dph:            { label: "DPH (sdílená daň)",        color: "#38bdf8" },
  dan_nemovitost: { label: "Daň z nemovitých věcí",    color: "#2dd4bf" },
  poplatky:       { label: "Poplatky a ostatní daně",  color: "#34d399" },
  nedanove:       { label: "Nedaňové (pronájmy, služby)", color: "#fbbf24" },
  kapitalove:     { label: "Kapitálové (prodej majetku)", color: "#fb923c" },
  dotace:         { label: "Dotace a transfery",       color: "#f472b6" },
  prevody:        { label: "Převody mezi vlastními fondy", color: "#818cf8" },
  ostatni:        { label: "Ostatní příjmy",           color: "#94a3b8" },
};
const PRIJEM_ORDER = ["dan_prijmy","dph","dan_nemovitost","poplatky","nedanove","kapitalove","dotace","prevody","ostatni"];

function classifyPrijem(kod) {
  kod = String(kod || "");
  if (/^11/.test(kod)) return "dan_prijmy";
  if (/^12/.test(kod)) return "dph";
  if (/^15/.test(kod)) return "dan_nemovitost";
  if (/^13/.test(kod)) return "poplatky";
  if (/^(21|22|23|24)/.test(kod)) return "nedanove";
  if (/^(31|32|33)/.test(kod)) return "kapitalove";
  if (kod === "4134" || kod === "4139" || kod === "4138" || /^8/.test(kod)) return "prevody";
  if (/^(41|42|43)/.test(kod)) return "dotace";
  return "ostatni";
}

let DATA = null;
let HIST = null; // older years from MONITOR (State Treasury; consolidated, internal transfers removed)
let ODP = null; // waste management (budget §372x + EKO-KOM + FCC invoices)
let YEARS = [];
let state = { year: null, mode: "skutecnost", view: "year", perCapita: false };
const charts = {};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------- data helpers ----------
function val(g) { return g[state.mode] || 0; }

const pct = (x, d = 1) => x.toLocaleString("cs-CZ", { minimumFractionDigits: d, maximumFractionDigits: d }) + " %";

// a year is incomplete unless the statement is compiled as of 31 Dec (MONITOR years are always full)
function isPartial(year) { const r = DATA.roky[year]; return r ? !/^31\.\s*12\./.test(r.k || "") : false; }
function kLabel(year) { const r = DATA.roky[year]; return (r && r.k) || "?"; }

function updatePartialNote() {
  const box = $("#partialNote");
  const partials = YEARS.filter(isPartial);
  if (state.view === "cmp" && partials.length) {
    box.textContent = `⚠ Rok ${partials.join(", ")} je neúplný — skutečnost k ${kLabel(partials[0])} (v grafech označen hvězdičkou). Meziroční srovnání s úplnými roky proto kulhá.`;
    box.style.display = "block";
  } else if ((state.view === "year" || state.view === "anl") && isPartial(state.year)) {
    box.textContent = state.mode === "skutecnost"
      ? `⚠ Rok ${state.year} je neúplný — zobrazená skutečnost je průběžný stav k ${kLabel(state.year)}.`
      : `ⓘ Zobrazen celoroční rozpočet (plán) roku ${state.year}. Skutečné plnění je zatím k ${kLabel(state.year)}.`;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }
}

function vydajeGroups(year) {
  return DATA.roky[year].vydaje
    .map(g => ({ ...g, v: val(g) }))
    .filter(g => g.v > 0)
    .sort((a, b) => b.v - a.v);
}

function prijmyByCat(year) {
  const cats = {};
  const detail = {};
  for (const g of DATA.roky[year].prijmy) {
    const pols = g.polozky.length ? g.polozky : [{ kod: g.paragraf, text: g.nazev, [state.mode]: g[state.mode], skutecnost: g.skutecnost, rozpocet: g.rozpocet, schvaleny: g.schvaleny }];
    for (const p of pols) {
      const v = p[state.mode] || 0;
      if (v === 0) continue;
      const c = classifyPrijem(p.kod);
      cats[c] = (cats[c] || 0) + v;
      (detail[c] = detail[c] || []).push({ ...p, v, par: g.paragraf, parnaz: g.nazev });
    }
  }
  const list = PRIJEM_ORDER.filter(c => cats[c]).map(c => ({ key: c, label: PRIJEM_CATS[c].label, color: PRIJEM_CATS[c].color, v: cats[c], detail: (detail[c] || []).sort((a, b) => b.v - a.v) }));
  return list.sort((a, b) => b.v - a.v);
}

// income detail grouped by druh (not by paragraf) — taxes/transfers carry no paragraf in FIN 2-12
function prijmyDruhGroups(year) {
  const cats = {};
  for (const g of DATA.roky[year].prijmy) {
    const pols = g.polozky.length ? g.polozky : [{ kod: g.paragraf, text: g.nazev, skutecnost: g.skutecnost, rozpocet: g.rozpocet, schvaleny: g.schvaleny }];
    for (const p of pols) {
      const c = classifyPrijem(p.kod);
      const cat = cats[c] || (cats[c] = { paragraf: "", nazev: PRIJEM_CATS[c].label, schvaleny: 0, rozpocet: 0, skutecnost: 0, polozky: [] });
      cat.schvaleny += p.schvaleny || 0; cat.rozpocet += p.rozpocet || 0; cat.skutecnost += p.skutecnost || 0;
      cat.polozky.push({
        kod: p.kod,
        text: g.paragraf ? `${p.text} · §${g.paragraf} ${g.nazev}` : p.text,
        schvaleny: p.schvaleny || 0, rozpocet: p.rozpocet || 0, skutecnost: p.skutecnost || 0,
      });
    }
  }
  return PRIJEM_ORDER.filter(c => cats[c]).map(c => cats[c]);
}

function totals(year) {
  const r = DATA.roky[year];
  const p = state.mode === "skutecnost" ? r.prijmy_celkem : r.prijmy_rozpocet;
  const v = state.mode === "skutecnost" ? r.vydaje_celkem : r.vydaje_rozpocet;
  return { p, v, saldo: p - v };
}

function popul(year) { return (DATA.obyvatele && DATA.obyvatele[year]) || null; }

// per-capita conversion (summaries only — KPIs, donuts, execution, comparison; accounting tables stay in CZK)
function cap(v, year) {
  if (!state.perCapita) return v;
  const n = popul(year || state.year);
  return n ? v / n : v;
}

// capital expenditure = items of class 6xxx
function investice(year, mode) {
  let s = 0;
  for (const g of DATA.roky[year].vydaje)
    for (const p of g.polozky)
      if (/^6/.test(String(p.kod))) s += p[mode || state.mode] || 0;
  return s;
}

// ---------- KPIs ----------
function renderKpis() {
  const y = state.year;
  const t = totals(y);
  const prevYear = String(+y - 1);
  const hasPrev = DATA.roky[prevYear];
  const box = $("#kpis");
  box.innerHTML = "";

  const partial = isPartial(y);
  const deltaHtml = (cur, prev) => {
    // comparing an incomplete year's actuals with a full previous year is misleading -> show the period instead of a delta
    // (the budget is a full-year plan, so a year-on-year comparison makes sense even mid-year)
    if (partial && state.mode === "skutecnost") return `<div class="sub">průběžný stav k ${kLabel(y)}</div>`;
    if (!hasPrev || !prev || (state.mode === "skutecnost" && isPartial(prevYear))) return `<div class="sub">&nbsp;</div>`;
    const d = cur - prev, pc = prev ? (d / Math.abs(prev) * 100) : 0;
    const cls = d >= 0 ? "up" : "down";
    const sign = d >= 0 ? "▲" : "▼";
    return `<div class="sub">vs ${prevYear}: <span class="delta ${cls}">${sign} ${kcShort(cap(Math.abs(d)))} (${d>=0?"+":"−"}${Math.abs(pc).toFixed(0)} %)</span></div>`;
  };
  const tp = hasPrev ? totals(prevYear) : null;

  const r = DATA.roky[y];
  const plnP = r.prijmy_rozpocet ? r.prijmy_celkem / r.prijmy_rozpocet * 100 : null;
  const plnV = r.vydaje_rozpocet ? r.vydaje_celkem / r.vydaje_rozpocet * 100 : null;
  const inv = investice(y);
  const u = r.ucty || {};
  const uDif = (u.konec || 0) - (u.pocatek || 0);

  // for an incomplete year the most useful figure is budget execution, for a full year the year-on-year change
  const subP = (state.mode === "skutecnost" && partial && plnP != null)
    ? `<div class="sub">plnění <strong>${Math.round(plnP)} %</strong> rozpočtu po změnách</div>`
    : deltaHtml(t.p, tp && tp.p);
  const subV = (state.mode === "skutecnost" && partial && plnV != null)
    ? `<div class="sub">plnění <strong>${Math.round(plnV)} %</strong> rozpočtu po změnách</div>`
    : deltaHtml(t.v, tp && tp.v);

  const skut = state.mode === "skutecnost";
  const chip = `<span class="modechip ${skut ? "skut" : "rozp"}">${skut ? "skutečnost" : "rozpočet"}</span>`;
  const cards = [
    { lab: "Příjmy" + chip, val: kc(cap(t.p)), sub: subP, accent: true },
    { lab: "Výdaje" + chip, val: kc(cap(t.v)), sub: subV + `<div class="sub">z toho investice ${kcShort(cap(inv))}</div>` },
    { lab: (skut ? "" : "Plánovaný ") + (t.saldo >= 0 ? "přebytek hospodaření" : "schodek hospodaření"),
      val: `<span class="${t.saldo>=0?'up':'down'}">${t.saldo>=0?"+":"−"}${kc(cap(Math.abs(t.saldo)))}</span>`,
      sub: `<div class="sub"><span class="badge ${t.saldo>=0?'pre':'def'}">${t.saldo>=0?"PŘEBYTEK":"SCHODEK"}</span>${partial && skut?` <span class="muted">k ${kLabel(y)}</span>`:""}</div>` },
    { lab: "Rezerva obce", val: u.konec ? kc(cap(u.konec)) : "—",
      sub: u.konec ? `<div class="sub">na účtech a v pokladně · <span class="delta ${uDif>=0?'up':'down'}">${uDif>=0?"▲":"▼"} ${kcShort(cap(Math.abs(uDif)))}</span> ${partial?"od začátku roku":"za rok"}</div>` : "" },
  ];
  for (const c of cards) {
    const e = el("div", "kpi" + (c.accent ? " accent" : ""));
    e.innerHTML = `<div class="lab">${c.lab}</div><div class="val">${c.val}</div>${c.sub}`;
    box.appendChild(e);
  }
}

// ---------- donut builder ----------
function donut(canvasId, items, onClick) {
  if (charts[canvasId]) charts[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  const total = items.reduce((s, i) => s + i.v, 0);
  charts[canvasId] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: items.map(i => i.label),
      datasets: [{
        data: items.map(i => i.v),
        backgroundColor: items.map(i => i.color),
        borderColor: "#0f172a", borderWidth: 2, hoverOffset: 10,
      }],
    },
    options: {
      cutout: "62%", responsive: true, maintainAspectRatio: false,
      animation: false, resizeDelay: 150,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => ` ${kc(c.parsed)}  ·  ${pct(c.parsed / total * 100)}`,
          },
          backgroundColor: "#020617", borderColor: "#334155", borderWidth: 1, padding: 12,
          titleColor: "#e2e8f0", bodyColor: "#cbd5e1",
        },
      },
      onClick: (e, act) => { if (act.length) onClick(items[act[0].index]); },
    },
    plugins: [centerText(total, (state.perCapita ? "Kč/obyv. · " : "") + (state.mode === "skutecnost" ? "skutečnost" : "rozpočet"))],
  });
}

function centerText(total, label) {
  return {
    id: "center",
    beforeDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const x = (chartArea.left + chartArea.right) / 2;
      const y = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#e2e8f0"; ctx.font = "700 20px -apple-system,Segoe UI,Roboto";
      ctx.fillText(kcShort(total).replace("mil.", "mil"), x, y - 8);
      ctx.fillStyle = "#94a3b8"; ctx.font = "600 12px -apple-system,Segoe UI,Roboto";
      ctx.fillText(label || "celkem Kč", x, y + 14);
      ctx.restore();
    },
  };
}

function buildLegend(boxId, items, onClick) {
  const box = document.getElementById(boxId);
  const total = items.reduce((s, i) => s + i.v, 0);
  box.innerHTML = "";
  items.forEach((i) => {
    const row = el("div", "row");
    row.innerHTML = `<span class="dot" style="background:${i.color}"></span>
      <span class="nm">${i.label}</span>
      <span class="am">${kcShort(i.v)}</span>
      <span class="pc">${pct(i.v / total * 100)}</span>`;
    row.onclick = () => onClick(i);
    box.appendChild(row);
  });
}

// merge chapters below 2 % into "Ostatní" (other) so the donut and legend stay readable
function groupSmall(groups, threshold = 0.02) {
  const tot = groups.reduce((s, g) => s + g.v, 0);
  if (!tot) return groups;
  const big = groups.filter(g => g.v / tot >= threshold);
  const small = groups.filter(g => g.v / tot < threshold);
  if (small.length < 2) return groups;
  const sum = (k) => small.reduce((s, g) => s + (g[k] || 0), 0);
  return [...big, {
    paragraf: "", nazev: `Ostatní (${small.length} ${small.length < 5 ? "kapitoly" : "kapitol"})`,
    v: sum("v"), schvaleny: sum("schvaleny"), rozpocet: sum("rozpocet"), skutecnost: sum("skutecnost"),
    polozky: small.map(g => ({ kod: g.paragraf ? "§" + g.paragraf : "—", text: g.nazev,
      schvaleny: g.schvaleny, rozpocet: g.rozpocet, skutecnost: g.skutecnost })),
  }];
}

// ---------- budget vs. actual (bullet bars) ----------
function renderPlneni() {
  const box = $("#plnBody");
  const r = DATA.roky[state.year];

  const groups = r.vydaje.filter(g => (g.rozpocet || g.skutecnost) > 0)
    .slice().sort((a, b) => b.rozpocet - a.rozpocet);
  const top = groups.slice(0, 9);
  const rest = groups.slice(9);
  if (rest.length > 1) {
    const sum = (k) => rest.reduce((s, g) => s + (g[k] || 0), 0);
    top.push({ paragraf: "", nazev: `Ostatní (${rest.length} ${rest.length < 5 ? "kapitoly" : "kapitol"})`,
      schvaleny: sum("schvaleny"), rozpocet: sum("rozpocet"), skutecnost: sum("skutecnost"),
      polozky: rest.map(g => ({ kod: g.paragraf ? "§" + g.paragraf : "—", text: g.nazev,
        schvaleny: g.schvaleny, rozpocet: g.rozpocet, skutecnost: g.skutecnost })) });
  } else if (rest.length === 1) top.push(rest[0]);

  const souhrn = [
    { nazev: "Příjmy celkem", schvaleny: r.prijmy_schvaleny, rozpocet: r.prijmy_rozpocet, skutecnost: r.prijmy_celkem, cls: "sum" },
    { nazev: "Výdaje celkem", schvaleny: r.vydaje_schvaleny, rozpocet: r.vydaje_rozpocet, skutecnost: r.vydaje_celkem, cls: "sum" },
  ];

  const max = Math.max(...souhrn.concat(top).map(g => Math.max(g.rozpocet || 0, g.skutecnost || 0)), 1);
  const row = (g) => {
    const w = (x) => Math.max(0, Math.min(100, x / max * 100));
    const pln = g.rozpocet ? g.skutecnost / g.rozpocet * 100 : null;
    const over = g.skutecnost > g.rozpocet && g.rozpocet > 0;
    const fillW = w(Math.min(g.skutecnost, g.rozpocet || g.skutecnost));
    return `<div class="prow ${g.cls || ""}" data-par="${g.paragraf ?? ""}">
      <span class="pname" title="${g.nazev}">${g.paragraf ? `<span class="code">§${g.paragraf}</span> ` : ""}${g.nazev}</span>
      <span class="pbar">
        <span class="ptrack" style="width:${w(g.rozpocet)}%"></span>
        <span class="pfill${g.cls === "sum" ? " green" : ""}" style="width:${fillW}%"></span>
        ${over ? `<span class="pover" style="left:${w(g.rozpocet)}%;width:${w(g.skutecnost) - w(g.rozpocet)}%"></span>` : ""}
        ${g.schvaleny > 0 ? `<span class="ptick" style="left:${w(g.schvaleny)}%" title="schválený rozpočet: ${kc(cap(g.schvaleny))}"></span>` : ""}
      </span>
      <span class="pnum"><b>${kcShort(cap(g.skutecnost))}</b> / ${kcShort(cap(g.rozpocet))}
        <span class="ppct ${pln != null && pln > 100 ? "down" : ""}">${pln != null ? Math.round(pln) + " %" : "—"}</span></span>
    </div>`;
  };

  box.innerHTML = souhrn.map(row).join("") + `<div class="psep"></div>` + top.map(row).join("");
  box.querySelectorAll(".prow:not(.sum)").forEach((el, i) => { el.onclick = () => showDrillVydaje({ ...top[i], v: val(top[i]) }); });
}

// mini bullet bar: grey track = budget, fill = spent, red = over budget, yellow marker = approved budget
function bulletHtml(r, max, goodOver) {
  const w = (x) => Math.max(0, Math.min(100, (x || 0) / max * 100));
  const over = r.skutecnost > r.rozpocet && r.rozpocet > 0;
  return `<span class="bl">
    <span class="t" style="width:${w(r.rozpocet)}%"></span>
    <span class="f" style="width:${w(Math.min(r.skutecnost, r.rozpocet || r.skutecnost))}%"></span>
    ${over ? `<span class="o${goodOver ? " g" : ""}" style="left:${w(r.rozpocet)}%;width:${w(r.skutecnost) - w(r.rozpocet)}%"></span>` : ""}
    ${r.schvaleny > 0 ? `<span class="s" style="left:${w(r.schvaleny)}%" title="schválený rozpočet: ${kc(r.schvaleny)}"></span>` : ""}
  </span>`;
}

// ---------- drill-down ----------
function showDrillVydaje(g) {
  const t = totals(state.year);
  const rows = g.polozky.map(p => ({ ...p, v: p[state.mode] || 0 }))
    .filter(p => p.v !== 0 || p.rozpocet || p.skutecnost)  // include budgeted items with no spending
    .sort((a, b) => b.v - a.v);
  const maxB = Math.max(...rows.map(r => Math.max(r.rozpocet || 0, Math.abs(r.skutecnost) || 0)), 1);
  let body = `<table><thead><tr><th>Položka</th><th>Popis</th><th class="num">Částka</th><th class="barcell">Čerpání</th><th class="num">% z výdajů</th>${state.mode==="skutecnost"?'<th class="num">Plnění</th>':''}</tr></thead><tbody>`;
  for (const r of rows) {
    const pln = r.rozpocet ? (r.skutecnost / r.rozpocet * 100) : null;
    body += `<tr><td class="code">${r.kod}</td><td>${r.text}</td>
      <td class="num">${kc(r.v)}</td>
      <td class="barcell" style="width:130px">${bulletHtml(r, maxB)}</td>
      <td class="num plnpct">${pct(r.v / t.v * 100)}</td>
      ${state.mode==="skutecnost"?`<td class="num plnpct">${pln!=null?pln.toFixed(0)+" %":"—"}</td>`:""}</tr>`;
  }
  body += `<tr class="tot"><td></td><td>Celkem ${g.nazev}</td><td class="num">${kc(g.v != null ? g.v : val(g))}</td><td class="barcell"></td><td class="num">${pct(val(g)/t.v*100)}</td>${state.mode==="skutecnost"?"<td></td>":""}</tr>`;
  body += `</tbody></table>`;
  openDrill(g.paragraf ? `§ ${g.paragraf} &nbsp;${g.nazev}` : g.nazev, `výdaje · ${state.year} · ${state.mode === "skutecnost" ? "skutečnost" : "rozpočet po změnách"}`, body);
}

function showDrillPrijem(cat) {
  const t = totals(state.year);
  const rows = cat.detail.slice().sort((a, b) => b.v - a.v);
  const maxB = Math.max(...rows.map(r => Math.max(r.rozpocet || 0, Math.abs(r.skutecnost) || 0)), 1);
  let body = `<table><thead><tr><th>Položka</th><th>Popis</th><th class="parcell">Paragraf</th><th class="num">Částka</th><th class="barcell">Plnění</th><th class="num">% z příjmů</th></tr></thead><tbody>`;
  for (const r of rows) {
    body += `<tr><td class="code">${r.kod}</td><td>${r.text}</td>
      <td class="code parcell">${r.par ? "§ " + r.par : "—"}</td>
      <td class="num">${kc(r.v)}</td>
      <td class="barcell" style="width:130px">${bulletHtml(r, maxB, true)}</td>
      <td class="num plnpct">${pct(r.v / t.p * 100)}</td></tr>`;
  }
  body += `<tr class="tot"><td></td><td>Celkem ${cat.label}</td><td class="parcell"></td><td class="num">${kc(cat.v)}</td><td class="barcell"></td><td class="num">${pct(cat.v/t.p*100)}</td></tr>`;
  body += `</tbody></table>`;
  openDrill(cat.label, `příjmy · ${state.year} · ${state.mode === "skutecnost" ? "skutečnost" : "rozpočet po změnách"}`, body);
}

function openDrill(title, sub, body) {
  $("#drillTitle").innerHTML = `${title}<small>${sub}</small>`;
  $("#drillBody").innerHTML = body;
  $("#drillPanel").style.display = "block";
  $("#drillPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeDrill() { $("#drillPanel").style.display = "none"; }

// ---------- full tables ----------
function fullTable(boxId, groups, isPrijem) {
  const box = document.getElementById(boxId);
  const tot = groups.reduce((s, g) => s + val(g), 0);
  const colR = state.mode === "rozpocet" ? " colactive rozp" : "";
  const colS = state.mode === "skutecnost" ? " colactive" : "";
  let h = `<table><thead><tr><th>Paragraf / položka</th><th>Název</th><th class="num schcell">Schválený</th><th class="num${colR}">Rozpočet</th><th class="num${colS}">Skutečnost</th><th class="barcell">${isPrijem?"Plnění":"Čerpání"}</th>${state.mode==="skutecnost"?'<th class="num">Plnění</th>':''}<th class="num">Podíl</th></tr></thead><tbody>`;
  const sorted = groups.slice().map(g => ({ ...g, v: val(g) })).sort((a, b) => b.v - a.v);
  const maxG = Math.max(...sorted.map(g => Math.max(g.rozpocet || 0, Math.abs(g.skutecnost) || 0)), 1);
  sorted.forEach((g, gi) => {
    const id = `${boxId}-g${gi}`;
    const pln = g.rozpocet ? (g.skutecnost / g.rozpocet * 100) : null;
    h += `<tr class="parrow" data-t="${id}"><td class="code">${g.paragraf && g.paragraf !== "BEZ" ? "§ " + g.paragraf : "—"}</td>
      <td><strong>${g.nazev}</strong></td>
      <td class="num schcell">${kc(g.schvaleny || 0)}</td>
      <td class="num">${kc(g.rozpocet)}</td>
      <td class="num">${kc(g.skutecnost)}</td>
      <td class="barcell" style="width:130px">${bulletHtml(g, maxG, isPrijem)}</td>
      ${state.mode==="skutecnost"?`<td class="num plnpct">${pln!=null?pln.toFixed(0)+" %":"—"}</td>`:""}
      <td class="num">${tot?pct(g.v/tot*100):"0 %"}</td></tr>`;
    const pols = g.polozky.slice().sort((a, b) => (b[state.mode]||0) - (a[state.mode]||0));
    const maxP = Math.max(...pols.map(p => Math.max(p.rozpocet || 0, Math.abs(p.skutecnost) || 0)), 1);
    for (const p of pols) {
      const pp = p.rozpocet ? (p.skutecnost / p.rozpocet * 100) : null;
      h += `<tr class="subrow" data-p="${id}" style="display:none"><td class="code">${p.kod}</td>
        <td>${p.text}</td><td class="num schcell">${kc(p.schvaleny || 0)}</td><td class="num">${kc(p.rozpocet)}</td><td class="num">${kc(p.skutecnost)}</td>
        <td class="barcell">${bulletHtml(p, maxP, isPrijem)}</td>
        ${state.mode==="skutecnost"?`<td class="num">${pp!=null?pp.toFixed(0)+" %":"—"}</td>`:""}<td></td></tr>`;
    }
  });
  h += `<tr class="tot"><td></td><td>Celkem</td><td class="num schcell">${kc(sorted.reduce((s,g)=>s+(g.schvaleny||0),0))}</td><td class="num">${kc(sorted.reduce((s,g)=>s+g.rozpocet,0))}</td><td class="num">${kc(sorted.reduce((s,g)=>s+g.skutecnost,0))}</td><td class="barcell"></td>${state.mode==="skutecnost"?"<td></td>":""}<td class="num">100 %</td></tr>`;
  h += `</tbody></table>`;
  box.innerHTML = h;
  box.querySelectorAll(".parrow").forEach(r => {
    r.onclick = () => {
      const id = r.dataset.t;
      box.querySelectorAll(`.subrow[data-p="${id}"]`).forEach(s => {
        s.style.display = s.style.display === "none" ? "table-row" : "none";
      });
    };
  });
}

// ---------- analytics page ----------
function renderAnalyza() {
  const a = state.anl;
  document.querySelectorAll("#anlRok button").forEach(b => b.classList.toggle("active", b.dataset.r === a.rok));
  document.querySelectorAll("#anlSekce button").forEach(b => b.classList.toggle("active", b.dataset.s === a.sekce));
  document.querySelectorAll("#anlUroven button").forEach(b => b.classList.toggle("active", b.dataset.u === a.uroven));
  document.querySelectorAll("#anlFiltr button").forEach(b => b.classList.toggle("active", b.dataset.f === a.filtr));

  const groups = a.sekce === "vydaje" ? DATA.roky[a.rok].vydaje : prijmyDruhGroups(a.rok);
  let rows = [];
  if (a.uroven === "kapitoly") {
    rows = groups.map(g => ({ kod: g.paragraf && g.paragraf !== "BEZ" ? "§ " + g.paragraf : "—", nazev: g.nazev,
      schvaleny: g.schvaleny || 0, rozpocet: g.rozpocet || 0, skutecnost: g.skutecnost || 0, par: g.paragraf }));
  } else {
    for (const g of groups)
      for (const p of g.polozky)
        rows.push({ kod: p.kod, nazev: p.text, schvaleny: p.schvaleny || 0, rozpocet: p.rozpocet || 0,
          skutecnost: p.skutecnost || 0, ctx: g.paragraf ? `§${g.paragraf} ${g.nazev}` : g.nazev });
  }
  rows.forEach(x => { x.pln = x.rozpocet ? x.skutecnost / x.rozpocet * 100 : null; x.rozdil = x.skutecnost - x.rozpocet; });

  const FILTRY = {
    vse: () => true,
    precerpane: x => x.skutecnost > x.rozpocet + 0.005,
    nedocerpane: x => x.rozpocet > 0 && x.skutecnost < x.rozpocet - 0.005,
    necerpane: x => x.rozpocet > 0 && !x.skutecnost,
  };
  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const q = norm(a.q);
  rows = rows.filter(FILTRY[a.filtr] || FILTRY.vse)
    .filter(x => !q || norm(`${x.kod} ${x.nazev} ${x.ctx || ""}`).includes(q));

  rows.sort((x, y) => {
    let vx = x[a.sort], vy = y[a.sort];
    if (typeof vx === "string" || typeof vy === "string") return a.dir * String(vx).localeCompare(String(vy), "cs");
    if (vx == null) vx = a.dir < 0 ? -Infinity : Infinity;  // rows without execution always at the bottom
    if (vy == null) vy = a.dir < 0 ? -Infinity : Infinity;
    return a.dir * (vx - vy);
  });

  const goodOver = a.sekce === "prijmy";
  const maxB = Math.max(...rows.map(x => Math.max(x.rozpocet, Math.abs(x.skutecnost))), 1);
  const cols = [
    ["kod", "Kód", "code"], ["nazev", "Název", ""],
    ["schvaleny", "Schválený", "num schcell"], ["rozpocet", "Rozpočet", "num"], ["skutecnost", "Skutečnost", "num"],
    [null, goodOver ? "Plnění" : "Čerpání", "barcell"], ["pln", "%", "num"], ["rozdil", "Rozdíl", "num"],
  ];
  let h = `<table><thead><tr>` + cols.map(([k, lab, cls]) =>
    k ? `<th class="sortable ${cls} ${a.sort === k ? "on" : ""}" data-k="${k}">${lab}${a.sort === k ? (a.dir < 0 ? " ▼" : " ▲") : ""}</th>`
      : `<th class="${cls}">${lab}</th>`).join("") + `</tr></thead><tbody>`;
  for (const x of rows) {
    const dCls = x.rozdil > 0.005 ? (goodOver ? "up" : "down") : x.rozdil < -0.005 ? (goodOver ? "down" : "up") : "";
    h += `<tr${x.par ? ` class="parrow" data-par="${x.par}"` : ""}>
      <td class="code">${x.kod}</td>
      <td>${x.nazev}${x.ctx ? ` <span class="muted" style="font-size:11px">· ${x.ctx}</span>` : ""}</td>
      <td class="num schcell">${kc(x.schvaleny)}</td>
      <td class="num">${kc(x.rozpocet)}</td>
      <td class="num">${kc(x.skutecnost)}</td>
      <td class="barcell" style="width:130px">${bulletHtml(x, maxB, goodOver)}</td>
      <td class="num plnpct">${x.pln != null ? Math.round(x.pln) + " %" : "—"}</td>
      <td class="num ${dCls}">${Math.abs(x.rozdil) < 0.005 ? kc(0) : (x.rozdil > 0 ? "+" : "−") + kc(Math.abs(x.rozdil))}</td></tr>`;
  }
  const sS = rows.reduce((s, x) => s + x.schvaleny, 0), sR = rows.reduce((s, x) => s + x.rozpocet, 0), sK = rows.reduce((s, x) => s + x.skutecnost, 0);
  h += `<tr class="tot"><td></td><td>Celkem (${rows.length} ${rows.length === 1 ? "řádek" : rows.length < 5 ? "řádky" : "řádků"})</td>
    <td class="num schcell">${kc(sS)}</td><td class="num">${kc(sR)}</td><td class="num">${kc(sK)}</td><td class="barcell"></td>
    <td class="num">${sR ? Math.round(sK / sR * 100) + " %" : "—"}</td>
    <td class="num">${(sK - sR >= 0 ? "+" : "−") + kc(Math.abs(sK - sR))}</td></tr>`;
  h += `</tbody></table>`;
  const box = $("#anlBody");
  box.innerHTML = h;
  box.querySelectorAll("th.sortable").forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (a.sort === k) a.dir = -a.dir;
    else { a.sort = k; a.dir = (k === "nazev" || k === "kod") ? 1 : -1; }
    renderAnalyza();
  });
  box.querySelectorAll("tr.parrow").forEach(tr => tr.onclick = () => {
    a.uroven = "polozky"; a.q = "§" + tr.dataset.par;
    $("#anlQ").value = a.q;
    renderAnalyza();
  });
}

// ---------- comparison view ----------
function renderComparison() {
  // the main chart reaches back into MONITOR history; the table and trend use only the detailed statement years
  const histYears = HIST ? Object.keys(HIST.roky).filter(y => !DATA.roky[y]).sort() : [];
  let years = [...histYears, ...YEARS];
  if (state.perCapita) years = years.filter(y => popul(y)); // cannot convert without a known population

  const skut = state.mode === "skutecnost";
  const tFor = (y) => {
    if (DATA.roky[y]) {
      const r = DATA.roky[y];
      return { p: skut ? r.prijmy_celkem : r.prijmy_rozpocet, v: skut ? r.vydaje_celkem : r.vydaje_rozpocet, inv: investice(y) };
    }
    const h = HIST.roky[y];
    return { p: skut ? h.prijmy_celkem : h.prijmy_rozpocet, v: skut ? h.vydaje_celkem : h.vydaje_rozpocet, inv: h.vydaje_investice || 0 };
  };
  const P = years.map(y => cap(tFor(y).p, y));
  const V = years.map(y => cap(tFor(y).v, y));
  const INV = years.map(y => cap(tFor(y).inv, y));

  // incomplete year: asterisk in the label and muted bars so it does not look like a drop
  const labels = years.map(y => isPartial(y) ? y + " *" : y);
  const dim = (color) => years.map(y => isPartial(y) ? color + "66" : color);

  if (charts.cmpBars) charts.cmpBars.destroy();
  charts.cmpBars = new Chart($("#cmpBars"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Příjmy", data: P, backgroundColor: dim("#38bdf8"), borderRadius: 6, stack: "p" },
        { label: "Provozní výdaje", data: V.map((v, i) => v - INV[i]), backgroundColor: dim("#fb7185"), stack: "v" },
        { label: "Investice", data: INV, backgroundColor: dim("#fbbf24"), borderRadius: 6, stack: "v" },
        { label: "Saldo", type: "line", data: years.map((_, i) => P[i] - V[i]), borderColor: "#34d399", backgroundColor: "#34d399", tension: .3, pointRadius: 4, borderWidth: 2 },
      ],
    },
    options: (() => { const o = chartOpts((v) => kcShort(v)); o.scales.x.stacked = true; o.scales.y.stacked = true; return o; })(),
  });

  // top expense paragrafy across detailed years
  const totalsByPar = {};
  YEARS.forEach(y => DATA.roky[y].vydaje.forEach(g => {
    if (!g.paragraf || g.paragraf === "BEZ") return;
    totalsByPar[g.paragraf] = totalsByPar[g.paragraf] || { naz: g.nazev, sum: 0 };
    totalsByPar[g.paragraf].sum += g.skutecnost;
  }));
  const topPars = Object.entries(totalsByPar).sort((a, b) => b[1].sum - a[1].sum).slice(0, 6);
  const trendData = topPars.map(([par, info], idx) => ({
    label: `§${par} ${info.naz.length > 26 ? info.naz.slice(0, 24) + "…" : info.naz}`,
    data: YEARS.map(y => {
      const g = DATA.roky[y].vydaje.find(x => x.paragraf === par);
      return g ? cap(state.mode === "skutecnost" ? g.skutecnost : g.rozpocet, y) : 0;
    }),
    borderColor: PALETTE[idx], backgroundColor: PALETTE[idx] + "33", tension: .3, pointRadius: 3, borderWidth: 2, fill: false,
  }));
  if (charts.cmpTrend) charts.cmpTrend.destroy();
  charts.cmpTrend = new Chart($("#cmpTrend"), {
    type: "line", data: { labels: YEARS.map(y => isPartial(y) ? y + " *" : y), datasets: trendData },
    options: chartOpts((v) => kcShort(v), true),
  });

  // table (detailed statement years only)
  let h = `<table><thead><tr><th>Rok</th><th class="num">Příjmy</th><th class="num">Výdaje</th><th class="num">Saldo</th><th class="num">Výsledek</th></tr></thead><tbody>`;
  YEARS.forEach((y) => {
    const t = tFor(y);
    const p = cap(t.p, y), v = cap(t.v, y), s = p - v;
    const part = isPartial(y);
    h += `<tr><td><strong>${y}</strong>${part?` <span class="muted">(k ${kLabel(y)})</span>`:""}</td><td class="num">${kc(p)}</td><td class="num">${kc(v)}</td>
      <td class="num ${s>=0?'up':'down'}">${s>=0?"+":"−"}${kc(Math.abs(s))}</td>
      <td class="num"><span class="badge ${s>=0?'pre':'def'}">${part?"průběžně":s>=0?"přebytek":"schodek"}</span></td></tr>`;
  });
  // only full years go into the total — adding a running year would distort it
  const full = YEARS.filter(y => !isPartial(y));
  const sp = full.reduce((a, y) => a + cap(tFor(y).p, y), 0), sv = full.reduce((a, y) => a + cap(tFor(y).v, y), 0);
  h += `<tr class="tot"><td>Σ ${full[0]}–${full[full.length-1]}</td><td class="num">${kc(sp)}</td><td class="num">${kc(sv)}</td><td class="num ${sp-sv>=0?'up':'down'}">${sp-sv>=0?"+":"−"}${kc(Math.abs(sp-sv))}</td><td></td></tr>`;
  h += `</tbody></table>`;
  $("#cmpTableBody").innerHTML = h;
}

function chartOpts(tickFmt, legendTop) {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: false, resizeDelay: 150,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#cbd5e1", boxWidth: 12, font: { size: 11 } }, position: legendTop ? "bottom" : "top" },
      tooltip: { backgroundColor: "#020617", borderColor: "#334155", borderWidth: 1, padding: 10,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${kc(c.parsed.y)}` } },
    },
    scales: {
      x: { ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
      y: { ticks: { color: "#94a3b8", callback: tickFmt }, grid: { color: "#1e293b" } },
    },
  };
}

// ---------- render orchestration ----------
function renderYearView() {
  renderKpis();
  const openDrillV = (i) => showDrillVydaje(i.orig || i);
  const openDrillP = (i) => showDrillPrijem(i.orig || i);

  const vg = groupSmall(vydajeGroups(state.year))
    .map((g, i) => ({ ...g, label: g.paragraf ? `§${g.paragraf} ${g.nazev}` : g.nazev, color: PALETTE[i % PALETTE.length] }))
    .map(g => ({ ...g, v: cap(g.v), orig: g }));
  donut("vydajeChart", vg, openDrillV);
  buildLegend("vydajeLegend", vg, openDrillV);

  const pc = prijmyByCat(state.year).map(c => ({ ...c, v: cap(c.v), orig: c }));
  donut("prijmyChart", pc, openDrillP);
  buildLegend("prijmyLegend", pc, openDrillP);

  renderPlneni();
  fullTable("fullVydajeBody", DATA.roky[state.year].vydaje, false);
  fullTable("fullPrijmyBody", prijmyDruhGroups(state.year), true);
  closeDrill();
}

function render() {
  $("#yearView").style.display = state.view === "year" ? "block" : "none";
  $("#cmpView").style.display = state.view === "cmp" ? "block" : "none";
  $("#anlView").style.display = state.view === "anl" ? "block" : "none";
  const odpView = $("#odpView"); if (odpView) odpView.style.display = state.view === "odp" ? "block" : "none";
  // the waste tab has its own KPIs; the actual/budget and per-capita toggles make no sense there
  const isOdp = state.view === "odp";
  $("#kpis").style.display = isOdp ? "none" : "";
  $("#modeSeg").style.display = isOdp ? "none" : "";
  $("#capSeg").style.display = isOdp ? "none" : "";
  if (isOdp) { $("#partialNote").style.display = "none"; renderOdpady(); return; }
  if (state.view === "anl") state.year = state.anl.rok;
  updatePartialNote();
  document.querySelectorAll("#modeSeg button").forEach(b => b.classList.toggle("active", b.dataset.mode === state.mode));
  document.querySelectorAll("#capSeg button").forEach(b => b.classList.toggle("active", (b.dataset.cap === "ob") === state.perCapita));
  const skut = state.mode === "skutecnost";
  document.querySelectorAll(".modechip").forEach(el => {
    el.textContent = skut ? "skutečnost" : "rozpočet po změnách";
    el.className = "modechip " + (skut ? "skut" : "rozp");
  });
  if (state.view === "year") renderYearView();
  else if (state.view === "cmp") { renderKpisCmp(); renderComparison(); }
  else { renderKpis(); renderAnalyza(); }
}
// ---------- Waste management ----------
// Colours validated against the panel surface (#1b2538): lightness band, chroma, CVD adjacency,
// normal-vision floor and contrast (dataviz validator). Do not change without re-validating.
const ODP_SURFACE = "#1b2538";
const ODP_KOM = { // commodity donut — container semantics (plastic yellow, paper blue, glass green, cartons orange)
  smesny: "#d55181", plast: "#c98500", papir: "#3987e5", sklo: "#008300",
  kovy: "#9085e9", napojove_kartony: "#d95926", oleje: "#199e70", ostatni: "#64748b",
};
const ODP_FIN = { poplatek: "#3987e5", ekokom: "#199e70", doplatek: "#e66767" }; // who pays
const ODP_SLUZBY = [ // cost composition from the journals — order = stack order
  { key: "svoz_smesny", nazev: "Pravidelný svoz — směsný komunální (FCC)", color: "#d55181" },
  { key: "svoz_trideny", nazev: "Pravidelný svoz — tříděný (FCC)", color: "#3987e5" },
  { key: "svoz_dalsi", nazev: "Další faktury FCC (mimořádné svozy)", color: "#93c5fd" },
  { key: "kontejnery", nazev: "Velkoobjemové kontejnery", color: "#c98500" },
  { key: "ostatni", nazev: "Likvidace a ostatní", color: "#9085e9" },
  { key: "bioodpad", nazev: "Bioodpad", color: "#d95926" },
  { key: "vybaveni", nazev: "Nádoby a vybavení", color: "#199e70" },
  { key: "nezauctovano", nazev: "Prosinec 2025 (deník neúplný)", color: "#64748b" },
];
const tun = v => v.toLocaleString("cs-CZ", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " t";
const kg1 = v => v.toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function odpChart(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }
const odpTip = { backgroundColor: "#020617", borderColor: "#334155", borderWidth: 1, padding: 10, titleColor: "#e2e8f0", bodyColor: "#cbd5e1" };
// shared chrome: hairline grid, muted axes (only the data may be loud)
const odpGrid = { color: "#33415544", lineWidth: 1 };
const odpTicks = { color: "#94a3b8", font: { size: 11 } };
const odpLegend = { labels: { color: "#cbd5e1", boxWidth: 10, boxHeight: 10, font: { size: 12 } } };
// selective direct labels: the total on top of the bar (muted text token, not the series colour)
const capTotals = fmtFn => ({
  id: "capTotals",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(chart.data.datasets.length - 1);
    ctx.save();
    ctx.textAlign = "center"; ctx.fillStyle = "#94a3b8"; ctx.font = "600 11px -apple-system,Segoe UI,Roboto";
    chart.data.labels.forEach((_, i) => {
      const total = chart.data.datasets.reduce((s, d) => s + (d.data[i] || 0), 0);
      const bar = meta.data[i];
      if (bar) ctx.fillText(fmtFn(total), bar.x, chart.scales.y.getPixelForValue(total) - 6);
    });
    ctx.restore();
  },
});

function renderOdpady() {
  const R = ODP.roky;
  const last = R[R.length - 1], first = R[0];
  const labels = R.map(r => String(r.rok));

  // --- KPIs (latest full year) ---
  const sob = (last.poplatek + last.ekokom) / last.vydaje * 100;
  const kpis = [
    { lab: "Náklady na odpady", val: kc(last.vydaje), sub: `<div class="sub">rok ${last.rok} · <span class="up">▲ +${Math.round((last.vydaje / first.vydaje - 1) * 100)} %</span> od ${first.rok}</div>`, accent: true },
    { lab: "Vybráno od občanů", val: kc(last.poplatek), sub: `<div class="sub">poplatek za odpad</div>` },
    { lab: "Odměna EKO-KOM", val: kc(last.ekokom), sub: `<div class="sub">za vytříděný odpad</div>` },
    { lab: "Doplatek obce", val: `<span class="down">${kc(last.doplatek)}</span>`, sub: `<div class="sub"><span class="badge def">${fmt.format(last.doplatek_obyv)} Kč / obyvatele</span></div>` },
  ];
  const box = $("#odpKpis"); box.innerHTML = "";
  for (const c of kpis) { const e = el("div", "kpi" + (c.accent ? " accent" : "")); e.innerHTML = `<div class="lab">${c.lab}</div><div class="val">${c.val}</div>${c.sub}`; box.appendChild(e); }

  // --- chart: who pays for waste (stacked funding) ---
  const gap = { borderColor: ODP_SURFACE, borderWidth: 2, borderSkipped: false }; // 2px surface-coloured gap between segments
  odpChart("odpTrend", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Poplatek občanů", data: R.map(r => r.poplatek), backgroundColor: ODP_FIN.poplatek, stack: "s", ...gap, maxBarThickness: 26 },
        { label: "Odměna EKO-KOM", data: R.map(r => r.ekokom), backgroundColor: ODP_FIN.ekokom, stack: "s", ...gap, maxBarThickness: 26 },
        { label: "Doplatek obce (z daní)", data: R.map(r => r.doplatek), backgroundColor: ODP_FIN.doplatek, stack: "s", ...gap, maxBarThickness: 26,
          borderRadius: { topLeft: 4, topRight: 4 } },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 18 } },
      scales: { x: { stacked: true, ticks: odpTicks, grid: { display: false }, border: { color: "#334155" } },
        y: { stacked: true, ticks: { ...odpTicks, callback: v => kcShort(v), stepSize: 100000 }, grid: odpGrid, border: { display: false } } },
      plugins: {
        legend: odpLegend,
        tooltip: { ...odpTip, callbacks: { label: c => ` ${c.dataset.label}: ${kc(c.parsed.y)}`,
          footer: items => { const r = R[items[0].dataIndex]; return `Náklady celkem: ${kc(r.vydaje)}`; } } },
      },
    },
    plugins: [capTotals(kcShort)],
  });

  // --- chart: self-sufficiency (% coverage) ---
  const kryto = R.map(r => Math.round((r.poplatek + r.ekokom) / r.vydaje * 100));
  odpChart("odpSelf", {
    type: "line",
    data: { labels, datasets: [{ label: "Kryto poplatkem + EKO-KOM", data: kryto,
      borderColor: ODP_FIN.ekokom, borderWidth: 2, borderJoinStyle: "round", borderCapStyle: "round",
      backgroundColor: "rgba(25,158,112,.10)", fill: true, tension: .25,
      pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: ODP_FIN.ekokom,
      pointBorderColor: ODP_SURFACE, pointBorderWidth: 2 }] }, // 2px surface-coloured ring
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 18, right: 34 } },
      scales: { x: { ticks: odpTicks, grid: { display: false }, border: { color: "#334155" } },
        y: { min: 0, max: 100, ticks: { ...odpTicks, callback: v => v + " %", stepSize: 25 }, grid: odpGrid, border: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { ...odpTip, callbacks: { label: c => ` obec doplácí ${100 - c.parsed.y} %  ·  kryto ${c.parsed.y} %` } } },
    },
    plugins: [{ // direct labels only on the end points (first and last year)
      id: "endLabels",
      afterDatasetsDraw(chart) {
        const { ctx } = chart, m = chart.getDatasetMeta(0);
        ctx.save(); ctx.fillStyle = "#cbd5e1"; ctx.font = "700 12px -apple-system,Segoe UI,Roboto";
        [[0, "left"], [kryto.length - 1, "right"]].forEach(([i, side]) => {
          const p = m.data[i]; if (!p) return;
          ctx.textAlign = side === "left" ? "left" : "left";
          ctx.fillText(kryto[i] + " %", p.x + (side === "left" ? 8 : 8), p.y - 10);
        });
        ctx.restore();
      },
    }],
  });

  // --- chart: cost composition by service (accounting journals) ---
  if (ODP.sluzby) {
    const SL = ODP.sluzby, sroky = Object.keys(SL.roky).sort();
    const dsets = ODP_SLUZBY.filter(s => sroky.some(y => SL.roky[y][s.key]))
      .map((s, idx, arr) => ({ label: s.nazev, data: sroky.map(y => SL.roky[y][s.key] || 0),
        backgroundColor: s.color, stack: "s", ...gap, maxBarThickness: 34,
        ...(idx === arr.length - 1 ? { borderRadius: { topLeft: 4, topRight: 4 } } : {}) }));
    odpChart("odpSluzby", {
      type: "bar",
      data: { labels: sroky, datasets: dsets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        indexAxis: "y",
        layout: { padding: { right: 56 } },
        scales: { y: { stacked: true, ticks: { ...odpTicks, font: { size: 12, weight: 600 } }, grid: { display: false }, border: { color: "#334155" } },
          x: { stacked: true, ticks: { ...odpTicks, callback: v => kcShort(v), maxTicksLimit: 7 }, grid: odpGrid, border: { display: false } } },
        plugins: {
          legend: odpLegend,
          tooltip: { ...odpTip, callbacks: { label: c => ` ${c.dataset.label}: ${kc(c.parsed.x)}`,
            footer: items => `Celkem ${items[0].label}: ${kc(dsets.reduce((s, d) => s + (d.data[items[0].dataIndex] || 0), 0))}` } },
        },
      },
      plugins: [{ // total above the bar cap
        id: "rowTotals",
        afterDatasetsDraw(chart) {
          const { ctx } = chart, meta = chart.getDatasetMeta(chart.data.datasets.length - 1);
          ctx.save(); ctx.fillStyle = "#94a3b8"; ctx.font = "600 11px -apple-system,Segoe UI,Roboto"; ctx.textAlign = "left";
          chart.data.labels.forEach((_, i) => {
            const total = chart.data.datasets.reduce((s, d) => s + (d.data[i] || 0), 0);
            const bar = meta.data[i];
            if (bar) ctx.fillText(kcShort(total), chart.scales.x.getPixelForValue(total) + 8, bar.y + 4);
          });
          ctx.restore();
        },
      }],
    });
    const sluzbyPanel = $("#odpSluzby").closest(".panel");
    let sluzbyNote = sluzbyPanel.querySelector(".sluzby-note");
    if (SL.pozn_svoz) {
      if (!sluzbyNote) { sluzbyNote = document.createElement("p"); sluzbyNote.className = "hint sluzby-note"; sluzbyNote.style.marginTop = "10px"; sluzbyPanel.appendChild(sluzbyNote); }
      sluzbyNote.textContent = SL.pozn_svoz;
    }
  }

  // --- EKO-KOM sorted collection ---
  const E = ODP.ekokom_2025;
  const qrows = E.kvartaly.map(q => `<tr><td>${q.q} 2025</td><td class="num">${tun(q.t)}</td><td class="num">${kc(q.kc)}</td></tr>`).join("");
  $("#odpEkokom").innerHTML = `
    <div class="kpis" style="margin:0 0 12px">
      <div class="kpi"><div class="lab">Vytříděno 2025</div><div class="val">${tun(E.tuny)}</div><div class="sub">${kg1(E.kg_obyv)} kg na obyvatele</div></div>
      <div class="kpi"><div class="lab">Odměna EKO-KOM 2025</div><div class="val"><span class="up">${kc(E.castka)}</span></div><div class="sub">vyfakturováno obcí</div></div>
    </div>
    <table><thead><tr><th>Období</th><th class="num">Množství</th><th class="num">Odměna</th></tr></thead>
    <tbody>${qrows}<tr class="tot"><td>Rok 2025</td><td class="num">${tun(E.tuny)}</td><td class="num">${kc(E.castka)}</td></tr></tbody></table>
    <p class="hint" style="margin-top:8px">Pozn.: odměna z výročního přehledu (${kc(E.castka)}) se od částky v rozpočtu liší kvůli časovému posunu fakturace (poslední čtvrtletí obec inkasuje až v dalším roce).</p>`;

  // --- collection structure (donut) ---
  const S = ODP.svoz_struktura, items = S.polozky.map(p => ({ ...p, color: ODP_KOM[p.kod] || "#64748b" }));
  const stot = items.reduce((s, i) => s + i.kc, 0);
  odpChart("odpStruktura", {
    type: "doughnut",
    data: { labels: items.map(i => i.nazev), datasets: [{ data: items.map(i => i.kc), backgroundColor: items.map(i => i.color), borderColor: ODP_SURFACE, borderWidth: 2, hoverOffset: 8 }] },
    options: { cutout: "62%", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { ...odpTip, callbacks: { label: c => ` ${kc(c.parsed)} · ${pct(c.parsed / stot * 100)}` } } } },
    plugins: [centerText(stot, "svoz · " + ((S.obdobi.match(/\((.+)\)/) || [])[1] || ""))],
  });
  const smes = items.filter(i => i.skupina === "směsný").reduce((s, i) => s + i.kc, 0);
  const trid = items.filter(i => i.skupina === "tříděný").reduce((s, i) => s + i.kc, 0);
  $("#odpStrukturaLegend").innerHTML =
    items.map(i => `<div class="odpleg"><span class="lname"><span class="dot" style="background:${i.color}"></span>${i.nazev}${i.nadoby ? `<span class="lsub">${i.nadoby} · svoz ${i.svoz}</span>` : ""}</span><span class="lval">${kc(i.kc)} · ${pct(i.kc / stot * 100)}</span></div>`).join("") +
    (S.pozn_nadoby ? `<p class="hint" style="margin-top:8px">${S.pozn_nadoby}</p>` : "") +
    `<p class="hint" style="margin-top:8px"><strong>Tříděný svoz (${pct(trid / stot * 100)}) stojí víc než směsný (${pct(smes / stot * 100)})</strong> — papír se sváží 2× týdně, plast 52× ročně. Svoz tříděného je dražší, i když ho EKO-KOM částečně dotuje.</p>`;

  // --- trend table ---
  const th = `<tr><th>Rok</th><th class="num">Náklady</th><th class="num">z toho tříděný</th><th class="num">Poplatek</th><th class="num">EKO-KOM</th><th class="num">Doplatek obce</th><th class="num">Kč/obyv.</th><th class="num">Kryto</th></tr>`;
  const trs = R.map(r => `<tr><td>${r.rok}</td><td class="num">${kc(r.vydaje)}</td><td class="num muted">${kc(r.v_trideny)}</td><td class="num">${kc(r.poplatek)}</td><td class="num">${kc(r.ekokom)}</td>
    <td class="num"><strong>${kc(r.doplatek)}</strong></td><td class="num">${fmt.format(r.doplatek_obyv)}</td><td class="num">${Math.round((r.poplatek + r.ekokom) / r.vydaje * 100)} %</td></tr>`).join("");
  const y = ODP.rok_2026_ytd;
  const ytd = y ? `<tr class="muted"><td>2026*</td><td class="num">${kc(y.vydaje)}</td><td class="num">—</td><td class="num">${kc(y.poplatek)}</td><td class="num">${kc(y.ekokom)}</td><td class="num">${kc(y.doplatek)}</td><td class="num">—</td><td class="num">${Math.round((y.poplatek + y.ekokom) / y.vydaje * 100)} %</td></tr>` : "";
  $("#odpTableBody").innerHTML = `<table><thead>${th}</thead><tbody>${trs}${ytd}</tbody></table>${y ? `<p class="hint">* rok 2026 zatím neúplný (k ${y.k}).</p>` : ""}<p class="hint">Záporný poplatek v roce 2023 jsou vratky dle výkazu obce — poplatek se v tom roce fakticky nevybíral (výběr se obnovil v letech 2024–2025). Přepočet na obyvatele u let 2019–2021 používá současný počet obyvatel (181).</p>`;

  // --- analysis ---
  $("#odpAnalyza").innerHTML = `<h2>Co z čísel plyne</h2>
    <ul class="analyza">
      <li><strong>Odpady zdražují nejrychleji ze všech běžných výdajů obce.</strong> Náklady vzrostly z ${kc(first.vydaje)} (${first.rok}) na ${kc(last.vydaje)} (${last.rok}), tedy o ${Math.round((last.vydaje / first.vydaje - 1) * 100)} %.</li>
      <li><strong>Občané platí čím dál menší část.</strong> V roce ${first.rok} poplatek a odměna EKO-KOM pokryly ${Math.round((first.poplatek + first.ekokom) / first.vydaje * 100)} % nákladů, v roce ${last.rok} už jen ${Math.round(sob)} %. Zbytek — <strong>${kc(last.doplatek)}</strong> ročně (${fmt.format(last.doplatek_obyv)} Kč na obyvatele) — jde z ostatních daní obce.</li>
      <li><strong>Třídění se vyplácí, ale samo náklady nepokryje.</strong> Obec vytřídila ${tun(E.tuny)} (${kg1(E.kg_obyv)} kg/obyvatele) a dostala za to ${kc(E.castka)}. To je zhruba ${Math.round(E.castka / last.vydaje * 100)} % ročních nákladů — třídění je levnější než skládkování, ale svoz tříděného odpadu je zároveň nejdražší položka faktury.</li>
      <li><strong>Kde jsou peníze:</strong> ${pct(trid / stot * 100)} fakturovaného svozu tvoří tříděné složky, ${pct(smes / stot * 100)} směsný odpad. Prostor pro úspory je v četnosti svozů a objemu směsného odpadu.</li>
    </ul>`;
}

function renderKpisCmp() {
  // in comparison, show aggregate KPIs of latest year for context
  state.year = YEARS[YEARS.length - 1];
  renderKpis();
}

// ---------- init ----------
async function init() {
  try {
    const res = await fetch("budget.json", { cache: "no-store" });
    DATA = await res.json();
  } catch (e) {
    $("#spin").textContent = "Chyba načítání dat: " + e;
    return;
  }
  try {
    const hres = await fetch("historie.json", { cache: "no-store" });
    if (hres.ok) HIST = await hres.json();
  } catch (e) { /* historie je volitelná */ }
  try {
    const ores = await fetch("odpady.json", { cache: "no-store" });
    if (ores.ok) ODP = await ores.json();
  } catch (e) { /* odpady jsou volitelné */ }
  YEARS = Object.keys(DATA.roky).sort();
  state.year = YEARS[YEARS.length - 1];
  $("#ico").textContent = DATA.ico || "—";

  // deep-linking: ?rok=2024 / ?pohled=srovnani / ?rezim=rozpocet
  const q = new URLSearchParams(location.search);
  if (q.get("rok") && DATA.roky[q.get("rok")]) { state.year = q.get("rok"); }
  if (["srovnani", "cmp"].includes(q.get("pohled"))) { state.view = "cmp"; }
  if (["analyza", "anl"].includes(q.get("pohled"))) { state.view = "anl"; }
  if (["odpady", "odp"].includes(q.get("pohled")) && ODP) { state.view = "odp"; }
  if (["rozpocet", "skutecnost"].includes(q.get("rezim"))) { state.mode = q.get("rezim"); }
  if (q.get("prepocet") === "obyvatel") { state.perCapita = true; }

  // year tabs (+ comparison)
  const tabs = $("#yearTabs");
  YEARS.forEach(y => {
    const b = el("button", "tab", y);
    b.onclick = () => { state.view = "year"; state.year = y; syncTabs(); render(); };
    b.dataset.year = y;
    tabs.appendChild(b);
  });
  const cmp = el("button", "tab", "Srovnání let");
  cmp.dataset.year = "cmp";
  cmp.onclick = () => { state.view = "cmp"; syncTabs(); render(); };
  tabs.appendChild(cmp);
  const anlTab = el("button", "tab", "Analýza");
  anlTab.dataset.year = "anl";
  anlTab.onclick = () => { state.view = "anl"; syncTabs(); render(); };
  tabs.appendChild(anlTab);
  if (ODP) {
    const odpTab = el("button", "tab", "♻︎ Odpady");
    odpTab.dataset.year = "odp";
    odpTab.onclick = () => { state.view = "odp"; syncTabs(); render(); };
    tabs.appendChild(odpTab);
  }

  // analytics page: its own year selector + toggles + search
  state.anl = { rok: state.year, sekce: "vydaje", uroven: "kapitoly", filtr: "vse", q: "", sort: "skutecnost", dir: -1 };
  YEARS.forEach(y => {
    const b = el("button", null, y);
    b.dataset.r = y;
    b.onclick = () => { state.anl.rok = y; state.year = y; renderKpis(); updatePartialNote(); renderAnalyza(); };
    $("#anlRok").appendChild(b);
  });
  [["anlSekce", "s", "sekce"], ["anlUroven", "u", "uroven"], ["anlFiltr", "f", "filtr"]].forEach(([id, attr, key]) => {
    document.querySelectorAll(`#${id} button`).forEach(b => {
      b.onclick = () => { state.anl[key] = b.dataset[attr]; renderAnalyza(); };
    });
  });
  $("#anlQ").oninput = () => { state.anl.q = $("#anlQ").value; renderAnalyza(); };

  document.querySelectorAll("#modeSeg button").forEach(b => {
    b.onclick = () => { state.mode = b.dataset.mode; render(); };
  });
  document.querySelectorAll("#capSeg button").forEach(b => {
    b.onclick = () => { state.perCapita = b.dataset.cap === "ob"; render(); };
  });
  $("#drillClose").onclick = closeDrill;

  const r = DATA.roky[state.year];
  const obyv = DATA.obyvatele ? `<br>Počet obyvatel pro přepočet (k 1. 1.): ${YEARS.map(y => `${y}: ${DATA.obyvatele[y] || "?"}`).join(" · ")}.` : "";
  const ro = (r.opatreni && r.opatreni.length) ? ` Rozpočet po změnách roku ${state.year} zahrnuje ${r.opatreni.join(", ")}.` : "";
  $("#foot").innerHTML = `Data: výkazy <strong>FIN 2-12 M</strong> obce Běloky (IČO ${DATA.ico}), sestaveno k ${r.k || "?"}.<br>
    Hodnoty „Skutečnost" = výsledek od počátku roku, „Rozpočet" = rozpočet po změnách.${ro} Zobrazené částky jsou v Kč.${obyv}`;

  syncTabs();
  $("#spin").style.display = "none";
  $("#app").style.display = "block";
  render();
}
function syncTabs() {
  document.querySelectorAll("#yearTabs .tab").forEach(t => {
    t.classList.toggle("active", (state.view === "year" && t.dataset.year === state.year) || (state.view === "cmp" && t.dataset.year === "cmp") || (state.view === "anl" && t.dataset.year === "anl") || (state.view === "odp" && t.dataset.year === "odp"));
  });
}

init();
