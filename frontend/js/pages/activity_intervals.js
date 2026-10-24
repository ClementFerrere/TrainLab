// Activity page add-ons: interval-session analysis, engine/race helpers.
import { api } from "../api.js";
import { T, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, status, seg, onSeg } from "../ui.js";
import * as f from "../fmt.js";

// ---------------------------------------------------------------- race flag control
export const ENGINE_TIP = "Écart entre ta FC sur cette sortie et celle que prédit ton « moteur » (relation allure ↔ FC des 42 jours précédents) à la même allure. Positif = plus coûteux que d'habitude (fatigue, chaleur, maladie…).";

export function raceControl(a) {
  // race_user: explicit override (1/0); absent/null = automatic detection
  const state = a.race_user === 1 ? "1" : a.race_user === 0 ? "0" : "auto";
  const auto = state === "auto" ? ` (${a.is_race ? "oui" : "non"})` : "";
  return `<div class="act-racectl"><span class="muted">Course officielle</span>${seg("race", [["auto", `Auto${auto}`], ["1", "Oui"], ["0", "Non"]], state)}</div>`;
}

export function bindRaceControl(root, id) {
  onSeg(root, "race", async (v) => {
    try {
      await api.put(`/api/activities/${id}/race`, { value: v === "auto" ? null : v === "1" });
    } catch (e) { console.error(e); }
    window.dispatchEvent(new HashChangeEvent("hashchange"));  // re-render with the new flag
  });
}

// ---------------------------------------------------------------- interval analysis
const VERDICT = {
  progressif: ["good", "Progressif"], regulier: ["good", "Régulier"], correct: ["neutral", "Correct"],
  irregulier: ["warning", "Irrégulier"], craque: ["serious", "Craquage"],
};
const repDist = (m) => (m >= 950 ? `${f.num(Math.round(m / 100) / 10, 1)} km` : `${f.num(Math.round(m / 10) * 10)} m`);

export function intervalsCard(iv) {
  const sm = iv.summary;
  const [lvl, lbl] = VERDICT[sm.verdict] || ["neutral", sm.verdict];
  const cvTxt = sm.cv <= 2.5 ? "très homogène" : sm.cv <= 4.5 ? "quelques écarts" : "variable";
  const kpis = [
    stat("Allure des reps", f.pace(sm.speed), "/km", `meilleure ${f.pace(sm.best)}`),
    stat("Régularité", f.num(sm.cv, 1), "% d'écart", cvTxt),
    stat("Dernière vs première", f.signed(sm.last_vs_first, 1), "%", "+ = plus rapide à la fin"),
    sm.fade != null ? stat("Évolution dans les reps", f.signed(sm.fade, 1), "%", "2ᵉ moitié vs 1ʳᵉ") : "",
    sm.hrr60 != null ? stat("Récup FC en 60 s", f.num(sm.hrr60), "bpm", "chute après chaque rep") : "",
    stat("FC moyenne des reps", f.num(sm.avg_hr), "bpm", sm.cost_trend != null ? `coût cardiaque ${f.signed(sm.cost_trend, 1)} %/rep` : ""),
    sm.rest_ratio != null ? stat("Récup / effort", f.num(sm.rest_ratio * 100), "%", "durée de récup vs rep") : "",
  ].join("");
  const rows = iv.reps.map((r) => `<tr style="cursor:default">
      <td>${r.index}</td><td class="r">${repDist(r.distance)}</td><td class="r">${f.duration(r.duration)}</td>
      <td class="r"><b>${f.pace(r.speed)}</b></td><td class="r">${f.num(r.avg_hr)}</td><td class="r">${f.num(r.max_hr)}</td>
      <td class="r">${r.fade == null ? "–" : `${f.signed(r.fade, 1)} %`}</td><td class="r">${r.hrr60 == null ? "–" : f.num(r.hrr60)}</td>
      <td class="r">${f.num(r.cadence)}</td><td class="r">${f.num(r.gct)}</td></tr>`).join("");
  return card({
    id: "act-iv",
    title: "Analyse du fractionné",
    sub: `${sm.n} × ${repDist(sm.rep_distance)} · ${iv.source === "laps" ? "répétitions de ta séance structurée (tours de la montre)" : "répétitions détectées sur la vitesse"}`,
    actions: status(lvl, lbl),
    body: `
      <p class="iv-why">${f.esc(sm.why || "")}</p>
      <div class="stat-grid iv-kpis">${kpis}</div>
      <div class="iv-grid">
        <div>
          <div id="iv-chart" class="chart" style="height:290px"></div>
          <div class="legend iv-legend">
            <span><i class="line" style="background:${T.pos}"></i>Allure moyenne de la rep</span>
            <span><i class="line" style="background:${T.text3}"></i>Évolution 1ʳᵉ → 2ᵉ moitié</span>
            <span><i class="line" style="background:${T.fatigue}"></i>FC moyenne</span>
            <span><i class="iv-ring"></i>FC max</span>
          </div>
        </div>
        <div class="table-wrap iv-table"><table class="data"><thead><tr><th>#</th><th class="r">Dist.</th><th class="r">Durée</th><th class="r">Allure</th>
          <th class="r">FC moy.</th><th class="r">FC max</th><th class="r">Évol.</th><th class="r">Récup 60 s</th><th class="r">Cad.</th><th class="r">Sol (ms)</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>
      <div class="iv-sim">
        <div class="iv-sim-head"><h3>Progression sur tes séances similaires</h3><span class="muted">même nombre de reps (±1) · même distance (±15 %)</span></div>
        <div id="iv-sim" class="chart" style="height:290px"></div>
        <div id="iv-sim-foot" class="legend"></div>
      </div>`,
  });
}

function niceRange(lo, hi, steps, n = 4) {
  const span = Math.max(hi - lo, 1e-6);
  const step = steps.find((st) => span / st <= n) || steps[steps.length - 1];
  return { min: Math.floor((lo - span * 0.08) / step) * step, max: Math.ceil((hi + span * 0.08) / step) * step, interval: step };
}

export function drawIntervals(view, iv) {
  const reps = iv.reps;
  const cats = reps.map((r) => `R${r.index}`);
  // first/second-half paces reconstructed from the mean speed and the within-rep change
  const halves = reps.map((r) => {
    if (r.fade == null) return null;
    const v1 = (2 * r.speed) / (2 + r.fade / 100);
    return [1000 / v1, 1000 / (v1 * (1 + r.fade / 100))];
  });
  const paces = reps.map((r) => 1000 / r.speed);
  const allP = paces.concat(halves.flat().filter((x) => x != null));
  const yr = niceRange(Math.min(...allP), Math.max(...allP), [2, 5, 10, 15, 30, 60]);
  const hrs = reps.flatMap((r) => [r.avg_hr, r.max_hr]).filter((x) => x != null);
  const hr = hrs.length ? niceRange(Math.min(...hrs), Math.max(...hrs), [5, 10, 20, 40], 1.2) : { min: 100, max: 200, interval: 50 };
  chart(view.querySelector("#iv-chart"), {
    animation: false,
    grid: [{ left: 52, right: 24, top: 22, height: "50%" }, { left: 52, right: 24, top: "72%", bottom: 26 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      { type: "category", data: cats, gridIndex: 0, axisLabel: { show: false }, axisLine: { show: false } },
      { type: "category", data: cats, gridIndex: 1 },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, inverse: true, ...yr, axisLabel: { formatter: (y) => f.paceSec(y) } },
      { type: "value", gridIndex: 1, ...hr },
    ],
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = reps[ps[0].dataIndex];
        const h = halves[ps[0].dataIndex];
        return ttTitle(`Répétition ${r.index} · ${repDist(r.distance)} en ${f.duration(r.duration)}`)
          + ttRow(T.pos, `${f.pace(r.speed)} /km`, "allure moyenne")
          + (h ? ttRow(T.text3, `${f.paceSec(h[0])} → ${f.paceSec(h[1])}`, "1ʳᵉ → 2ᵉ moitié") : "")
          + (r.avg_hr ? ttRow(T.fatigue, `${f.num(r.avg_hr)} bpm`, `FC moy. (max ${f.num(r.max_hr)})`) : "")
          + (r.hrr60 != null ? ttRow(T.text3, `−${f.num(r.hrr60)} bpm`, "récup FC en 60 s") : "")
          + (r.t90 != null ? ttRow(T.text3, `${f.num(r.t90)} s`, "pour atteindre 90 % de la FC max de la rep") : "");
      },
    },
    series: [
      { name: "Évolution", type: "custom", xAxisIndex: 0, yAxisIndex: 0, z: 1, silent: true,
        data: halves.map((h, i) => (h ? [i, h[0], h[1]] : [i, NaN, NaN])),
        renderItem: (params, apiR) => {
          if (Number.isNaN(apiR.value(1))) return null;
          const p0 = apiR.coord([apiR.value(0), apiR.value(1)]);
          const p1 = apiR.coord([apiR.value(0), apiR.value(2)]);
          const x = p0[0] + 16;  // beside the mean dot
          return { type: "group", children: [
            { type: "line", shape: { x1: x, y1: p0[1], x2: x, y2: p1[1] }, style: { stroke: T.text3, lineWidth: 2, lineCap: "round" } },
            { type: "circle", shape: { cx: x, cy: p1[1], r: 3.5 }, style: { fill: T.text3 } },
          ] };
        } },
      { name: "Allure", type: "line", xAxisIndex: 0, yAxisIndex: 0, data: paces, color: T.pos, symbol: "circle", symbolSize: 11,
        showSymbol: true, lineStyle: { width: 1.5, opacity: 0.6 }, itemStyle: { borderColor: T.surface, borderWidth: 2 },
        label: { show: reps.length <= 12, position: "left", distance: 8, formatter: (p) => f.paceSec(p.value), color: T.text2, fontSize: 11 } },
      { name: "FC moyenne", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: reps.map((r) => r.avg_hr), color: T.fatigue,
        symbol: "circle", symbolSize: 9, showSymbol: true, itemStyle: { borderColor: T.surface, borderWidth: 2 } },
      { name: "FC max", type: "scatter", xAxisIndex: 1, yAxisIndex: 1, data: reps.map((r) => r.max_hr), symbolSize: 9,
        itemStyle: { color: "transparent", borderColor: T.fatigue, borderWidth: 2 } },
    ],
  });
}

export function drawIvSimilar(view, iv, a) {
  const foot = view.querySelector("#iv-sim-foot");
  const node = view.querySelector("#iv-sim");
  const sims = (iv.similar || []).filter((x) => x.speed);
  if (!sims.length) {
    node.style.height = "auto";
    node.innerHTML = `<p class="muted iv-empty">Pas encore de séance comparable dans ton historique : celle-ci servira de référence pour les prochaines.</p>`;
    return;
  }
  const sm = iv.summary;
  const cur = { id: a.id, date: a.date, name: a.strava?.name || a.name, speed: sm.speed, avg_hr: sm.avg_hr, verdict: sm.verdict, n: sm.n, rep_distance: sm.rep_distance };
  const all = [...sims, cur].sort((p, q) => (p.date < q.date ? -1 : 1));
  const ts = (x) => f.parseDate(x.date).getTime();
  const paces = all.map((x) => 1000 / x.speed);
  const yr = niceRange(Math.min(...paces), Math.max(...paces), [2, 5, 10, 15, 30, 60]);
  const hrs = all.map((x) => x.avg_hr).filter((x) => x != null);
  const hr = hrs.length ? niceRange(Math.min(...hrs), Math.max(...hrs), [5, 10, 20, 40], 1.2) : { min: 140, max: 190, interval: 25 };
  const ptsOf = (fn) => all.map((x) => ({
    value: [ts(x), fn(x)],
    itemStyle: x.id === a.id ? { color: T.accent, borderColor: T.surface, borderWidth: 3 } : undefined,
    symbolSize: x.id === a.id ? 15 : 10,
  }));
  const c = chart(node, {
    animation: false,
    grid: [{ left: 52, right: 24, top: 18, height: "44%" }, { left: 52, right: 24, top: "64%", bottom: 26 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      { type: "time", gridIndex: 0, axisLabel: { show: false }, axisLine: { show: false }, splitLine: { show: false } },
      { type: "time", gridIndex: 1, axisLabel: { formatter: (v) => f.dateShort(f.isoDate(new Date(v))), hideOverlap: true }, splitLine: { show: false } },
    ],
    yAxis: [
      { type: "value", gridIndex: 0, inverse: true, ...yr, axisLabel: { formatter: (y) => f.paceSec(y) } },
      { type: "value", gridIndex: 1, ...hr },
    ],
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const x = all[p.dataIndex];
        const lbl = (VERDICT[x.verdict] || [null, x.verdict || ""])[1];
        return ttTitle(`${f.dateDay(x.date)}${x.id === a.id ? " · cette séance" : ""}`) + `<b>${f.esc(x.name || "")}</b>`
          + ttRow(T.pos, `${f.pace(x.speed)} /km`, `allure moyenne des reps (${x.n} × ${repDist(x.rep_distance)})`)
          + (x.avg_hr ? ttRow(T.fatigue, `${f.num(x.avg_hr)} bpm`, "FC moyenne des reps") : "")
          + (lbl ? `<div class="tt-row"><span class="tt-key" style="background:transparent"></span><span>${f.esc(lbl)}</span></div>` : "");
      },
    },
    series: [
      { type: "line", xAxisIndex: 0, yAxisIndex: 0, data: ptsOf((x) => 1000 / x.speed), color: T.pos, symbol: "circle", showSymbol: true,
        lineStyle: { width: 1.5, opacity: 0.5 }, itemStyle: { borderColor: T.surface, borderWidth: 2 } },
      { type: "line", xAxisIndex: 1, yAxisIndex: 1, data: ptsOf((x) => x.avg_hr), color: T.fatigue, symbol: "circle", showSymbol: true,
        lineStyle: { width: 1.5, opacity: 0.5 }, itemStyle: { borderColor: T.surface, borderWidth: 2 } },
    ],
  });
  c.on("click", (p) => { const x = all[p.dataIndex]; if (x && x.id !== a.id) location.hash = `#/activity/${x.id}`; });
  const prev = sims.filter((x) => x.date < a.date).sort((p, q) => (p.date < q.date ? 1 : -1))[0];
  let note = "";
  if (prev) {
    const dp = 1000 / sm.speed - 1000 / prev.speed;
    const dh = sm.avg_hr != null && prev.avg_hr != null ? sm.avg_hr - prev.avg_hr : null;
    note = `<span class="iv-note">Vs la précédente (${f.dateShort(prev.date)}) : <b>${f.num(Math.abs(dp))} s/km ${dp <= 0 ? "plus vite" : "plus lent"}</b>${dh != null ? ` pour <b>${f.signed(dh)} bpm</b>` : ""}</span>`;
  }
  foot.innerHTML = `<span><i class="line" style="background:${T.pos}"></i>Allure moyenne des reps</span><span><i class="line" style="background:${T.fatigue}"></i>FC moyenne des reps</span><span><i class="act-dot" style="background:${T.accent}"></i>cette séance</span>${note}`;
}
