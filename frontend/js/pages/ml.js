import { api } from "../api.js";
import { T, ttRow, ttTitle } from "../theme.js";
import { card, chart, empty, seg, onSeg, status } from "../ui.js";
import * as f from "../fmt.js";

const TARGETS = [["hrv", "HRV"], ["sleep_score", "Sommeil"], ["resting_hr", "FC repos"]];
const FEEL_COLORS = { "En dessous": T.neg, Normal: T.mid, "Au-dessus": T.pos };
const MODEL_NAMES = { ridge: "Ridge", rf: "Random forest", gbm: "Gradient boosting", ens: "Ensemble Ridge + forest", logit: "Régression logistique" };

export async function render(view, { setActions }) {
  view.innerHTML = card({ body: empty("Entraînement des modèles…", "Premier calcul : environ 1 minute, ensuite c'est instantané (recalculé après chaque synchro).") });
  let exp, now;
  try {
    [exp, now] = await Promise.all([api.get("/api/ml/experiments"), api.get("/api/ml/now")]);
  } catch (e) {
    view.innerHTML = card({ body: empty("Pas assez de données", f.esc(e.message)) });
    return;
  }
  setActions(`<span class="chip">Test : ${f.dateShort(exp.hrv.test_from)} ${exp.hrv.test_from.slice(0, 4)} → ${f.dateShort(exp.hrv.test_to)} ${exp.hrv.test_to.slice(0, 4)}</span>`);
  view.innerHTML = `
    <div class="grid">
      <div class="span-8">${tonightCard(now.tonight, exp)}</div>
      <div class="span-4">${feelNowCard(now.next_feel, exp.feel_before)}</div>
      <div class="span-12">${scoreboardCard(exp)}</div>
      <div class="span-7">${card({ title: "Prédit vs réel sur la période de test", sub: "Jamais vue à l'entraînement · le modèle prédit l'écart à ta moyenne 7 nuits",
        actions: seg("mlt", TARGETS, "hrv"), body: `<div class="legend" id="ml-ts-legend"></div><div id="ml-ts" class="chart" style="height:300px"></div><div class="ml-foot" id="ml-ts-foot"></div>` })}</div>
      <div class="span-5">${card({ title: "Ce qui pèse dans la prédiction", sub: "Importance par permutation sur le test : erreur ajoutée quand on brouille la variable",
        body: `<div id="ml-imp" class="chart" style="height:330px"></div>` })}</div>
      <div class="span-6">${feelCard(exp)}</div>
      <div class="span-6">${card({ title: "Effets mesurés sur ta nuit", sub: "Écart à ta moyenne 7 nuits selon la journée · moyenne ± IC 95 % · descriptif, pas causal",
        actions: seg("mle", TARGETS, "hrv"), body: `<div id="ml-eff" class="chart" style="height:300px"></div><div class="ml-foot" id="ml-eff-foot"></div>` })}</div>
      <div class="span-12">${alertCard(exp.hrv_low)}</div>
      <div class="span-12">${methodCard()}</div>
    </div>`;

  const drawTarget = (t) => { drawTestSeries(exp[t]); drawImportance(exp[t]); };
  drawTarget("hrv");
  onSeg(view, "mlt", drawTarget);
  drawFeelCharts(exp);
  drawEffects(exp.effects, "hrv");
  onSeg(view, "mle", (t) => drawEffects(exp.effects, t));
}

// ---------------------------------------------------------------- helpers
const fmtVal = (t, v) => (t === "resting_hr" ? f.num(v) : f.num(v));
const unitOf = (t) => ({ hrv: "ms", sleep_score: "", resting_hr: "bpm" })[t];
function verdictReg(e) {
  if (e.skill >= 0.03) return status("good", `Bat ta moyenne 7 j de ${f.num(e.skill * 100)} %`);
  if (e.skill > -0.01) return status("neutral", "Pas mieux que ta moyenne 7 j");
  return status("warning", "Moins bien que ta moyenne 7 j");
}
function verdictClf(e) {
  return e.skill >= 0.03 ? status("good", `+${f.num(e.skill * 100)} pts vs meilleure référence`) : status("neutral", "Pas mieux que la référence");
}

// ---------------------------------------------------------------- tonight
function tonightCard(tn, exp) {
  if (!tn || !tn.hrv) return card({ title: "Cette nuit", body: empty("Pas encore de données aujourd'hui") });
  const tile = (t, label) => {
    const p = tn[t];
    const diff = p.baseline != null ? p.pred - p.baseline : null;
    const drivers = (p.drivers || []).filter((d) => Math.abs(d.effect) >= (t === "resting_hr" ? 0.1 : 0.3)).slice(0, 3);
    return `<div class="ml-tile">
      <div class="eyebrow">${label}</div>
      <div class="ml-pred">${fmtVal(t, p.pred)}<small>${unitOf(t)}</small></div>
      <div class="muted small">fourchette ${fmtVal(t, p.range[0])}–${fmtVal(t, p.range[1])} · ta moyenne 7 nuits ${p.baseline != null ? fmtVal(t, p.baseline) : "–"}</div>
      ${diff != null ? `<div class="ml-diff">${f.signed(diff, 1)} ${unitOf(t)} vs ta moyenne</div>` : ""}
      <div class="ml-drivers">${drivers.map((d) => `<div class="ml-drv"><span>${f.esc(d.label)}</span><b class="num">${f.signed(d.effect, 1)}</b></div>`).join("") || `<div class="muted small">Journée sans facteur marquant</div>`}</div>
      <div class="ml-verdict">${verdictReg(exp[t])}</div>
    </div>`;
  };
  return card({
    title: "Cette nuit", sub: `Prévision pour la nuit qui vient (réveil ${f.dateLong(tn.for_night)}) · avec les données d'aujourd'hui jusqu'à maintenant`,
    body: `<div class="ml-tiles">${tile("hrv", "HRV attendue")}${tile("sleep_score", "Score de sommeil")}${tile("resting_hr", "FC de repos demain")}</div>
      <p class="ml-note">Les « facteurs » montrent de combien chaque variable déplace la prévision par rapport à une journée typique de tes 4 dernières semaines.</p>`,
  });
}

function feelNowCard(nf, e) {
  if (!nf || !nf.proba) return card({ title: "Ta prochaine sortie", body: empty("Pas assez de séances notées") });
  const order = ["En dessous", "Normal", "Au-dessus"];
  const bar = order.map((k) => `<span style="width:${(nf.proba[k] || 0) * 100}%;background:${FEEL_COLORS[k]}" data-tip="${f.esc(`<b>${f.num((nf.proba[k] || 0) * 100)} %</b> ${k}`)}"></span>`).join("");
  const best = order.reduce((a, b) => ((nf.proba[a] || 0) >= (nf.proba[b] || 0) ? a : b));
  return card({
    title: "Ta prochaine sortie", sub: `Ressenti probable si tu pars maintenant (course ~${f.num(nf.assumed.duration_min)} min)`,
    body: `<div class="ml-pred sm">${best}</div>
      <div class="ml-probbar">${bar}</div>
      <div class="legend">${order.map((k) => `<span><i style="background:${FEEL_COLORS[k]}"></i>${k} ${f.num((nf.proba[k] || 0) * 100)} %</span>`).join("")}</div>
      <p class="ml-note">« En dessous » = très faible / faible, « Au-dessus » = fort / très fort sur ta montre. Modèle : ${MODEL_NAMES[nf.model] || nf.model}.</p>
      <div class="ml-verdict">${verdictClf(e)}</div>`,
  });
}

// ---------------------------------------------------------------- scoreboard
function scoreboardCard(exp) {
  const row = (name, metric, base, model, verdict, n, chosen) => `<tr><td><b>${name}</b><div class="muted small">${n}</div></td><td>${metric}</td>
    <td class="r num">${base}</td><td class="r num"><b>${model}</b><div class="muted small">${chosen}</div></td><td>${verdict}</td></tr>`;
  const regRow = (t) => {
    const e = exp[t];
    const best = e.models.find((m) => m.key === e.chosen);
    const bl = Math.min(...e.baselines.map((b) => b.mae));
    return row(e.label, `Erreur moyenne (${unitOf(t) || "points"})`, f.num(bl, 2), f.num(best.mae, 2), verdictReg(e),
      `${e.n_train} nuits d'entraînement · ${e.n_test} de test`, MODEL_NAMES[e.chosen] || e.chosen);
  };
  const clfRow = (key) => {
    const e = exp[key];
    const best = e.models.find((m) => m.key === e.chosen);
    const bl = Math.max(...e.baselines.map((b) => b.bacc));
    return row(e.label, "Exactitude équilibrée (3 classes, hasard = 33 %)", `${f.num(bl * 100)} %`, `${f.num(best.bacc * 100)} %`, verdictClf(e),
      `${e.n_train} séances notées · ${e.n_test} de test`, MODEL_NAMES[e.chosen] || e.chosen);
  };
  const a = exp.hrv_low;
  const bestA = a.models.reduce((x, y) => ((x.auc || 0) >= (y.auc || 0) ? x : y));
  const blA = Math.max(...a.baselines.map((b) => b.auc || 0));
  return card({
    title: "Ce qu'on arrive à prédire (ou pas)", sub: "Score sur la période de test, jamais vue à l'entraînement · comparé à la meilleure prévision naïve",
    body: `<div class="table-wrap"><table class="data ml-score"><thead><tr><th>Cible</th><th>Mesure</th><th class="r">Référence naïve</th><th class="r">Meilleur modèle</th><th>Verdict</th></tr></thead><tbody>
      ${regRow("hrv")}${regRow("sleep_score")}${regRow("resting_hr")}${clfRow("feel_before")}${clfRow("feel_after")}
      ${row(a.label, "AUC (0,5 = hasard)", f.num(blA, 2), f.num(bestA.auc, 2), bestA.auc - blA >= 0.05 ? status("good", `+${f.num(bestA.auc - blA, 2)} d'AUC`) : status("neutral", "Pas mieux"), `${f.num(a.rate * 100)} % des nuits · ${a.n_test} de test`, bestA.label)}
    </tbody></table></div>`,
  });
}

// ---------------------------------------------------------------- charts
function drawTestSeries(e) {
  const s = e.test_series;
  document.getElementById("ml-ts-legend").innerHTML = `<span><i class="pf-key dot" style="background:${T.text1}"></i>Réel</span><span><i class="line" style="background:${T.seq[6]}"></i>Prédit</span><span><i class="line" style="background:${T.text3}"></i>Moyenne 7 nuits (référence)</span>`;
  const best = e.models.find((m) => m.key === e.chosen);
  document.getElementById("ml-ts-foot").innerHTML = `Modèle retenu (validation croisée sur l'entraînement) : <b>${MODEL_NAMES[e.chosen]}</b> · erreur ${f.num(best.mae, 2)} vs ${f.num(Math.min(...e.baselines.map((b) => b.mae)), 2)} pour la référence · corrélation des écarts prédits/réels ${f.num(best.dev_corr, 2)}`;
  chart("#ml-ts", {
    animation: false, grid: { left: 44, right: 14, top: 12, bottom: 28 },
    tooltip: { trigger: "axis", formatter: (ps) => ttTitle(f.dateLong(s[ps[0].dataIndex].date)) + ps.map((p) => ttRow(p.color, f.num(p.value[1], 1), p.seriesName.toLowerCase())).join("") },
    xAxis: { type: "time", axisLabel: { formatter: (v) => f.dateShort(f.isoDate(new Date(v))) } },
    yAxis: { type: "value", scale: true },
    series: [
      { name: "Moyenne 7 nuits", type: "line", showSymbol: false, data: s.map((r) => [r.date, r.baseline]), color: T.text3, lineStyle: { width: 1.5, color: T.text3 } },
      { name: "Prédit", type: "line", showSymbol: false, data: s.map((r) => [r.date, r.pred]), color: T.seq[6], lineStyle: { width: 2, color: T.seq[6] } },
      { name: "Réel", type: "scatter", symbolSize: 5, data: s.map((r) => [r.date, r.actual]), color: T.text1, itemStyle: { color: T.text1, opacity: 0.8 } },
    ],
  });
}

function drawImportance(e) {
  const imp = [...e.importance].reverse();
  chart("#ml-imp", {
    animation: false, grid: { left: 210, right: 30, top: 6, bottom: 24 },
    tooltip: { formatter: (p) => ttRow(T.seq[5], `+${f.num(imp[p.dataIndex].importance, 2)}`, `${f.esc(imp[p.dataIndex].label)} (erreur ajoutée)`, true) },
    xAxis: { type: "value", axisLabel: { formatter: (v) => f.num(v, 1) } },
    yAxis: { type: "category", data: imp.map((i) => i.label), axisLabel: { color: T.text2, fontSize: 11, width: 200, overflow: "truncate" } },
    series: [{ type: "bar", barMaxWidth: 14, data: imp.map((i) => Math.max(0, i.importance)), color: T.seq[5], itemStyle: { borderRadius: [0, 4, 4, 0] } }],
  });
}

function feelCard(exp) {
  const e = exp.feel_after, b = exp.feel_before;
  return card({
    title: "Ton ressenti (note de la montre)", sub: "Classes regroupées : en dessous (très faible/faible) · normal · au-dessus (fort/très fort)",
    actions: seg("mlf", [["after", "Après la séance"], ["before", "Avant de partir"]], "after"),
    body: `<div class="ml-feel"><div id="ml-cm" class="chart" style="height:250px"></div><div id="ml-bacc" class="chart" style="height:250px"></div></div>
      <p class="ml-note">« Avant de partir » n'utilise que tes signaux du matin, ta charge et ton historique de notes (${f.num(b.models.find((m) => m.key === b.chosen).bacc * 100)} % d'exactitude équilibrée).
      « Après la séance » ajoute FC, training effect, allure… mais jamais ton RPE (${f.num(e.models.find((m) => m.key === e.chosen).bacc * 100)} %). Répartition de tes notes : ${Object.entries(e.class_counts).map(([k, v]) => `${k} ${v}`).join(" · ")}.</p>`,
  });
}

function drawFeelCharts(exp) {
  const draw = (key) => {
    const e = exp[key];
    const labels = ["En dessous", "Normal", "Au-dessus"];
    const cm = e.confusion;
    const rows = cm.map((r) => r.reduce((a, b) => a + b, 0));
    const data = [];
    cm.forEach((r, i) => r.forEach((v, j) => data.push([j, i, rows[i] ? v / rows[i] : 0, v])));
    chart("#ml-cm", {
      animation: false, grid: { left: 82, right: 10, top: 26, bottom: 36 },
      title: { text: "Réel (lignes) → prédit (colonnes)", left: "center", top: 0, textStyle: { color: T.text3, fontSize: 11, fontWeight: 400 } },
      tooltip: { formatter: (p) => ttTitle(`réel ${labels[p.data[1]]} → prédit ${labels[p.data[0]]}`) + ttRow(T.seq[6], `${p.data[3]} séances`, `${f.num(p.data[2] * 100)} % de la ligne`, true) },
      xAxis: { type: "category", data: labels, axisLabel: { color: T.text2, fontSize: 10, interval: 0 } },
      yAxis: { type: "category", data: labels, inverse: true, axisLabel: { color: T.text2, fontSize: 11, interval: 0 } },
      visualMap: { show: false, min: 0, max: 1, inRange: { color: [T.surface2, T.seq[3], T.seq[7]] } },
      series: [{ type: "heatmap", data, label: { show: true, formatter: (p) => `${f.num(p.data[2] * 100)} %`, color: T.text1, fontSize: 11 },
                 itemStyle: { borderColor: T.surface, borderWidth: 3 } }],
    });
    const items = [...e.baselines.map((x) => ({ name: x.label, v: x.bacc, base: true })), ...e.models.map((m) => ({ name: m.label, v: m.bacc, chosen: m.key === e.chosen }))];
    chart("#ml-bacc", {
      animation: false, grid: { left: 150, right: 44, top: 26, bottom: 24 },
      title: { text: "Exactitude équilibrée sur le test", left: "center", top: 0, textStyle: { color: T.text3, fontSize: 11, fontWeight: 400 } },
      tooltip: { formatter: (p) => ttRow(T.seq[6], `${f.num(p.value * 100)} %`, f.esc(items[p.dataIndex].name), true) },
      xAxis: { type: "value", min: 0, max: 1, interval: 0.5, axisLabel: { formatter: (v) => `${v * 100} %` } },
      yAxis: { type: "category", data: items.map((x) => x.name), inverse: true, axisLabel: { color: T.text2, fontSize: 11, width: 140, overflow: "truncate" } },
      series: [{ type: "bar", barMaxWidth: 14, label: { show: true, position: "right", color: T.text2, fontSize: 11, formatter: (p) => `${f.num(p.value * 100)} %` },
                 data: items.map((x) => ({ value: x.v, itemStyle: { color: x.base ? T.text3 : x.chosen ? T.seq[7] : T.seq[3], borderRadius: [0, 4, 4, 0] } })),
                 markLine: { silent: true, symbol: "none", label: { formatter: "hasard", color: T.text3, fontSize: 10 }, lineStyle: { color: T.text3, type: "solid", width: 1 }, data: [{ xAxis: 1 / 3 }] } }],
    });
  };
  draw("feel_after");
  onSeg(document, "mlf", (v) => draw(v === "after" ? "feel_after" : "feel_before"));
}

function drawEffects(effects, target) {
  const rows = effects.filter((e) => e.target === target).sort((a, b) => a.shift - b.shift);
  const unit = unitOf(target);
  document.getElementById("ml-eff-foot").innerHTML = rows.filter((r) => r.p < 0.05).length
    ? `Significatif (p &lt; 0,05) : ${rows.filter((r) => r.p < 0.05).map((r) => `${f.esc(r.label.toLowerCase())} ${f.signed(r.shift, 1)} ${unit}`).join(" · ")}`
    : "Aucun effet significatif pour cette cible.";
  chart("#ml-eff", {
    animation: false, grid: { left: 230, right: 24, top: 8, bottom: 28 },
    tooltip: { formatter: (p) => { const r = rows[p.dataIndex]; return ttTitle(f.esc(r.label)) + ttRow(r.shift >= 0 ? T.pos : T.neg, `${f.signed(r.shift, 2)} ${unit}`, `IC 95 % [${f.signed(r.ci[0], 1)} ; ${f.signed(r.ci[1], 1)}]`, true) + `<div class="tt-row muted">p = ${f.num(r.p, 3)} · ${r.n} nuits</div>`; } },
    xAxis: { type: "value", axisLabel: { formatter: (v) => f.signed(v, 0) } },
    yAxis: { type: "category", data: rows.map((r) => r.label), axisLabel: { color: T.text2, fontSize: 11, width: 220, overflow: "truncate" } },
    series: [
      { type: "custom", renderItem: (params, api) => {
        const lo = api.coord([api.value(1), api.value(0)]), hi = api.coord([api.value(2), api.value(0)]);
        return { type: "line", shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: { stroke: T.text3, lineWidth: 2 } };
      }, data: rows.map((r, i) => [i, r.ci[0], r.ci[1]]), encode: { x: [1, 2], y: 0 }, silent: true },
      { type: "scatter", symbolSize: 11, data: rows.map((r, i) => ({ value: [r.shift, i], itemStyle: { color: r.p < 0.05 ? (r.shift >= 0 ? T.pos : T.neg) : T.text3, borderColor: T.surface, borderWidth: 2 } })),
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.axis, type: "solid" }, data: [{ xAxis: 0 }] } },
    ],
  });
}

// ---------------------------------------------------------------- alert & method
function alertCard(a) {
  const items = [...a.baselines.map((b) => ({ ...b, base: true })), ...a.models];
  return card({
    title: "Alerte « HRV basse cette nuit »", sub: `Prédire si ta HRV de la nuit passera sous ta plage équilibrée (arrive ${f.num(a.rate * 100)} % des nuits)`,
    body: `<div class="ml-auc">${items.map((x) => `<div class="ml-aucrow"><span>${f.esc(x.label)}</span>
      <div class="ml-aucbar"><div style="width:${Math.max(0, ((x.auc || 0.5) - 0.5) / 0.5) * 100}%;background:${x.base ? T.text3 : T.seq[6]}"></div></div><b class="num">${x.auc != null ? f.num(x.auc, 2) : "–"}</b></div>`).join("")}</div>
      <p class="ml-note">AUC = probabilité que le modèle classe une nuit « basse » au-dessus d'une nuit normale (0,5 = hasard, 1 = parfait). La barre part de 0,5.</p>`,
  });
}

function methodCard() {
  return card({
    title: "Comment c'est évalué", body: `<ul class="ml-method">
      <li><b>Pas de fuite d'information</b> : chaque prédiction n'utilise que ce qui est connu avant (le soir pour la nuit, le matin et ta charge pour le ressenti). Les signaux Garmin « de la journée » (stress, Body Battery) courent jusqu'à minuit et contiennent le début de la nuit prédite : les inclure donne une fausse amélioration (une ablation le montre), ils sont donc exclus.</li>
      <li><b>Split chronologique</b> : entraînement sur le passé, test sur les 25 % les plus récents, avec 7 jours d'écart.</li>
      <li><b>Choix du modèle</b> par validation croisée temporelle sur l'entraînement uniquement (Ridge, random forest, gradient boosting, ensemble), puis un seul score sur le test.</li>
      <li><b>Cible = écart à ta moyenne 7 nuits</b> : ton niveau de HRV dérive sur des mois et les arbres n'extrapolent pas ; on prédit donc « mieux ou moins bien que d'habitude ».</li>
      <li><b>Références naïves</b> : « comme la veille », « moyenne 7 nuits », « classe majoritaire », « comme ta dernière séance » — un modèle n'est utile que s'il les bat.</li>
    </ul>`,
  });
}
