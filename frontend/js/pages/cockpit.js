import { api } from "../api.js";
import { T, SPORTS, sport, sportIcon, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, status, empty, routeSvg, formState, acwrState } from "../ui.js";
import * as f from "../fmt.js";

export async function render(view, { setActions }) {
  const d = await api.get("/api/cockpit");
  if (!d.pmc && !d.nights?.length) {
    view.innerHTML = card({ body: empty("Aucune donnée pour l'instant", "Connecte ta clé Garmin dans Réglages & sources : la synchro démarre aussitôt.", `<a class="btn primary" href="#/settings">Connecter Garmin</a>`) });
    return;
  }
  setActions(`<span class="chip">${f.dateLong(d.today)}</span>`);

  view.innerHTML = `
    <div class="grid cockpit">
      <div class="span-4">${heroCard(d)}</div>
      <div class="span-4">${readinessCard(d.readiness)}</div>
      <div class="span-4">${goalCard(d)}</div>
      <div class="span-8">${weekCard(d)}</div>
      <div class="span-4">${nightCard(d)}</div>
      <div class="span-7">${card({ title: "Fitness & fatigue", sub: "120 derniers jours · modèle impulsion-réponse (CTL 42 j, ATL 7 j)", body: `<div class="chart tall" id="pmc"></div>` })}</div>
      <div class="span-5">${lastCard(d)}</div>
      <div class="span-12">${card({ title: "Une année d'entraînement", sub: "Charge quotidienne (hrTSS) — chaque case est un jour", body: `<div class="chart" id="heat" style="height:200px"></div><div class="heat-legend" id="heat-legend"></div>` })}</div>
    </div>`;

  drawPmc(d.pmc || []);
  drawHeat(d.heat || []);
}

// ---------------------------------------------------------------- hero: form gauge
function heroCard(d) {
  const fm = d.form || {};
  const [lvl, label] = formState(fm.tsb);
  const [alvl, alabel] = acwrState(fm.acwr);
  const lo = -40, hi = 25;
  const pos = (v) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100;
  const zones = [[-40, -30, "critical"], [-30, -10, "serious"], [-10, 5, "good"], [5, 15, "good2"], [15, 25, "warning"]];
  const gauge = `
    <div class="gauge" role="img" aria-label="Fraîcheur ${f.signed(Math.round(fm.tsb ?? 0) || 0)} : ${label}">
      <div class="gauge-track">${zones.map(([a, b, z]) => `<span class="gz gz-${z}" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%"></span>`).join("")}</div>
      <div class="gauge-needle" style="left:${pos(fm.tsb ?? 0)}%"></div>
      <div class="gauge-labels"><span style="left:${pos(-35)}%">surcharge</span><span style="left:${pos(-20)}%">productif</span><span style="left:${pos(-2.5)}%">équilibré</span><span style="left:${pos(10)}%">frais</span><span style="left:${pos(20)}%">transition</span></div>
    </div>`;
  return card({
    cls: "glow hero",
    body: `
      <div class="eyebrow">Forme du jour · fraîcheur (TSB)</div>
      <div class="hero-row">
        <div class="hero-num">${f.signed(Math.round(fm.tsb ?? 0) || 0)}</div>
        <div>${status(lvl, label)}</div>
      </div>
      ${gauge}
      <div class="stat-grid four">
        ${stat("Fitness (CTL)", f.num(fm.ctl), "", `${f.signed(fm.ramp, 1)} / 7 j`)}
        ${stat("Fatigue (ATL)", f.num(fm.atl))}
        ${stat("Ratio aigu/chronique", f.num(fm.acwr, 2), "", status(alvl, alabel))}
        ${stat("VO2max Garmin", d.garmin_vo2max ? f.num(d.garmin_vo2max.vo2max) : "–", "", d.vdot ? `VDOT ${f.num(d.vdot, 1)}` : "")}
      </div>`,
  });
}

// ---------------------------------------------------------------- morning readiness
const MODEL_SHORT = { vdot: "VDOT", riegel: "Riegel", cs: "vitesse critique", engine: "moteur cardiaque", workout: "séances clés" };
const READY_ZONES = [[0, 30, "serious", "récup"], [30, 45, "warning", "prudence"], [45, 65, "good2", "normal"], [65, 100, "good", "prêt"]];

function readinessCard(r) {
  if (!r || r.score == null) {
    return card({ title: "Readiness du matin", body: empty("Pas encore de score", "Il faut une dizaine de nuits synchronisées pour établir ta référence.") });
  }
  const score = Math.round(r.score);
  const gauge = `
    <div class="gauge rd-gauge" role="img" aria-label="Readiness ${score} sur 100 : ${f.esc(r.label)}">
      <div class="gauge-track">${READY_ZONES.map(([a, b, z]) => `<span class="gz gz-${z}" style="left:${a}%;width:${b - a}%"></span>`).join("")}</div>
      <div class="gauge-needle" style="left:${Math.max(0, Math.min(100, r.score))}%"></div>
      <div class="gauge-labels">${READY_ZONES.map(([a, b, , l]) => `<span style="left:${(a + b) / 2}%">${l}</span>`).join("")}</div>
    </div>`;
  // z-scores clipped to ±3 on a diverging bar centred on 0 (your 28-day normal)
  const bars = (r.contrib || []).map((c) => {
    const z = Math.max(-3, Math.min(3, c.z));
    const w = (Math.abs(z) / 3) * 50;
    const tip = `<b>${f.signed(c.z, 1)} σ</b> vs ta moyenne 28 j · poids ${f.num(c.weight * 100)} %`;
    return `<div class="rd-row" data-tip="${f.esc(tip)}"><span class="rd-lbl">${f.esc(c.label)}</span>
      <span class="rd-bar"><i class="rd-mid"></i><i class="rd-fill" style="${z >= 0 ? `left:50%` : `left:${50 - w}%`};width:${w}%;background:${z >= 0 ? T.pos : T.neg}"></i></span>
      <span class="rd-val num">${f.signed(c.z, 1)}</span></div>`;
  }).join("");
  const engine = r.engine_resid != null && Math.abs(r.engine_resid) >= 2
    ? `<div class="rd-note muted">Moteur sur ta dernière course : FC ${f.signed(r.engine_resid)} bpm vs ta forme habituelle</div>` : "";
  return card({
    title: "Readiness du matin",
    sub: `Nuit du ${f.dateShort(r.date)} · signaux vs tes 28 derniers jours`,
    actions: `<a class="btn" href="#/sleep">Historique</a>`,
    body: `
      <div class="hero-row"><div class="hero-num">${score}<span class="hero-unit">/100</span></div>${status(r.level, r.label)}</div>
      ${gauge}
      <div class="rd-bars">${bars}</div>
      <div class="rd-axis muted"><span>en dessous de ta normale</span><span>au-dessus</span></div>
      ${r.divergence_note ? `<div class="callout warn rd-div">${status("warning", "Ressenti ≠ signaux")} ${f.esc(r.divergence_note)}</div>` : ""}
      ${engine}`,
  });
}

// ---------------------------------------------------------------- goals
function goalCard(d) {
  const goals = d.goals || [];
  if (!goals.length) return card({ title: "Objectifs", body: empty("Aucun objectif à venir", "", `<a class="btn" href="#/settings">Ajouter</a>`) });
  const main = goals.find((g) => g.priority === "A") || goals[0];
  const others = goals.filter((g) => g !== main).slice(0, 3);
  const pred = main.predicted, target = main.target_time;
  const range = main.predicted_range;
  let bullet = "";
  if (pred && target) {
    const vals = [pred, target, ...(range || [])];
    const lo = Math.min(...vals) * 0.985, hi = Math.max(...vals) * 1.015;
    const p = (v) => ((v - lo) / (hi - lo)) * 100;
    const gap = pred - target;
    const by = MODEL_SHORT[main.predicted_by] || "plusieurs modèles";
    bullet = `
      <div class="bullet" role="img" aria-label="Prédiction ${f.duration(pred)} (fourchette ${range ? `${f.duration(range[0])} à ${f.duration(range[1])}` : "—"}) pour un objectif ${f.duration(target)}">
        <div class="bullet-track"></div>
        ${range ? `<div class="bullet-range" style="left:${p(range[0])}%;width:${p(range[1]) - p(range[0])}%" data-tip="${f.esc(`Fourchette <b>${f.duration(range[0])} – ${f.duration(range[1])}</b> (erreur moyenne du modèle sur tes courses passées)`)}"></div>` : ""}
        <div class="bullet-target" style="left:${p(target)}%"><span>objectif ${f.duration(target)}</span></div>
        <div class="bullet-pred" style="left:${p(pred)}%" data-tip="${f.esc(`<b>${f.duration(pred)}</b> prédit · ensemble de 5 modèles, surtout ${by}`)}"><span>prédit ${f.duration(pred)}</span></div>
      </div>
      <div class="goal-gap">${gap > 0 ? `Encore <b>${f.duration(gap)}</b> à gagner` : `Objectif <b>dans les clous</b> (marge ${f.duration(-gap)})`}<span class="muted"> · prédiction (ensemble de 5 modèles, surtout ${by})</span></div>`;
  }
  return card({
    title: "Prochain objectif",
    actions: `<span class="chip">Priorité ${f.esc(main.priority || "–")}</span><a class="btn" href="#/profile">Détails</a>`,
    body: `
      <div class="countdown"><span class="cd-num">${main.days_to}</span><span class="cd-unit">jours</span></div>
      <div class="goal-name">${f.esc(main.name)}</div>
      <div class="muted">${f.dateLong(main.date)}${main.distance ? ` · ${f.km(main.distance, main.distance < 10000 ? 1 : 0)} km` : ""}</div>
      ${bullet}
      <div class="goal-list">${others.map((g) => `
        <div class="goal-row"><span class="chip">${f.relDays(g.days_to)}</span><span class="gname">${f.esc(g.name)}</span>
        <span class="num dim">${g.target_time ? f.duration(g.target_time) : ""}${g.predicted ? ` <span class="muted">/ ${f.duration(g.predicted)}</span>` : ""}</span></div>`).join("")}
      </div>`,
  });
}

// ---------------------------------------------------------------- last night
function nightCard(d) {
  // today's row can be partial (daily summary synced before the night): use the latest full night
  const n = (d.nights || []).find((x) => x.sleep_seconds);
  if (!n || !n.sleep_seconds) {
    return card({ title: "Dernière nuit", body: empty("Pas encore de nuit", "Les données de sommeil arrivent avec Garmin.") });
  }
  const tot = n.sleep_seconds + (n.awake_seconds || 0);
  const seg = (v, c, l) => v ? `<span style="width:${(v / tot) * 100}%;background:${c}" data-tip="${f.esc(`<b>${f.hm(v)}</b> ${l}`)}"></span>` : "";
  const hrvLvl = { BALANCED: "good", UNBALANCED: "warning", LOW: "serious", POOR: "critical" }[n.hrv_status] || "neutral";
  const hrvLbl = { BALANCED: "Équilibrée", UNBALANCED: "Déséquilibrée", LOW: "Basse", POOR: "Faible" }[n.hrv_status] || "—";
  const scoreLvl = n.sleep_score >= 80 ? "good" : n.sleep_score >= 60 ? "warning" : "serious";
  return card({
    title: "Dernière nuit",
    sub: `${f.dateShort(n.date)} · ${f.timeOf(n.sleep_start)} → ${f.timeOf(n.sleep_end)}`,
    actions: `<a class="btn" href="#/sleep">Détails</a>`,
    body: `
      <div class="hero-row"><div class="hero-num sm">${f.hm(n.sleep_seconds)}</div>${n.sleep_score ? status(scoreLvl, `score ${n.sleep_score}`) : ""}</div>
      <div class="stage-bar">${seg(n.deep_seconds, T.deep, "profond")}${seg(n.light_seconds, T.light, "léger")}${seg(n.rem_seconds, T.rem, "paradoxal")}${seg(n.awake_seconds, T.awake, "éveillé")}</div>
      <div class="legend" style="margin:8px 0 14px"><span><i style="background:${T.deep}"></i>Profond</span><span><i style="background:${T.light}"></i>Léger</span><span><i style="background:${T.rem}"></i>Paradoxal</span><span><i style="background:${T.awake}"></i>Éveil</span></div>
      <dl class="kv">
        <dt>HRV nocturne</dt><dd>${f.num(n.hrv_overnight)} ms ${n.hrv_status ? status(hrvLvl, hrvLbl) : ""}</dd>
        <dt>FC de repos</dt><dd>${f.num(n.resting_hr)} bpm</dd>
        <dt>Body Battery max</dt><dd>${f.num(n.body_battery_high)}</dd>
        <dt>Stress pendant le sommeil</dt><dd>${f.num(n.sleep_stress)}</dd>
      </dl>`,
  });
}

// ---------------------------------------------------------------- week strip
function weekCard(d) {
  const ws = f.parseDate(d.week_start);
  const days = Array.from({ length: 7 }, (_, i) => f.addDays(ws, i));
  const acts = d.week || [];
  const cur = acts.filter((a) => a.date >= d.week_start);
  const todayIso = d.today;
  // previous 4 weeks, cut at the same weekday so a week in progress compares fairly
  const dow = (f.parseDate(todayIso).getDay() + 6) % 7;
  const prev = [1, 2, 3, 4].flatMap((k) => {
    const s = f.isoDate(f.addDays(ws, -7 * k)), e = f.isoDate(f.addDays(ws, -7 * k + dow));
    return acts.filter((a) => a.date >= s && a.date <= e);
  });
  const sum = (arr, fn) => arr.reduce((s, a) => s + (fn(a) || 0), 0);
  const runKm = (arr) => sum(arr.filter((a) => a.sport === "run"), (a) => a.distance) / 1000;
  const hours = (arr) => sum(arr, (a) => a.moving_time) / 3600;
  const load = (arr) => sum(arr, (a) => a.load);
  const ref = dow === 6 ? "moy. 4 sem." : `même point, moy. 4 sem.`;
  const delta = (v, r) => r ? `${f.signed(((v / r) - 1) * 100)} % vs ${ref}` : "";
  const cols = days.map((day) => {
    const iso = f.isoDate(day);
    const list = cur.filter((a) => a.date === iso);
    const pills = list.map((a) => {
      const sp = sport(a.sport);
      const name = a.strava?.name || a.name || sp.label;
      const main = a.distance > 0 ? `${f.km(a.distance)} km` : f.hm(a.moving_time);
      return `<a class="pill" href="#/activity/${a.id}" style="--c:${sp.color}" data-tip="${f.esc(`<b>${main}</b> · ${f.hm(a.moving_time)}<br>${f.esc(name)}<br>charge ${f.num(a.load)}`)}">
        <span class="pill-ic">${sportIcon(a.sport, 14)}</span><span class="pill-t">${main}</span></a>`;
    }).join("");
    return `<div class="wday ${iso === todayIso ? "today" : ""} ${iso > todayIso ? "future" : ""}">
      <div class="wday-h">${["lun", "mar", "mer", "jeu", "ven", "sam", "dim"][(day.getDay() + 6) % 7]} <b>${day.getDate()}</b></div>
      <div class="wday-b">${pills || `<span class="rest">${iso > todayIso ? "" : "repos"}</span>`}</div></div>`;
  }).join("");
  return card({
    title: "Cette semaine",
    sub: `du ${f.dateShort(d.week_start)} au ${f.dateShort(f.isoDate(days[6]))}`,
    actions: `<a class="btn" href="#/journal">Journal</a>`,
    body: `<div class="week-strip">${cols}</div>
      <div class="stat-grid four" style="margin-top:14px">
        ${stat("Course", f.num(runKm(cur), 1), "km", delta(runKm(cur), runKm(prev) / 4))}
        ${stat("Volume total", f.num(hours(cur), 1), "h", delta(hours(cur), hours(prev) / 4))}
        ${stat("Charge", f.num(load(cur)), "", delta(load(cur), load(prev) / 4))}
        ${stat("Séances", f.num(cur.length), "", `${f.num(prev.length / 4, 1)} en moyenne à ce stade`)}
      </div>`,
  });
}

// ---------------------------------------------------------------- last activity
function lastCard(d) {
  const a = d.last_activity;
  if (!a) return card({ title: "Dernière séance", body: empty("Aucune séance") });
  const sp = sport(a.sport);
  const name = a.strava?.name || a.name;
  const pace = a.sport === "run" ? `${f.pace(a.avg_speed)}<small>/km</small>` : a.sport === "bike" ? `${f.kmh(a.avg_speed)}<small>km/h</small>` : "–";
  return card({
    title: "Dernière séance",
    sub: `${f.dateDay(a.date)} · ${f.timeOf(a.start_local)}`,
    actions: `<a class="btn" href="#/activity/${a.id}">Ouvrir</a>`,
    body: `
      <div class="last-act">
        <div class="last-route" style="--c:${sp.color}">${routeSvg(a.route, { w: 132, h: 110, color: sp.color, stroke: 2.4 }) || `<span class="big-ic">${sportIcon(a.sport, 40)}</span>`}</div>
        <div>
          <div class="goal-name">${f.esc(name)}</div>
          <div class="muted">${sp.label}${a.location_name ? ` · ${f.esc(a.location_name)}` : ""}</div>
          ${a.strava?.description ? `<p class="desc">${f.esc(a.strava.description)}</p>` : ""}
        </div>
      </div>
      <div class="stat-grid three">
        ${stat("Distance", f.km(a.distance), "km")}
        ${stat("Durée", f.hm(a.moving_time))}
        ${stat(a.sport === "run" ? "Allure" : "Vitesse", pace)}
        ${stat("FC moyenne", f.num(a.avg_hr), "bpm")}
        ${stat("Charge", f.num(a.load))}
        ${stat("Training effect", f.num(a.aerobic_te, 1), "", a.rpe ? `RPE ${f.num(a.rpe)}/10` : "")}
      </div>`,
  });
}

// ---------------------------------------------------------------- charts
function drawPmc(pmc) {
  if (!pmc.length) return;
  const dates = pmc.map((r) => r.date);
  chart("#pmc", {
    animation: false,
    legend: { top: 0, left: 0, data: [{ name: "Fitness (CTL)", icon: "rect" }, { name: "Fatigue (ATL)", icon: "rect" }, { name: "Forme (TSB)", icon: "roundRect" }], itemWidth: 14, itemHeight: 3 },
    grid: [{ left: 36, right: 12, top: 30, height: "52%" }, { left: 36, right: 12, top: "72%", bottom: 26 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = pmc[ps[0].dataIndex];
        return ttTitle(f.dateDay(r.date)) + ttRow(T.fitness, f.num(r.ctl), "fitness") + ttRow(T.fatigue, f.num(r.atl), "fatigue")
          + ttRow(r.tsb >= 0 ? T.pos : T.neg, f.signed(r.tsb), "forme", true) + ttRow(T.text3, f.num(r.load), "charge du jour", true);
      },
    },
    xAxis: [
      { type: "category", data: dates, gridIndex: 0, axisLabel: { show: false }, axisLine: { show: false } },
      { type: "category", data: dates, gridIndex: 1, axisLabel: { formatter: (v) => f.dateShort(v), interval: 29 } },
    ],
    yAxis: [{ type: "value", gridIndex: 0, splitNumber: 3 }, { type: "value", gridIndex: 1, splitNumber: 2 }],
    series: [
      { name: "Fitness (CTL)", type: "line", data: pmc.map((r) => r.ctl), color: T.fitness, areaStyle: { color: T.fitness, opacity: 0.1 } },
      { name: "Fatigue (ATL)", type: "line", data: pmc.map((r) => r.atl), color: T.fatigue },
      { name: "Forme (TSB)", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 4, color: T.pos,
        data: pmc.map((r) => ({ value: r.tsb, itemStyle: { color: r.tsb >= 0 ? T.pos : T.neg, borderRadius: r.tsb >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })) },
    ],
  });
}

function drawHeat(heat) {
  if (!heat.length) return;
  const vals = heat.map((r) => r.load).filter((v) => v > 0).sort((a, b) => a - b);
  const p95 = vals[Math.floor(vals.length * 0.95)] || 100;
  const start = heat[0].date, end = heat[heat.length - 1].date;
  const months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  chart("#heat", {
    animation: false,
    tooltip: {
      formatter: (p) => {
        const r = heat.find((x) => x.date === p.data[0]);
        return ttTitle(f.dateLong(p.data[0])) + (r && r.load > 0 ? ttRow(T.seq[6], f.num(r.load), "charge", true) + (r.run_km ? ttRow(SPORTS.run.color, `${f.num(r.run_km, 1)} km`, "course") : "") : "repos");
      },
    },
    visualMap: { show: false, min: 1, max: p95, inRange: { color: T.seq.slice(0, 9) }, outOfRange: { color: T.surface3 } },
    calendar: {
      range: [start, end], top: 22, left: 34, right: 8, bottom: 4, cellSize: ["auto", 18],
      splitLine: { show: false },
      itemStyle: { color: T.surface2, borderColor: T.surface, borderWidth: 3 },
      dayLabel: { firstDay: 1, nameMap: ["D", "L", "M", "M", "J", "V", "S"], color: T.text3, fontSize: 10 },
      monthLabel: { nameMap: months, color: T.text3, fontSize: 11 },
      yearLabel: { show: false },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data: heat.map((r) => [r.date, r.load > 0 ? Math.round(r.load) : 0]) }],
  });
  const leg = document.getElementById("heat-legend");
  leg.innerHTML = `<span class="muted">repos</span><i style="background:${T.surface2}"></i>${[0, 2, 4, 6, 8].map((i) => `<i style="background:${T.seq[i]}"></i>`).join("")}<span class="muted">≥ ${f.num(p95)} hrTSS</span>`;
}
