// Charge & objectifs: PMC, injury-risk ratios, run volume, goals vs predictions,
// fitness curve, training paces, critical speed, records and aerobic efficiency.
import { api } from "../api.js";
import { T, SPORTS, SPORT_ORDER, sport, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, status, empty, seg, onSeg, formState, acwrState } from "../ui.js";
import * as f from "../fmt.js";

const RANGES = [["3m", "3 mois"], ["6m", "6 mois"], ["1y", "1 an"], ["all", "Tout"]];
const RANGE_DAYS = { "3m": 92, "6m": 183, "1y": 366, all: null };
const EFFORT_DIST = { "1k": 1000, "5k": 5000, "10k": 10000, "Half-Marathon": 21097.5 };
const EFFORT_LABEL = { "1k": "1 km", "5k": "5 km", "10k": "10 km", "Half-Marathon": "Semi-marathon" };

// ---------------------------------------------------------------- Daniels (port of backend)
const vo2 = (v) => -4.6 + 0.182258 * v + 0.000104 * v * v;
const pctMax = (t) => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
const vdotOf = (d, s) => vo2(d / (s / 60)) / pctMax(s / 60);

// ---------------------------------------------------------------- small helpers
const mmss = (s) => f.duration(s);
const fmtPct = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${f.num(Math.abs(v), 1)} %`;
function cutoffIso(range, lastIso) {
  const days = RANGE_DAYS[range];
  if (!days) return null;
  return f.isoDate(f.addDays(f.parseDate(lastIso), -days));
}
function rollingMedian(vals, k) {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - k + 1), i + 1).filter(f.isNum).sort((a, b) => a - b);
    if (w.length < Math.min(5, k)) return null;
    const m = Math.floor(w.length / 2);
    return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
  });
}
const axisDate = { formatter: (v) => f.dateShort(v), hideOverlap: true };
function robustBounds(vals) {
  const s = vals.filter(f.isNum).sort((a, b) => a - b);
  if (s.length < 10) return {};
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.ceil(s.length * 0.99) - 1];
  const pad = (hi - lo) * 0.15 || 0.05;
  return { min: Math.floor((lo - pad) * 20) / 20, max: Math.ceil((hi + pad) * 20) / 20 };
}
const sectionHead = (title, sub = "") => `<div class="ld-section"><h3>${title}</h3>${sub ? `<span>${sub}</span>` : ""}</div>`;

// ---------------------------------------------------------------- page
export async function render(view, { query = {}, setActions }) {
  const [rows, perf, goals, pred] = await Promise.all([
    api.get("/api/load", { ttl: 30000 }),
    api.get("/api/performance", { ttl: 30000 }),
    api.get("/api/goals"),
    api.get("/api/profile/predictions", { ttl: 30000 }).catch(() => null),
  ]);
  if (!rows.length) {
    view.innerHTML = card({ body: empty("Pas encore de charge à afficher", "Les séances Garmin alimentent le modèle de charge dès la première synchro.", `<a class="btn primary" href="#/settings">Connecter Garmin</a>`) });
    return;
  }
  const last = rows[rows.length - 1];
  const races = collectRaces(perf.progression || {});
  let range = "1y";
  try { range = localStorage.getItem("load.range") || "1y"; } catch { /* storage blocked */ }
  if (RANGE_DAYS[query.range] !== undefined) range = query.range;

  setActions(`<a class="btn" href="#/settings">Modifier les objectifs</a>`);
  // Efficiency: easy runs (< Z3) when there are enough of them, otherwise every run
  const from0 = cutoffIso(range, last.date);
  let efMode = (perf.ef || []).filter((r) => r.easy && (!from0 || r.date >= from0)).length >= 10 ? "easy" : "all";
  const [flvl, flabel] = formState(last.tsb);
  const [alvl, alabel] = acwrState(last.acwr);

  view.innerHTML = `<div class="ld-page">
    <div class="filters">${seg("range", RANGES, range)}<span class="muted ld-note">Période appliquée aux graphiques datés · prédictions sur les 90 derniers jours</span></div>

    ${sectionHead("Forme & charge", "Modèle impulsion-réponse de Banister : fitness (CTL, 42 j), fatigue (ATL, 7 j), fraîcheur (TSB)")}
    <div class="grid">
      <div class="span-12">${card({
        body: `<div class="stat-grid ld-kpis">
          ${stat("Fitness (CTL)", f.num(last.ctl), "", `${f.signed(last.ramp, 1)} sur 7 j`)}
          ${stat("Fatigue (ATL)", f.num(last.atl))}
          ${stat("Fraîcheur (TSB)", f.signed(Math.round(last.tsb ?? 0) || 0), "", status(flvl, flabel.split(" — ")[0]))}
          ${stat("Fitness course", f.num(last.run_ctl), "", "CTL course à pied seule")}
          ${stat("Ratio aigu/chronique", f.num(last.acwr, 2), "", status(alvl, alabel))}
          ${stat("Monotonie (7 j)", f.num(last.monotony, 2), "", last.monotony > 2 ? status("serious", "Élevée") : status("good", "Variée"))}
        </div>
        <div class="chart" id="ld-pmc" style="height:520px"></div>`,
      })}</div>
    </div>

    <div class="grid">
      <div class="span-6">${card({ title: "Risque de blessure", sub: "Ratio charge aiguë (7 j) / chronique (28 j) et monotonie de Foster", body: `<div class="chart" id="ld-acwr" style="height:300px"></div>` })}</div>
      <div class="span-6">${card({ title: "Volume de course hebdomadaire", sub: "Km par semaine · plafond = +10 % vs semaine précédente", body: `<div class="chart" id="ld-vol" style="height:300px"></div>` })}</div>
    </div>

    ${sectionHead("Objectifs", "Écart entre chaque prédiction et ton objectif — à gauche du zéro, tu es dans les temps")}
    <div class="grid">
      <div class="span-12">${goalsCard(goals, pred)}</div>
    </div>

    ${sectionHead("Fitness & allures", `VDOT de Daniels sur les meilleurs efforts glissants · ${perf.predictions?.vdot_source ? `référence actuelle : ${f.esc(perf.predictions.vdot_source)}` : ""}`)}
    <div class="grid">
      <div class="span-7">${card({ title: "Courbe de forme", sub: "VDOT (meilleur effort ≥ 1 mile sur 60 j glissants) et VO2max estimée par la montre", body: `<div class="chart" id="ld-fit" style="height:300px"></div>` })}</div>
      <div class="span-5">${pacesCard(perf.predictions)}</div>
    </div>
    <div class="grid">
      <div class="span-4">${csCard(perf.predictions?.cs)}</div>
      <div class="span-8">${card({ title: "Efficacité aérobie", sub: "Vitesse ajustée à la pente par battement cardiaque (m/min/bpm) — plus haut = plus économe", actions: seg("ef", [["easy", "Footings (< Z3)"], ["all", "Toutes les sorties"]], efMode), body: `<div class="chart" id="ld-ef" style="height:280px"></div>` })}</div>
    </div>

    ${sectionHead("Records & progression", "Chaque point est le meilleur passage sur la distance dans une séance · escalier = record personnel")}
    <div class="grid">
      ${Object.keys(EFFORT_DIST).map((k) => `<div class="span-3">${card({ title: EFFORT_LABEL[k], sub: prSub(perf.progression?.[k]), body: `<div class="chart short" id="ld-pr-${k.replace(/[^a-z0-9]/gi, "")}"></div>` })}</div>`).join("")}
    </div>
    <div class="grid">
      <div class="span-8">${recordsCard(perf.records || [])}</div>
      <div class="span-4">${card({ title: "Dérive cardiaque", sub: "Découplage allure/FC des sorties ≥ 50 min — sous 5 % = endurance solide", body: `<div class="chart" id="ld-dec" style="height:300px"></div>` })}</div>
    </div></div>`;

  // ---- charts (built once, re-optioned on range change)
  const charts = {
    pmc: chart("#ld-pmc", {}),
    acwr: chart("#ld-acwr", {}),
    vol: chart("#ld-vol", {}),
    fit: chart("#ld-fit", {}),
    ef: chart("#ld-ef", {}),
    dec: chart("#ld-dec", {}),
  };
  const prCharts = Object.fromEntries(Object.keys(EFFORT_DIST).map((k) => [k, chart(`#ld-pr-${k.replace(/[^a-z0-9]/gi, "")}`, {})]));
  drawGoals(pred);
  drawCs(perf.predictions?.cs);
  drawPaces(perf.predictions?.paces);

  const goTo = (p) => { const id = p?.data?.id ?? p?.data?.[3]; if (id) location.hash = `#/activity/${id}`; };
  [charts.ef, charts.dec, charts.fit, charts.pmc, ...Object.values(prCharts)].forEach((c) => c?.on("click", goTo));

  const redraw = () => {
    const from = cutoffIso(range, last.date);
    const slice = from ? rows.filter((r) => r.date >= from) : rows;
    const inRange = (d) => !from || d >= from;
    charts.pmc.setOption(pmcOption(slice, races.filter((r) => inRange(r.date))), true);
    charts.acwr.setOption(acwrOption(slice), true);
    charts.vol.setOption(volumeOption(rows, from, last.date), true);
    charts.fit.setOption(fitnessOption(perf, races, inRange), true);
    charts.ef.setOption(efOption((perf.ef || []).filter((r) => (efMode === "all" || r.easy) && inRange(r.date)), efMode), true);
    charts.dec.setOption(decouplingOption((perf.ef || []).filter((r) => f.isNum(r.decoupling) && inRange(r.date))), true);
    for (const [k, c] of Object.entries(prCharts)) c.setOption(progressionOption(perf.progression?.[k] || [], inRange), true);
  };
  redraw();
  onSeg(view, "range", (v) => {
    range = v;
    try { localStorage.setItem("load.range", v); } catch { /* ignore */ }
    redraw();
  });
  onSeg(view, "ef", (v) => { efMode = v; redraw(); });
}

// ---------------------------------------------------------------- data shaping
function collectRaces(progression) {
  const byId = new Map();
  for (const [name, pts] of Object.entries(progression)) {
    for (const p of pts) {
      if (!p.race) continue;
      const v = vdotOf(EFFORT_DIST[name], p.time);
      const cur = byId.get(p.activity_id);
      if (!cur || v > cur.vdot) byId.set(p.activity_id, { id: p.activity_id, date: p.date, name: p.activity_name, vdot: v });
    }
  }
  return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function prSub(pts) {
  if (!pts?.length) return "Pas encore d'effort";
  const best = pts[pts.length - 1].pr;
  const p = pts.find((x) => x.time === best);
  return `Record ${mmss(best)}${p ? ` · ${f.dateShort(p.date)} ${p.date.slice(0, 4)}` : ""}`;
}

// ---------------------------------------------------------------- PMC
function pmcOption(rows, races) {
  const dates = rows.map((r) => r.date);
  const sports = SPORT_ORDER.filter((s) => rows.some((r) => r[`load_${s}`] > 0));
  const raceSet = new Map(races.map((r) => [r.date, r]));
  const ctlByDate = new Map(rows.map((r) => [r.date, r.ctl]));
  const tsbVals = rows.map((r) => r.tsb);
  const zones = [
    [15, 60, T.warning, "transition"], [5, 15, T.good, "frais"], [-10, 5, T.good, "équilibré"],
    [-30, -10, T.serious, "productif"], [-90, -30, T.critical, "surcharge"],
  ];
  // step adapts to the span so a one-off spike (e.g. a 70.3) doesn't stack a dozen labels
  const tsbLo = Math.min(-40, Math.min(...tsbVals)), tsbHi = Math.max(40, Math.max(...tsbVals));
  const tsbStep = [20, 25, 50, 100, 200].find((st) => (tsbHi - tsbLo) / st <= 4) || 200;
  const tsbMin = Math.floor(tsbLo / tsbStep) * tsbStep;
  const tsbMax = Math.ceil(tsbHi / tsbStep) * tsbStep;
  return {
    animation: false,
    legend: {
      type: "scroll", top: 0, left: 0, right: 0, itemWidth: 12, itemHeight: 8, pageIconColor: T.text2, pageTextStyle: { color: T.text3 },
      data: [{ name: "Fitness (CTL)", icon: "rect", itemStyle: { color: T.fitness } }, { name: "Fatigue (ATL)", icon: "rect", itemStyle: { color: T.fatigue } },
        ...sports.map((s) => ({ name: SPORTS[s].label, icon: "roundRect" })), ...(races.length ? [{ name: "Course officielle", icon: "pin" }] : [])],
    },
    grid: [{ left: 44, right: 78, top: 34, height: "42%" }, { left: 44, right: 78, top: "54%", height: "12%" }, { left: 44, right: 78, top: "71%", bottom: 24 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        if (!r) return "";
        const race = raceSet.get(r.date);
        let h = ttTitle(f.dateDay(r.date)) + ttRow(T.fitness, f.num(r.ctl), "fitness") + ttRow(T.fatigue, f.num(r.atl), "fatigue")
          + ttRow(T.text2, f.signed(r.tsb), "fraîcheur") + ttRow(T.text3, f.num(r.load), "charge du jour", true);
        for (const s of sports) if (r[`load_${s}`] > 0.5) h += ttRow(SPORTS[s].color, f.num(r[`load_${s}`]), SPORTS[s].label.toLowerCase(), true);
        if (race) h += `<div class="tt-row" style="margin-top:4px"><b>${f.esc(race.name)}</b></div>`;
        return h;
      },
    },
    title: [
      { text: "Charge quotidienne", left: 44, top: "50.5%", textStyle: { fontSize: 11, color: T.text3, fontWeight: 500 } },
      { text: "Fraîcheur (TSB)", left: 44, top: "67.5%", textStyle: { fontSize: 11, color: T.text3, fontWeight: 500 } },
    ],
    xAxis: [0, 1, 2].map((i) => ({
      type: "category", data: dates, gridIndex: i, boundaryGap: i === 1,
      axisLabel: i === 2 ? axisDate : { show: false }, axisLine: { show: i === 2, lineStyle: { color: T.axis } },
    })),
    yAxis: [
      { type: "value", gridIndex: 0, splitNumber: 4 },
      { type: "value", gridIndex: 1, splitNumber: 2 },
      { type: "value", gridIndex: 2, min: tsbMin, max: tsbMax, interval: tsbStep },
    ],
    series: [
      {
        name: "Fitness (CTL)", type: "line", data: rows.map((r) => r.ctl), color: T.fitness, areaStyle: { color: T.fitness, opacity: 0.1 }, z: 3,
        markLine: races.length ? {
          silent: true, symbol: "none", label: { show: false },
          lineStyle: { color: T.axis, width: 1, type: "solid" }, data: races.map((r) => ({ xAxis: r.date })),
        } : undefined,
      },
      { name: "Fatigue (ATL)", type: "line", data: rows.map((r) => r.atl), color: T.fatigue, z: 4 },
      ...(races.length ? [{
        name: "Course officielle", type: "scatter", symbol: "pin", symbolSize: 18, color: T.text1, z: 6,
        data: races.filter((r) => ctlByDate.has(r.date)).map((r) => ({ value: [r.date, ctlByDate.get(r.date)], name: r.name, id: r.id })),
        itemStyle: { borderColor: T.surface, borderWidth: 1.5 },
        tooltip: { trigger: "item", formatter: (p) => ttTitle(f.dateDay(p.value[0])) + `<b>${f.esc(p.name)}</b>` },
      }] : []),
      ...sports.map((s) => ({
        name: SPORTS[s].label, type: "bar", stack: "load", xAxisIndex: 1, yAxisIndex: 1, color: SPORTS[s].color,
        barCategoryGap: "15%", barMaxWidth: 8, itemStyle: { borderRadius: 0 },
        data: rows.map((r) => (r[`load_${s}`] > 0 ? Math.round(r[`load_${s}`]) : null)),
      })),
      {
        name: "Fraîcheur (TSB)", type: "line", xAxisIndex: 2, yAxisIndex: 2, data: tsbVals, color: T.text1, lineStyle: { width: 1.6 },
        markArea: {
          silent: true,
          data: zones.map(([a, b, c, label]) => [
            { yAxis: Math.max(a, tsbMin), itemStyle: { color: c, opacity: label === "équilibré" ? 0.07 : 0.13 },
              label: { show: true, position: "right", distance: 6, formatter: label, color: T.text3, fontSize: 10 } },
            { yAxis: Math.min(b, tsbMax) },
          ]),
        },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.axis, width: 1, type: "solid" }, data: [{ yAxis: 0 }] },
      },
    ],
  };
}

// ---------------------------------------------------------------- ACWR & monotony
function acwrOption(rows) {
  const dates = rows.map((r) => r.date);
  const band = (a, b, c, label, op = 0.12) => [{ yAxis: a, itemStyle: { color: c, opacity: op }, label: { show: true, position: "right", distance: 6, formatter: label, color: T.text3, fontSize: 10 } }, { yAxis: b }];
  return {
    animation: false,
    title: [
      { text: "Ratio aigu / chronique", left: 40, top: 0, textStyle: { fontSize: 11, color: T.text3, fontWeight: 500 } },
      { text: "Monotonie (moyenne / écart-type, 7 j)", left: 40, top: "64%", textStyle: { fontSize: 11, color: T.text3, fontWeight: 500 } },
    ],
    grid: [{ left: 40, right: 74, top: 22, height: "50%" }, { left: 40, right: 74, top: "73%", bottom: 24 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        const [lvl, lab] = acwrState(r.acwr);
        return ttTitle(f.dateDay(r.date)) + ttRow(T.text1, f.num(r.acwr, 2), `ratio · ${lab.toLowerCase()}`) + ttRow(T.text2, f.num(r.monotony, 2), "monotonie")
          + ttRow(T.text3, f.num(r.strain), "contrainte (strain)", true) + (lvl === "critical" ? `<div class="tt-row">⚠ pic de charge</div>` : "");
      },
    },
    xAxis: [
      { type: "category", data: dates, gridIndex: 0, axisLabel: { show: false }, axisLine: { show: false } },
      { type: "category", data: dates, gridIndex: 1, axisLabel: axisDate },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, min: 0.5, max: (v) => Math.max(2, Math.ceil(v.max * 2) / 2), interval: 0.5 },
      { type: "value", gridIndex: 1, min: 0, max: (v) => Math.max(3, Math.ceil(v.max)), interval: 1 },
    ],
    series: [
      {
        name: "Ratio", type: "line", data: rows.map((r) => r.acwr), color: T.text1, lineStyle: { width: 1.6 },
        markArea: { silent: true, data: [band(0, 0.8, T.warning, "sous-charge", 0.07), band(0.8, 1.3, T.good, "optimal", 0.14), band(1.3, 1.5, T.serious, "hausse"), band(1.5, 3, T.critical, "pic")] },
      },
      {
        name: "Monotonie", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: rows.map((r) => r.monotony), color: T.text2, lineStyle: { width: 1.4 },
        markLine: { silent: true, symbol: "none", lineStyle: { color: T.serious, width: 1, type: "solid" }, label: { formatter: "seuil 2", color: T.text3, fontSize: 10, position: "end" }, data: [{ yAxis: 2 }] },
      },
    ],
  };
}

// ---------------------------------------------------------------- weekly run volume
function volumeOption(rows, from, lastIso) {
  const weeks = new Map();
  for (const r of rows) {
    const wk = f.isoDate(f.mondayOf(f.parseDate(r.date)));
    weeks.set(wk, (weeks.get(wk) || 0) + (r.run_km || 0));
  }
  let list = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const startWk = from ? f.isoDate(f.mondayOf(f.parseDate(from))) : null;
  const idx0 = startWk ? list.findIndex(([w]) => w >= startWk) : 0;
  const prevKm = idx0 > 0 ? list[idx0 - 1][1] : null;
  list = list.slice(Math.max(0, idx0));
  const curWk = f.isoDate(f.mondayOf(f.parseDate(lastIso)));
  const ceil = list.map((_, i) => {
    const p = i === 0 ? prevKm : list[i - 1][1];
    return p && p > 5 ? p * 1.1 : null;
  });
  const over = list.map(([w, km], i) => (ceil[i] && km > ceil[i] && w !== curWk ? (km / (ceil[i] / 1.1) - 1) * 100 : null));
  return {
    animation: false,
    legend: {
      type: "scroll", top: 0, left: 0, right: 0, itemWidth: 12, itemHeight: 8, pageIconColor: T.text2, pageTextStyle: { color: T.text3 },
      data: [{ name: "Km course", icon: "roundRect" }, { name: "Plafond", icon: "rect", itemStyle: { color: T.text2 } }, { name: "> +10 %", icon: "triangle" }],
    },
    grid: { left: 40, right: 14, top: 40, bottom: 28 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,0.04)" } },
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const [w, km] = list[i];
        let h = ttTitle(`Semaine du ${f.dateShort(w)}${w === curWk ? " · en cours" : ""}`) + ttRow(SPORTS.run.color, `${f.num(km, 1)} km`, "course", true);
        if (ceil[i]) h += ttRow(T.text2, `${f.num(ceil[i], 1)} km`, "plafond +10 %");
        if (over[i] != null) h += `<div class="tt-row">⚠ <b>${fmtPct(over[i])}</b>&nbsp;vs semaine précédente</div>`;
        return h;
      },
    },
    xAxis: { type: "category", data: list.map(([w]) => w), axisLabel: { formatter: (v) => (v === curWk ? "en cours" : f.dateShort(v)), hideOverlap: true } },
    yAxis: { type: "value", splitNumber: 4, axisLabel: { formatter: "{value} km" } },
    series: [
      {
        name: "Km course", type: "bar", color: SPORTS.run.color, barMaxWidth: 22,
        data: list.map(([w, km], i) => ({
          value: Math.round(km * 10) / 10,
          itemStyle: w === curWk ? { opacity: 0.45 } : undefined,
        })),
      },
      {
        name: "> +10 %", type: "scatter", symbol: "triangle", symbolSize: 8, color: T.serious, z: 6, symbolOffset: [0, -9],
        data: list.map(([, km], i) => (over[i] != null ? [i, km] : null)).filter(Boolean),
        tooltip: { show: false },
      },
      {
        name: "Plafond", type: "custom", color: T.text2, z: 5,
        renderItem: (params, a) => {
          if (a.value(1) == null || Number.isNaN(a.value(1))) return null;
          const p = a.coord([a.value(0), a.value(1)]);
          const w = Math.min(22, a.size([1, 0])[0] * 0.7) + 6;
          return { type: "rect", shape: { x: p[0] - w / 2, y: p[1] - 1, width: w, height: 2 }, style: { fill: T.text2 } };
        },
        data: ceil.map((v, i) => [i, v]),
      },
    ],
  };
}

// ---------------------------------------------------------------- goals
// Ensemble of 5 estimators backtested on the athlete's races (backend: analytics/predict.py).
// Colours follow the categorical slot order; shapes double the identity (legend + tooltip too).
const MODELS = [
  { key: "workout", label: "Séances clés", color: () => SPORTS.run.color, symbol: "circle" },
  { key: "vdot", label: "VDOT (Daniels)", color: () => SPORTS.bike.color, symbol: "diamond" },
  { key: "riegel", label: "Riegel perso", color: () => SPORTS.swim.color, symbol: "triangle" },
  { key: "cs", label: "Vitesse critique", color: () => SPORTS.strength.color, symbol: "rect" },
  { key: "engine", label: "Moteur cardiaque", color: () => SPORTS.racket.color, symbol: "roundRect" },
];

function predGoals(pred) {
  return (pred?.goals || []).filter((g) => g.distance && g.target_time && g.ensemble);
}

function goalsCard(goals, pred) {
  const todayIso = f.isoDate(f.today());
  const up = goals.filter((g) => g.date >= todayIso);
  if (!up.length) return card({ title: "Objectifs", body: empty("Aucun objectif à venir", "", `<a class="btn" href="#/settings">Ajouter un objectif</a>`) });
  const byId = Object.fromEntries((pred?.goals || []).map((g) => [g.id, g]));
  const rowsHtml = up.map((g) => {
    const days = Math.round((f.parseDate(g.date) - f.today()) / 86400000);
    const p = byId[g.id];
    const e = p?.ensemble;
    const gap = f.isNum(e) && g.target_time ? e - g.target_time : null;
    const lvl = gap == null ? null : gap <= 0 ? "good" : gap / g.target_time < 0.03 ? "warning" : "serious";
    const lab = gap == null ? "" : gap <= 0 ? `dans les temps (${mmss(-gap)} de marge)` : `${mmss(gap)} à gagner`;
    const main = p?.weights ? Object.entries(p.weights).sort((x, y) => y[1] - x[1])[0] : null;
    const mainLbl = main && main[1] > 0 ? `${MODELS.find((m) => m.key === main[0])?.label || main[0]} · ${f.num(main[1] * 100)} %` : "";
    return `<tr>
      <td><span class="chip">${f.relDays(days)}</span></td>
      <td class="name"><b>${f.esc(g.name)}</b><div class="muted">${f.dateLong(g.date)}${g.notes ? ` · ${f.esc(g.notes)}` : ""}</div></td>
      <td class="r">${g.priority ? `<span class="chip">${f.esc(g.priority)}</span>` : ""}</td>
      <td class="r num">${g.target_time ? f.duration(g.target_time) : "–"}</td>
      <td class="r num"><b>${f.isNum(e) ? f.duration(e) : "–"}</b></td>
      <td class="r num muted">${p?.range ? `${f.duration(p.range[0])} – ${f.duration(p.range[1])}` : "–"}</td>
      <td class="muted">${mainLbl}</td>
      <td>${lvl ? status(lvl, lab) : `<span class="muted">${g.sport === "run" && g.distance ? "pas assez de données" : "hors modèle (trail / multisport)"}</span>`}</td>
    </tr>`;
  }).join("");
  const n = predGoals(pred).length;
  return card({
    title: "Objectifs à venir",
    sub: "Prédiction = ensemble de 5 modèles, pondérés par leur précision mesurée sur tes courses passées (de distance proche)",
    actions: `<a class="btn" href="#/profile">Méthode & backtest</a>`,
    body: `
      ${n ? `<div class="legend ld-legend">${MODELS.map((m) => `<span><i class="sym sym-${m.symbol}" style="background:${m.color()}"></i>${m.label}</span>`).join("")}
        <span><i class="ld-ens"></i>Ensemble</span><span><i class="ld-band"></i>Fourchette</span><span><i class="line" style="background:${T.text1}"></i>Objectif</span></div>
      <div class="chart" id="ld-goals" style="height:${70 + n * 58}px"></div>` : ""}
      <div class="table-wrap ld-goal-table"><table class="data">
        <thead><tr><th></th><th>Objectif</th><th class="r">Prio.</th><th class="r">Cible</th><th class="r">Prédiction</th><th class="r">Fourchette</th><th>Modèle principal</th><th>Verdict</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>`,
  });
}

function drawGoals(pred) {
  const gs = predGoals(pred);
  if (!gs.length || !document.getElementById("ld-goals")) return;
  const pct = (v, g) => (v / g.target_time - 1) * 100;
  const cats = gs.map((g) => `${g.name}  ·  J-${g.days_to}`);
  const all = gs.flatMap((g) => [...Object.values(g.preds || {}).filter(f.isNum).map((v) => pct(v, g)), ...(g.range || []).map((v) => pct(v, g))]);
  const ext = Math.max(4, Math.ceil(Math.max(...all.map(Math.abs)) + 1));
  chart("#ld-goals", {
    animation: false,
    grid: { left: 250, right: 30, top: 10, bottom: 34 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const g = gs[p.data.gi];
        let h = ttTitle(`${f.esc(g.name)} · objectif ${f.duration(g.target_time)}`);
        h += ttRow(T.text1, f.duration(g.ensemble), `ensemble (${fmtPct(pct(g.ensemble, g))})`);
        if (g.range) h += ttRow(T.text3, `${f.duration(g.range[0])} – ${f.duration(g.range[1])}`, "fourchette");
        for (const m of MODELS) {
          const v = g.preds?.[m.key];
          if (f.isNum(v)) h += ttRow(m.color(), f.duration(v), `${m.label} · poids ${f.num((g.weights?.[m.key] || 0) * 100)} %`);
        }
        return h;
      },
    },
    xAxis: {
      type: "value", min: -ext, max: ext, splitNumber: 6,
      axisLabel: { formatter: (v) => (v === 0 ? "objectif" : `${v > 0 ? "+" : "−"}${Math.abs(v)} %`) },
      name: "← plus rapide que l'objectif        plus lent →", nameLocation: "middle", nameGap: 22, nameTextStyle: { color: T.text3, fontSize: 11 },
    },
    yAxis: { type: "category", data: cats, inverse: true, axisLabel: { color: T.text1, fontSize: 12, width: 230, overflow: "truncate" }, splitLine: { show: true, lineStyle: { color: T.grid } } },
    series: [
      {  // ensemble range band
        type: "custom", z: 1, data: gs.map((g, i) => ({ value: [0, i], gi: i })),
        renderItem: (params, a) => {
          const g = gs[params.dataIndex];
          if (!g.range) return null;
          const p1 = a.coord([pct(g.range[0], g), params.dataIndex]), p2 = a.coord([pct(g.range[1], g), params.dataIndex]);
          return { type: "rect", shape: { x: p1[0], y: p1[1] - 9, width: p2[0] - p1[0], height: 18, r: 9 }, style: { fill: "rgba(200,245,96,0.14)", stroke: "rgba(200,245,96,0.35)", lineWidth: 1 } };
        },
      },
      ...MODELS.map((m, k) => ({
        name: m.label, type: "scatter", symbol: m.symbol, symbolSize: 10, color: m.color(), z: 3,
        symbolOffset: [0, (k - 2) * 5],
        itemStyle: { borderColor: T.surface, borderWidth: 2 },
        data: gs.map((g, i) => (f.isNum(g.preds?.[m.key]) ? { value: [pct(g.preds[m.key], g), i], gi: i } : null)).filter(Boolean),
      })),
      {
        name: "Ensemble", type: "scatter", symbol: "circle", symbolSize: 18, z: 6, color: T.accent,
        itemStyle: { color: T.accent, borderColor: T.surface, borderWidth: 3 },
        label: { show: true, position: "top", distance: 8, formatter: (p) => f.duration(gs[p.data.gi].ensemble), color: T.text1, fontSize: 12, fontWeight: 600 },
        data: gs.map((g, i) => ({ value: [pct(g.ensemble, g), i], gi: i })),
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.text1, width: 2, type: "solid" }, data: [{ xAxis: 0 }] },
      },
    ],
  });
}

// ---------------------------------------------------------------- fitness curve
function fitnessOption(perf, races, inRange) {
  const trend = (perf.vdot_trend || []).filter((r) => inRange(r.date));
  const vo2 = (perf.garmin_vo2max || []).filter((r) => inRange(r.date));
  const rs = races.filter((r) => inRange(r.date));
  const all = [...trend.map((r) => r.vdot), ...vo2.map((r) => r.vo2max), ...rs.map((r) => r.vdot)].filter(f.isNum);
  return {
    animation: false,
    legend: {
      type: "scroll", top: 0, left: 0, right: 0, itemWidth: 12, itemHeight: 8, pageIconColor: T.text2, pageTextStyle: { color: T.text3 },
      data: [{ name: "VDOT glissant", icon: "rect", itemStyle: { color: T.fitness } }, { name: "VO2max Garmin", icon: "circle" }, ...(rs.length ? [{ name: "Course officielle", icon: "pin" }] : [])],
    },
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        if (p.seriesName === "Course officielle") return ttTitle(f.dateDay(p.value[0])) + `<b>${f.esc(p.data.name)}</b>` + ttRow(T.text1, f.num(p.value[1], 1), "VDOT de la course");
        return ttTitle(f.dateDay(p.value[0])) + ttRow(p.color, f.num(p.value[1], 1), p.seriesName);
      },
    },
    xAxis: { type: "time", axisLabel: { formatter: (v) => { const d = new Date(v); return `${f.monthShort(d)} ${String(d.getFullYear()).slice(2)}`; }, hideOverlap: true } },
    yAxis: { type: "value", min: Math.floor(Math.min(...all, 45) - 1), max: Math.ceil(Math.max(...all, 50) + 1), splitNumber: 4 },
    series: [
      { name: "VO2max Garmin", type: "scatter", symbolSize: 5, color: T.text3, itemStyle: { opacity: 0.4 }, data: vo2.map((r) => [r.date, r.vo2max]) },
      { name: "VDOT glissant", type: "line", step: "end", data: trend.map((r) => [r.date, r.vdot]), color: T.fitness, z: 3, tooltip: { trigger: "item" } },
      ...(rs.length ? [{
        name: "Course officielle", type: "scatter", symbol: "pin", symbolSize: 20, color: T.text1, z: 5, itemStyle: { borderColor: T.surface, borderWidth: 1.5 },
        data: rs.map((r) => ({ value: [r.date, r.vdot], name: r.name, id: r.id })),
      }] : []),
    ],
  };
}

// ---------------------------------------------------------------- training paces
function pacesCard(pred) {
  if (!pred?.paces) return card({ title: "Allures d'entraînement", body: empty("Pas encore de VDOT", "Il faut au moins un effort ≥ 1 mile sur 90 jours.") });
  return card({
    title: "Allures d'entraînement",
    sub: `Zones de Daniels pour un VDOT de ${f.num(pred.vdot, 1)}`,
    body: `<div class="chart" id="ld-paces" style="height:250px"></div>`,
  });
}

function drawPaces(paces) {
  if (!paces || !document.getElementById("ld-paces")) return;
  const ramp = [T.zones[0], T.zones[1], T.zones[2], T.zones[3], T.zones[4]];
  const vals = paces.flatMap((p) => [p.slow, p.fast]);
  const lo = Math.floor((Math.min(...vals) - 8) / 30) * 30, hi = Math.ceil((Math.max(...vals) + 8) / 30) * 30;
  chart("#ld-paces", {
    animation: false,
    grid: { left: 120, right: 96, top: 8, bottom: 26 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const z = paces[p.dataIndex];
        return ttTitle(`${z.code} · ${f.esc(z.label)}`) + ttRow(ramp[p.dataIndex], z.slow === z.fast ? `${f.paceSec(z.fast)} /km` : `${f.paceSec(z.fast)} – ${f.paceSec(z.slow)} /km`, "allure", true);
      },
    },
    xAxis: { type: "value", min: lo, max: hi, inverse: true, interval: 30, axisLabel: { formatter: (v) => f.paceSec(v) } },
    yAxis: { type: "category", data: paces.map((p) => `${p.code}  ${p.label}`), inverse: true, axisLabel: { color: T.text1, fontSize: 12 } },
    series: [{
      type: "custom",
      renderItem: (params, a) => {
        const i = params.dataIndex;
        const z = paces[i];
        const p1 = a.coord([z.slow, i]), p2 = a.coord([z.fast, i]);
        const h = Math.min(18, a.size([0, 1])[1] * 0.5);
        let x = Math.min(p1[0], p2[0]), w = Math.abs(p2[0] - p1[0]);
        if (w < 8) { x -= (8 - w) / 2; w = 8; }
        return {
          type: "group",
          children: [
            { type: "rect", shape: { x, y: p1[1] - h / 2, width: w, height: h, r: 4 }, style: { fill: ramp[i] } },
            { type: "text", style: { x: x + w + 8, y: p1[1], text: z.slow === z.fast ? f.paceSec(z.fast) : `${f.paceSec(z.fast)}–${f.paceSec(z.slow)}`, fill: T.text2, font: "12px Segoe UI", verticalAlign: "middle" } },
          ],
        };
      },
      data: paces.map((_, i) => [i]),
    }],
  });
}

// ---------------------------------------------------------------- critical speed
function csCard(cs) {
  if (!cs) return card({ title: "Vitesse critique", body: empty("Modèle indisponible", "Il faut au moins 3 meilleurs efforts entre 2 et 25 min sur 90 jours.") });
  return card({
    title: "Vitesse critique",
    sub: "Modèle distance = VC × temps + D′ sur tes meilleurs efforts 2–25 min (90 j)",
    body: `<div class="stat-grid three">
        ${stat("Allure critique", f.paceSec(1000 / cs.cs), "/km", `${f.num(cs.cs * 3.6, 1)} km/h`)}
        ${stat("Réserve D′", f.num(cs.d_prime), "m", "anaérobie")}
        ${stat("Ajustement", f.num(cs.r2, 2), "R²")}
      </div>
      <div class="chart" id="ld-cs" style="height:170px;margin-top:10px"></div>
      <p class="muted ld-foot">La vitesse critique correspond à l'allure tenable ~30–40 min : un bon repère pour ton allure 10 km.</p>`,
  });
}

function drawCs(cs) {
  if (!cs || !document.getElementById("ld-cs")) return;
  const pts = cs.points || [];
  const tMax = Math.max(...pts.map((p) => p[0]), 600) * 1.08;
  chart("#ld-cs", {
    animation: false,
    grid: { left: 46, right: 26, top: 10, bottom: 26 },
    tooltip: { trigger: "item", formatter: (p) => ttRow(SPORTS.run.color, `${f.num(p.value[1])} m`, `en ${f.duration(p.value[0])}`) },
    xAxis: { type: "value", min: 0, max: Math.ceil(tMax / 300) * 300, interval: 300, axisLabel: { formatter: (v) => `${v / 60} min` } },
    yAxis: { type: "value", splitNumber: 3, axisLabel: { formatter: (v) => (v >= 1000 ? `${f.num(v / 1000, 0)} km` : `${v} m`) } },
    series: [
      { type: "line", silent: true, data: [[0, cs.d_prime], [tMax, cs.d_prime + cs.cs * tMax]], color: T.text3, lineStyle: { width: 1.5 }, symbol: "none" },
      { type: "scatter", data: pts, color: SPORTS.run.color, symbolSize: 10, itemStyle: { borderColor: T.surface, borderWidth: 2 } },
    ],
  });
}

// ---------------------------------------------------------------- efficiency & decoupling
function efOption(easy, mode) {
  const med = rollingMedian(easy.map((r) => r.ef), 15);
  const vals = easy.map((r) => r.ef);
  const ptName = mode === "easy" ? "Footing" : "Sortie";
  const medName = `Médiane glissante (15 ${mode === "easy" ? "footings" : "sorties"})`;
  return {
    animation: false,
    legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 8, data: [{ name: ptName, icon: "circle" }, { name: medName, icon: "rect", itemStyle: { color: SPORTS.run.color } }] },
    grid: { left: 44, right: 16, top: 36, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const r = easy[p.dataIndex];
        if (!r) return "";
        return ttTitle(f.dateDay(r.date)) + `<b>${f.esc(r.name)}</b>` + ttRow(T.text2, f.num(r.ef, 2), "m/min/bpm") + ttRow(T.text3, f.num(r.avg_hr), "bpm moyen")
          + (f.isNum(med[p.dataIndex]) ? ttRow(SPORTS.run.color, f.num(med[p.dataIndex], 2), "médiane") : "");
      },
    },
    xAxis: { type: "time", axisLabel: { formatter: (v) => { const d = new Date(v); return `${f.monthShort(d)} ${String(d.getFullYear()).slice(2)}`; }, hideOverlap: true } },
    // robust bounds: one GPS/HR glitch must not squash the trend
    yAxis: { type: "value", scale: true, splitNumber: 4, ...robustBounds(vals) },
    series: [
      { name: ptName, type: "scatter", symbolSize: 6, color: T.text3, itemStyle: { opacity: 0.6 }, data: easy.map((r) => ({ value: [r.date, r.ef], id: r.id })) },
      { name: medName, type: "line", data: easy.map((r, i) => [r.date, med[i]]), color: SPORTS.run.color, connectNulls: true, z: 3, silent: true },
    ],
    graphic: !easy.length ? [{ type: "text", left: "center", top: "middle", style: { text: "Aucune sortie sur la période", fill: T.text3, font: "13px Segoe UI" } }] : [],
  };
}

function decouplingOption(rows) {
  return {
    animation: false,
    grid: { left: 40, right: 54, top: 12, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return ttTitle(f.dateDay(r.date)) + `<b>${f.esc(r.name)}</b>` + ttRow(T.text1, `${f.num(r.decoupling, 1)} %`, "dérive allure/FC") + ttRow(T.text3, f.num(r.avg_hr), "bpm moyen");
      },
    },
    xAxis: { type: "time", axisLabel: { formatter: (v) => { const d = new Date(v); return `${f.monthShort(d)} ${String(d.getFullYear()).slice(2)}`; }, hideOverlap: true } },
    yAxis: { type: "value", min: (v) => Math.min(-5, Math.floor(v.min)), max: (v) => Math.max(15, Math.ceil(v.max)), splitNumber: 4, axisLabel: { formatter: "{value} %" } },
    series: [{
      type: "scatter", symbolSize: 9, color: SPORTS.run.color, itemStyle: { borderColor: T.surface, borderWidth: 2 },
      data: rows.map((r) => ({ value: [r.date, r.decoupling], id: r.id })),
      markArea: {
        silent: true,
        data: [
          [{ yAxis: -50, itemStyle: { color: T.good, opacity: 0.1 }, label: { show: true, position: "right", formatter: "couplé", color: T.text3, fontSize: 10 } }, { yAxis: 5 }],
          [{ yAxis: 5, itemStyle: { color: T.serious, opacity: 0.1 }, label: { show: true, position: "right", formatter: "dérive", color: T.text3, fontSize: 10 } }, { yAxis: 100 }],
        ],
      },
    }],
    graphic: rows.length ? [] : [{ type: "text", left: "center", top: "middle", style: { text: "Aucune sortie longue sur la période", fill: T.text3, font: "13px Segoe UI" } }],
  };
}

// ---------------------------------------------------------------- progression small multiples
function progressionOption(pts, inRange) {
  const data = pts.filter((p) => inRange(p.date));
  if (!data.length) {
    return { graphic: [{ type: "text", left: "center", top: "middle", style: { text: "Aucun effort sur la période", fill: T.text3, font: "12px Segoe UI" } }] };
  }
  const times = data.map((p) => p.time);
  const lo = Math.min(...times), hi = Math.max(...times);
  // keep the y-range readable: clip the slow tail at the 90th percentile
  const sorted = [...times].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? hi;
  const pad = Math.max(5, (p90 - lo) * 0.08);
  const step = [5, 10, 15, 30, 60, 120, 300, 600, 900].find((s) => (p90 + pad - lo + pad) / s <= 4) || 1800;
  const yMin = Math.floor((lo - pad) / step) * step, yMax = Math.ceil((p90 + pad) / step) * step;
  return {
    animation: false,
    grid: { left: 46, right: 10, top: 10, bottom: 24 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const r = p.data.r;
        if (!r) return "";
        return ttTitle(f.dateDay(r.date)) + `<b>${f.esc(r.activity_name || "")}</b>` + ttRow(SPORTS.run.color, mmss(r.time), r.race ? "course officielle" : "meilleur passage") + ttRow(T.text3, mmss(r.pr), "record à date");
      },
    },
    xAxis: { type: "time", splitNumber: 3, axisLabel: { formatter: (v) => { const d = new Date(v); return `${f.monthShort(d)} ${String(d.getFullYear()).slice(2)}`; }, hideOverlap: true } },
    yAxis: { type: "value", inverse: true, min: yMin, max: yMax, interval: step, axisLabel: { formatter: (v) => mmss(v) } },
    series: [
      {
        type: "scatter", symbolSize: (v, p) => (p.data.r.race ? 11 : 5), z: 2,
        data: data.map((r) => ({ value: [r.date, Math.min(r.time, yMax)], r, id: r.activity_id,
          itemStyle: r.race ? { color: T.text1, borderColor: T.surface, borderWidth: 2, opacity: 1 } : { color: T.text3, opacity: 0.45 } })),
      },
      { type: "line", step: "end", silent: true, data: data.map((r) => [r.date, r.pr]), color: SPORTS.run.color, z: 3 },
    ],
  };
}

function recordsCard(records) {
  if (!records.length) return card({ title: "Records personnels", body: empty("Aucun record pour l'instant") });
  const rows = records.map((r) => `
    <tr onclick="location.hash='#/activity/${r.activity_id}'">
      <td><b>${f.esc(r.name)}</b></td>
      <td class="r num"><b>${f.duration(r.time)}</b></td>
      <td class="r num">${f.pace(r.distance / r.time)} /km</td>
      <td class="r num">${f.num(r.vdot, 1)}</td>
      <td class="num">${f.dateShort(r.date)} ${r.date.slice(0, 4)}</td>
      <td class="name">${f.esc(r.activity_name || "")}</td>
    </tr>`).join("");
  return card({
    title: "Records personnels",
    sub: "Meilleurs passages mesurés dans tes séances (GPS) · clic = ouvrir la séance",
    body: `<div class="table-wrap" style="max-height:380px"><table class="data">
      <thead><tr><th>Distance</th><th class="r">Temps</th><th class="r">Allure</th><th class="r">VDOT</th><th>Date</th><th>Séance</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
  });
}
