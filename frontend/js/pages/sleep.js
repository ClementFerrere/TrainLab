// Sommeil & récupération — nights, HRV, resting HR, Body Battery, stress.
import { api } from "../api.js";
import { T, SPORTS, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, status, empty, seg, onSeg, disposeCharts } from "../ui.js";
import * as f from "../fmt.js";

const RANGES = [["30", "30 j"], ["90", "90 j"], ["182", "6 mois"], ["365", "1 an"]];
const STORE_KEY = "allure.sleep.range";
const C_HRV = T.pos;            // HRV identity
const C_RHR = T.fatigue;        // resting HR identity
const C_STRESS = SPORTS.bike.color;
const HRV_LABEL = { BALANCED: ["good", "Équilibrée"], UNBALANCED: ["warning", "Déséquilibrée"], LOW: ["serious", "Basse"], POOR: ["critical", "Faible"] };

function readRange() {
  try { return localStorage.getItem(STORE_KEY) || "90"; } catch { return "90"; }
}
function saveRange(v) {
  try { localStorage.setItem(STORE_KEY, v); } catch { /* private mode */ }
}

// clock hour of a local ISO timestamp on a 20h→36h scale (night-centred)
function clockH(iso) {
  if (!iso) return null;
  const h = Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
  return h < 15 ? h + 24 : h;
}
const fmtClock = (h) => {
  if (h == null) return "–";
  const x = ((h % 24) + 24) % 24;
  const hh = Math.floor(x), mm = Math.round((x - hh) * 60);
  return mm === 60 ? `${hh + 1}h00` : `${hh}h${String(mm).padStart(2, "0")}`;
};

function rolling(arr, w) {
  return arr.map((_, i) => {
    const s = arr.slice(Math.max(0, i - w + 1), i + 1).filter(f.isNum);
    return s.length >= Math.ceil(w / 2) ? s.reduce((a, b) => a + b, 0) / s.length : null;
  });
}
const mean = (a) => { const s = a.filter(f.isNum); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const sd = (a) => {
  const s = a.filter(f.isNum); if (s.length < 2) return null;
  const m = mean(s); return Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / (s.length - 1));
};

export async function render(view) {
  const start = f.isoDate(f.addDays(f.today(), -400));
  const [well, load, rd] = await Promise.all([
    api.get(`/api/wellness?start=${start}`), api.get(`/api/load?start=${start}`),
    api.get(`/api/readiness?start=${start}`).catch(() => null),
  ]);
  const nights = well.filter((r) => r.sleep_seconds);
  if (!well.length) {
    view.innerHTML = `<div class="card">${empty("Pas encore de données de récupération",
      "Le sommeil, la HRV et la FC de repos arrivent via l'API personnelle Garmin.",
      `<a class="btn primary" href="#/settings">Connecter Garmin</a>`)}</div>`;
    return;
  }
  let range = readRange();

  view.innerHTML = `
    <div class="filters">${seg("range", RANGES, range)}<span class="muted sl-note">Une nuit est datée du matin où elle se termine.</span></div>
    <div class="grid">
      <div class="span-5" id="sl-last"></div>
      <div class="span-4" id="sl-recov"></div>
      <div class="span-3" id="sl-avg"></div>
      <div class="span-12">${card({ title: "Readiness du matin", sub: "Score maison : HRV, FC de repos, sommeil, Body Battery et stress nocturne vs tes 28 jours précédents (50 = ta normale)", actions: `<span id="sl-rd-chip"></span>`, body: `<div class="legend" id="sl-rd-leg"></div><div class="chart" id="sl-rd" style="height:260px"></div>` })}</div>
      <div class="span-12">${card({ title: "Fenêtres de sommeil", sub: "Du coucher au réveil, une barre par nuit — couleur = score de sommeil", body: `<div class="chart tall" id="sl-window"></div>` })}</div>
      <div class="span-12">${card({ title: "Phases de sommeil", sub: "Heures par phase, nuit par nuit", body: `<div class="legend" id="sl-stage-leg"></div><div class="chart" id="sl-stages"></div>` })}</div>
      <div class="span-7">${card({ title: "HRV nocturne", sub: "Moyenne de la nuit, moyenne 7 j et plage équilibrée (baseline Garmin)", body: `<div class="legend" id="sl-hrv-leg"></div><div class="chart" id="sl-hrv"></div>` })}</div>
      <div class="span-5">${card({ title: "FC de repos", sub: "Valeur quotidienne et moyenne 7 j", body: `<div class="legend" id="sl-rhr-leg"></div><div class="chart" id="sl-rhr"></div>` })}</div>
      <div class="span-7">${card({ title: "Body Battery", sub: "Plage quotidienne, du minimum au maximum", body: `<div class="chart" id="sl-bb"></div>` })}</div>
      <div class="span-5">${card({ title: "Stress", sub: "Stress moyen de la journée et moyenne 7 j", body: `<div class="legend" id="sl-stress-leg"></div><div class="chart" id="sl-stress"></div>` })}</div>
      <div class="span-12" id="sl-impact"></div>
    </div>`;

  const draw = () => {
    disposeCharts();
    const days = Number(range);
    const from = f.isoDate(f.addDays(f.today(), -days + 1));
    const rows = well.filter((r) => r.date >= from);
    const nr = rows.filter((r) => r.sleep_seconds);
    document.getElementById("sl-last").innerHTML = lastNight(nights);
    document.getElementById("sl-recov").innerHTML = recovery(well);
    document.getElementById("sl-avg").innerHTML = averages(nr, days);
    drawReadiness(rd, from);
    drawWindow(nr);
    drawStages(nr);
    drawHrv(rows);
    drawRhr(rows);
    drawBodyBattery(rows);
    drawStress(rows);
    impactPanel(well, load, from);
  };
  onSeg(view, "range", (v) => { range = v; saveRange(v); draw(); });
  draw();
}

// ---------------------------------------------------------------- readiness history
const RD_ZONES = [[0, 30, "--serious", "récup"], [30, 45, "--warning", "prudence"], [45, 65, "--good", "normal"], [65, 100, "--good", "prêt"]];
const C_RD = T.fitness;

function drawReadiness(rd, from) {
  const node = document.getElementById("sl-rd");
  const days = (rd?.days || []).filter((r) => r.date >= from);
  const scored = days.filter((r) => f.isNum(r.score));
  if (!scored.length) {
    node.style.height = "auto";
    node.innerHTML = `<p class="muted">Pas assez de nuits pour établir ta référence (il en faut une dizaine).</p>`;
    return;
  }
  const t = rd.today || {};
  document.getElementById("sl-rd-chip").innerHTML = f.isNum(t.score) ? status(t.level, `${f.num(t.score)} · ${t.label}`) : "";
  const labels = rd.labels || {};
  const dates = days.map((r) => r.date);
  const score = days.map((r) => (f.isNum(r.score) ? r.score : null));
  const avg7 = rolling(score, 7);
  const flags = days.map((r, i) => (f.isNum(r.divergence) && Math.abs(r.divergence) > 1.5 && score[i] != null ? [i, score[i]] : null)).filter(Boolean);
  const css = getComputedStyle(document.documentElement);
  document.getElementById("sl-rd-leg").innerHTML = `
    <span><i class="line" style="background:${C_RD};opacity:.45"></i>Score du jour</span>
    <span><i class="line" style="background:${C_RD}"></i>Moyenne 7 j</span>
    <span><i class="sl-flag"></i>Ressenti ≠ signaux (divergence &gt; 1,5 σ)</span>`;
  chart(node, {
    animation: false,
    grid: { left: 40, right: 64, top: 12, bottom: 26 },
    xAxis: { type: "category", data: dates, axisLabel: { formatter: (v) => f.dateShort(v), hideOverlap: true }, boundaryGap: false },
    yAxis: { type: "value", min: 0, max: 100, interval: 25 },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = days[ps[0].dataIndex];
        if (!r) return "";
        let h = ttTitle(`Nuit du ${f.dateDay(r.date)}`);
        if (f.isNum(r.score)) h += ttRow(C_RD, f.num(r.score), "readiness");
        for (const k of Object.keys(labels)) if (f.isNum(r[`z_${k}`])) h += ttRow(r[`z_${k}`] >= 0 ? T.pos : T.neg, `${f.signed(r[`z_${k}`], 1)} σ`, labels[k], true);
        if (f.isNum(r.divergence)) h += ttRow(T.text3, `${f.signed(r.divergence, 1)} σ`, "ressenti − signaux");
        return h;
      },
    },
    series: [
      { name: "Score", type: "line", data: score, color: C_RD, lineStyle: { width: 1, opacity: 0.45 }, showSymbol: false, connectNulls: false,
        markArea: { silent: true, data: RD_ZONES.map(([a, b, c, l]) => [
          { yAxis: a, itemStyle: { color: css.getPropertyValue(c).trim(), opacity: l === "normal" ? 0.05 : 0.09 },
            label: { show: true, position: "right", formatter: l, color: T.text3, fontSize: 10 } }, { yAxis: b }]) } },
      { name: "Moyenne 7 j", type: "line", data: avg7, color: C_RD, lineStyle: { width: 2 }, showSymbol: false },
      { name: "Divergence", type: "scatter", data: flags, symbol: "triangle", symbolSize: 11, z: 5,
        itemStyle: { color: T.warning, borderColor: T.surface, borderWidth: 2 } },
    ],
  });
}

// ---------------------------------------------------------------- hero cards
function stageBar(n) {
  const tot = n.sleep_seconds + (n.awake_seconds || 0);
  const seg1 = (v, c, l) => v ? `<span style="width:${(v / tot) * 100}%;background:${c}" data-tip="${f.esc(`<b>${f.hm(v)}</b> ${l} · ${f.num((v / tot) * 100)} %`)}"></span>` : "";
  return `<div class="stage-bar">${seg1(n.deep_seconds, T.deep, "profond")}${seg1(n.light_seconds, T.light, "léger")}${seg1(n.rem_seconds, T.rem, "paradoxal")}${seg1(n.awake_seconds, T.awake, "éveillé")}</div>`;
}

function lastNight(nights) {
  const n = nights[nights.length - 1];
  if (!n) return card({ title: "Dernière nuit", body: empty("Aucune nuit enregistrée") });
  const pct = (v) => (n.sleep_seconds ? (v / n.sleep_seconds) * 100 : null);
  const scoreLvl = n.sleep_score >= 80 ? "good" : n.sleep_score >= 60 ? "warning" : "serious";
  const scoreLbl = n.sleep_score >= 80 ? "bon" : n.sleep_score >= 60 ? "moyen" : "faible";
  return card({
    cls: "glow",
    title: "Dernière nuit",
    sub: `${f.dateLong(n.date)} · ${fmtClock(clockH(n.sleep_start))} → ${fmtClock(clockH(n.sleep_end))}`,
    body: `
      <div class="hero-row"><div class="hero-num">${f.hm(n.sleep_seconds)}</div>${n.sleep_score ? status(scoreLvl, `score ${f.num(n.sleep_score)} · ${scoreLbl}`) : ""}</div>
      ${stageBar(n)}
      <div class="legend sl-legend">
        <span><i style="background:${T.deep}"></i>Profond <b>${f.hm(n.deep_seconds)}</b> <span class="muted">${f.num(pct(n.deep_seconds))} %</span></span>
        <span><i style="background:${T.light}"></i>Léger <b>${f.hm(n.light_seconds)}</b></span>
        <span><i style="background:${T.rem}"></i>Paradoxal <b>${f.hm(n.rem_seconds)}</b> <span class="muted">${f.num(pct(n.rem_seconds))} %</span></span>
        <span><i style="background:${T.awake}"></i>Éveil <b>${f.hm(n.awake_seconds)}</b></span>
      </div>
      <div class="stat-grid four">
        ${stat("Réveils", f.num(n.awake_count))}
        ${stat("FC sommeil", f.num(n.sleep_hr), "bpm")}
        ${stat("Respiration", f.num(n.sleep_resp, 1), "rpm")}
        ${stat("SpO2", f.num(n.sleep_spo2, 1), "%")}
      </div>`,
  });
}

function recovery(well) {
  const last = [...well].reverse().find((r) => f.isNum(r.hrv_overnight)) || {};
  const recentRhr = well.slice(-31, -1).map((r) => r.resting_hr).filter(f.isNum).sort((a, b) => a - b);
  const medRhr = recentRhr.length ? recentRhr[Math.floor(recentRhr.length / 2)] : null;
  const [lvl, lbl] = HRV_LABEL[last.hrv_status] || ["neutral", "—"];
  // HRV range visual: balanced band, weekly marker, last-night dot
  let band = "";
  if (f.isNum(last.hrv_baseline_low) && f.isNum(last.hrv_baseline_high)) {
    const vals = [last.hrv_baseline_low, last.hrv_baseline_high, last.hrv_overnight, last.hrv_weekly].filter(f.isNum);
    const lo = Math.min(...vals) * 0.85, hi = Math.max(...vals) * 1.12;
    const p = (v) => ((v - lo) / (hi - lo)) * 100;
    band = `
      <div class="hrv-range" role="img" aria-label="HRV ${f.num(last.hrv_overnight)} ms, plage équilibrée ${f.num(last.hrv_baseline_low)}–${f.num(last.hrv_baseline_high)} ms">
        <div class="hr-track"></div>
        <div class="hr-band" style="left:${p(last.hrv_baseline_low)}%;width:${p(last.hrv_baseline_high) - p(last.hrv_baseline_low)}%"><span>plage équilibrée ${f.num(last.hrv_baseline_low)}–${f.num(last.hrv_baseline_high)}</span></div>
        ${f.isNum(last.hrv_weekly) ? `<div class="hr-week" style="left:${p(last.hrv_weekly)}%" data-tip="${f.esc(`<b>${f.num(last.hrv_weekly)} ms</b> moyenne 7 j`)}"><span>moy. 7 j ${f.num(last.hrv_weekly)}</span></div>` : ""}
        ${f.isNum(last.hrv_overnight) ? `<div class="hr-dot" style="left:${p(last.hrv_overnight)}%" data-tip="${f.esc(`<b>${f.num(last.hrv_overnight)} ms</b> cette nuit`)}"></div>` : ""}
      </div>`;
  }
  const lastRow = well[well.length - 1] || {};
  const dRhr = f.isNum(lastRow.resting_hr) && medRhr ? lastRow.resting_hr - medRhr : null;
  return card({
    title: "Récupération",
    sub: last.date ? `HRV de la nuit du ${f.dateShort(last.date)}` : "",
    body: `
      <div class="hero-row"><div class="hero-num sm">${f.num(last.hrv_overnight)}<span class="hero-unit">ms</span></div>${last.hrv_status ? status(lvl, `HRV ${lbl.toLowerCase()}`) : ""}</div>
      ${band}
      <div class="stat-grid three">
        ${stat("FC de repos", f.num(lastRow.resting_hr), "bpm", dRhr == null ? "" : `${f.signed(dRhr)} vs médiane 30 j`)}
        ${stat("Body Battery max", f.num(lastRow.body_battery_high))}
        ${stat("Pic HRV 5 min", f.num(last.hrv_5min_high), "ms")}
      </div>`,
  });
}

function averages(nr, days) {
  if (!nr.length) return card({ title: "Sur la période", body: empty("Aucune nuit") });
  const hrs = nr.map((r) => r.sleep_seconds / 3600);
  const beds = nr.map((r) => clockH(r.sleep_start)).filter(f.isNum);
  const wakes = nr.map((r) => clockH(r.sleep_end)).filter(f.isNum);
  const over7 = hrs.filter((h) => h >= 7).length / hrs.length * 100;
  const label = RANGES.find(([v]) => Number(v) === days)?.[1] || "";
  return card({
    title: "Sur la période",
    sub: `${nr.length} nuits · ${label}`,
    body: `<div class="stat-grid two">
      ${stat("Sommeil moyen", f.hm(mean(hrs) * 3600))}
      ${stat("Score moyen", f.num(mean(nr.map((r) => r.sleep_score))))}
      ${stat("Nuits ≥ 7 h", f.num(over7), "%")}
      ${stat("HRV moyenne", f.num(mean(nr.map((r) => r.hrv_overnight))), "ms")}
      ${stat("Coucher moyen", fmtClock(mean(beds)), "", `± ${f.num((sd(beds) || 0) * 60)} min`)}
      ${stat("Réveil moyen", fmtClock(mean(wakes)), "", `± ${f.num((sd(wakes) || 0) * 60)} min`)}
    </div>`,
  });
}

// ---------------------------------------------------------------- charts
function xDates(rows) {
  return { type: "category", data: rows.map((r) => r.date), axisLabel: { formatter: (v) => f.dateShort(v), hideOverlap: true } };
}
function legend(id, items) {
  const node = document.getElementById(id);
  if (node) node.innerHTML = items.map(([c, l, kind]) => `<span><i class="${kind === "line" ? "line" : ""}" style="background:${c}"></i>${l}</span>`).join("");
}

function drawWindow(nr) {
  if (!nr.length) return;
  const data = nr.map((r, i) => [i, clockH(r.sleep_start), clockH(r.sleep_end), r.sleep_score ?? 0, r.sleep_seconds]);
  const scores = data.map((d) => d[3]).filter((v) => v > 0).sort((a, b) => a - b);
  const qs = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))];
  const smin = scores.length ? Math.floor(qs(0.05)) : 40, smax = scores.length ? Math.ceil(qs(0.95)) : 95;
  const ymin = Math.max(18, Math.floor(Math.min(...data.map((d) => d[1]).filter(f.isNum)) - 0.5));
  const ymax = Math.min(38, Math.ceil(Math.max(...data.map((d) => d[2]).filter(f.isNum)) + 0.5));
  chart("#sl-window", {
    animation: false,
    grid: { left: 52, right: 110, top: 12, bottom: 28 },
    tooltip: {
      formatter: (p) => {
        const r = nr[p.data[0]];
        return ttTitle(`Nuit du ${f.dateShort(f.isoDate(f.addDays(f.parseDate(r.date), -1)))} au ${f.dateShort(r.date)}`)
          + ttRow(p.color, f.hm(r.sleep_seconds), "de sommeil", true)
          + `<div class="tt-row"><span class="tt-val">${fmtClock(p.data[1])} → ${fmtClock(p.data[2])}</span></div>`
          + (r.sleep_score ? `<div class="tt-row"><span class="tt-val">${f.num(r.sleep_score)}</span><span>score</span></div>` : "");
      },
    },
    visualMap: {
      type: "continuous", dimension: 3, min: Math.min(smin, smax - 5), max: smax, calculable: false, right: 0, top: "middle", itemHeight: 140, itemWidth: 10,
      text: [`score ${smax}`, `${Math.min(smin, smax - 5)}`], textStyle: { color: T.text3, fontSize: 11 }, inRange: { color: T.seq.slice(1, 10) },
    },
    xAxis: { ...xDates(nr), data: nr.map((r) => r.date) },
    yAxis: { type: "value", inverse: true, min: ymin, max: ymax, interval: 2, axisLabel: { formatter: (v) => fmtClock(v) } },
    series: [{
      type: "custom", encode: { x: 0, y: [1, 2] }, data: data.filter((d) => f.isNum(d[1]) && f.isNum(d[2])),
      renderItem: (params, a) => {
        const x = a.coord([a.value(0), a.value(1)]);
        const y2 = a.coord([a.value(0), a.value(2)])[1];
        const w = Math.max(1.5, Math.min(10, a.size([1, 0])[0] * 0.62));
        return { type: "rect", shape: { x: x[0] - w / 2, y: x[1], width: w, height: y2 - x[1], r: Math.min(3, w / 2) }, style: { fill: a.visual("color") } };
      },
    }],
  });
}

function drawStages(nr) {
  if (!nr.length) return;
  const many = nr.length > 120;
  const mk = (key, name, color) => ({
    name, type: "bar", stack: "s", color, barMaxWidth: 24,
    itemStyle: { borderColor: many ? undefined : T.surface, borderWidth: many ? 0 : 1, borderRadius: 0 },
    data: nr.map((r) => (r[key] || 0) / 3600),
  });
  legend("sl-stage-leg", [[T.deep, "Profond"], [T.light, "Léger"], [T.rem, "Paradoxal"], [T.awake, "Éveil"]]);
  chart("#sl-stages", {
    animation: false,
    grid: { left: 40, right: 12, top: 10, bottom: 28 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => {
        const r = nr[ps[0].dataIndex];
        return ttTitle(f.dateDay(r.date)) + ps.slice().reverse().map((p) => ttRow(p.color, f.hm(p.value * 3600), p.seriesName.toLowerCase(), true)).join("")
          + `<div class="tt-row"><span class="tt-val">${f.hm(r.sleep_seconds)}</span><span>de sommeil</span></div>`;
      },
    },
    xAxis: xDates(nr),
    yAxis: { type: "value", axisLabel: { formatter: (v) => `${v} h` }, splitNumber: 4 },
    series: [mk("deep_seconds", "Profond", T.deep), mk("light_seconds", "Léger", T.light), mk("rem_seconds", "Paradoxal", T.rem),
      { ...mk("awake_seconds", "Éveil", T.awake), itemStyle: { borderRadius: [3, 3, 0, 0], borderColor: many ? undefined : T.surface, borderWidth: many ? 0 : 1 } }],
  });
}

function drawHrv(rows) {
  const r = rows.filter((x) => f.isNum(x.hrv_overnight) || f.isNum(x.hrv_weekly));
  if (!r.length) { document.getElementById("sl-hrv").innerHTML = empty("Pas de HRV sur la période"); return; }
  const band = r.map((x) => (f.isNum(x.hrv_baseline_low) && f.isNum(x.hrv_baseline_high) ? x.hrv_baseline_high - x.hrv_baseline_low : null));
  legend("sl-hrv-leg", [[C_HRV, "Nuit"], [T.text1, "Moyenne 7 j", "line"], ["rgba(180,184,196,0.35)", "Plage équilibrée"]]);
  chart("#sl-hrv", {
    animation: false,
    grid: { left: 40, right: 12, top: 10, bottom: 28 },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const x = r[ps[0].dataIndex];
        const [lvl, lbl] = HRV_LABEL[x.hrv_status] || [null, null];
        return ttTitle(f.dateDay(x.date)) + ttRow(C_HRV, `${f.num(x.hrv_overnight)} ms`, "cette nuit", true)
          + ttRow(T.text1, `${f.num(x.hrv_weekly)} ms`, "moyenne 7 j")
          + (f.isNum(x.hrv_baseline_low) ? ttRow("rgba(180,184,196,0.5)", `${f.num(x.hrv_baseline_low)}–${f.num(x.hrv_baseline_high)}`, "plage équilibrée", true) : "")
          + (lbl ? `<div class="tt-row"><span>statut : </span><span class="tt-val">${lbl}</span></div>` : "");
      },
    },
    xAxis: xDates(r),
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (v) => `${v}` }, name: "ms", nameTextStyle: { color: T.text3, align: "right" } },
    series: [
      { name: "base", type: "line", stack: "band", data: r.map((x) => x.hrv_baseline_low), lineStyle: { opacity: 0 }, symbol: "none", silent: true },
      { name: "Plage équilibrée", type: "line", stack: "band", data: band, lineStyle: { opacity: 0 }, symbol: "none", silent: true,
        areaStyle: { color: "rgba(180,184,196,0.13)" } },
      { name: "Nuit", type: "scatter", data: r.map((x) => x.hrv_overnight), symbolSize: r.length > 200 ? 4 : 7, itemStyle: { color: C_HRV, opacity: 0.75 } },
      { name: "Moyenne 7 j", type: "line", data: r.map((x) => x.hrv_weekly), color: T.text1, lineStyle: { width: 2 }, connectNulls: true },
    ],
  });
}

function drawRhr(rows) {
  const r = rows.filter((x) => f.isNum(x.resting_hr));
  if (!r.length) { document.getElementById("sl-rhr").innerHTML = empty("Pas de FC de repos sur la période"); return; }
  const roll = rolling(r.map((x) => x.resting_hr), 7);
  legend("sl-rhr-leg", [[C_RHR, "Quotidienne", "line"], [T.text1, "Moyenne 7 j", "line"]]);
  chart("#sl-rhr", {
    animation: false,
    grid: { left: 40, right: 12, top: 10, bottom: 28 },
    tooltip: { trigger: "axis", formatter: (ps) => ttTitle(f.dateDay(r[ps[0].dataIndex].date)) + ttRow(C_RHR, `${f.num(r[ps[0].dataIndex].resting_hr)} bpm`, "ce jour") + ttRow(T.text1, `${f.num(roll[ps[0].dataIndex], 1)} bpm`, "moyenne 7 j") },
    xAxis: xDates(r),
    yAxis: { type: "value", scale: true, name: "bpm", nameTextStyle: { color: T.text3, align: "right" } },
    series: [
      { name: "Quotidienne", type: "line", data: r.map((x) => x.resting_hr), color: C_RHR, lineStyle: { width: 1, opacity: 0.55 } },
      { name: "Moyenne 7 j", type: "line", data: roll, color: T.text1, lineStyle: { width: 2 } },
    ],
  });
}

function drawBodyBattery(rows) {
  const r = rows.filter((x) => f.isNum(x.body_battery_high) && f.isNum(x.body_battery_low));
  if (!r.length) { document.getElementById("sl-bb").innerHTML = empty("Pas de Body Battery sur la période"); return; }
  chart("#sl-bb", {
    animation: false,
    grid: { left: 40, right: 12, top: 10, bottom: 28 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => {
        const x = r[ps[0].dataIndex];
        return ttTitle(f.dateDay(x.date)) + ttRow(T.seq[6], `${f.num(x.body_battery_low)} → ${f.num(x.body_battery_high)}`, "min → max", true)
          + (f.isNum(x.body_battery_charged) ? `<div class="tt-row"><span class="tt-val">+${f.num(x.body_battery_charged)}</span><span>rechargé</span><span class="tt-val">−${f.num(x.body_battery_drained)}</span><span>dépensé</span></div>` : "");
      },
    },
    xAxis: xDates(r),
    yAxis: { type: "value", min: 0, max: 100, interval: 25 },
    series: [
      { type: "bar", stack: "bb", data: r.map((x) => x.body_battery_low), itemStyle: { color: "transparent" }, barMaxWidth: 12, silent: true },
      { type: "bar", stack: "bb", data: r.map((x) => x.body_battery_high - x.body_battery_low), barMaxWidth: 12,
        itemStyle: { color: T.seq[5], borderRadius: 3 } },
    ],
  });
}

function drawStress(rows) {
  const r = rows.filter((x) => f.isNum(x.stress_avg));
  if (!r.length) { document.getElementById("sl-stress").innerHTML = empty("Pas de stress sur la période"); return; }
  const roll = rolling(r.map((x) => x.stress_avg), 7);
  legend("sl-stress-leg", [[C_STRESS, "Quotidien", "line"], [T.text1, "Moyenne 7 j", "line"]]);
  chart("#sl-stress", {
    animation: false,
    grid: { left: 40, right: 12, top: 10, bottom: 28 },
    tooltip: { trigger: "axis", formatter: (ps) => ttTitle(f.dateDay(r[ps[0].dataIndex].date)) + ttRow(C_STRESS, f.num(r[ps[0].dataIndex].stress_avg), "stress moyen") + ttRow(T.text1, f.num(roll[ps[0].dataIndex], 1), "moyenne 7 j") },
    xAxis: xDates(r),
    yAxis: { type: "value", min: 0, max: (v) => Math.max(50, Math.ceil(v.max / 10) * 10), splitNumber: 4 },
    series: [
      { name: "Quotidien", type: "line", data: r.map((x) => x.stress_avg), color: C_STRESS, lineStyle: { width: 1, opacity: 0.55 } },
      { name: "Moyenne 7 j", type: "line", data: roll, color: T.text1, lineStyle: { width: 2 } },
    ],
  });
}

// ---------------------------------------------------------------- training ↔ recovery
function impactPanel(well, load, from) {
  const host = document.getElementById("sl-impact");
  const byDate = new Map(well.map((r) => [r.date, r]));
  const hrvSeries = well.map((r) => r.hrv_overnight);
  const idx = new Map(well.map((r, i) => [r.date, i]));
  const rows = [];
  for (const l of load) {
    if (l.date < from) continue;
    const next = f.isoDate(f.addDays(f.parseDate(l.date), 1));
    const w = byDate.get(next);
    if (!w) continue;
    const i = idx.get(l.date);
    // personal reference: mean of the 7 nights up to (and including) the night before the training day
    const ref = i != null ? mean(hrvSeries.slice(Math.max(0, i - 6), i + 1)) : null;
    const rhrRef = i != null ? mean(well.slice(Math.max(0, i - 6), i + 1).map((r) => r.resting_hr)) : null;
    rows.push({
      load: l.load || 0,
      hrvDev: f.isNum(w.hrv_overnight) && ref ? (w.hrv_overnight / ref - 1) * 100 : null,
      rhrDev: f.isNum(w.resting_hr) && rhrRef ? w.resting_hr - rhrRef : null,
      sleep: w.sleep_seconds ? w.sleep_seconds / 3600 : null,
      score: w.sleep_score,
    });
  }
  const pos = rows.filter((r) => r.load > 0).map((r) => r.load).sort((a, b) => a - b);
  if (rows.length < 20 || pos.length < 9) {
    host.innerHTML = card({ title: "Entraînement → nuit suivante", body: empty("Pas assez de jours sur la période", "Élargis la période pour comparer les nuits après des jours faciles et durs.") });
    return;
  }
  const q1 = pos[Math.floor(pos.length / 3)], q2 = pos[Math.floor((2 * pos.length) / 3)];
  const groups = [
    { name: "Repos", test: (r) => r.load === 0, color: T.text3 },
    { name: "Léger", test: (r) => r.load > 0 && r.load < q1, color: T.seq[2], hint: `< ${f.num(q1)}` },
    { name: "Modéré", test: (r) => r.load >= q1 && r.load < q2, color: T.seq[5], hint: `${f.num(q1)}–${f.num(q2)}` },
    { name: "Dur", test: (r) => r.load >= q2, color: T.seq[8], hint: `≥ ${f.num(q2)}` },
  ];
  const metrics = [
    ["hrvDev", "HRV la nuit suivante", "% vs moy. 7 j", 1, true],
    ["rhrDev", "FC de repos le lendemain", "bpm vs moy. 7 j", 1, true],
    ["sleep", "Durée de sommeil", "h", 2, false],
    ["score", "Score de sommeil", "", 0, false],
  ];
  host.innerHTML = card({
    title: "Entraînement → nuit suivante",
    sub: "Moyenne ± IC 95 % de la nuit qui suit, selon la charge du jour (terciles de tes jours d'entraînement). Descriptif : ces écarts n'établissent pas de causalité — teste-les dans le Labo.",
    actions: `<a class="btn" href="#/lab?x=load&y=hrv&lag=1">Ouvrir dans le Labo</a>`,
    body: `<div class="legend">${groups.map((g) => `<span><i style="background:${g.color}"></i>${g.name}${g.hint ? ` <span class="muted">${g.hint} hrTSS</span>` : ""} <span class="muted">· n=${rows.filter(g.test).length}</span></span>`).join("")}</div>
      <div class="sl-multiples">${metrics.map(([k, t, u]) => `<div><div class="sl-mtitle">${t} <span class="muted">${u}</span></div><div class="chart short" id="sl-m-${k}"></div></div>`).join("")}</div>`,
  });
  for (const [k, , unit, digits, zeroLine] of metrics) {
    const stats = groups.map((g) => {
      const v = rows.filter(g.test).map((r) => r[k]).filter(f.isNum);
      const m = mean(v), s = sd(v);
      return { m, ci: s && v.length > 1 ? 1.96 * s / Math.sqrt(v.length) : 0, n: v.length };
    });
    chart(`#sl-m-${k}`, {
      animation: false,
      grid: { left: 40, right: 8, top: 10, bottom: 24 },
      tooltip: {
        formatter: (p) => {
          const s = stats[p.dataIndex];
          return ttTitle(groups[p.dataIndex].name) + ttRow(groups[p.dataIndex].color, `${f.num(s.m, digits)} ${unit.split(" ")[0]}`, "moyenne", true)
            + `<div class="tt-row"><span>IC 95 % ±</span><span class="tt-val">${f.num(s.ci, digits)}</span><span>· n=${s.n}</span></div>`;
        },
      },
      xAxis: { type: "category", data: groups.map((g) => g.name) },
      yAxis: { type: "value", scale: !zeroLine, splitNumber: 3, axisLabel: { formatter: (v) => f.num(v, digits === 2 ? 1 : 0) } },
      series: [
        {
          type: "custom", silent: true,
          data: stats.map((s, i) => [i, s.m - s.ci, s.m + s.ci]),
          renderItem: (p, a) => {
            const lo = a.coord([a.value(0), a.value(1)]), hi = a.coord([a.value(0), a.value(2)]);
            return { type: "group", children: [
              { type: "line", shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: { stroke: T.text3, lineWidth: 1.5 } },
              { type: "line", shape: { x1: lo[0] - 5, y1: lo[1], x2: lo[0] + 5, y2: lo[1] }, style: { stroke: T.text3, lineWidth: 1.5 } },
              { type: "line", shape: { x1: hi[0] - 5, y1: hi[1], x2: hi[0] + 5, y2: hi[1] }, style: { stroke: T.text3, lineWidth: 1.5 } },
            ] };
          },
        },
        {
          type: "scatter", symbolSize: 11, data: stats.map((s, i) => ({ value: s.m, itemStyle: { color: groups[i].color, borderColor: T.surface, borderWidth: 2 } })),
          markLine: zeroLine ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.axis, type: "solid", width: 1 }, data: [{ yAxis: 0 }] } : undefined,
        },
      ],
    });
  }
}
