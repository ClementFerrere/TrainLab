// Profil athlète: Runner Matrix, backtested race predictions, speed-duration
// curve, durability and the speed <-> heart-rate "engine".
import { api } from "../api.js";
import { T, SPORTS, ttRow, ttTitle } from "../theme.js";
import { card, chart, empty, seg, onSeg } from "../ui.js";
import * as f from "../fmt.js";

// Model identity: categorical slots 1..5 in fixed order (most important first).
const MODEL_ORDER = ["workout", "vdot", "riegel", "cs", "engine"];
const MC = {
  workout: SPORTS.run.color, vdot: SPORTS.bike.color, riegel: SPORTS.swim.color,
  cs: SPORTS.strength.color, engine: SPORTS.racket.color, ensemble: T.text1,
};
const DIST_ORDER = ["5 km", "10 km", "Semi", "Marathon"];
const DIST_SHORT = { "5 km": "5 km", "10 km": "10 km", Semi: "Semi-marathon", Marathon: "Marathon" };

// x positions for duration charts (log10 of seconds)
const LOG_TICKS = [30, 60, 300, 1200, 3600, 7200];
const lg = (s) => Math.log10(s);
const durLabel = (s) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${f.num(s / 3600, s % 3600 ? 1 : 0)} h`);
const durFromLog = (x) => durLabel(Math.round(10 ** x));

const hms = (s) => (f.isNum(s) ? f.duration(s, { hms: s >= 3600 }) : "–");
const paceOf = (v) => (f.isNum(v) && v > 0 ? 1000 / v : null); // m/s -> s/km
const kmhPace = (kmh) => (f.isNum(kmh) && kmh > 0 ? f.paceSec(3600 / kmh) : "–");
const pctS = (v, d = 1) => (f.isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${f.num(Math.abs(v), d)} %` : "–");
const fmt3 = (v, d = 3) => (f.isNum(v) ? v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
// pace axis (s/km, inverted) with bounds aligned on a round step so ticks stay regular
function paceAxis(vals, step = 30) {
  const v = vals.filter(f.isNum);
  const lo = Math.floor((Math.min(...v) - 3) / step) * step, hi = Math.ceil((Math.max(...v) + 3) / step) * step;
  const span = hi - lo;
  const interval = span / step > 8 ? step * Math.ceil(span / step / 6) : step;
  return { type: "value", inverse: true, min: Math.floor(lo / interval) * interval, max: Math.ceil(hi / interval) * interval, interval,
    axisLabel: { formatter: (x) => f.paceSec(x) }, splitLine: { lineStyle: { color: T.grid } } };
}
const section = (title, sub = "") => `<div class="pf-section"><h3>${title}</h3>${sub ? `<span>${sub}</span>` : ""}</div>`;
const key = (m, round = true) => `<i class="pf-key${round ? " dot" : ""}" style="background:${MC[m]}"></i>`;

// ---------------------------------------------------------------- page
export async function render(view) {
  const [mx, pr, cv, en] = await Promise.allSettled([
    api.get("/api/profile/matrix", { ttl: 60000 }),
    api.get("/api/profile/predictions", { ttl: 60000 }),
    api.get("/api/profile/curves", { ttl: 60000 }),
    api.get("/api/profile/engine", { ttl: 60000 }),
  ]).then((rs) => rs.map((r) => (r.status === "fulfilled" ? r.value : null)));

  const hasMatrix = mx && mx.axes?.some((a) => a.score != null);
  const hasPred = pr && pr.distances && Object.keys(pr.distances).length;
  if (!hasMatrix && !hasPred) {
    view.innerHTML = card({ body: empty("Pas encore assez de données", "Le profil se construit à partir de tes fichiers FIT (courbes vitesse-durée, fenêtres stables). Laisse la synchro Garmin terminer.") });
    return;
  }

  view.innerHTML = `
    ${section("Runner Matrix", `Six dimensions notées sur 100 · 100 = ton meilleur niveau depuis le début des données · comparé à il y a 6 mois${mx?.past ? ` (${f.dateShort(mx.past)})` : ""}`)}
    <div class="grid">
      <div class="span-5">${radarCard(mx)}</div>
      <div class="span-7"><div class="pf-axes">${(mx?.axes || []).map((a) => axisCard(a, mx.history || [])).join("")}</div></div>
    </div>

    ${section("Prédictions", "5 modèles, pondérés par leur précision mesurée sur tes propres courses")}
    <div class="grid">
      <div class="span-12">${predictionsCard(pr)}</div>
      <div class="span-7">${card({ title: "Backtest sur tes courses", sub: "Erreur de chaque modèle s'il avait prédit la veille de la course · à gauche = trop optimiste, à droite = trop pessimiste", body: `<div class="pf-legend legend">${legendModels(true)}</div><div id="pf-backtest" class="chart" style="height:${Math.max(260, 60 + (pr?.backtest?.length || 0) * 50)}px"></div>` })}</div>
      <div class="span-5">${leaderboardCard(pr)}</div>
    </div>

    ${section("Courbe vitesse-durée", "Ta meilleure allure tenue sur chaque durée · ajustée au dénivelé, fenêtres quasi plates uniquement")}
    <div class="grid">
      <div class="span-8">${card({ title: "Meilleures allures par durée", sub: "Plus la courbe est haute, plus tu es rapide · points = tes records par distance (clic = séance) · tout ton historique Garmin", body: `<div class="legend" id="pf-sd-legend"></div><div id="pf-sd" class="chart" style="height:330px"></div>` })}</div>
      <div class="span-4">${sdNumbersCard(cv, pr)}</div>
    </div>

    ${section("Durabilité", "Ce que tu gardes de ta vitesse quand la fatigue s'accumule — décisif sur marathon et triathlon")}
    <div class="grid">
      <div class="span-6">${card({ title: "Frais vs fatigué", sub: "Meilleures allures sur 1 an : depuis le départ, après 60 min et après 90 min de course", body: `<div class="legend" id="pf-dur-legend"></div><div id="pf-dur" class="chart" style="height:250px"></div><div class="pf-di" id="pf-di"></div>` })}</div>
      <div class="span-6">${card({ title: "Dérive sur tes sorties longues", sub: "Pente à allure égale sur les fenêtres stables de chaque sortie ≥ 40 min · plus bas = plus durable", actions: seg("drift", [["hr", "Fréquence cardiaque"], ["gct", "Contact au sol"]], "hr"), body: `<div id="pf-drift" class="chart" style="height:290px"></div><div class="pf-note" id="pf-drift-note"></div>` })}</div>
    </div>

    ${section("Moteur allure ↔ FC", "Ta relation allure-fréquence cardiaque sur les fenêtres stables (hors fractionné), mois après mois")}
    <div class="grid">
      <div class="span-7">${card({ title: "Famille de courbes mensuelles", sub: "Une droite par mois (5e → 95e centile de FC) · plus la droite est haute, plus tu cours vite à FC égale", body: `<div class="legend" id="pf-eng-legend"></div><div id="pf-engine" class="chart" style="height:330px"></div>` })}</div>
      <div class="span-5">${card({ title: "Allure à FC fixe", sub: "Moteur ajusté sur les 42 jours précédant chaque semaine", body: `<div class="pf-tiles" id="pf-eng-tiles"></div><div class="legend" style="margin-top:10px"><span><i class="line" style="background:${T.seq[8]}"></i>à 150 bpm</span><span><i class="line" style="background:${T.seq[4]}"></i>à 165 bpm</span></div><div id="pf-engser" class="chart" style="height:220px"></div>` })}</div>
      <div class="span-12">${card({ title: "Écart moteur par séance", sub: "FC observée − FC attendue à ton allure d'après le moteur des 42 jours précédents · positif = cœur plus sollicité que d'habitude (fatigue, chaleur, maladie) · clique pour ouvrir", body: `<div class="legend"><span><i style="background:${T.neg}"></i>FC plus haute que d'habitude</span><span><i style="background:${T.pos}"></i>FC plus basse</span><span><i class="line" style="background:${T.text2}"></i>moyenne glissante 7 séances</span></div><div id="pf-resid" class="chart" style="height:220px"></div>` })}</div>
    </div>`;

  if (hasMatrix) drawRadar(mx);
  drawSparks(mx);
  if (hasPred) drawBacktest(pr);
  if (cv) { drawSpeedDuration(cv); drawDurability(cv); drawDrift(cv, "hr"); onSeg(view, "drift", (k) => drawDrift(cv, k)); }
  if (en) { drawEngineFamily(en); drawEngineSeries(en); drawResiduals(en); }
}

// ---------------------------------------------------------------- Runner Matrix
function radarCard(mx) {
  const a = mx?.archetype;
  return card({
    cls: "glow pf-radar-card",
    body: `
      ${a ? `<div class="pf-arch"><div class="eyebrow">Archétype</div><div class="pf-arch-name">${f.esc(a.name)}</div>
        <div class="pf-arch-sub">force : <b>${f.esc(a.strength)}</b> · à travailler : <b>${f.esc(a.weakness)}</b></div></div>` : ""}
      <div class="legend pf-radar-legend"><span><i style="background:${T.seq[6]}"></i>Aujourd'hui</span><span><i class="line" style="background:${T.text3}"></i>Il y a 6 mois</span></div>
      <div id="pf-radar" class="chart" style="height:330px"></div>`,
  });
}

const AXIS_HIST = { vitesse: "vitesse", endurance: "endurance", resilience: "resilience", physiologie: "vo2max", economie: "economie", recuperation: "hrv" };

function axisValue(a, hist) {
  const last = hist[hist.length - 1] || {};
  switch (a.key) {
    case "vitesse":
    case "endurance":
      return `${f.num(a.value, 1)} km/h <span class="muted">· ${kmhPace(a.value)}/km</span>`;
    case "resilience":
      return `${f.signed(a.value, 1)} bpm/h`;
    case "physiologie":
      return `VO2max ${f.num(a.value, 1)}${f.isNum(last.engine160) ? ` <span class="muted">· ${kmhPace(last.engine160)}/km à 160 bpm</span>` : ""}`;
    case "economie":
      return `${f.num(a.value, 2)} <span class="muted">m/s par W/kg</span>`;
    case "recuperation":
      return `HRV ${f.num(a.value)} ms${f.isNum(last.rhr) ? ` <span class="muted">· FC repos ${f.num(last.rhr)} · sommeil ${f.num(last.sleep)}</span>` : ""}`;
    default:
      return f.num(a.value, 2);
  }
}

function axisCard(a, hist) {
  const sc = a.score, past = a.score_6m;
  const d = f.isNum(sc) && f.isNum(past) ? sc - past : null;
  const dir = d == null ? "" : d >= 0.5 ? "up" : d <= -0.5 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
  return `
    <div class="pf-axis">
      <div class="pf-axis-head">
        <span class="pf-axis-name">${f.esc(a.label)}</span>
        <span class="pf-score">${f.isNum(sc) ? f.num(sc) : "–"}<small>/100</small></span>
      </div>
      <div class="pf-scorebar" role="img" aria-label="Score ${f.num(sc)} sur 100, il y a 6 mois ${f.num(past)}">
        <i style="width:${f.isNum(sc) ? sc : 0}%"></i>
        ${f.isNum(past) ? `<b style="left:${past}%" data-tip="${f.esc(`<b>${f.num(past)}</b> il y a 6 mois`)}"></b>` : ""}
      </div>
      <div class="pf-axis-val">${axisValue(a, hist)}</div>
      ${d != null ? `<div class="pf-delta ${dir}"><span class="arr">${arrow}</span> ${f.signed(d)} pts en 6 mois</div>` : `<div class="pf-delta muted">pas de recul suffisant</div>`}
      <div class="pf-spark" id="pf-spark-${a.key}"></div>
      <p class="pf-desc">${f.esc(a.desc)}</p>
    </div>`;
}

function drawRadar(mx) {
  const axes = mx.axes;
  chart("#pf-radar", {
    animation: false,
    tooltip: {
      trigger: "item",
      formatter: (p) => ttTitle(p.name) + axes.map((a, i) => `<div class="tt-row"><span class="tt-val">${f.isNum(p.value[i]) ? f.num(p.value[i]) : "–"}</span><span>${f.esc(a.label)}</span></div>`).join(""),
    },
    radar: {
      center: ["50%", "53%"], radius: "68%", startAngle: 90, splitNumber: 4, shape: "polygon",
      indicator: axes.map((a) => ({ name: `${a.label}\n${f.isNum(a.score) ? f.num(a.score) : "–"}`, max: 100, min: 0 })),
      axisName: { color: T.text2, fontSize: 12, lineHeight: 16 },
      splitLine: { lineStyle: { color: T.grid } },
      splitArea: { areaStyle: { color: ["rgba(255,255,255,0.012)", "rgba(255,255,255,0.03)"] } },
      axisLine: { lineStyle: { color: T.grid } },
    },
    series: [{
      type: "radar", symbol: "circle", symbolSize: 7,
      data: [
        { name: "Il y a 6 mois", value: axes.map((a) => a.score_6m ?? 0), lineStyle: { color: T.text3, width: 1.5 }, itemStyle: { color: T.text3 }, areaStyle: { opacity: 0 } },
        { name: "Aujourd'hui", value: axes.map((a) => a.score ?? 0), lineStyle: { color: T.seq[6], width: 2 }, itemStyle: { color: T.seq[6], borderColor: T.surface, borderWidth: 2 }, areaStyle: { color: T.seq[5], opacity: 0.22 } },
      ],
    }],
  });
}

function drawSparks(mx) {
  const hist = mx?.history || [];
  for (const a of mx?.axes || []) {
    const k = AXIS_HIST[a.key];
    const pts = hist.filter((h) => f.isNum(h[k])).map((h) => [h.date, a.key === "recuperation" ? Math.exp(h[k]) : h[k]]);
    if (pts.length < 3) continue;
    const vals = pts.map((p) => p[1]);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12 || 0.1;
    chart(`#pf-spark-${a.key}`, {
      animation: false,
      grid: { left: 2, right: 2, top: 4, bottom: 2 },
      xAxis: { type: "time", show: false },
      yAxis: { type: "value", show: false, min: lo - pad, max: hi + pad, inverse: a.key === "resilience" },
      tooltip: {
        trigger: "axis", axisPointer: { type: "line" },
        formatter: (ps) => ttTitle(f.dateShort(ps[0].value[0])) + ttRow(T.seq[6], fmtRaw(a.key, ps[0].value[1]), f.esc(a.label.toLowerCase())),
      },
      series: [{ type: "line", data: pts, showSymbol: false, lineStyle: { width: 1.5, color: T.seq[6] }, areaStyle: { color: T.seq[6], opacity: 0.08 } }],
    });
  }
}

function fmtRaw(k, v) {
  if (!f.isNum(v)) return "–";
  if (k === "vitesse" || k === "endurance") return `${kmhPace(v)}/km`;
  if (k === "resilience") return `${f.signed(v, 1)} bpm/h`;
  if (k === "physiologie") return `VO2max ${f.num(v, 1)}`;
  if (k === "economie") return f.num(v, 2);
  if (k === "recuperation") return `HRV ${f.num(v)} ms`;
  return f.num(v, 1);
}

// ---------------------------------------------------------------- predictions
function legendModels(withEnsemble = false) {
  return MODEL_ORDER.map((m) => `<span>${key(m)}${f.esc(MODEL_LABEL[m])}</span>`).join("")
    + (withEnsemble ? `<span><i class="pf-key diamond" style="background:${MC.ensemble}"></i>Ensemble</span>` : "");
}
const MODEL_LABEL = { workout: "Séances clés", vdot: "VDOT (Daniels)", riegel: "Riegel personnel", cs: "Vitesse critique", engine: "Moteur cardiaque" };

function goalFor(pr, dist) {
  return (pr.goals || []).find((g) => g.distance && Math.abs(g.distance / dist - 1) < 0.02 && g.target_time);
}

function predictionsCard(pr) {
  if (!pr?.distances) return card({ title: "Prédictions", body: empty("Pas encore de prédiction") });
  const rows = DIST_ORDER.filter((n) => pr.distances[n]).map((n) => predRow(n, pr.distances[n], goalFor(pr, pr.distances[n].distance))).join("");
  return card({
    title: "Prédictions par distance",
    sub: "Barre blanche = ensemble et sa marge d'erreur (± erreur moyenne du backtest) · taille des points = poids du modèle pour cette distance",
    body: `<div class="legend pf-plegend">${legendModels()}<span><i class="pf-key" style="background:rgba(238,240,244,.35)"></i>Ensemble ± marge</span><span><i class="pf-key" style="background:${T.warning}"></i>Objectif</span></div><div class="pf-preds">${rows}</div>`,
  });
}

function predRow(name, d, goal) {
  const vals = MODEL_ORDER.map((m) => d.preds[m]).filter(f.isNum);
  const pts = [...vals, ...(d.range || []), d.ensemble, goal?.target_time].filter(f.isNum);
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = (hi - lo) * 0.06 || lo * 0.02;
  lo -= pad; hi += pad;
  const x = (t) => ((t - lo) / (hi - lo)) * 100;
  const ticks = niceTimeTicks(lo, hi);
  const gap = goal && d.ensemble ? d.ensemble - goal.target_time : null;
  const dots = MODEL_ORDER.filter((m) => f.isNum(d.preds[m])).map((m) => {
    const w = d.weights?.[m] || 0;
    const size = 8 + Math.round(16 * Math.sqrt(w));
    return `<span class="pf-dot" style="left:${x(d.preds[m])}%;width:${size}px;height:${size}px;background:${MC[m]};opacity:${0.55 + 0.45 * Math.min(1, w * 2)}"
      data-tip="${f.esc(`<b>${hms(d.preds[m])}</b> ${MODEL_LABEL[m]}<br>poids ${f.num(w * 100)} %`)}"></span>`;
  }).join("");
  const range = d.range ? `<span class="pf-band" style="left:${x(d.range[0])}%;width:${x(d.range[1]) - x(d.range[0])}%"></span>` : "";
  const ens = f.isNum(d.ensemble) ? `<span class="pf-ens" style="left:${x(d.ensemble)}%" data-tip="${f.esc(`<b>${hms(d.ensemble)}</b> ensemble<br>${hms(d.range?.[0])} – ${hms(d.range?.[1])}`)}"></span>` : "";
  const tgt = goal ? `<span class="pf-target" style="left:${x(goal.target_time)}%"><em>objectif ${hms(goal.target_time)}</em></span>` : "";
  const list = MODEL_ORDER.filter((m) => f.isNum(d.preds[m])).map((m) => `
    <div class="pf-mrow">${key(m)}<span class="pf-mname">${MODEL_LABEL[m]}</span><span class="num">${hms(d.preds[m])}</span>
      <span class="pf-wbar"><i style="width:${(d.weights?.[m] || 0) * 100}%;background:${MC[m]}"></i></span><span class="num muted pf-wpct">${f.num((d.weights?.[m] || 0) * 100)} %</span></div>`).join("");
  return `
    <div class="pf-prow">
      <div class="pf-pleft">
        <div class="eyebrow">${DIST_SHORT[name]}</div>
        <div class="pf-ptime">${hms(d.ensemble)}</div>
        <div class="muted small">${d.range ? `${hms(d.range[0])} – ${hms(d.range[1])}` : ""} · ${f.paceSec(d.ensemble / (d.distance / 1000))}/km</div>
        ${goal ? `<div class="pf-goal">${f.esc(goal.name)} · ${f.relDays(goal.days_to)}<br>objectif <b>${hms(goal.target_time)}</b> · ${gap > 0 ? `encore <b>${hms(gap)}</b>` : `marge <b>${hms(-gap)}</b>`}</div>` : ""}
      </div>
      <div class="pf-track">
        <div class="pf-rail"></div>${range}${tgt}${ens}${dots}
        <div class="pf-ticks">${ticks.map((t) => `<span style="left:${x(t)}%">${hms(t)}</span>`).join("")}</div>
        <div class="pf-faster"><span>← plus rapide</span><span>plus lent →</span></div>
      </div>
      <div class="pf-mlist">${list}</div>
    </div>`;
}

function niceTimeTicks(lo, hi) {
  const span = hi - lo;
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const step = steps.find((s) => span / s <= 5) || 3600;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}

function leaderboardCard(pr) {
  if (!pr?.leaderboard) return card({ title: "Classement des modèles", body: empty("Pas de course pour évaluer") });
  const lb = [...pr.leaderboard].sort((a, b) => (a.mape ?? 99) - (b.mape ?? 99));
  const maxM = Math.max(...lb.map((r) => r.mape || 0), 1);
  const wr = pr.workout_ratio || {};
  const fracAt = (sec) => {
    const r = (pr.race_hr || []).reduce((best, x) => (!best || Math.abs(x.duration - sec) < Math.abs(best.duration - sec) ? x : best), null);
    return r ? r.frac : null;
  };
  const desc = {
    workout: `Ta meilleure séance de fractions 800–3 200 m des 6 dernières semaines${pr.best_session ? ` (${f.paceSec(1000 / pr.best_session)}/km)` : ""}, × ton ratio vitesse de course / vitesse de fraction (α ${fmt3(wr.alpha, 2)}, β ${fmt3(wr.beta, 3)}, appris sur ${f.num(wr.n)} courses).`,
    vdot: "VDOT de Daniels de tes meilleurs efforts ≥ 1 mile des 90 derniers jours — pessimiste quand tu ne fais pas d'effort maximal long.",
    riegel: `Meilleur effort de type course des 180 derniers jours, projeté avec ton exposant personnel ${fmt3(pr.exponent)} (1,060 = standard).`,
    cs: pr.cs ? `Vitesse critique ${f.paceSec(1000 / pr.cs.cs)}/km et D′ ${f.num(pr.cs.d_prime)} m, ajustées sur ta courbe vitesse-durée 2–7 min (90 j).` : "Vitesse critique ajustée sur ta courbe vitesse-durée 2–7 min (90 j).",
    engine: `Ta vitesse, d'après le moteur allure ↔ FC, à la FC que tu tiens en course (${f.num((fracAt(2400) || 0) * 100)} % de FC max sur 40 min), × calibration ${fmt3(pr.engine_calibration, 2)} apprise sur tes courses.`,
  };
  const rows = lb.map((r) => {
    const m = r.model, isEns = m === "ensemble";
    return `<tr class="${isEns ? "pf-ens-row" : ""}">
      <td>${isEns ? `<i class="pf-key diamond" style="background:${MC.ensemble}"></i>` : key(m)}${f.esc(isEns ? "Ensemble (pondéré)" : MODEL_LABEL[m] || r.label)}</td>
      <td class="r"><span class="pf-mape"><i style="width:${((r.mape || 0) / maxM) * 100}%"></i></span>${f.isNum(r.mape) ? `${f.num(r.mape, 1)} %` : "–"}</td>
      <td class="r">${pctS(r.bias)}</td><td class="r">${f.num(r.n)}</td></tr>`;
  }).join("");
  return card({
    title: "Classement des modèles",
    sub: "Erreur absolue moyenne (MAPE) et biais (+ = trop pessimiste) sur tes courses",
    body: `
      <div class="table-wrap pf-lb"><table class="data"><thead><tr><th>Modèle</th><th class="r">MAPE</th><th class="r">Biais</th><th class="r">n</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="pf-method">Chaque modèle rejoue la veille de chaque course avec les seules données antérieures. L'ensemble est une moyenne pondérée par l'erreur mesurée sur des courses de distance proche, évaluée en <i>leave-one-out</i> (la course notée n'entre pas dans ses propres poids).</p>
      <div class="pf-mdesc">${MODEL_ORDER.map((m) => `<div>${key(m)}<b>${MODEL_LABEL[m]}</b> — ${desc[m]}</div>`).join("")}</div>`,
  });
}

function drawBacktest(pr) {
  const bt = pr.backtest || [];
  if (!bt.length) return;
  const names = bt.map((r) => `${f.dateShort(r.date)} ${r.date.slice(2, 4)} · ${raceShort(r)}`);
  const series = MODEL_ORDER.map((m) => ({
    name: MODEL_LABEL[m], type: "scatter", symbolSize: 9, z: 3,
    itemStyle: { color: MC[m], borderColor: T.surface, borderWidth: 2 },
    data: bt.map((r, i) => (f.isNum(r.errors[m]) ? { value: [clipErr(r.errors[m]), i], raw: r.errors[m], r, m } : null)).filter(Boolean),
  }));
  series.push({
    name: "Ensemble", type: "scatter", symbol: "diamond", symbolSize: 15, z: 5,
    itemStyle: { color: MC.ensemble, borderColor: T.surface, borderWidth: 2 },
    data: bt.map((r, i) => (f.isNum(r.errors.ensemble) ? { value: [clipErr(r.errors.ensemble), i], raw: r.errors.ensemble, r, m: "ensemble" } : null)).filter(Boolean),
    markLine: { silent: true, symbol: "none", lineStyle: { color: T.text3, width: 1, type: "solid" }, label: { show: false }, data: [{ xAxis: 0 }] },
    markArea: { silent: true, itemStyle: { color: "rgba(255,255,255,0.035)" }, data: [[{ xAxis: -3 }, { xAxis: 3 }]] },
  });
  chart("#pf-backtest", {
    animation: false,
    grid: { left: 190, right: 34, top: 10, bottom: 34 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const { r, m, raw } = p.data;
        const pred = r.preds[m];
        return ttTitle(`${f.dateLong(r.date)} · ${f.esc(r.name)}`)
          + ttRow(m === "ensemble" ? MC.ensemble : MC[m], pctS(raw), m === "ensemble" ? "ensemble" : MODEL_LABEL[m])
          + `<div class="tt-row"><span class="tt-val">${hms(pred)}</span><span>prédit</span></div>`
          + `<div class="tt-row"><span class="tt-val">${hms(r.actual)}</span><span>réel · ${f.num(r.distance / 1000, 2)} km</span></div>`;
      },
    },
    xAxis: { type: "value", min: -20, max: 20, interval: 5, axisLabel: { formatter: (v) => (v <= -20 ? "≤ −20 %" : v >= 20 ? "≥ +20 %" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)} %`) }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: { type: "category", data: names, inverse: true, axisLabel: { color: T.text2, fontSize: 11 }, splitLine: { show: true, lineStyle: { color: T.grid } } },
    series,
  });
}
const clipErr = (e) => Math.max(-20, Math.min(20, e));
function raceShort(r) {
  const km = r.distance / 1000;
  const label = Math.abs(km - 42.195) < 1 ? "Marathon" : Math.abs(km - 21.1) < 0.5 ? "Semi" : `${f.num(km, km < 10 ? 2 : 1)} km`;
  return `${label} ${hms(r.actual)}`;
}

// ---------------------------------------------------------------- speed-duration
function envSeries(points) {
  return (points || []).filter((p) => f.isNum(p.speed)).map((p) => [lg(p.duration), paceOf(p.speed)]);
}

function sdNumbersCard(cv, pr) {
  if (!cv) return card({ title: "Repères", body: empty("Pas de courbe") });
  const at = (pts, d) => (pts || []).find((p) => p.duration === d)?.speed;
  const all = cv.envelopes["Tout"], d90 = cv.envelopes["90 j"];
  const src = Object.fromEntries((cv.sources || []).map((x) => [x.duration, x]));
  const rows = [[60, "1 min"], [300, "5 min"], [1200, "20 min"], [3600, "1 h"]].map(([d, l]) => {
    const a = at(all, d), b = at(d90, d);
    const diff = f.isNum(a) && f.isNum(b) ? paceOf(b) - paceOf(a) : null;
    const s0 = src[d];
    return `<tr><td>${l}</td><td class="r"><b>${f.isNum(a) ? f.paceSec(paceOf(a)) : "–"}</b>${s0 ? `<div class="muted small">${f.dateShort(s0.date)} ${s0.date.slice(0, 4)}</div>` : ""}</td>
      <td class="r">${f.isNum(b) ? f.paceSec(paceOf(b)) : "–"}</td>
      <td class="r muted">${diff == null ? "" : Math.abs(diff) < 1 ? "=" : `${diff > 0 ? "+" : "−"}${Math.round(Math.abs(diff))} s`}</td></tr>`;
  }).join("");
  const cs = cv.cs;
  return card({
    title: "Repères", sub: "Meilleure allure tenue (min/km) · ton record vs tes 90 derniers jours",
    body: `
      <div class="table-wrap"><table class="data pf-sdtable"><thead><tr><th>Durée</th><th class="r">Record</th><th class="r">90 j</th><th class="r">écart</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${cs ? `<div class="pf-cs">
        <div><div class="muted small">Vitesse critique (90 j)</div><div class="pf-big">${f.paceSec(1000 / cs.cs)}<small>/km</small></div></div>
        <div><div class="muted small">Réserve D′</div><div class="pf-big">${f.num(cs.d_prime)}<small> m</small></div></div>
      </div>
      <p class="pf-note">La vitesse critique ne vaut que si la courbe contient de vrais efforts maximaux de 3 à 20 min : sans course récente, elle sous-estime ton niveau (c'est le modèle le moins pondéré du backtest).</p>` : ""}`,
  });
}

function drawSpeedDuration(cv) {
  const wins = [["90 j", T.seq[2], 1.5], ["1 an", T.seq[5], 2], ["Tout", T.seq[8], 2.5]];
  const series = wins.map(([k, col, w]) => ({
    name: k === "90 j" ? "90 derniers jours" : k === "1 an" ? "12 derniers mois" : "Tout l'historique",
    type: "line", data: envSeries(cv.envelopes[k]), color: col, smooth: 0.25,
    lineStyle: { width: w, color: col }, symbol: "circle", symbolSize: 5, showSymbol: false,
  }));
  if (cv.cs) {
    const pts = [];
    for (let t = 120; t <= 1200; t *= 1.15) pts.push([lg(t), paceOf(cv.cs.cs + cv.cs.d_prime / t)]);
    series.push({ name: "Modèle vitesse critique", type: "line", data: pts, color: T.text3, showSymbol: false, lineStyle: { width: 1.5, type: [6, 4], color: T.text3 } });
  }
  const races = (cv.races || []).filter((r) => r.elapsed_time > 0);
  series.push({
    name: "Courses", type: "scatter", symbolSize: 8, z: 5, color: T.text3,
    itemStyle: { color: "transparent", borderColor: T.text2, borderWidth: 1.5 },
    data: races.map((r) => ({ value: [lg(r.elapsed_time), r.elapsed_time / (r.distance / 1000)], r })),
  });
  // all-time records per distance, labelled selectively (neighbours like 800 m / 1 km stay tooltip-only)
  const LABELS = { "400m": "400 m", "1 mile": "1 mile", "5k": "5 km", "10k": "10 km", "Half-Marathon": "Semi", "Marathon": "Marathon" };
  const NICE = { ...LABELS, "1/2 mile": "800 m", "1k": "1 km", "2 mile": "2 miles", "15k": "15 km", "10 mile": "10 miles", "20k": "20 km", "30k": "30 km" };
  const recs = (cv.records || []).filter((r) => r.time >= 15 && r.time <= 7200);
  series.push({
    name: "Records", type: "scatter", symbolSize: 11, z: 6, color: T.accent,
    itemStyle: { color: T.accent, borderColor: T.surface, borderWidth: 2 },
    label: { show: true, position: "top", distance: 6, color: T.text1, fontSize: 11, fontWeight: 600,
             formatter: (p) => (LABELS[p.data.rec.name] ? `${LABELS[p.data.rec.name]} ${hms(p.data.rec.time)}` : "") },
    labelLayout: { hideOverlap: true },
    data: recs.map((r) => ({ value: [lg(r.time), r.time / (r.distance / 1000)], rec: { ...r, label: NICE[r.name] || r.name } })),
  });
  document.getElementById("pf-sd-legend").innerHTML = wins.map(([k, col]) => `<span><i class="line" style="background:${col}"></i>${k === "90 j" ? "90 derniers jours" : k === "1 an" ? "12 derniers mois" : "Tout l'historique"}</span>`).join("")
    + (cv.cs ? `<span><i class="line pf-dashkey"></i>Modèle vitesse critique (2–7 min)</span>` : "")
    + `<span><i class="pf-key dot" style="background:${T.accent}"></i>Records par distance</span>`
    + `<span><i class="pf-key dot pf-ring"></i>Courses officielles</span>`;
  const allPaces = series.flatMap((s) => s.data.filter((d) => (Array.isArray(d) ? d[0] : d.value[0]) <= lg(3600))
    .map((d) => (Array.isArray(d) ? d[1] : d.value[1]))).filter(f.isNum);
  const sdChart = chart("#pf-sd", {
    animation: false,
    grid: { left: 54, right: 20, top: 14, bottom: 30 },
    tooltip: {
      trigger: "axis", axisPointer: { type: "line" },
      formatter: (ps) => {
        const rc = ps.find((p) => p.seriesName === "Records");
        if (rc && rc.data?.rec) {
          const r = rc.data.rec;
          return ttTitle(`Record ${f.esc(r.label)} · ${f.dateLong(r.date)}`) + `<div class="tt-row"><span class="tt-val">${hms(r.time)}</span><span>${f.paceSec(r.time / (r.distance / 1000))}/km</span></div>`
            + `<div class="tt-row"><span>${f.esc(r.activity_name || "")}</span></div><div class="tt-row muted">clic pour ouvrir la séance</div>`;
        }
        const sc = ps.find((p) => p.seriesName === "Courses");
        if (sc && sc.data?.r) {
          const r = sc.data.r;
          return ttTitle(`${f.dateLong(r.date)}`) + `<div class="tt-row"><span class="tt-val">${hms(r.elapsed_time)}</span><span>${f.esc(r.name)} · ${f.num(r.distance / 1000, 2)} km</span></div>`
            + `<div class="tt-row"><span class="tt-val">${f.paceSec(r.elapsed_time / (r.distance / 1000))}/km</span><span>allure moyenne</span></div>`;
        }
        const dur = Math.exp(ps[0].axisValue);
        const near = (cv.sources || []).reduce((b, x) => (!b || Math.abs(Math.log(x.duration / dur)) < Math.abs(Math.log(b.duration / dur)) ? x : b), null);
        return ttTitle(durFromLog(ps[0].axisValue)) + ps.filter((p) => !["Courses", "Records"].includes(p.seriesName) && f.isNum(p.value?.[1]))
          .map((p) => ttRow(p.color, `${f.paceSec(p.value[1])}/km`, p.seriesName.toLowerCase())).join("")
          + (near ? `<div class="tt-row muted">record : ${f.esc(near.name || "")} · ${f.dateShort(near.date)} ${near.date.slice(0, 4)}</div>` : "");
      },
    },
    xAxis: {
      type: "value", min: lg(15), max: lg(7200),
      axisLabel: { customValues: LOG_TICKS.map(lg), formatter: (v) => durFromLog(v), color: T.text3 },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: paceAxis(allPaces),
    series: series.map((s) => ({ ...s, clip: true })),
  });
  sdChart?.on("click", (p) => {
    const id = p.data?.rec?.activity_id || p.data?.r?.id;
    if (id) location.hash = `#/activity/${id}`;
  });
}

// ---------------------------------------------------------------- durability
function drawDurability(cv) {
  const fresh = cv.envelopes["1 an"] || [];
  const f60 = cv.fatigued["3600"] || [], f90 = cv.fatigued["5400"] || [];
  const defs = [["Frais (depuis le départ)", fresh, T.seq[8], 2.5], ["Après 60 min", f60, T.seq[5], 2], ["Après 90 min", f90, T.seq[2], 2]];
  document.getElementById("pf-dur-legend").innerHTML = defs.map(([n, , c]) => `<span><i class="line" style="background:${c}"></i>${n}</span>`).join("");
  const maxDur = 3600;
  const series = defs.map(([n, pts, c, w]) => ({
    name: n, type: "line", smooth: 0.25, showSymbol: false, color: c, lineStyle: { width: w, color: c },
    data: envSeries(pts.filter((p) => p.duration <= maxDur)),
  }));
  const allPaces = series.flatMap((s) => s.data.map((d) => d[1])).filter(f.isNum);
  if (!allPaces.length) return;
  chart("#pf-dur", {
    animation: false,
    grid: { left: 54, right: 16, top: 12, bottom: 30 },
    tooltip: {
      trigger: "axis",
      formatter: (ps) => ttTitle(durFromLog(ps[0].axisValue)) + ps.filter((p) => f.isNum(p.value?.[1])).map((p) => ttRow(p.color, `${f.paceSec(p.value[1])}/km`, p.seriesName.toLowerCase())).join(""),
    },
    xAxis: { type: "value", min: lg(15), max: lg(maxDur), axisLabel: { customValues: [30, 60, 300, 1200, 3600].map(lg), formatter: (v) => durFromLog(v), color: T.text3 }, axisTick: { show: false }, splitLine: { show: false } },
    yAxis: paceAxis(allPaces),
    series,
  });
  const di = (arr, d) => arr.find((p) => p.duration === d)?.di;
  const tiles = [[300, "5 min"], [1200, "20 min"]].map(([d, l]) => {
    const a = di(f60, d), b = di(f90, d);
    return `<div class="pf-ditile"><div class="muted small">Ce que tu gardes sur ${l}</div>
      <div class="pf-dirow"><span class="pf-big">${f.isNum(a) ? f.num(a * 100) : "–"}<small> %</small></span><span class="muted">après 60 min</span></div>
      <div class="pf-dirow"><span class="pf-big">${f.isNum(b) ? f.num(b * 100) : "–"}<small> %</small></span><span class="muted">après 90 min</span></div></div>`;
  }).join("");
  document.getElementById("pf-di").innerHTML = tiles + `<p class="pf-note">Indice de durabilité = meilleure vitesse tenue après X minutes ÷ meilleure vitesse fraîche, sur 12 mois. Il dépend de tes séances : un fartlek ou une fin de sortie longue rapide le fait monter.</p>`;
}

function rollingMedian(vals, k) {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - k + 1), i + 1).filter(f.isNum).sort((a, b) => a - b);
    if (w.length < Math.min(4, k)) return null;
    const m = Math.floor(w.length / 2);
    return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
  });
}

function drawDrift(cv, which) {
  const runs = (cv.long_runs || []).filter((r) => f.isNum(which === "hr" ? r.drift_hr : r.drift_gct));
  const node = document.getElementById("pf-drift");
  if (!runs.length) { node.innerHTML = empty("Pas de sortie longue analysable"); return; }
  const val = (r) => (which === "hr" ? r.drift_hr : r.drift_gct);
  const unit = which === "hr" ? "bpm/h" : "ms/h";
  const vals = runs.map(val);
  const sorted = [...vals].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.03)], hi = sorted[Math.ceil(sorted.length * 0.97) - 1];
  const pad = (hi - lo) * 0.12 || 1;
  const med = rollingMedian(vals, 9);
  const existing = echarts.getInstanceByDom(node);
  const opt = {
    animation: false,
    grid: { left: 46, right: 14, top: 14, bottom: 28 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        if (p.seriesType === "line") return ttTitle(f.dateShort(p.value[0])) + ttRow(T.text2, `${f.signed(p.value[1], 1)} ${unit}`, "médiane glissante");
        const r = p.data.r;
        return ttTitle(`${f.dateLong(r.date)} · ${f.esc(r.name || "")}`) + ttRow(T.seq[6], `${f.signed(val(r), 1)} ${unit}`, which === "hr" ? "dérive cardiaque" : "dérive du contact au sol", true)
          + `<div class="tt-row"><span class="tt-val">${f.hm(r.moving_time)}</span><span>${f.km(r.distance)} km · FC ${f.num(r.avg_hr)}</span></div>`;
      },
    },
    xAxis: { type: "time", axisLabel: { formatter: (v) => f.monthShort(new Date(v)) + " " + String(new Date(v).getFullYear()).slice(2), hideOverlap: true } },
    yAxis: { type: "value", min: Math.floor((lo - pad) / 5) * 5, max: Math.ceil((hi + pad) / 5) * 5, interval: 5, axisLabel: { formatter: (v) => `${v > 0 ? "+" : ""}${v}` }, name: unit, nameTextStyle: { color: T.text3, fontSize: 11, padding: [0, 0, 0, 20] } },
    series: [
      {
        type: "scatter", z: 3,
        symbolSize: (v, p) => 6 + Math.min(8, (p.data.r.moving_time || 0) / 1200),
        itemStyle: { color: T.seq[6], opacity: 0.75, borderColor: T.surface, borderWidth: 1 },
        data: runs.map((r) => ({ value: [r.date, clipTo(val(r), lo - pad, hi + pad)], r })),
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.text3, width: 1, type: "solid" }, data: [{ yAxis: 0 }] },
      },
      { type: "line", data: runs.map((r, i) => [r.date, med[i]]), showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: T.text2 }, z: 4 },
    ],
  };
  const c = existing ? (existing.setOption(opt, true), existing) : chart(node, opt);
  c.off("click");
  c.on("click", (p) => { if (p.data?.r) location.hash = `#/activity/${p.data.r.id}`; });
  const recent = runs.filter((r) => r.date >= f.isoDate(f.addDays(f.today(), -90)));
  const recentMed = rollingMedian(recent.map(val), recent.length).pop();
  document.getElementById("pf-drift-note").innerHTML = recent.length
    ? `Médiane des 90 derniers jours : <b>${f.signed(recentMed, 1)} ${unit}</b> sur ${recent.length} sorties — ${which === "hr"
      ? "au-delà de +4 bpm/h, ta FC grimpe nettement à allure constante en fin de sortie (hydratation, chaleur, glycogène ou manque de volume long)."
      : "un temps de contact qui s'allonge à allure égale signale une fatigue musculaire (foulée qui s'affaisse)."}`
    : "";
}
const clipTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- engine
function drawEngineFamily(en) {
  const months = (en.monthly || []).slice(-12);
  if (!months.length) { document.getElementById("pf-engine").innerHTML = empty("Pas assez de fenêtres stables"); return; }
  const ramp = T.seq.slice(1, 10);
  const colorOf = (i) => ramp[Math.round((i / Math.max(1, months.length - 1)) * (ramp.length - 1))];
  const series = months.map((m, i) => {
    const last = i === months.length - 1;
    const p1 = [m.hr_lo, paceOf(m.a + m.b * m.hr_lo)], p2 = [m.hr_hi, paceOf(m.a + m.b * m.hr_hi)];
    return {
      name: m.month, type: "line", data: [p1, p2], showSymbol: last, symbolSize: 7, z: last ? 6 : 3,
      lineStyle: { width: last ? 3.5 : 1.6, color: colorOf(i), opacity: last ? 1 : 0.85 }, itemStyle: { color: colorOf(i) },
      endLabel: last ? { show: true, formatter: () => monthName(m.month), color: T.text1, fontSize: 11 } : undefined,
      emphasis: { focus: "series", lineStyle: { width: 3.5 } }, m,
    };
  });
  const samples = (en.samples || []).filter((s) => f.isNum(s[0]) && f.isNum(s[1]));
  series.unshift({ name: "Fenêtres stables (42 j)", type: "scatter", symbolSize: 4, z: 1, silent: true, itemStyle: { color: T.text3, opacity: 0.35 }, data: samples.map((s) => [s[0], paceOf(s[1])]) });
  const paces = series.flatMap((s) => s.data.map((d) => d[1])).filter(f.isNum).sort((a, b) => a - b);
  const pLo = paces[Math.floor(paces.length * 0.02)], pHi = paces[Math.ceil(paces.length * 0.98) - 1];
  document.getElementById("pf-eng-legend").innerHTML =
    `<span class="pf-ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span class="muted">ancien → récent</span>`
    + `<span><i class="line" style="background:${ramp[ramp.length - 1]};height:3px"></i>${monthName(months[months.length - 1].month)} (mois en cours)</span>`
    + `<span><i class="pf-key dot" style="background:${T.text3}"></i>Fenêtres stables des 42 derniers jours</span>`;
  chart("#pf-engine", {
    animation: false,
    grid: { left: 54, right: 70, top: 14, bottom: 36 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const m = series[p.seriesIndex]?.m;
        if (!m) return "";
        return ttTitle(monthName(m.month)) + [140, 150, 160, 170].filter((h) => h >= m.hr_lo - 3 && h <= m.hr_hi + 3)
          .map((h) => ttRow(p.color, `${f.paceSec(paceOf(m.a + m.b * h))}/km`, `à ${h} bpm`)).join("") + `<div class="tt-row"><span>${m.n} fenêtres</span></div>`;
      },
    },
    xAxis: { type: "value", min: 115, max: 190, interval: 10, name: "FC (bpm)", nameLocation: "middle", nameGap: 24, nameTextStyle: { color: T.text3, fontSize: 11 }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: paceAxis([pLo, pHi]),
    series,
  });
}

function monthName(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${f.monthShort(new Date(y, m - 1, 1))} ${y}`;
}

function drawEngineSeries(en) {
  const s = (en.series || []).filter((r) => f.isNum(r.v150) || f.isNum(r.v165));
  const tiles = document.getElementById("pf-eng-tiles");
  if (!s.length) { tiles.innerHTML = ""; document.getElementById("pf-engser").innerHTML = empty("Pas assez de données"); return; }
  const last = s[s.length - 1];
  const ref = s.filter((r) => r.date <= f.isoDate(f.addDays(f.parseDate(last.date), -91))).pop();
  const tile = (k, h) => {
    const p = paceOf(last[k]);
    const d = ref && f.isNum(ref[k]) ? p - paceOf(ref[k]) : null;
    return `<div class="pf-etile"><div class="muted small">à ${h} bpm</div><div class="pf-big">${f.paceSec(p)}<small>/km</small></div>
      <div class="pf-delta ${d == null ? "" : d < -0.5 ? "up" : d > 0.5 ? "down" : "flat"}">${d == null ? "" : `<span class="arr">${d < -0.5 ? "▲" : d > 0.5 ? "▼" : "■"}</span> ${Math.abs(d) < 0.5 ? "stable" : `${d < 0 ? "−" : "+"}${Math.round(Math.abs(d))} s/km`} vs il y a 3 mois`}</div></div>`;
  };
  tiles.innerHTML = tile("v150", 150) + tile("v165", 165);
  const paces = s.flatMap((r) => [paceOf(r.v150), paceOf(r.v165)]).filter(f.isNum);
  chart("#pf-engser", {
    animation: false,
    grid: { left: 50, right: 12, top: 10, bottom: 26 },
    tooltip: { trigger: "axis", formatter: (ps) => ttTitle(`semaine du ${f.dateShort(ps[0].value[0])}`) + ps.filter((p) => f.isNum(p.value[1])).map((p) => ttRow(p.color, `${f.paceSec(p.value[1])}/km`, p.seriesName)).join("") },
    xAxis: { type: "time", axisLabel: { formatter: (v) => f.monthShort(new Date(v)) + " " + String(new Date(v).getFullYear()).slice(2), hideOverlap: true } },
    yAxis: paceAxis(paces),
    series: [
      { name: "à 150 bpm", type: "line", showSymbol: false, data: s.map((r) => [r.date, paceOf(r.v150)]), lineStyle: { width: 2, color: T.seq[8] }, itemStyle: { color: T.seq[8] } },
      { name: "à 165 bpm", type: "line", showSymbol: false, data: s.map((r) => [r.date, paceOf(r.v165)]), lineStyle: { width: 2, color: T.seq[4] }, itemStyle: { color: T.seq[4] } },
    ],
  });
}

function drawResiduals(en) {
  const r = (en.residuals || []).filter((x) => f.isNum(x.engine_resid));
  const node = document.getElementById("pf-resid");
  if (!r.length) { node.innerHTML = empty("Pas encore d'écart calculé"); return; }
  const vals = r.map((x) => x.engine_resid);
  const ma = vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - 6), i + 1);
    return w.length >= 3 ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
  const lim = Math.min(20, Math.ceil(Math.max(...vals.map(Math.abs)) / 5) * 5);
  const c = chart(node, {
    animation: false,
    grid: { left: 40, right: 12, top: 12, bottom: 26 },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        if (p.seriesType === "line") return ttTitle(f.dateShort(p.value[0])) + ttRow(T.text2, `${f.signed(p.value[1], 1)} bpm`, "moyenne 7 séances");
        const x = p.data.x;
        return ttTitle(`${f.dateLong(x.date)} · ${f.esc(x.name || "")}`) + ttRow(x.engine_resid >= 0 ? T.neg : T.pos, `${f.signed(x.engine_resid, 1)} bpm`, "vs moteur", true)
          + `<div class="tt-row"><span>${f.hm(x.moving_time)} · clique pour ouvrir</span></div>`;
      },
    },
    xAxis: { type: "time", axisLabel: { formatter: (v) => f.monthShort(new Date(v)) + " " + String(new Date(v).getFullYear()).slice(2), hideOverlap: true } },
    yAxis: { type: "value", min: -lim, max: lim, axisLabel: { formatter: (v) => `${v > 0 ? "+" : ""}${v}` }, name: "bpm", nameTextStyle: { color: T.text3, fontSize: 11 } },
    series: [
      {
        type: "bar", barMaxWidth: 6, barMinWidth: 2,
        data: r.map((x) => ({
          value: [x.date, clipTo(x.engine_resid, -lim, lim)], x,
          itemStyle: { color: x.engine_resid >= 0 ? T.neg : T.pos, borderRadius: x.engine_resid >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] },
        })),
      },
      { type: "line", data: r.map((x, i) => [x.date, ma[i]]), showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: T.text2 }, z: 4 },
    ],
  });
  c.on("click", (p) => { if (p.data?.x) location.hash = `#/activity/${p.data.x.id}`; });
}
