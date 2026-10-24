// Labo — correlation explorer between training, performance, sleep and recovery.
import { api, qs } from "../api.js";
import { T, SPORTS, ttRow, ttTitle } from "../theme.js";
import { card, chart, empty, seg, onSeg, disposeCharts } from "../ui.js";
import * as f from "../fmt.js";

const PERIODS = [["182", "6 mois"], ["365", "1 an"], ["730", "2 ans"], ["all", "Tout"]];
const LAGS = [-3, -2, -1, 0, 1, 2, 3];
const SMOOTH = [["1", "Brut"], ["7", "7 j"], ["28", "28 j"]];
const C_X = SPORTS.run.color;   // categorical slot 1
const C_Y = SPORTS.bike.color;  // categorical slot 2
const C_POINT = SPORTS.run.color;

const MATRIX_KEYS = ["load", "atl", "tsb", "sleep_hours", "sleep_score", "deep_pct", "hrv", "resting_hr",
  "body_battery_high", "stress_avg", "run_ef", "run_hr", "run_rpe"];
const SHORT = {
  load: "Charge", load_run: "Charge course", run_km: "Km course", train_hours: "Heures", ctl: "Fitness", atl: "Fatigue",
  tsb: "Fraîcheur", acwr: "ACWR", monotony: "Monotonie", run_ef: "EF course", easy_ef: "EF footing", run_speed: "Vitesse",
  run_hr: "FC course", run_decoupling: "Dérive", run_rpe: "RPE", run_feel: "Ressenti", run_cadence: "Cadence",
  run_gct: "Contact sol", run_vosc: "Oscillation", run_stride: "Foulée", aerobic_te: "TE aérobie", garmin_load: "Charge Garmin",
  vo2max: "VO2max", sleep_hours: "Sommeil", sleep_score: "Score sommeil", deep_pct: "Profond %", rem_pct: "Paradoxal %",
  awake_min: "Éveils", sleep_debt_3d: "Dette 3 j", bedtime_hour: "Coucher", sleep_hr: "FC sommeil", sleep_stress: "Stress nuit",
  hrv: "HRV", hrv_dev: "HRV vs 7 j", resting_hr: "FC repos", body_battery_high: "Body Battery", body_battery_charged: "BB rechargé",
  stress_avg: "Stress", respiration: "Respiration", steps: "Pas",
};
// Variables mechanically derived from one another: a correlation between them says little.
const FAMILIES = [
  ["load", "load_run", "run_km", "train_hours", "garmin_load"],
  ["ctl", "atl", "tsb", "acwr", "monotony"],
  ["hrv", "hrv_dev"],
  ["sleep_hours", "sleep_debt_3d", "deep_pct", "rem_pct"],
  ["run_speed", "run_ef", "easy_ef", "run_hr", "run_stride", "run_cadence"],
  ["body_battery_high", "body_battery_charged"],
];
const sameFamily = (a, b) => FAMILIES.some((fam) => fam.includes(a) && fam.includes(b));

function strength(r) {
  if (r == null) return "—";
  const a = Math.abs(r);
  const s = a < 0.1 ? "négligeable" : a < 0.3 ? "faible" : a < 0.5 ? "modérée" : a < 0.7 ? "forte" : "très forte";
  return a < 0.1 ? "Corrélation négligeable" : `Corrélation ${r > 0 ? "positive" : "négative"} ${s}`;
}
function pfmt(p) {
  if (p == null) return "–";
  if (p < 0.001) return "< 0,001";
  return p.toLocaleString("fr-FR", { maximumSignificantDigits: 2 });
}
const lagLabel = (l) => (l === 0 ? "J" : l > 0 ? `J+${l}` : `J−${-l}`);

export async function render(view, { query }) {
  const vars = await api.get("/api/lab/variables", { ttl: 60000 });
  const meta = Object.fromEntries(vars.map((v) => [v.key, v]));
  const usable = vars.filter((v) => v.n >= 10);
  if (usable.length < 2) {
    view.innerHTML = `<div class="card">${empty("Pas encore assez de données", "Le labo s'allume dès que Garmin a synchronisé quelques semaines de séances et de nuits.", `<a class="btn primary" href="#/settings">Connecter Garmin</a>`)}</div>`;
    return;
  }
  const pick = (k, fallback) => (meta[k]?.n >= 10 ? k : fallback);
  const st = {
    x: pick(query.x, pick("load", usable[0].key)),
    y: pick(query.y, pick("hrv", usable[1].key)),
    lag: LAGS.includes(Number(query.lag)) ? Number(query.lag) : (query.lag === undefined ? 1 : 0),
    period: PERIODS.some(([v]) => v === query.p) ? query.p : "365",
    active: query.a === "1",
    smooth: "7",
    target: null,
    showDerived: false,
  };
  const label = (k) => meta[k]?.label || k;
  const unit = (k) => (meta[k]?.unit ? ` (${meta[k].unit})` : "");
  const short = (k) => SHORT[k] || label(k);

  const groups = [...new Set(vars.map((v) => v.group))];
  const options = (sel) => groups.map((g) => `<optgroup label="${f.esc(g)}">${vars.filter((v) => v.group === g).map((v) =>
    `<option value="${v.key}" ${v.key === sel ? "selected" : ""} ${v.n < 10 ? "disabled" : ""}>${f.esc(v.label)}${v.n < 10 ? ` (n=${v.n})` : ""}</option>`).join("")}</optgroup>`).join("");

  view.innerHTML = `
    <div class="filters lab-controls">
      ${seg("period", PERIODS, st.period)}
      <label class="field">Variable X<select class="input" id="lab-x">${options(st.x)}</select></label>
      <button class="btn lab-swap" id="lab-swap" type="button" title="Inverser X et Y" aria-label="Inverser X et Y"><svg viewBox="0 0 24 24"><path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg></button>
      <label class="field">Variable Y<select class="input" id="lab-y">${options(st.y)}</select></label>
      <div class="field"><span>Décalage de Y</span>${seg("lag", LAGS.map((l) => [l, lagLabel(l)]), st.lag)}</div>
      <label class="toggle"><input type="checkbox" id="lab-active" ${st.active ? "checked" : ""}> Jours d'entraînement uniquement</label>
    </div>
    <div class="lab-sentence" id="lab-sentence"></div>
    <div class="grid">
      <div class="span-8">${card({ title: "Nuage de points", sub: "Chaque point est un jour · droite des moindres carrés · moyennes par quintile de X ± erreur-type", body: `<div class="legend" id="lab-sc-leg"></div><div class="chart" id="lab-scatter" style="height:470px"></div>` })}</div>
      <div class="span-4 lab-side" id="lab-stats"></div>
      <div class="span-12">${card({ title: "Les deux séries dans le temps", sub: "Valeurs centrées-réduites (z-score) sur la période, Y décalé pour être aligné sur X", actions: seg("smooth", SMOOTH, st.smooth), body: `<div class="legend" id="lab-ts-leg"></div><div class="chart" id="lab-ts"></div>` })}</div>
      <div class="span-7" id="lab-matrix-card"></div>
      <div class="span-5 lab-side" id="lab-discover"></div>
    </div>`;

  const xSel = view.querySelector("#lab-x"), ySel = view.querySelector("#lab-y");
  const startDate = () => (st.period === "all" ? undefined : f.isoDate(f.addDays(f.today(), -Number(st.period) + 1)));
  const syncUrl = () => {
    history.replaceState(null, "", `#/lab${qs({ x: st.x, y: st.y, lag: st.lag, p: st.period, a: st.active ? "1" : "" })}`);
  };
  const setLagUi = () => view.querySelectorAll('[data-seg="lag"] button').forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === st.lag));

  let busy = 0;
  async function refresh() {
    const token = ++busy;
    syncUrl();
    sentence();
    view.classList.add("loading");
    const start = startDate();
    try {
      const [pair, disc, mat, series] = await Promise.all([
        api.get(`/api/lab/pair${qs({ x: st.x, y: st.y, lag: st.lag, start, active: st.active ? "true" : "" })}`),
        api.get(`/api/lab/discover${qs({ target: st.target || st.y, lag: st.lag, start })}`, { ttl: 30000 }),
        api.get(`/api/lab/matrix${qs({ keys: MATRIX_KEYS.filter((k) => meta[k]?.n >= 20).join(","), lag: st.lag, start })}`, { ttl: 30000 }),
        api.get(`/api/lab/series${qs({ keys: `${st.x},${st.y}`, start })}`, { ttl: 30000 }),
      ]);
      if (token !== busy) return;
      disposeCharts();
      drawScatter(pair);
      statsCard(pair, disc);
      drawSeries(series);
      drawMatrix(mat);
      discoverCard(disc);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === busy) view.classList.remove("loading");
    }
  }

  // ---------------------------------------------------------------- plain-language framing
  function sentence() {
    const yl = `<b>${f.esc(label(st.y))}</b>`, xl = `<b>${f.esc(label(st.x))}</b>`;
    const yGroup = meta[st.y]?.group;
    let txt;
    if (st.lag === 0) {
      txt = `On compare ${xl} et ${yl} <b>le même jour J</b>.`;
      if (["Sommeil", "Récupération"].includes(yGroup)) txt += ` <span class="muted">La nuit datée J est celle qui précède la journée J.</span>`;
    } else if (st.lag > 0) {
      txt = `On compare ${xl} du jour J à ${yl} mesuré <b>${st.lag} jour${st.lag > 1 ? "s" : ""} après</b> (${lagLabel(st.lag)}).`;
      if (st.lag === 1 && ["Sommeil", "Récupération"].includes(yGroup)) txt += ` <span class="muted">Pour le sommeil : la nuit qui suit la journée J.</span>`;
    } else {
      txt = `On compare ${xl} du jour J à ${yl} mesuré <b>${-st.lag} jour${st.lag < -1 ? "s" : ""} avant</b> (${lagLabel(st.lag)}).`;
    }
    if (st.active) txt += ` <span class="muted">Seuls les jours avec une séance sont gardés.</span>`;
    view.querySelector("#lab-sentence").innerHTML = txt;
  }

  // ---------------------------------------------------------------- scatter
  function drawScatter(pair) {
    const node = view.querySelector("#lab-scatter");
    const pts = pair.points || [];
    view.querySelector("#lab-sc-leg").innerHTML = pts.length
      ? `<span><i style="background:${C_POINT};border-radius:50%"></i>Jours (n=${pts.length})</span><span><i class="line" style="background:${T.text2}"></i>Régression linéaire</span><span><i style="background:${T.text1};border-radius:50%"></i>Moyenne par quintile ± ET</span>`
      : "";
    if (pts.length < 5) { node.innerHTML = empty("Pas assez de jours où les deux variables existent", "Change de période, de décalage ou de variables."); return; }
    const xs = pts.map((p) => p[0]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const series = [{
      name: "Jours", type: "scatter", data: pts, symbolSize: pts.length > 400 ? 5 : 7,
      itemStyle: { color: C_POINT, opacity: pts.length > 400 ? 0.4 : 0.6 }, emphasis: { itemStyle: { opacity: 1, borderColor: T.text1, borderWidth: 2 } },
    }];
    if (pair.fit) {
      series.push({ name: "Régression", type: "line", silent: true, symbol: "none", color: T.text2, lineStyle: { width: 2 },
        data: [[x0, pair.fit.intercept + pair.fit.slope * x0], [x1, pair.fit.intercept + pair.fit.slope * x1]], z: 3 });
    }
    if (pair.bins?.length) {
      series.push({
        type: "custom", silent: true, z: 4,
        data: pair.bins.map((b) => [b.x, b.y - b.se, b.y + b.se]),
        renderItem: (p, a) => {
          const lo = a.coord([a.value(0), a.value(1)]), hi = a.coord([a.value(0), a.value(2)]);
          return { type: "group", children: [
            { type: "line", shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: { stroke: T.text1, lineWidth: 1.5 } },
            { type: "line", shape: { x1: lo[0] - 5, y1: lo[1], x2: lo[0] + 5, y2: lo[1] }, style: { stroke: T.text1, lineWidth: 1.5 } },
            { type: "line", shape: { x1: hi[0] - 5, y1: hi[1], x2: hi[0] + 5, y2: hi[1] }, style: { stroke: T.text1, lineWidth: 1.5 } },
          ] };
        },
      });
      series.push({ name: "Quintiles", type: "scatter", z: 5, symbolSize: 11, data: pair.bins.map((b) => [b.x, b.y, b.n, b.se]),
        itemStyle: { color: T.text1, borderColor: T.surface, borderWidth: 2 } });
    }
    chart(node, {
      animation: false,
      grid: { left: 58, right: 18, top: 16, bottom: 46 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          if (p.seriesName === "Quintiles") {
            return ttTitle("Quintile de X") + ttRow(T.text1, f.num(p.data[1], 2), `${short(st.y)} moyen`, true)
              + `<div class="tt-row"><span>X moyen</span><span class="tt-val">${f.num(p.data[0], 2)}</span><span>· n=${p.data[2]} · ET ${f.num(p.data[3], 2)}</span></div>`;
          }
          const [x, y, d] = p.data;
          return ttTitle(`${f.dateDay(d)}${st.lag ? ` → Y le ${f.dateShort(f.isoDate(f.addDays(f.parseDate(d), st.lag)))}` : ""}`)
            + ttRow(C_X, f.num(x, 2), f.esc(short(st.x)), true) + ttRow(C_Y, f.num(y, 2), f.esc(short(st.y)), true);
        },
      },
      xAxis: { type: "value", scale: true, name: `${label(st.x)}${unit(st.x)} · jour J`, nameLocation: "middle", nameGap: 28, nameTextStyle: { color: T.text3 },
        splitLine: { lineStyle: { color: T.grid } }, axisLine: { lineStyle: { color: T.axis } } },
      yAxis: { type: "value", scale: true, name: `${label(st.y)}${unit(st.y)} · ${lagLabel(st.lag)}`, nameLocation: "middle", nameGap: 44, nameTextStyle: { color: T.text3 } },
      series,
    });
  }

  // ---------------------------------------------------------------- stats + lag profile
  function statsCard(pair, disc) {
    const s = pair.stats || {};
    const host = view.querySelector("#lab-stats");
    if (s.spearman == null) {
      host.innerHTML = card({ title: "Statistiques", body: empty("Pas assez de données", `n = ${s.n || 0} jour(s) en commun.`) });
      return;
    }
    const q = (disc || []).find((r) => r.key === st.x)?.q;
    const qNote = st.target && st.target !== st.y ? null : q;
    const warn = [];
    if (s.n < 30) warn.push(`<b>Petit échantillon</b> (n=${s.n}) : l'estimation est instable, élargis la période.`);
    if (s.p_spearman >= 0.05) warn.push("<b>Non significatif</b> au seuil de 5 % : ce lien peut être dû au hasard.");
    if (sameFamily(st.x, st.y)) warn.push("<b>Lien par construction</b> : ces deux variables sont calculées l'une à partir de l'autre.");
    const slope = pair.fit?.slope;
    const xStep = niceStep(pair.points.map((p) => p[0]));
    host.innerHTML = card({
      title: "Statistiques",
      sub: `${short(st.x)} (J) → ${short(st.y)} (${lagLabel(st.lag)})`,
      body: `
        <div class="lab-rho">
          <div><div class="eyebrow">Rho de Spearman</div><div class="hero-num">${f.signed(s.spearman, 2)}</div></div>
          <div class="rho-bar" aria-hidden="true"><span class="rho-mid"></span><span class="rho-fill" style="${s.spearman >= 0 ? "left:50%" : `right:50%`};width:${Math.abs(s.spearman) * 50}%;background:${s.spearman >= 0 ? T.pos : T.neg}"></span></div>
        </div>
        <div class="lab-strength">${strength(s.spearman)}</div>
        <dl class="kv lab-kv">
          <dt>Jours (n)</dt><dd>${f.num(s.n)}</dd>
          <dt>p (Spearman)</dt><dd>${pfmt(s.p_spearman)}</dd>
          <dt>r de Pearson</dt><dd>${f.signed(s.pearson, 2)} <span class="muted">p ${pfmt(s.p_pearson)}</span></dd>
          ${qNote != null ? `<dt title="Corrigé de Benjamini-Hochberg sur toutes les variables testées contre Y">q (FDR, toutes variables vs Y)</dt><dd>${pfmt(qNote)}</dd>` : ""}
          ${slope != null ? `<dt>Pente (OLS)</dt><dd>+${f.num(xStep, xStep < 1 ? 2 : 0)} ${f.esc(short(st.x))} → ${f.signed(slope * xStep, 2)} ${f.esc(meta[st.y]?.unit || "")}</dd>` : ""}
        </dl>
        ${warn.length ? `<div class="callout warn lab-warn">${warn.join("<br>")}</div>` : ""}
        <div class="lab-lagtitle">Profil de décalage <span class="muted">· rho par décalage (clique pour choisir)</span></div>
        <div class="chart short" id="lab-lags"></div>
        <p class="muted lab-caveat">Corrélation ≠ causalité : la saison, le bloc d'entraînement ou la météo peuvent créer un lien entre deux variables sans que l'une agisse sur l'autre.</p>`,
    });
    const lags = pair.lags || [];
    const maxAbs = Math.max(0.2, ...lags.map((l) => Math.abs(l.r || 0)));
    const lim = Math.min(1, Math.ceil(maxAbs * 10) / 10 + 0.1);
    const c = chart(host.querySelector("#lab-lags"), {
      animation: false,
      grid: { left: 36, right: 6, top: 14, bottom: 22 },
      tooltip: {
        formatter: (p) => {
          const l = lags[p.dataIndex];
          return ttTitle(`Y à ${lagLabel(l.lag)}`) + ttRow(l.r >= 0 ? T.pos : T.neg, f.signed(l.r, 2), "ρ", true)
            + `<div class="tt-row"><span>p</span><span class="tt-val">${pfmt(l.p)}</span><span>· n=${l.n}</span></div>`;
        },
      },
      xAxis: { type: "category", data: lags.map((l) => lagLabel(l.lag)) },
      yAxis: { type: "value", min: -lim, max: lim, splitNumber: 2, axisLabel: { formatter: (v) => f.num(v, 1) } },
      series: [{
        type: "bar", barMaxWidth: 22,
        data: lags.map((l) => ({
          value: l.r,
          itemStyle: {
            color: (l.r || 0) >= 0 ? T.pos : T.neg, opacity: l.lag === st.lag ? 1 : 0.38,
            borderRadius: (l.r || 0) >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
          },
          label: l.lag === st.lag ? { show: true, position: (l.r || 0) >= 0 ? "top" : "bottom", color: T.text1, fontSize: 11, formatter: () => f.signed(l.r, 2) } : undefined,
        })),
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.axis, type: "solid", width: 1 }, data: [{ yAxis: 0 }] },
      }],
    });
    c?.on("click", (p) => { st.lag = lags[p.dataIndex].lag; setLagUi(); refresh(); });
  }

  // ---------------------------------------------------------------- time series (z-scores, one axis)
  function drawSeries(rows) {
    const node = view.querySelector("#lab-ts");
    if (!rows.length) { node.innerHTML = empty("Pas de données sur la période"); return; }
    const w = Number(st.smooth);
    const roll = (arr) => arr.map((_, i) => {
      const s = arr.slice(Math.max(0, i - w + 1), i + 1).filter(f.isNum);
      return s.length >= Math.ceil(w / 2) ? s.reduce((a, b) => a + b, 0) / s.length : null;
    });
    const z = (arr) => {
      const s = arr.filter(f.isNum);
      if (s.length < 3) return arr.map(() => null);
      const m = s.reduce((a, b) => a + b, 0) / s.length;
      const sdv = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1)) || 1;
      return arr.map((v) => (f.isNum(v) ? (v - m) / sdv : null));
    };
    const xv = rows.map((r) => r[st.x]);
    // Y(D + lag) plotted at D
    const yv = rows.map((_, i) => rows[i + st.lag]?.[st.y] ?? null);
    const xs = z(roll(xv)), ys = z(roll(yv));
    view.querySelector("#lab-ts-leg").innerHTML = `<span><i class="line" style="background:${C_X}"></i>X · ${f.esc(label(st.x))}</span><span><i class="line" style="background:${C_Y}"></i>Y · ${f.esc(label(st.y))}${st.lag ? ` <span class="muted">(${lagLabel(st.lag)}, décalé)</span>` : ""}</span>`;
    chart(node, {
      animation: false,
      grid: { left: 40, right: 14, top: 10, bottom: 28 },
      tooltip: {
        trigger: "axis",
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          return ttTitle(f.dateDay(rows[i].date)) + ttRow(C_X, f.num(xv[i], 2), `${f.esc(short(st.x))} (z ${f.signed(xs[i], 1)})`)
            + ttRow(C_Y, f.num(yv[i], 2), `${f.esc(short(st.y))} ${lagLabel(st.lag)} (z ${f.signed(ys[i], 1)})`);
        },
      },
      xAxis: { type: "category", data: rows.map((r) => r.date), axisLabel: { formatter: (v) => f.dateShort(v), hideOverlap: true } },
      yAxis: { type: "value", name: "z", nameTextStyle: { color: T.text3, align: "right" }, splitNumber: 4 },
      series: [
        { name: "X", type: "line", data: xs, color: C_X, connectNulls: false, lineStyle: { width: w === 1 ? 1 : 2 } },
        { name: "Y", type: "line", data: ys, color: C_Y, connectNulls: false, lineStyle: { width: w === 1 ? 1 : 2 },
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.axis, type: "solid", width: 1 }, data: [{ yAxis: 0 }] } },
      ],
    });
  }

  // ---------------------------------------------------------------- correlation matrix
  function drawMatrix(mat) {
    const host = view.querySelector("#lab-matrix-card");
    const keys = mat.keys || [];
    host.innerHTML = card({
      title: "Matrice de corrélations",
      sub: st.lag === 0 ? "ρ de Spearman, même jour · cases pâles = non significatives (p ≥ 0,05) · clique une case pour l'explorer"
        : `ρ de Spearman · ligne = X au jour J, colonne = Y à ${lagLabel(st.lag)} · cases pâles = p ≥ 0,05`,
      body: keys.length < 2 ? empty("Pas assez de variables renseignées")
        : `<div class="chart" id="lab-matrix" style="height:${Math.max(320, keys.length * 34 + 90)}px"></div>
           <div class="lab-divleg"><span class="muted">−1</span><i style="background:linear-gradient(90deg, ${T.neg}, ${T.mid}, ${T.pos})"></i><span class="muted">+1</span><span class="muted">négative · nulle · positive</span></div>`,
    });
    if (keys.length < 2) return;
    const idx = Object.fromEntries(keys.map((k, i) => [k, i]));
    const n = keys.length;
    const node = host.querySelector("#lab-matrix");
    const cellW = (node.clientWidth - 110) / n;
    const data = mat.cells.map((c) => {
      const sig = c.p != null && c.p < 0.05;
      return {
        value: [idx[c.y], n - 1 - idx[c.x], c.r, c.p, c.n],
        itemStyle: { opacity: c.x === c.y ? 0.25 : sig ? 1 : 0.32, borderColor: T.surface, borderWidth: 2 },
        label: { color: c.r != null && Math.abs(c.r) > 0.45 && sig ? "#fff" : T.text2 },
      };
    });
    const c = chart(node, {
      animation: false,
      grid: { left: 104, right: 6, top: 6, bottom: 76 },
      tooltip: {
        formatter: (p) => {
          const [xi, yi, r, pv, nn] = p.data.value;
          const kx = keys[n - 1 - yi], ky = keys[xi];
          return ttTitle(`${f.esc(short(kx))} (J) × ${f.esc(short(ky))} (${lagLabel(st.lag)})`) + ttRow(r >= 0 ? T.pos : T.neg, f.signed(r, 2), "ρ", true)
            + `<div class="tt-row"><span>p</span><span class="tt-val">${pfmt(pv)}</span><span>· n=${nn}</span></div>`
            + (sameFamily(kx, ky) && kx !== ky ? `<div class="tt-row muted">lien par construction</div>` : "");
        },
      },
      xAxis: { type: "category", data: keys.map(short), axisLabel: { rotate: 45, interval: 0, color: T.text2, fontSize: 11 }, splitLine: { show: false }, axisLine: { show: false } },
      yAxis: { type: "category", data: keys.map(short).reverse(), axisLabel: { interval: 0, color: T.text2, fontSize: 11 }, splitLine: { show: false }, axisLine: { show: false } },
      visualMap: { show: false, min: -1, max: 1, dimension: 2, inRange: { color: [T.neg, T.mid, T.pos] } },
      series: [{
        type: "heatmap", data,
        label: { show: cellW >= 34, fontSize: 10, formatter: (p) => (p.data.value[2] == null || p.data.value[0] === n - 1 - p.data.value[1] ? "" : f.num(p.data.value[2], 2)) },
        emphasis: { itemStyle: { borderColor: T.text1, borderWidth: 2 } },
      }],
    });
    c?.on("click", (p) => {
      const kx = keys[n - 1 - p.data.value[1]], ky = keys[p.data.value[0]];
      if (kx === ky) return;
      st.x = kx; st.y = ky; xSel.value = kx; ySel.value = ky;
      refresh();
      view.querySelector(".lab-sentence").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ---------------------------------------------------------------- discovery
  function discoverCard(disc) {
    const host = view.querySelector("#lab-discover");
    const target = st.target || st.y;
    const rows = (disc || []).filter((r) => r.n >= 20 && (st.showDerived || !sameFamily(r.key, target)));
    const top = rows.slice(0, 14);
    const tOptions = groups.map((g) => `<optgroup label="${f.esc(g)}">${vars.filter((v) => v.group === g).map((v) =>
      `<option value="${v.key}" ${v.key === target ? "selected" : ""} ${v.n < 10 ? "disabled" : ""}>${f.esc(v.label)}</option>`).join("")}</optgroup>`).join("");
    host.innerHTML = card({
      title: "Découverte",
      sub: `Variables les plus liées à la cible (X au jour J, cible à ${lagLabel(st.lag)}) · q = p corrigée Benjamini-Hochberg`,
      actions: `<select class="input" id="lab-target" aria-label="Variable cible">${tOptions}</select>`,
      body: `
        <label class="toggle lab-derived"><input type="checkbox" id="lab-derived" ${st.showDerived ? "checked" : ""}> Inclure les variables liées par construction</label>
        ${top.length ? `<div class="disc-list">${top.map((r) => {
          const sig = r.q < 0.05;
          return `<button type="button" class="disc-row ${sig ? "" : "ns"}" data-key="${r.key}" data-tip="${f.esc(`<b>${f.signed(r.r, 2)}</b> ρ · p ${pfmt(r.p)} · q ${pfmt(r.q)} · n=${r.n}<br>Clique pour l'explorer en X`)}">
            <span class="disc-name">${f.esc(label(r.key))}</span>
            <span class="disc-bar"><span class="rho-mid"></span><span class="rho-fill" style="${r.r >= 0 ? "left:50%" : "right:50%"};width:${Math.abs(r.r) * 50}%;background:${r.r >= 0 ? T.pos : T.neg}"></span></span>
            <span class="disc-r num">${f.signed(r.r, 2)}</span>
            <span class="disc-q num">${sig ? `q ${pfmt(r.q)}` : "n.s."}</span>
          </button>`;
        }).join("")}</div>` : empty("Aucune variable exploitable")}
        <p class="muted lab-caveat">Avec ~${f.num((disc || []).length)} tests, quelques liens « significatifs » apparaissent par hasard : la q-value en tient compte. Lignes pâles = q ≥ 0,05.</p>`,
    });
    host.querySelector("#lab-target").addEventListener("change", (e) => { st.target = e.target.value; refresh(); });
    host.querySelector("#lab-derived").addEventListener("change", (e) => { st.showDerived = e.target.checked; discoverCard(disc); });
    host.querySelectorAll(".disc-row").forEach((b) => b.addEventListener("click", () => {
      st.x = b.dataset.key; xSel.value = st.x;
      if (st.target && st.target !== st.y) { st.y = st.target; ySel.value = st.y; }
      refresh();
      view.querySelector(".lab-sentence").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  // ---------------------------------------------------------------- controls
  onSeg(view, "period", (v) => { st.period = v; refresh(); });
  onSeg(view, "lag", (v) => { st.lag = Number(v); refresh(); });
  onSeg(view, "smooth", (v) => { st.smooth = v; refresh(); });
  xSel.addEventListener("change", () => { st.x = xSel.value; refresh(); });
  ySel.addEventListener("change", () => { st.y = ySel.value; st.target = null; refresh(); });
  view.querySelector("#lab-active").addEventListener("change", (e) => { st.active = e.target.checked; refresh(); });
  view.querySelector("#lab-swap").addEventListener("click", () => {
    [st.x, st.y] = [st.y, st.x]; xSel.value = st.x; ySel.value = st.y; st.target = null; refresh();
  });
  await refresh();
}

// A round step (~1/5 of the x range) to express the OLS slope in human units
function niceStep(xs) {
  const v = xs.filter(f.isNum);
  if (!v.length) return 1;
  const span = (Math.max(...v) - Math.min(...v)) / 5 || 1;
  const p = 10 ** Math.floor(Math.log10(span));
  const m = span / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
