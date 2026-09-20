"use strict";

const fmt = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
const kc = v => fmt.format(Math.round(v)) + " Kč";
const kcShort = v => {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: 2 }) + " mil.";
  if (a >= 1e3) return Math.round(v / 1e3) + " tis.";
  return fmt.format(Math.round(v));
};
const $ = s => document.querySelector(s);
const MESICE = ["", "led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"];

let D = null;      // internal data (MONITOR)
let B = null;      // budget.json (FIN statements + amendments)
let DK = null;     // denik.json (accounting journals — individual payments, internal only)
let AKT = null;    // current (latest) year in budget.json
const charts = {};

function chart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), cfg);
}
function opts(extra) {
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: false, resizeDelay: 150,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#cbd5e1", boxWidth: 12, font: { size: 11 } } },
      tooltip: { backgroundColor: "#020617", borderColor: "#334155", borderWidth: 1, padding: 10,
        callbacks: { label: c => ` ${c.dataset.label}: ${kc(c.parsed.y)}` } },
    },
    scales: {
      x: { ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
      y: { ticks: { color: "#94a3b8", callback: v => kcShort(v) }, grid: { color: "#1e293b" } },
    },
  }, extra || {});
}

// ---------- cumulatives / interpolation ----------
function cumAt(rada, m) {
  // cumulative in month m; when the statement is missing, interpolate linearly between neighbours
  const ex = rada.find(r => r.m === m);
  if (ex) return { p: ex.p, v: ex.v };
  const pred = [...rada].filter(r => r.m < m).pop();
  const po = rada.find(r => r.m > m);
  if (pred && po) {
    const t = (m - pred.m) / (po.m - pred.m);
    return { p: pred.p + (po.p - pred.p) * t, v: pred.v + (po.v - pred.v) * t };
  }
  return pred ? { p: pred.p, v: pred.v } : null;
}

// ---------- Overview ----------
function renderPrehled() {
  const r = B.roky[AKT];
  const u = r.ucty || {};
  const mes26 = D.mesicni[AKT] || [];
  const lastM = Math.max(...mes26.map(x => x.m), 0);
  const elapsed = lastM / 12;

  // seasonal forecast: share of the cumulative in month lastM of the full year, average 2022–2025
  const shares = [];
  for (const y of Object.keys(D.mesicni)) {
    if (y === AKT) continue;
    const rada = D.mesicni[y];
    const konec = cumAt(rada, 12), stred = cumAt(rada, lastM);
    if (konec && stred && konec.p && konec.v) shares.push({ y, p: stred.p / konec.p, v: stred.v / konec.v });
  }
  const avg = k => shares.reduce((s, x) => s + x[k], 0) / (shares.length || 1);
  const ytd = mes26.length ? cumAt(mes26, lastM) : null;

  // capital spend cannot be extrapolated seasonally (one-off projects) -> operations seasonally + capital as a known value
  const inv = r.vydaje.reduce((s, g) => s + g.polozky.reduce((q, p) => q + (/^6/.test(p.kod) ? p.skutecnost : 0), 0), 0);
  const invRozp = r.vydaje.reduce((s, g) => s + g.polozky.reduce((q, p) => q + (/^6/.test(p.kod) ? p.rozpocet : 0), 0), 0);
  const invOcek = Math.max(inv, invRozp);

  const progP = ytd ? ytd.p / avg("p") : null;
  const progV = ytd ? (ytd.v - inv) / avg("v") + invOcek : null;
  const rozsah = k => {
    const vals = shares.map(x => k === "p" ? ytd.p / x.p : (ytd.v - inv) / x.v + invOcek);
    return [Math.min(...vals), Math.max(...vals)];
  };
  const progSaldo = progP != null ? progP - progV : null;
  const progRezerva = progSaldo != null ? (u.pocatek || 0) + progSaldo : null;
  const kpi = [
    { lab: `Rezerva k ${r.k}`, val: kc(u.konec || 0), sub: `začátek roku: ${kcShort(u.pocatek || 0)}` },
    { lab: "Saldo od začátku roku", val: `<span class="${r.prijmy_celkem - r.vydaje_celkem >= 0 ? "up" : "down"}">${kcShort(r.prijmy_celkem - r.vydaje_celkem)}</span>`,
      sub: `příjmy ${kcShort(r.prijmy_celkem)} · výdaje ${kcShort(r.vydaje_celkem)}` },
    { lab: "Prognóza salda za celý rok", val: progSaldo != null ? `<span class="${progSaldo >= 0 ? "up" : "down"}">${kcShort(progSaldo)}</span>` : "—",
      sub: progRezerva != null ? `→ rezerva na konci roku ≈ ${kcShort(progRezerva)}` : "" },
    { lab: "Investice letos", val: kcShort(inv), sub: `${Math.round(inv / (r.vydaje_celkem || 1) * 100)} % výdajů` },
  ];
  $("#kpis").innerHTML = kpi.map(c => `<div class="kpi"><div class="lab">${c.lab}</div><div class="val">${c.val}</div><div class="sub">${c.sub}</div></div>`).join("");

  // forecast detail
  if (progP != null) {
    const [pMin, pMax] = rozsah("p"), [vMin, vMax] = rozsah("v");
    $("#progHint").textContent = `Sezónní extrapolace z kumulativu k měsíci ${lastM} podle průběhu let ${shares.map(s => s.y).join(", ")}.`;
    $("#prognoza").innerHTML = `<table>
      <thead><tr><th></th><th class="num">Očekávání</th><th class="num">Rozpětí (dle let)</th><th class="num">Rozpočet po změnách</th><th class="num">Odchylka od plánu</th></tr></thead><tbody>
      <tr><td><b>Příjmy</b></td><td class="num">${kc(progP)}</td><td class="num muted">${kcShort(pMin)} – ${kcShort(pMax)}</td>
        <td class="num">${kc(r.prijmy_rozpocet)}</td><td class="num ${progP - r.prijmy_rozpocet >= 0 ? "up" : "down"}">${(progP - r.prijmy_rozpocet >= 0 ? "+" : "−") + kcShort(Math.abs(progP - r.prijmy_rozpocet))}</td></tr>
      <tr><td><b>Výdaje</b></td><td class="num">${kc(progV)}</td><td class="num muted">${kcShort(vMin)} – ${kcShort(vMax)}</td>
        <td class="num">${kc(r.vydaje_rozpocet)}</td><td class="num ${progV - r.vydaje_rozpocet <= 0 ? "up" : "down"}">${(progV - r.vydaje_rozpocet >= 0 ? "+" : "−") + kcShort(Math.abs(progV - r.vydaje_rozpocet))}</td></tr>
      <tr class="tot"><td>Saldo</td><td class="num ${progSaldo >= 0 ? "up" : "down"}">${(progSaldo >= 0 ? "+" : "−") + kc(Math.abs(progSaldo))}</td>
        <td class="num muted">${kcShort(pMin - vMax)} – ${kcShort(pMax - vMin)}</td>
        <td class="num">${kc(r.prijmy_rozpocet - r.vydaje_rozpocet)}</td><td></td></tr>
      </tbody></table>
      <p class="hint" style="margin-top:8px">Výdaje = sezónní extrapolace provozu + investice ${kcShort(invOcek)} jako jednorázová položka (nelze extrapolovat). Další neplánované akce prognóza nezná.</p>`;
  } else {
    $("#prognoza").textContent = "Pro prognózu chybí měsíční data.";
  }

  // alerts
  const alerty = [];
  for (const g of r.vydaje) {
    const nm = `§${g.paragraf} ${g.nazev}`;
    if (g.rozpocet > 0 && g.skutecnost > g.rozpocet + 0.5)
      alerty.push(["err", `<b>Překročen závazný ukazatel</b> ${nm}: ${kcShort(g.skutecnost)} z ${kcShort(g.rozpocet)} (+${kcShort(g.skutecnost - g.rozpocet)}). Nutné rozpočtové opatření.`]);
    if (!g.rozpocet && g.skutecnost > 0)
      alerty.push(["err", `<b>Výdaj zcela mimo rozpočet</b> ${nm}: ${kcShort(g.skutecnost)}. Kapitola nemá schválený závazný ukazatel.`]);
  }
  for (const g of r.vydaje) {
    const podil = g.rozpocet ? g.skutecnost / g.rozpocet : 0;
    if (g.rozpocet >= 50000 && podil > elapsed + 0.3 && podil <= 1)
      alerty.push(["warn", `<b>Rychlé čerpání</b> §${g.paragraf} ${g.nazev}: ${Math.round(podil * 100)} % rozpočtu při ${Math.round(elapsed * 100)} % roku.`]);
  }
  for (const g of r.vydaje) {
    if (g.rozpocet >= 100000 && !g.skutecnost)
      alerty.push(["info", `<b>Zatím nečerpáno</b> §${g.paragraf} ${g.nazev}: rozpočet ${kcShort(g.rozpocet)}.`]);
  }
  const dotace = r.prijmy.flatMap(g => g.polozky).filter(p => /^4[12]/.test(p.kod));
  const dotRozp = dotace.reduce((s, p) => s + p.rozpocet, 0), dotSkut = dotace.reduce((s, p) => s + p.skutecnost, 0);
  if (dotRozp > 100000 && dotSkut / dotRozp < elapsed / 2)
    alerty.push(["warn", `<b>Dotace zatím nedorazily</b>: přijato ${kcShort(dotSkut)} z rozpočtovaných ${kcShort(dotRozp)}.`]);
  $("#alerty").innerHTML = alerty.length
    ? alerty.map(([t, txt]) => `<div class="alert ${t}"><span class="ic">${t === "err" ? "⛔" : t === "warn" ? "⚠️" : "ℹ️"}</span><span>${txt}</span></div>`).join("")
    : `<div class="alert info"><span class="ic">✅</span><span>Žádné nálezy — vše v rámci rozpočtu.</span></div>`;

  // reserve chart
  const roky = Object.keys(B.roky).sort();
  chart("rezervaChart", {
    type: "bar",
    data: { labels: roky.map(y => y === AKT ? y + " *" : y),
      datasets: [{ label: "Rezerva na konci roku", data: roky.map(y => (B.roky[y].ucty || {}).konec || 0),
        backgroundColor: roky.map(y => y === AKT ? "#fdba7466" : "#fdba74"), borderRadius: 6 }] },
    options: opts({ plugins: { legend: { display: false }, tooltip: { backgroundColor: "#020617", callbacks: { label: c => ` ${kc(c.parsed.y)}` } } } }),
  });
}

// ---------- Cash-flow ----------
let cashRok = null;
function renderCash() {
  const roky = Object.keys(D.mesicni).sort();
  if (!cashRok) cashRok = roky[roky.length - 1];
  $("#cashRok").innerHTML = roky.map(y => `<button data-y="${y}" class="${y === cashRok ? "active" : ""}">${y}</button>`).join("");
  $("#cashRok").querySelectorAll("button").forEach(b => b.onclick = () => { cashRok = b.dataset.y; renderCash(); });

  const rada = D.mesicni[cashRok];
  const labels = [], dP = [], dV = [], cP = [], cV = [];
  let prev = { p: 0, v: 0, m: 0 };
  for (const rec of rada) {
    labels.push(rec.m - prev.m > 1 ? `${MESICE[prev.m + 1]}–${MESICE[rec.m]}` : MESICE[rec.m]);
    dP.push(rec.p - prev.p); dV.push(rec.v - prev.v);
    cP.push(rec.p); cV.push(rec.v);
    prev = rec;
  }
  chart("cashChart", {
    type: "bar",
    data: { labels, datasets: [
      { label: "Příjmy za období", data: dP, backgroundColor: "#38bdf8", borderRadius: 5 },
      { label: "Výdaje za období", data: dV, backgroundColor: "#fb7185", borderRadius: 5 },
      { label: "Příjmy kumulativně", type: "line", data: cP, borderColor: "#38bdf8", borderDash: [6, 4], pointRadius: 3, borderWidth: 2 },
      { label: "Výdaje kumulativně", type: "line", data: cV, borderColor: "#fb7185", borderDash: [6, 4], pointRadius: 3, borderWidth: 2 },
    ] },
    options: opts(),
  });

  const PAL = ["#64748b", "#94a3b8", "#22d3ee", "#38bdf8", "#fbbf24"];
  const sets = [];
  Object.keys(D.mesicni).sort().forEach((y, i) => {
    sets.push({ label: y, data: D.mesicni[y].map(r => ({ x: r.m, y: r.v })),
      borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length], pointRadius: 3, borderWidth: y === cashRok ? 3 : 1.5, tension: .25 });
  });
  const o = opts();
  o.scales.x = { type: "linear", min: 1, max: 12, ticks: { stepSize: 1, color: "#94a3b8", callback: v => MESICE[v] || v }, grid: { color: "#1e293b" } };
  chart("cumChart", { type: "line", data: { datasets: sets }, options: o });
}

// ---------- Chapter heatmap ----------
function renderHeat() {
  const roky = Object.keys(D.odvetvi).sort();
  const pars = {};
  for (const y of roky)
    for (const [kod, v] of Object.entries(D.odvetvi[y])) {
      pars[kod] = pars[kod] || { sum: 0, vals: {} };
      pars[kod].vals[y] = v.s;
      pars[kod].sum += v.s;
    }
  const q = ($("#heatQ").value || "").toLowerCase();
  const norm = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const rows = Object.entries(pars)
    .filter(([kod]) => !q || norm(`${kod} ${D.par_nazvy[kod] || ""}`).includes(norm(q)))
    .sort((a, b) => b[1].sum - a[1].sum);

  let h = `<table class="heat"><thead><tr><th>§</th><th>Kapitola</th>${roky.map(y => `<th class="num">${y.slice(2)}</th>`).join("")}<th class="num">Σ</th></tr></thead><tbody>`;
  for (const [kod, info] of rows) {
    const rowMax = Math.max(...Object.values(info.vals), 1);
    h += `<tr><td class="code">${kod}</td><td class="nm" title="${D.par_nazvy[kod] || ""}">${D.par_nazvy[kod] || "—"}</td>`;
    for (const y of roky) {
      const v = info.vals[y];
      const a = v ? Math.max(0.06, v / rowMax * 0.55) : 0;
      h += `<td class="h" style="background:rgba(251,146,60,${a})" title="${y}: ${v ? kc(v) : "0 Kč"}">${v ? fmt.format(Math.round(v / 1000)) : "·"}</td>`;
    }
    h += `<td class="h"><b>${fmt.format(Math.round(info.sum / 1000))}</b></td></tr>`;
  }
  h += `<tr class="tot"><td></td><td>Celkem (tis. Kč)</td>${roky.map(y => {
    const s = Object.values(D.odvetvi[y]).reduce((q2, v) => q2 + v.s, 0);
    return `<td class="h">${fmt.format(Math.round(s / 1000))}</td>`;
  }).join("")}<td class="h"><b>${fmt.format(Math.round(rows.reduce((s, r) => s + r[1].sum, 0) / 1000))}</b></td></tr>`;
  $("#heatBody").innerHTML = h + "</tbody></table>";
}

// ---------- Benchmark ----------
function renderBench() {
  const plny = Object.keys(D.sousede[0].roky).filter(y => y !== AKT).sort();
  const rokB = plny[plny.length - 1];
  $("#benchRokLab").textContent = `(${rokB})`;
  const obce = D.sousede.filter(o => o.roky[rokB] && o.obyvatele);
  const per = (o, k, y) => (o.roky[y || rokB][k] || 0) / o.obyvatele;

  chart("benchBar", {
    type: "bar",
    data: { labels: obce.map(o => o.nazev),
      datasets: [
        { label: "Příjmy / ob.", data: obce.map(o => per(o, "p")), backgroundColor: "#38bdf8", borderRadius: 5 },
        { label: "Výdaje / ob.", data: obce.map(o => per(o, "v")), backgroundColor: "#fb7185", borderRadius: 5 },
        { label: "Investice / ob.", data: obce.map(o => per(o, "inv")), backgroundColor: "#fbbf24", borderRadius: 5 },
      ] },
    options: opts(),
  });

  const PAL = ["#fdba74", "#38bdf8", "#34d399", "#fb7185", "#a78bfa", "#22d3ee", "#f472b6"];
  chart("benchLine", {
    type: "line",
    data: { labels: plny, datasets: obce.map((o, i) => ({
      label: o.nazev, data: plny.map(y => o.roky[y] ? per(o, "v", y) : null),
      borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length],
      borderWidth: o.nazev === "Běloky" ? 3.5 : 1.5, pointRadius: o.nazev === "Běloky" ? 4 : 2, tension: .25 })) },
    options: opts(),
  });

  // KPI: Běloky vs. neighbours' average
  const bel = obce.find(o => o.nazev === "Běloky");
  const sous = obce.filter(o => o !== bel);
  const prum = k => sous.reduce((s, o) => s + per(o, k), 0) / sous.length;
  const invPodil = o => plny.reduce((s, y) => s + (o.roky[y] ? o.roky[y].inv : 0), 0) / plny.reduce((s, y) => s + (o.roky[y] ? o.roky[y].v : 0), 0);
  const poradiV = [...obce].sort((a, b) => per(a, "v") - per(b, "v")).findIndex(o => o === bel) + 1;
  $("#benchKpis").innerHTML = [
    { lab: `Výdaje na obyvatele ${rokB}`, val: kc(per(bel, "v")), sub: `průměr sousedů: ${kc(prum("v"))}` },
    { lab: `Příjmy na obyvatele ${rokB}`, val: kc(per(bel, "p")), sub: `průměr sousedů: ${kc(prum("p"))}` },
    { lab: `Investiční podíl ${plny[0]}–${rokB}`, val: Math.round(invPodil(bel) * 100) + " %",
      sub: `průměr sousedů: ${Math.round(sous.reduce((s, o) => s + invPodil(o), 0) / sous.length * 100)} %` },
    { lab: "Pořadí ve výdajích/ob.", val: `${poradiV}. z ${obce.length}`, sub: "1. = nejnižší výdaje na obyvatele" },
  ].map(c => `<div class="kpi"><div class="lab">${c.lab}</div><div class="val">${c.val}</div><div class="sub">${c.sub}</div></div>`).join("");

  let h = `<table><thead><tr><th>Obec</th><th class="num">Obyvatel</th><th class="num">Příjmy ${rokB}</th><th class="num">Výdaje ${rokB}</th>
    <th class="num">Saldo</th><th class="num">Investice</th><th class="num">Inv. podíl</th><th class="num">Příjmy/ob.</th><th class="num">Výdaje/ob.</th></tr></thead><tbody>`;
  for (const o of [...obce].sort((a, b) => per(b, "v") - per(a, "v"))) {
    const r = o.roky[rokB], s = r.p - r.v;
    h += `<tr${o.nazev === "Běloky" ? ' style="background:#7c2d1218"' : ""}><td><b>${o.nazev}</b></td><td class="num">${o.obyvatele}</td>
      <td class="num">${kc(r.p)}</td><td class="num">${kc(r.v)}</td>
      <td class="num ${s >= 0 ? "up" : "down"}">${(s >= 0 ? "+" : "−") + kcShort(Math.abs(s))}</td>
      <td class="num">${kcShort(r.inv)}</td><td class="num">${Math.round(r.inv / r.v * 100)} %</td>
      <td class="num">${kc(per(o, "p"))}</td><td class="num">${kc(per(o, "v"))}</td></tr>`;
  }
  $("#benchTable").innerHTML = h + "</tbody></table>";
}

// ---------- Payments (accounting journal) ----------
const KAT_ODP = { pausal: "pravidelný svoz", kontejnery: "kontejnery", bioodpad: "bioodpad",
  vybaveni: "vybavení", nebezpecny: "nebezpečný", ostatni: "likvidace/ostatní" };
const platbyState = { rok: null, q: "" };

function renderPlatby() {
  if (!DK) return;
  const roky = Object.keys(DK.roky).sort();
  if (!platbyState.rok) platbyState.rok = roky[roky.length - 1];
  const rok = platbyState.rok, R = DK.roky[rok];

  // year switch
  const seg = $("#platbyRok");
  if (!seg.children.length) roky.forEach(y => {
    const b = document.createElement("button");
    b.textContent = y;
    b.onclick = () => { platbyState.rok = y; renderPlatby(); };
    seg.appendChild(b);
  });
  [...seg.children].forEach(b => b.classList.toggle("active", b.textContent === platbyState.rok));

  // main payments table (with search in the notes)
  const q = platbyState.q.trim().toLowerCase();
  const rows = R.top_platby.filter(p => !q || p.pozn.toLowerCase().includes(q));
  const parNaz = p => (D.par_nazvy && D.par_nazvy[p]) ? ` title="${D.par_nazvy[p]}"` : "";
  $("#platbyHint").textContent = `Úhrady z účtu a pokladny (položky 5xxx/6xxx) seskupené po fakturách — top ${R.top_platby.length} plateb roku ${rok}, `
    + `celkem dle deníku ${kc(R.vydaje_celkem)}. Interní data — neveřejné.`;
  $("#platbyBody").innerHTML = `<table><thead><tr><th>Měsíc</th><th>Poznámka z účetnictví</th><th>§</th><th class="num">Částka</th></tr></thead><tbody>`
    + rows.map(p => `<tr><td class="muted">${p.mesic ? MESICE[p.mesic] : "—"}</td>
        <td>${p.pozn || "<span class='muted'>bez poznámky</span>"}</td>
        <td class="muted">${p.par.map(x => `<span${parNaz(x)}>§${x}</span>`).join(" ")}</td>
        <td class="num"><b>${kc(p.castka)}</b></td></tr>`).join("")
    + `</tbody></table>` + (rows.length ? "" : `<p class="hint">Nic nenalezeno.</p>`);

  // waste detail
  $("#platbyOdpady").innerHTML = `<table><thead><tr><th>Měsíc</th><th>Poznámka</th><th>Kategorie</th><th class="num">Částka</th></tr></thead><tbody>`
    + R.odpady_platby.map(p => `<tr><td class="muted">${p.mesic ? MESICE[p.mesic] : "—"}</td>
        <td>${p.pozn || "—"}</td><td class="muted">${KAT_ODP[p.kat] || p.kat}</td>
        <td class="num">${kc(p.castka)}</td></tr>`).join("") + `</tbody></table>`;

  // completeness check: journal vs. MONITOR functional breakdown
  const mon = (D.odvetvi && D.odvetvi[rok]) || {};
  const pars = new Set([...Object.keys(R.paragrafy), ...Object.keys(mon)]);
  const rws = [...pars].map(p => {
    const dv = R.paragrafy[p] || 0, mv = (mon[p] && mon[p].s) || 0;
    return { p, dv, mv, dif: dv - mv };
  }).filter(r => r.dv > 500 || r.mv > 500).sort((a, b) => b.mv - a.mv);
  $("#platbyPar").innerHTML = `<table><thead><tr><th>§</th><th>Kapitola</th><th class="num">Deník</th><th class="num">Výkaz</th><th class="num">Rozdíl</th></tr></thead><tbody>`
    + rws.map(r => `<tr><td class="muted">§${r.p}</td><td>${(D.par_nazvy && D.par_nazvy[r.p] || "").slice(0, 34)}</td>
        <td class="num">${kcShort(r.dv)}</td><td class="num">${kcShort(r.mv)}</td>
        <td class="num ${Math.abs(r.dif) < 1000 ? "muted" : "down"}">${Math.abs(r.dif) < 1000 ? "✓" : kcShort(r.dif)}</td></tr>`).join("")
    + `</tbody></table>`;
}

// ---------- init ----------
async function init() {
  try {
    const [dRes, bRes] = await Promise.all([
      fetch("data.json", { cache: "no-store" }),
      fetch("../budget.json", { cache: "no-store" }),
    ]);
    D = await dRes.json();
    B = await bRes.json();
  } catch (e) {
    $("#spin").textContent = "Chyba načítání dat: " + e;
    return;
  }
  try {
    const kRes = await fetch("denik.json", { cache: "no-store" });
    if (kRes.ok) DK = await kRes.json();
  } catch (e) { /* deník je volitelný */ }
  if (!DK) document.querySelector('#tabs .tab[data-v="platby"]').style.display = "none";
  AKT = Object.keys(B.roky).sort().pop();
  $("#gen").textContent = `data načtena ${D.generovano}`;

  document.querySelectorAll("#tabs .tab").forEach(t => t.onclick = () => {
    document.querySelectorAll("#tabs .tab").forEach(x => x.classList.toggle("active", x === t));
    document.querySelectorAll("[data-view]").forEach(v => v.style.display = v.dataset.view === t.dataset.v ? "block" : "none");
    ({ prehled: renderPrehled, cash: renderCash, kapitoly: renderHeat, bench: renderBench, platby: renderPlatby })[t.dataset.v]();
  });
  $("#heatQ").oninput = renderHeat;
  $("#platbyQ").oninput = () => { platbyState.q = $("#platbyQ").value; renderPlatby(); };

  $("#spin").style.display = "none";
  $("#app").style.display = "block";
  // deep-link: /interni/#platby, #cash, …
  const want = location.hash.slice(1);
  const tgt = want && document.querySelector(`#tabs .tab[data-v="${want}"]`);
  if (tgt && tgt.style.display !== "none") tgt.click();
  else renderPrehled();
}
init();
