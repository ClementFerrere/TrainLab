import { api } from "../api.js";
import { T, sport, sportIcon, ZONE_LABELS, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, status, empty, seg, onSeg } from "../ui.js";
import * as f from "../fmt.js";
import { ENGINE_TIP, bindRaceControl, drawIntervals, drawIvSimilar, intervalsCard, raceControl } from "./activity_intervals.js";

const FEEL = { 0: "Très faible", 25: "Faible", 50: "Normal", 75: "Fort", 100: "Très fort" };
const LAP_TYPES = { warmup: "Échauffement", active: "Effort", rest: "Récup", cooldown: "Retour au calme", recovery: "Récup", interval: "Effort" };

// ---------------------------------------------------------------- helpers
const has = (arr) => Array.isArray(arr) && arr.some((v) => v !== null && v !== undefined);
const minetti = (g) => { const i = Math.max(-0.35, Math.min(0.35, g)); return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6; };

function smooth(arr, w = 5) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(arr.length - 1, i + w); k++) if (arr[k] != null) { s += arr[k]; n++; }
    out[i] = n ? s / n : null;
  }
  return out;
}
function pct(arr, p) {
  const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * (v.length - 1))))];
}
function nearest(xs, x) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}
function interp(xs, ys, x) {
  if (!xs.length) return 0;
  const i = nearest(xs, x);
  return ys[i];
}
function niceAxis(lo, hi, steps, maxIntervals = 3) {
  const span = Math.max(hi - lo, 1e-6);
  const step = steps.find((st) => span / st <= maxIntervals) || steps[steps.length - 1];
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, interval: step };
}
const zoneOf = (hr, bounds) => (hr == null ? 0 : bounds.filter((b) => hr >= b).length);

export async function render(view, { args, setTitle, setActions }) {
  const id = args[0];
  let d, iv, ins;
  try {
    // the interval analysis and per-run insights are optional: never block the page on them
    [d, iv, ins] = await Promise.all([
      api.get(`/api/activities/${id}`),
      api.get(`/api/activities/${id}/intervals`).catch(() => ({ detected: false })),
      api.get(`/api/activities/${id}/insights`).catch(() => ({})),
    ]);
  }
  catch { view.innerHTML = card({ body: empty("Séance introuvable", "Elle a peut-être été supprimée de Garmin.", `<a class="btn" href="#/journal">Retour au journal</a>`) }); return; }

  const a = d.activity, s = d.streams || {}, sp = sport(a.sport);
  const zb = d.hr_zones || [];
  const title = a.strava?.name || a.name || sp.label;
  setTitle(title, `${f.dateLong(a.date)} · ${f.timeOf(a.start_local)}${a.location_name ? ` · ${a.location_name}` : ""}`);
  const acts = setActions(`${a.sport === "run" ? raceControl(a) : ""}<a class="btn" href="#/journal"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Journal</a>`
    + `<button class="btn" type="button" data-act="delete" title="Pour un enregistrement corrompu : la séance reste sur Garmin mais disparaît de TrainLab et de tous les calculs">Supprimer</button>`);
  bindRaceControl(acts, id);
  acts.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    if (!confirm("Supprimer cette séance de TrainLab ?\n\nElle reste sur Garmin, mais ne sera plus importée ni comptée dans les calculs.")) return;
    await api.del(`/api/activities/${id}`);
    location.hash = "#/journal";
  });

  // x axis basis shared by map, streams and laps
  const n = (s.time || []).length;
  const useDist = has(s.distance) && (s.distance[n - 1] || 0) > 200;
  const xs = useDist ? s.distance.map((v) => (v || 0) / 1000) : (s.time || []).map((t) => t / 60);
  const xUnit = useDist ? "km" : "min";
  const hasMap = has(s.latlng);
  const isRun = a.sport === "run", isBike = a.sport === "bike", isSwim = a.sport === "swim";

  // per-sample speeds (smoothed) and GAP
  const v = has(s.velocity_smooth) ? smooth(s.velocity_smooth, 3) : null;
  const gap = v && isRun && has(s.grade_smooth) ? v.map((x, i) => (x == null ? null : x * minetti((s.grade_smooth[i] || 0) / 100) / minetti(0))) : null;

  const panels = [];
  if (v && !isSwim) panels.push("speed");
  if (has(s.heartrate)) panels.push("hr");
  if (has(s.watts)) panels.push("power");
  if (has(s.cadence)) panels.push("cadence");
  if (has(s.altitude) && useDist) panels.push("alt");

  const hasZones = [a.z1, a.z2, a.z3, a.z4, a.z5].some((x) => x > 0);
  const hasEfforts = isRun && (d.best_efforts || []).length > 0;
  const hasCompare = (d.similar || []).filter((x) => x.avg_hr && x.avg_speed).length >= 3 && a.avg_hr && a.avg_speed;
  const lapsList = d.laps || [];
  const showLaps = (lapsList.length > 1 || (useDist && xs[n - 1] >= 2)) && v;

  const hasIv = iv && iv.detected && (iv.reps || []).length >= 2;
  view.innerHTML = `
    <div class="grid">
      <div class="span-12">${summaryCard(a, sp, !panels.length && !hasMap ? (isSwim ? "Pas de flux détaillé pour la natation en piscine : seuls les totaux de séance sont disponibles." : "Aucun flux détaillé (GPS / FC) n'a été enregistré pour cette séance.") : "", ins || {})}</div>
      ${hasIv ? `<div class="span-12">${intervalsCard(iv)}</div>` : ""}
      ${hasMap ? `<div class="span-5">${card({ title: "Parcours", sub: "Survole les courbes pour suivre ta position", actions: has(s.heartrate) ? seg("mapcolor", [["pace", isRun ? "Allure" : "Vitesse"], ["hr", "Zones FC"]], "pace") : "", body: `<div id="act-map" class="act-map" style="height:${Math.max(380, (panels.length ? 28 + panels.length * 134 : 420) - 30)}px"></div><div class="legend act-maplegend" id="act-maplegend"></div>` })}</div>` : ""}
      ${panels.length ? `<div class="${hasMap ? "span-7" : "span-12"}">${card({ title: "Courbes", sub: `Abscisse en ${useDist ? "kilomètres" : "minutes"} · un panneau par mesure, curseur synchronisé`, body: `<div id="act-streams" class="chart" style="height:${28 + panels.length * 134}px"></div>` })}</div>` : ""}
      ${showLaps ? `<div class="span-8">${card({ id: "act-laps", title: "Tours & splits", sub: "Largeur = distance du tour · hauteur = vitesse · couleur = zone FC moyenne", actions: seg("lapmode", [...(lapsList.length > 1 ? [["laps", `Tours (${lapsList.length})`]] : []), ...(useDist && xs[n - 1] >= 2 ? [["km", isBike ? "Tranches 5 km" : "Kilomètres"]] : [])], lapsList.length > 1 ? "laps" : "km"), body: `<div id="act-lapchart" class="chart" style="height:230px"></div><div class="legend act-zlegend">${T.zones.map((c, i) => `<span><i style="background:${c}"></i>${ZONE_LABELS[i]}</span>`).join("")}<span><i style="background:${T.surface3}"></i>Récup (atténué)</span></div><div id="act-laptable" class="table-wrap act-laptable"></div>` })}</div>` : ""}
      ${hasZones ? `<div class="${showLaps ? "span-4" : panels.length ? "span-6" : "span-12"}">${zonesCard(a, zb)}</div>` : ""}
      ${hasEfforts ? `<div class="${hasCompare ? "span-4" : "span-6"}">${effortsCard(d.best_efforts)}</div>` : ""}
      ${hasCompare ? `<div class="${hasEfforts ? "span-8" : "span-12"}">${card({ title: "Comparaison", sub: `Séances ${sp.label.toLowerCase()} de distance similaire (±15 %) · ${isRun ? "allure" : "vitesse"} selon la FC moyenne`, body: `<div id="act-compare" class="chart" style="height:300px"></div><div class="act-compare-foot" id="act-compare-foot"></div>` })}</div>` : ""}
      ${a.max_power_curve && Object.keys(a.max_power_curve).length > 2 ? `<div class="span-12">${card({ title: "Courbe de puissance", sub: "Meilleure puissance moyenne sur chaque durée", body: `<div id="act-power" class="chart" style="height:240px"></div>` })}</div>` : ""}
    </div>`;

  let map = null, marker = null, streamsChart = null;
  if (hasMap) ({ map, marker } = drawMap(view, s, v, zb, isRun));
  if (panels.length) streamsChart = drawStreams(view, { a, s, xs, xUnit, v, gap, panels, zb, lapsList, useDist, isRun, isBike, map, marker });
  if (hasEfforts) bindEffortHighlight(view, d.best_efforts, d.stream_step || 1, { xs, s, panels, streamsChart, map });
  if (showLaps) setupLaps(view, { a, s, xs, v, zb, lapsList, useDist, isRun, isBike });
  if (hasCompare) drawCompare(view, a, d.similar, isRun);
  if (hasIv) { drawIntervals(view, iv); drawIvSimilar(view, iv, a); }
  if (a.max_power_curve && Object.keys(a.max_power_curve).length > 2) drawPower(a.max_power_curve);

  return () => { if (map) map.remove(); };
}

// ---------------------------------------------------------------- summary
function summaryCard(a, sp, note = "", ins = {}) {
  const tiles = [];
  const add = (cond, html) => { if (cond) tiles.push(html); };
  const isRun = a.sport === "run", isBike = a.sport === "bike", isSwim = a.sport === "swim";
  add(a.distance > 0, stat("Distance", isSwim ? f.num(a.distance) : f.km(a.distance, 2), isSwim ? "m" : "km"));
  add(true, stat("Durée", f.duration(a.moving_time), "", a.elapsed_time && a.elapsed_time - a.moving_time > 60 ? `écoulé ${f.duration(a.elapsed_time)}` : ""));
  add(isRun && a.avg_speed, stat("Allure", f.pace(a.avg_speed), "/km", a.max_speed ? `max ${f.pace(a.max_speed)}` : ""));
  add(isRun && a.gap_speed, stat("Allure GAP", f.pace(a.gap_speed), "/km", "ajustée au D+"));
  add(isBike && a.avg_speed, stat("Vitesse", f.kmh(a.avg_speed), "km/h", a.max_speed ? `max ${f.kmh(a.max_speed)}` : ""));
  add(isSwim && a.avg_speed, stat("Allure", f.pace100(a.avg_speed), "/100 m", a.avg_swolf ? `SWOLF ${f.num(a.avg_swolf)}` : ""));
  add(a.avg_hr, stat("FC moyenne", f.num(a.avg_hr), "bpm", a.max_hr ? `max ${f.num(a.max_hr)}` : ""));
  const meth = { stream: "flux FC", avg_hr: "FC moyenne", estimate: "estimée (sans FC)" }[a.load_method] || "";
  add(a.load != null, stat("Charge", f.num(a.load), "hrTSS", `${meth}${a.garmin_load ? ` · Garmin ${f.num(a.garmin_load)}` : ""}`));
  add(a.aerobic_te, stat("Training effect", f.num(a.aerobic_te, 1), "", a.anaerobic_te != null ? `anaérobie ${f.num(a.anaerobic_te, 1)}` : "aérobie"));
  add(a.rpe, stat("RPE", f.num(a.rpe), "/10", a.feel != null ? `ressenti : ${FEEL[Math.round(a.feel / 25) * 25] || f.num(a.feel)}` : ""));
  add(a.avg_power, stat("Puissance", f.num(a.avg_power), "W", a.norm_power ? `NP ${f.num(a.norm_power)} W` : ""));
  add(a.avg_cadence, stat("Cadence", f.num(a.avg_cadence), isRun ? "spm" : isBike ? "rpm" : ""));
  add(a.elev_gain > 1, stat("Dénivelé +", f.num(a.elev_gain), "m"));
  add(a.ef, stat("Efficacité (EF)", f.num(a.ef, 2), "", "m/min par bpm"));
  if (a.decoupling != null) {
    const dv = a.decoupling;
    const st = dv < 5 ? status("good", "stable") : dv < 8 ? status("warning", "modérée") : status("serious", "forte");
    tiles.push(stat("Dérive cardiaque", f.signed(dv, 1), "%", st));
  }
  add(a.avg_gct, stat("Contact au sol", f.num(a.avg_gct), "ms"));
  add(a.avg_vert_osc, stat("Oscillation vert.", f.num(a.avg_vert_osc, 1), "cm"));
  add(a.avg_stride, stat("Foulée", f.num(a.avg_stride, 2), "m"));
  add(a.avg_vert_ratio, stat("Ratio vertical", f.num(a.avg_vert_ratio, 1), "%"));
  add(a.vo2max, stat("VO2max Garmin", f.num(a.vo2max)));
  add(a.avg_resp, stat("Respiration", f.num(a.avg_resp), "rpm"));
  add(a.calories, stat("Calories", f.num(a.calories), "kcal"));
  add(a.avg_temp != null, stat("Température", f.num(a.avg_temp), "°C"));
  // within-run durability (long steady runs): drift at constant speed
  if (ins.drift_hr != null) {
    const dh = ins.drift_hr;
    const st = dh < 3 ? status("good", "durable") : dh < 6 ? status("warning", "modérée") : status("serious", "forte");
    tiles.push(stat("Dérive FC", f.signed(dh, 1), "bpm/h", st));
  }
  add(ins.drift_gct != null, stat("Dérive contact sol", f.signed(ins.drift_gct, 1), "ms/h", "à allure égale"));

  const er = ins.engine_resid;
  const engineChip = er == null ? ""
    : Math.abs(er) < 2 ? `<span class="chip" data-tip="${f.esc(ENGINE_TIP)}">Moteur : FC conforme à ta forme</span>`
    : `<span class="chip act-engine ${er > 0 ? "worse" : "better"}" data-tip="${f.esc(ENGINE_TIP)}">Moteur : FC ${f.signed(er)} bpm vs ta forme</span>`;

  const chips = [
    `<span class="chip act-sport" style="--c:${sp.color}">${sportIcon(a.sport, 14)}${sp.label}</span>`,
    a.is_race ? `<span class="chip act-race">Course officielle</span>` : "",
    engineChip,
    a.te_label ? `<span class="chip">${f.esc(teLabel(a.te_label))}</span>` : "",
    a.strava ? `<span class="chip act-strava" title="Données Strava conservées 7 jours maximum, affichage seulement">via Strava (7 j)</span>` : "",
  ].join("");
  const desc = a.strava?.description || a.description;
  const extra = [
    a.strava?.gear_name ? `<span class="dim">Matériel : <b>${f.esc(a.strava.gear_name)}</b></span>` : "",
    a.strava?.kudos ? `<span class="dim">${f.num(a.strava.kudos)} kudos</span>` : "",
  ].filter(Boolean).join(" · ");
  return card({
    cls: "act-summary",
    body: `<div class="act-chips">${chips}</div>
      ${desc ? `<p class="act-desc">${f.esc(desc)}</p>` : ""}
      ${extra ? `<div class="act-extra">${extra}</div>` : ""}
      <div class="stat-grid act-tiles">${tiles.join("")}</div>
      ${note ? `<p class="act-note muted">${note}</p>` : ""}`,
  });
}

function teLabel(k) {
  return ({ AEROBIC_BASE: "Endurance de base", RECOVERY: "Récupération", TEMPO: "Tempo", THRESHOLD: "Seuil", VO2MAX: "VO2max",
    ANAEROBIC_CAPACITY: "Capacité anaérobie", SPEED: "Vitesse", LACTATE_THRESHOLD: "Seuil lactique" })[k] || k.replace(/_/g, " ").toLowerCase();
}

// ---------------------------------------------------------------- HR zones
function zonesCard(a, zb) {
  const z = [a.z1, a.z2, a.z3, a.z4, a.z5].map((x) => x || 0);
  const tot = z.reduce((s, x) => s + x, 0);
  if (!tot) return card({ title: "Zones cardiaques", body: empty("Pas de fréquence cardiaque", "") });
  const max = Math.max(...z);
  const ranges = [`< ${zb[0]}`, `${zb[0]}–${zb[1] - 1}`, `${zb[1]}–${zb[2] - 1}`, `${zb[2]}–${zb[3] - 1}`, `≥ ${zb[3]}`];
  return card({
    title: "Zones cardiaques",
    sub: a.load_method === "avg_hr" ? "Approximation : toute la séance dans la zone de la FC moyenne" : "Temps passé dans chaque zone",
    body: `<div class="act-zones">${z.map((sec, i) => `
      <div class="act-zone" data-tip="${f.esc(`<b>${f.hm(sec)}</b> en ${ZONE_LABELS[i]} (${ranges[i]} bpm)`)}">
        <div class="act-zone-lbl"><b>${ZONE_LABELS[i].split(" ")[0]}</b> <span class="muted">${ZONE_LABELS[i].split(" ").slice(1).join(" ")}</span><span class="muted act-zone-rng">${ranges[i]}</span></div>
        <div class="act-zone-bar"><i style="width:${max ? (sec / max) * 100 : 0}%;background:${T.zones[i]}"></i></div>
        <div class="act-zone-val num">${sec >= 60 ? f.hm(sec) : sec ? "< 1 min" : "–"} <span class="muted">${f.num((sec / tot) * 100)} %</span></div>
      </div>`).join("")}</div>`,
  });
}

// ---------------------------------------------------------------- best efforts
function effortsCard(efforts) {
  const chip = (r) => r === 1 ? `<span class="chip act-pr">Record</span>` : r <= 3 ? `<span class="chip act-top">Top 3</span>` : r <= 10 ? `<span class="chip">Top 10</span>` : `<span class="muted num">#${f.num(r)}</span>`;
  return card({
    title: "Meilleurs efforts",
    sub: "Segments les plus rapides · rang sur tout l'historique · survole pour situer",
    body: `<div class="act-efforts">${efforts.map((e, k) => `
      <div class="act-effort" data-effort="${k}"><span class="act-ename">${f.esc(e.name)}</span>
      <span class="num">${f.duration(e.elapsed_time)}</span>
      <span class="num muted">${f.paceSec(e.elapsed_time / (e.distance / 1000))} /km</span>
      <span class="act-erank">${chip(e.rank)}</span></div>`).join("")}</div>`,
  });
}

// ---------------------------------------------------------------- map
function drawMap(view, s, v, zb, isRun) {
  const node = view.querySelector("#act-map");
  const map = L.map(node, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
  // OSM standard tiles, darkened in CSS (.act-map .leaflet-tile-pane) — no API key needed
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
  }).addTo(map);
  const pts = s.latlng.map((p, i) => (p ? [p[0], p[1], i] : null)).filter(Boolean);
  const layer = L.layerGroup().addTo(map);
  const bounds = L.latLngBounds(pts.map((p) => [p[0], p[1]]));
  map.fitBounds(bounds, { padding: [24, 24] });

  // quantile bins of speed (8 steps of the sequential ramp: slow = deep, fast = bright)
  const speeds = v ? pts.map((p) => v[p[2]]) : [];
  const qs = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((q) => pct(speeds, q));
  const ramp = T.seq.slice(1, 9);
  const binPace = (i) => { const x = v?.[i]; if (x == null) return 0; let b = 0; while (b < qs.length && x > qs[b]) b++; return b; };
  const hr = s.heartrate || [];

  function paint(mode) {
    layer.clearLayers();
    const colorOf = mode === "hr" ? (i) => T.zones[zoneOf(hr[i], zb)] : (i) => ramp[binPace(i)];
    const keyOf = mode === "hr" ? (i) => zoneOf(hr[i], zb) : binPace;
    let cur = [], key = null;
    const flush = () => { if (cur.length > 1) L.polyline(cur.map((p) => [p[0], p[1]]), { color: colorOf(cur[cur.length - 1][2]), weight: 4, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(layer); };
    // smooth the key over a short window so colours don't flicker
    for (let k = 0; k < pts.length; k++) {
      const kk = keyOf(pts[Math.min(pts.length - 1, k)][2]);
      if (key === null) key = kk;
      cur.push(pts[k]);
      if (kk !== key && cur.length >= 6) { flush(); cur = [pts[k]]; key = kk; }
    }
    flush();
    const first = pts[0], last = pts[pts.length - 1];
    L.circleMarker([last[0], last[1]], { radius: 6, color: T.surface, weight: 2, fillColor: T.text1, fillOpacity: 1 }).addTo(layer).bindTooltip("Arrivée");
    L.circleMarker([first[0], first[1]], { radius: 6, color: T.surface, weight: 2, fillColor: T.accent, fillOpacity: 1 }).addTo(layer).bindTooltip("Départ");
    const leg = view.querySelector("#act-maplegend");
    leg.innerHTML = mode === "hr"
      ? T.zones.map((c, i) => `<span><i style="background:${c}"></i>${ZONE_LABELS[i].split(" ")[0]}</span>`).join("")
      : `<span class="muted">${isRun ? "lent" : "lent"}</span>${ramp.map((c) => `<i class="act-ramp" style="background:${c}"></i>`).join("")}<span class="muted">rapide</span>
         <span class="act-mapkeys"><span><i class="act-dot" style="background:${T.accent}"></i>départ</span><span><i class="act-dot" style="background:${T.text1}"></i>arrivée</span></span>`;
  }
  paint("pace");
  onSeg(view, "mapcolor", paint);
  const marker = L.circleMarker([pts[0][0], pts[0][1]], { radius: 7, color: T.surface, weight: 3, fillColor: T.accent, fillOpacity: 1, opacity: 0 }).addTo(map);
  marker.setStyle({ fillOpacity: 0 });
  setTimeout(() => map.invalidateSize(), 50);
  return { map, marker };
}

// ---------------------------------------------------------------- stream small multiples
function drawStreams(view, ctx) {
  const { s, xs, xUnit, v, gap, panels, zb, lapsList, useDist, isRun, isBike, map, marker } = ctx;
  const n = xs.length;
  const H = 92, G = 42, top0 = 30;
  const grids = [], xAxes = [], yAxes = [], series = [];
  const fmtX = (x) => useDist ? `${f.num(x, 2)} km` : f.duration(x * 60);

  const paceArr = v ? v.map((x) => (x != null && x > (isRun ? 1.2 : 0.5) ? 1000 / x : null)) : [];
  const gapPace = gap ? gap.map((x) => (x != null && x > 1.2 ? 1000 / x : null)) : null;

  // time -> x (laps are given in seconds from start)
  const tArr = s.time || [];
  const xAtTime = (t) => interp(tArr, xs, t);

  const defs = {
    speed: !v ? null : {
      name: isRun ? "Allure (min/km)" : "Vitesse (km/h)", inverse: isRun,
      data: isRun ? paceArr : v.map((x) => (x == null ? null : x * 3.6)),
      color: T.pos, fmt: (y) => (isRun ? f.paceSec(y) : f.num(y)), steps: isRun ? [10, 15, 30, 60, 120, 300] : [2, 5, 10, 20],
      range: isRun ? [pct(paceArr, 0.02) - 10, pct(paceArr, 0.98) + 15] : [Math.max(0, pct(v, 0.02) * 3.6 - 3), pct(v, 0.99) * 3.6 + 2],
    },
    hr: { name: "Fréquence cardiaque (bpm)", data: s.heartrate, color: T.fatigue, fmt: (y) => f.num(y), steps: [5, 10, 20, 30, 40], range: [Math.max(50, pct(s.heartrate || [], 0.01) - 6), Math.min(220, pct(s.heartrate || [], 0.995) + 4)] },
    power: { name: "Puissance (W)", data: s.watts ? smooth(s.watts, 3) : null, color: T.fitness, fmt: (y) => f.num(y), steps: [25, 50, 100, 200, 250], range: [Math.max(0, pct(s.watts || [], 0.02) - 30), pct(s.watts || [], 0.99) + 30] },
    cadence: { name: isRun ? "Cadence (pas/min)" : "Cadence (tr/min)", data: s.cadence, color: T.text2, fmt: (y) => f.num(y), steps: [5, 10, 20, 40], range: [Math.max(0, pct(s.cadence || [], 0.03) - 6), pct(s.cadence || [], 0.99) + 4] },
    alt: { name: "Altitude (m)", data: s.altitude, color: T.text3, fmt: (y) => f.num(y), area: true, steps: [2, 5, 10, 20, 50, 100, 200, 500], range: [pct(s.altitude || [], 0) - 5, pct(s.altitude || [], 1) + 5] },
  };

  panels.forEach((p, gi) => {
    const def = defs[p];
    const top = top0 + gi * (H + G);
    grids.push({ left: 52, right: 30, top, height: H });
    xAxes.push({
      type: "value", gridIndex: gi, min: xs[0], max: xs[n - 1],
      axisLabel: { show: gi === panels.length - 1, formatter: (x) => useDist ? `${f.num(x, x % 1 ? 1 : 0)} km` : `${Math.round(x)} min`, color: T.text3, fontSize: 11, hideOverlap: true, showMaxLabel: false },
      axisLine: { show: gi === panels.length - 1, lineStyle: { color: T.axis } }, splitLine: { show: false }, axisTick: { show: false },
    });
    const [lo, hi] = def.range;
    yAxes.push({
      type: "value", gridIndex: gi, inverse: !!def.inverse, ...niceAxis(lo, hi, def.steps),
      name: def.name, nameLocation: def.inverse ? "start" : "end", nameGap: 10, nameTextStyle: { color: T.text2, fontSize: 12, align: "left", padding: [0, 0, 0, -44] },
      axisLabel: { formatter: (y) => def.fmt(y), color: T.text3, fontSize: 10 },
      splitLine: { lineStyle: { color: T.grid } },
    });
    const ser = {
      name: def.name, type: "line", xAxisIndex: gi, yAxisIndex: gi, showSymbol: false, sampling: "lttb", connectNulls: false,
      lineStyle: { width: p === "alt" ? 1.5 : 2, color: def.color }, itemStyle: { color: def.color },
      data: xs.map((x, i) => [x, def.data?.[i] ?? null]),
      emphasis: { disabled: true },
    };
    if (def.area) ser.areaStyle = { color: def.color, opacity: 0.12, origin: "start" };
    if (p === "hr" && zb.length === 4) {
      const edges = [def.range[0], ...zb, def.range[1]];
      ser.markArea = {
        silent: true,
        data: edges.slice(0, -1).map((lo2, i) => [{ yAxis: Math.max(lo2, def.range[0]), itemStyle: { color: T.zones[i], opacity: 0.09 } }, { yAxis: Math.min(edges[i + 1], def.range[1]) }])
          .filter(([a1, b1]) => b1.yAxis > a1.yAxis),
      };
    }
    if (p === "speed" && lapsList.some((l) => l.intensity === "active") && lapsList.some((l) => l.intensity === "rest")) {
      ser.markArea = {
        silent: true,
        data: lapsList.filter((l) => l.intensity === "active").map((l) => [{ xAxis: xAtTime(l.start_offset), itemStyle: { color: T.text1, opacity: 0.05 } }, { xAxis: xAtTime(l.start_offset + l.elapsed_time) }]),
      };
    }
    series.push(ser);
    // empty carrier series whose markArea highlights a hovered best effort
    series.push({ id: `hl${gi}`, type: "line", xAxisIndex: gi, yAxisIndex: gi, data: [], silent: true, markArea: { silent: true, data: [] } });
    if (p === "speed" && gapPace) {
      series.push({ name: "GAP", type: "line", xAxisIndex: gi, yAxisIndex: gi, showSymbol: false, sampling: "lttb",
        lineStyle: { width: 1.5, color: T.text3 }, itemStyle: { color: T.text3 }, emphasis: { disabled: true },
        data: xs.map((x, i) => [x, gapPace[i]]), z: 1 });
    }
  });

  const c = chart(view.querySelector("#act-streams"), {
    animation: false,
    grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    axisPointer: { link: [{ xAxisIndex: "all" }], snap: false, lineStyle: { color: T.text3 } },
    tooltip: {
      trigger: "axis", axisPointer: { type: "line" },
      formatter: (ps) => {
        if (!ps.length) return "";
        const i = nearest(xs, ps[0].axisValue);
        let html = ttTitle(`${fmtX(xs[i])}${useDist && tArr[i] != null ? ` · ${f.duration(tArr[i])}` : ""}`);
        panels.forEach((p) => {
          const def = defs[p];
          if (!def) return;
          const y = def.data?.[i];
          if (y != null) html += ttRow(def.color, def.fmt(y), def.name.replace(/ \(.*\)/, "").toLowerCase());
          if (p === "speed" && gapPace?.[i] != null) html += ttRow(T.text3, f.paceSec(gapPace[i]), "GAP");
        });
        if (s.grade_smooth?.[i] != null && useDist) html += `<div class="tt-row"><span class="tt-key" style="background:transparent"></span><span class="tt-val">${f.signed(s.grade_smooth[i], 1)} %</span><span>pente</span></div>`;
        return html;
      },
    },
  });
  // legend for the pace panel (2 series) — rendered as HTML under the title
  if (gapPace && panels.includes("speed")) {
    const leg = document.createElement("div");
    leg.className = "legend act-streamlegend";
    leg.innerHTML = `<span><i class="line" style="background:${T.pos}"></i>Allure réelle</span><span><i class="line" style="background:${T.text3}"></i>Allure ajustée au dénivelé (GAP)</span>`;
    view.querySelector("#act-streams").before(leg);
  }
  if (map && marker && s.latlng) {
    c.on("updateAxisPointer", (e) => {
      const ax = e.axesInfo && e.axesInfo[0];
      if (!ax) return;
      const i = nearest(xs, ax.value);
      let p = s.latlng[i];
      for (let k = 1; !p && k < 30; k++) p = s.latlng[i - k] || s.latlng[i + k];
      if (p) { marker.setLatLng(p); marker.setStyle({ fillOpacity: 1, opacity: 1 }); }
    });
    c.getZr().on("globalout", () => marker.setStyle({ fillOpacity: 0, opacity: 0 }));
  }
  return c;
}

// Hovering a best effort shades its span on every stream panel and traces it on the map.
function bindEffortHighlight(view, efforts, step, { xs, s, panels, streamsChart, map }) {
  let seg = null;
  const clear = () => {
    if (streamsChart) streamsChart.setOption({ series: panels.map((_, gi) => ({ id: `hl${gi}`, markArea: { data: [] } })) });
    if (seg) { seg.remove(); seg = null; }
  };
  view.querySelectorAll(".act-effort").forEach((row) => {
    row.addEventListener("mouseenter", () => {
      const e = efforts[Number(row.dataset.effort)];
      const i0 = Math.min(xs.length - 1, Math.round(e.start_index / step));
      const i1 = Math.min(xs.length - 1, Math.round(e.end_index / step));
      if (streamsChart) {
        streamsChart.setOption({ series: panels.map((_, gi) => ({
          id: `hl${gi}`, markArea: { silent: true, data: [[{ xAxis: xs[i0], itemStyle: { color: T.accent, opacity: 0.12 } }, { xAxis: xs[i1] }]] },
        })) });
      }
      if (map && s.latlng) {
        const pts = s.latlng.slice(i0, i1 + 1).filter(Boolean);
        if (pts.length > 1) seg = L.polyline(pts, { color: T.accent, weight: 7, opacity: 0.9, lineCap: "round" }).addTo(map);
      }
    });
    row.addEventListener("mouseleave", clear);
  });
}

// ---------------------------------------------------------------- laps / splits
function kmSplits(s, xs, step = 1) {
  const d = s.distance, t = s.time, hr = s.heartrate, alt = s.altitude, cad = s.cadence, w = s.watts;
  const out = [];
  let i0 = 0;
  const total = d[d.length - 1];
  const mean = (arr, a, b) => { if (!arr) return null; let sm = 0, k = 0; for (let i = a; i <= b; i++) if (arr[i] != null) { sm += arr[i]; k++; } return k ? sm / k : null; };
  for (let km = 1; km * 1000 * step <= total + 1; km++) {
    let i1 = i0;
    while (i1 < d.length - 1 && d[i1] < km * 1000 * step) i1++;
    const dist = d[i1] - d[i0], el = t[i1] - t[i0];
    out.push({ lap_index: km - 1, intensity: "active", distance: dist, elapsed_time: el, avg_speed: dist / el, avg_hr: mean(hr, i0, i1),
      max_hr: hr ? Math.max(...hr.slice(i0, i1 + 1).filter((x) => x != null)) : null, avg_cadence: mean(cad, i0, i1), avg_power: mean(w, i0, i1),
      elev_gain: alt ? alt[i1] - alt[i0] : null, _delta: true, start_offset: t[i0] });
    i0 = i1;
  }
  const rest = total - (d[i0] || 0);
  if (rest > 150 * step) {
    const i1 = d.length - 1, el = t[i1] - t[i0];
    out.push({ lap_index: out.length, intensity: "active", distance: rest, elapsed_time: el, avg_speed: rest / el, avg_hr: mean(hr, i0, i1),
      max_hr: hr ? Math.max(...hr.slice(i0).filter((x) => x != null)) : null, avg_cadence: mean(cad, i0, i1), avg_power: mean(w, i0, i1),
      elev_gain: alt ? alt[i1] - alt[i0] : null, _delta: true, start_offset: t[i0] });
  }
  return out;
}

function setupLaps(view, ctx) {
  const { s, xs, zb, lapsList, useDist, isRun } = ctx;
  let mode = lapsList.length > 1 ? "laps" : "km";
  const draw = () => {
    const laps = mode === "km" ? kmSplits(s, xs, ctx.isBike ? 5 : 1) : lapsList;
    drawLaps(view, laps, zb, isRun, mode);
    lapTable(view, laps, isRun, mode);
  };
  onSeg(view, "lapmode", (m) => { mode = m; draw(); });
  draw();
}

function drawLaps(view, laps, zb, isRun, mode) {
  let x = 0;
  const rows = laps.filter((l) => l.distance > 0 && l.avg_speed).map((l) => {
    const r = { ...l, x0: x / 1000, x1: (x + l.distance) / 1000, zone: zoneOf(l.avg_hr, zb) };
    x += l.distance;
    return r;
  });
  const nActive = rows.filter((r) => r.intensity === "active").length;
  const node = view.querySelector("#act-lapchart");
  const old = echarts.getInstanceByDom(node);
  const maxV = Math.max(...rows.map((r) => r.avg_speed)) * 1.12;
  // ticks at round paces (or round km/h) — speed axis, so pace ticks are not evenly spaced
  let ticks = [];
  const minV = Math.min(...rows.map((r) => r.avg_speed));
  const lowV = Math.max(maxV * 0.4, minV * 0.85);
  if (isRun) {
    for (const st of [15, 30, 60, 120]) {
      ticks = [];
      for (let p = 120; p <= 1200; p += st) { const sp = 1000 / p; if (sp < maxV * 0.98 && sp >= lowV) ticks.push(sp); }
      if (ticks.length <= 4) break;
    }
  } else {
    for (const st of [2, 5, 10, 20]) {
      ticks = [];
      for (let k = st; k / 3.6 < maxV * 0.98; k += st) if (k / 3.6 >= lowV) ticks.push(k / 3.6);
      if (ticks.length <= 4) break;
    }
  }
  ticks = ticks.sort((p, q) => p - q).filter((t, i, arr) => i === 0 || t - arr[i - 1] >= maxV * 0.08);
  const opt = {
    animation: false,
    grid: { left: 52, right: 30, top: 22, bottom: 26 },
    xAxis: { type: "value", min: 0, max: rows.length ? rows[rows.length - 1].x1 : 1, axisLabel: { formatter: (v) => `${f.num(v, v % 1 ? 1 : 0)} km`, color: T.text3, hideOverlap: true, showMaxLabel: false }, splitLine: { show: false }, axisLine: { lineStyle: { color: T.axis } } },
    yAxis: { type: "value", min: 0, max: maxV, axisLabel: { customValues: ticks, formatter: (v) => (isRun ? f.pace(v) : `${f.num(v * 3.6)} km/h`), color: T.text3 },
      axisTick: { show: false, customValues: ticks }, splitLine: { show: true, lineStyle: { color: T.grid } } },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return ttTitle(`${mode === "km" ? (isRun ? `Km ${r.lap_index + 1}` : `Tranche ${r.lap_index + 1}`) : `Tour ${r.lap_index + 1} · ${LAP_TYPES[r.intensity] || r.intensity}`}`)
          + ttRow(T.zones[r.zone], isRun ? `${f.pace(r.avg_speed)} /km` : `${f.kmh(r.avg_speed)} km/h`, `sur ${f.num(r.distance)} m`, true)
          + `<div class="tt-row"><span class="tt-key" style="background:transparent"></span><span class="tt-val">${f.duration(r.elapsed_time)}</span><span>durée</span></div>`
          + (r.avg_hr ? `<div class="tt-row"><span class="tt-key" style="background:transparent"></span><span class="tt-val">${f.num(r.avg_hr)} bpm</span><span>FC moy. (${ZONE_LABELS[r.zone]})</span></div>` : "");
      },
    },
    series: [{
      type: "custom", z: 2,
      data: rows.map((r) => [r.x0, r.x1, r.avg_speed, r.zone, r.intensity === "rest" || r.intensity === "recovery" ? 1 : 0]),
      encode: { x: [0, 1], y: 2 },
      renderItem: (params, apiR) => {
        const p0 = apiR.coord([apiR.value(0), 0]);
        const p1 = apiR.coord([apiR.value(1), apiR.value(2)]);
        const w = Math.max(1, p1[0] - p0[0] - 2);
        const rest = apiR.value(4) === 1;
        const shape = { x: p0[0] + 1, y: p1[1], width: w, height: p0[1] - p1[1], r: w > 8 ? [4, 4, 0, 0] : 0 };
        const fill = rest ? T.surface3 : T.zones[apiR.value(3)];
        const children = [{ type: "rect", shape, style: { fill } }];
        const r = rows[params.dataIndex];
        if (!rest && w >= 38 && (mode === "laps" ? nActive <= 16 : rows.length <= 25)) {
          children.push({ type: "text", style: { text: isRun ? f.pace(r.avg_speed) : f.kmh(r.avg_speed), x: p0[0] + 1 + w / 2, y: p1[1] - 4, fill: T.text2, font: "11px Segoe UI, system-ui", align: "center", verticalAlign: "bottom" } });
        }
        return { type: "group", children };
      },
    }],
  };
  if (old) old.setOption(opt, true); else chart(node, opt);
}

function lapTable(view, laps, isRun, mode) {
  const box = view.querySelector("#act-laptable");
  const hasP = laps.some((l) => l.avg_power), hasC = laps.some((l) => l.avg_cadence);
  box.innerHTML = `<table class="data act-lt"><thead><tr>
    <th>${mode === "km" ? "Km" : "Tour"}</th>${mode === "laps" ? "<th>Type</th>" : ""}<th class="r">Distance</th><th class="r">Durée</th>
    <th class="r">${isRun ? "Allure" : "Vitesse"}</th><th class="r">FC moy.</th><th class="r">FC max</th>${hasC ? `<th class="r">Cadence</th>` : ""}${hasP ? `<th class="r">Puiss.</th>` : ""}<th class="r">${mode === "km" ? "Δ alt." : "D+"}</th></tr></thead>
    <tbody>${laps.map((l) => {
      const rest = l.intensity === "rest" || l.intensity === "recovery";
      return `<tr class="${rest ? "act-rest" : ""}" style="cursor:default"><td>${l.lap_index + 1}</td>${mode === "laps" ? `<td>${LAP_TYPES[l.intensity] || f.esc(l.intensity)}</td>` : ""}
      <td class="r">${l.distance >= 1000 ? `${f.km(l.distance, 2)} km` : `${f.num(l.distance)} m`}</td><td class="r">${f.duration(l.elapsed_time)}</td>
      <td class="r"><b>${isRun ? f.pace(l.avg_speed) : f.kmh(l.avg_speed)}</b></td><td class="r">${f.num(l.avg_hr)}</td><td class="r">${f.num(l.max_hr)}</td>
      ${hasC ? `<td class="r">${f.num(l.avg_cadence)}</td>` : ""}${hasP ? `<td class="r">${f.num(l.avg_power)}</td>` : ""}
      <td class="r">${l.elev_gain == null ? "–" : mode === "km" ? f.signed(l.elev_gain) : f.num(l.elev_gain)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- comparison
function drawCompare(view, a, similar, isRun) {
  const pts = similar.filter((x) => x.avg_hr && x.avg_speed);
  const all = [...pts, a];
  const dates = all.map((x) => f.parseDate(x.date).getTime());
  const dmin = Math.min(...dates), dmax = Math.max(...dates);
  const ramp = T.seq.slice(1, 9);
  const colorOf = (x) => ramp[Math.round(((f.parseDate(x.date).getTime() - dmin) / Math.max(1, dmax - dmin)) * (ramp.length - 1))];
  const yOf = (x) => (isRun ? 1000 / x.avg_speed : x.avg_speed * 3.6);
  const hrs = all.map((x) => x.avg_hr), ys = all.map(yOf);
  // clean tick steps (pace in 5/10/15/30 s, HR in 2/5/10 bpm)
  const nice = (lo, hi, steps) => {
    const span = Math.max(hi - lo, 1e-6);
    const step = steps.find((st) => span / st <= 5) || steps[steps.length - 1];
    return { min: Math.floor((lo - span * 0.06) / step) * step, max: Math.ceil((hi + span * 0.06) / step) * step, interval: step };
  };
  const xr = nice(Math.min(...hrs), Math.max(...hrs), [2, 5, 10, 20]);
  const yr = nice(Math.min(...ys), Math.max(...ys), isRun ? [5, 10, 15, 30, 60, 120] : [0.5, 1, 2, 5, 10]);

  // OLS of y on HR among similar sessions: residual = how much faster than expected at that HR
  let foot = "";
  if (pts.length >= 8) {
    const xm = pts.reduce((s, x) => s + x.avg_hr, 0) / pts.length, ym = pts.reduce((s, x) => s + yOf(x), 0) / pts.length;
    const sxy = pts.reduce((s, x) => s + (x.avg_hr - xm) * (yOf(x) - ym), 0), sxx = pts.reduce((s, x) => s + (x.avg_hr - xm) ** 2, 0);
    if (sxx > 0) {
      const b = sxy / sxx, c0 = ym - b * xm;
      const res = yOf(a) - (c0 + b * a.avg_hr);
      foot = isRun
        ? `À FC égale, cette séance est <b>${f.num(Math.abs(res))} s/km ${res < 0 ? "plus rapide" : "plus lente"}</b> que la tendance de tes ${pts.length} séances similaires.`
        : `À FC égale, cette séance est <b>${f.num(Math.abs(res), 1)} km/h ${res > 0 ? "plus rapide" : "plus lente"}</b> que la tendance de tes ${pts.length} séances similaires.`;
      foot += ` <span class="muted">(régression linéaire ${isRun ? "allure" : "vitesse"} ~ FC)</span>`;
    }
  }
  chart(view.querySelector("#act-compare"), {
    animation: false,
    grid: { left: 52, right: 16, top: 16, bottom: 34 },
    xAxis: { type: "value", ...xr, name: "FC moyenne (bpm)", nameLocation: "middle", nameGap: 24, nameTextStyle: { color: T.text3 }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: { type: "value", inverse: isRun, ...yr, axisLabel: { formatter: (y) => (isRun ? f.paceSec(y) : f.num(y, yr.interval < 1 ? 1 : 0)) } },
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const x = p.seriesIndex === 1 ? a : pts[p.dataIndex];
        return ttTitle(f.dateDay(x.date)) + `<b>${f.esc(x.strava?.name || x.name || "")}</b>`
          + ttRow(p.color, isRun ? `${f.pace(x.avg_speed)} /km` : `${f.kmh(x.avg_speed)} km/h`, `· ${f.num(x.avg_hr)} bpm · ${f.km(x.distance)} km`, true);
      },
    },
    series: [
      { type: "scatter", symbolSize: 10, data: pts.map((x) => ({ value: [x.avg_hr, yOf(x)], itemStyle: { color: colorOf(x), borderColor: T.surface, borderWidth: 2 } })) },
      { type: "scatter", symbolSize: 16, z: 5, data: [{ value: [a.avg_hr, yOf(a)], itemStyle: { color: T.accent, borderColor: T.surface, borderWidth: 3 } }],
        label: { show: true, formatter: "cette séance", position: "right", color: T.text1, fontSize: 12, fontWeight: 600 } },
    ],
  });
  view.querySelector("#act-compare-foot").innerHTML = `
    <div class="legend"><span class="muted">plus ancienne</span>${ramp.map((c) => `<i class="act-ramp" style="background:${c}"></i>`).join("")}<span class="muted">plus récente</span>
    <span><i class="act-dot" style="background:${T.accent}"></i>cette séance</span></div>${foot ? `<p class="act-foot">${foot}</p>` : ""}`;
}

// ---------------------------------------------------------------- power curve
function drawPower(curve) {
  const pts = Object.entries(curve).map(([k, w]) => [Number(k), w]).sort((p, q) => p[0] - q[0]);
  const lbl = (sec) => (sec < 60 ? `${sec} s` : sec < 3600 ? `${sec / 60} min` : `${sec / 3600} h`);
  chart("#act-power", {
    animation: false,
    grid: { left: 52, right: 16, top: 16, bottom: 30 },
    xAxis: { type: "log", logBase: 10, min: pts[0][0], max: pts[pts.length - 1][0], axisLabel: { formatter: (x) => lbl(x) }, splitLine: { show: false } },
    yAxis: { type: "value", axisLabel: { formatter: (y) => `${y} W` } },
    tooltip: { trigger: "axis", formatter: (ps) => ttTitle(lbl(ps[0].value[0])) + ttRow(T.fitness, `${f.num(ps[0].value[1])} W`, "puissance moyenne max") },
    series: [{ type: "line", data: pts, color: T.fitness, symbol: "circle", symbolSize: 8, showSymbol: true, itemStyle: { borderColor: T.surface, borderWidth: 2 }, areaStyle: { color: T.fitness, opacity: 0.1 } }],
  });
}
