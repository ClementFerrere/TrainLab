import { api, qs } from "../api.js";
import { T, SPORTS, SPORT_ORDER, sport, sportIcon, ttRow, ttTitle } from "../theme.js";
import { card, chart, stat, empty, seg, onSeg, routeSvg } from "../ui.js";
import * as f from "../fmt.js";

// Filters survive navigation to an activity and back (module state).
const state = {
  period: "91", sport: "", q: "", metric: "hours",
  month: null, sortKey: "start_local", sortDir: -1, shown: 60, wall: 72,
};

const PERIODS = [["28", "4 sem"], ["91", "3 mois"], ["182", "6 mois"], ["365", "1 an"], ["all", "Tout"]];
const METRICS = [["hours", "Heures"], ["km", "Km"], ["load", "Charge"]];

// Reuse a chart instance when re-rendering inside the page (filters change).
function draw(node, option) {
  if (typeof node === "string") node = document.querySelector(node);
  if (!node) return null;
  const inst = echarts.getInstanceByDom(node);
  if (inst) { inst.setOption(option, true); return inst; }
  return chart(node, option);
}

const startOf = (period) => (period === "all" ? null : f.isoDate(f.addDays(f.today(), -Number(period) + 1)));

export async function render(view) {
  if (!state.month) state.month = new Date(f.today().getFullYear(), f.today().getMonth(), 1);

  view.innerHTML = `
    <div class="filters j-filters">
      ${seg("period", PERIODS, state.period)}
      <div class="j-sports" id="j-sports"></div>
      <label class="j-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input class="input" id="j-q" type="search" placeholder="Rechercher une séance (nom, lieu…)" value="${f.esc(state.q)}"></label>
    </div>
    <div class="grid">
      <div class="span-8">${card({ title: "Volume hebdomadaire", sub: "Empilé par sport — chaque barre est une semaine (lundi → dimanche)", actions: seg("metric", METRICS, state.metric), body: `<div class="chart" id="j-weekly" style="height:300px"></div><div class="legend" id="j-weekly-legend"></div>` })}</div>
      <div class="span-4">${card({ title: "Sur la période", id: "j-summary", body: "" })}</div>
      <div class="span-12">${card({ title: "", id: "j-cal", body: "" })}</div>
      <div class="span-12">${card({ title: "Séances", id: "j-table", body: "" })}</div>
      <div class="span-12">${card({ title: "Mur de tracés", sub: "Chaque forme est une séance avec GPS — survole pour le détail, clique pour l'ouvrir", id: "j-wall", body: "" })}</div>
    </div>`;

  onSeg(view, "period", (v) => { state.period = v; state.shown = 60; refresh(); });
  onSeg(view, "metric", (v) => { state.metric = v; drawWeekly(); });
  let t;
  view.querySelector("#j-q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); state.shown = 60; refresh(); }, 280);
  });

  let acts = [];
  let routes = null;

  async function refresh() {
    view.querySelector(".grid").classList.add("j-dim");
    acts = await api.get(`/api/activities${qs({ start: startOf(state.period), sport: state.sport, q: state.q, limit: 6000 })}`);
    view.querySelector(".grid").classList.remove("j-dim");
    renderSportChips();
    drawWeekly();
    renderSummary();
    renderTable();
    renderWall();
    renderCalendar();
  }

  // ---------------------------------------------------------------- sport chips
  function renderSportChips() {
    const box = view.querySelector("#j-sports");
    const opts = [["", "Tous"], ...SPORT_ORDER.map((k) => [k, SPORTS[k].label])];
    box.innerHTML = opts.map(([k, l]) => `<button type="button" class="j-chip ${state.sport === k ? "on" : ""}" data-s="${k}">
      ${k ? `<span class="sw" style="background:${sport(k).color}"></span>` : ""}${l}</button>`).join("");
    box.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.sport = b.dataset.s;
      state.shown = 60;
      refresh();
    };
  }

  // ---------------------------------------------------------------- weekly stacked bars
  function drawWeekly() {
    const node = view.querySelector("#j-weekly");
    if (!acts.length) {
      echarts.getInstanceByDom(node)?.clear();
      view.querySelector("#j-weekly-legend").innerHTML = `<span class="muted">Aucune séance sur cette sélection.</span>`;
      return;
    }
    const first = f.mondayOf(f.parseDate(startOf(state.period) || acts[acts.length - 1].date));
    const last = f.mondayOf(f.today());
    const weeks = [];
    for (let d = first; d <= last; d = f.addDays(d, 7)) weeks.push(f.isoDate(d));
    const idx = Object.fromEntries(weeks.map((w, i) => [w, i]));
    const val = (a) => state.metric === "hours" ? (a.moving_time || 0) / 3600 : state.metric === "km" ? (a.distance || 0) / 1000 : (a.load || 0);
    const present = SPORT_ORDER.filter((k) => acts.some((a) => a.sport === k && val(a) > 0));
    const mat = Object.fromEntries(present.map((k) => [k, new Array(weeks.length).fill(0)]));
    for (const a of acts) {
      const w = f.isoDate(f.mondayOf(f.parseDate(a.date)));
      if (idx[w] !== undefined && mat[a.sport]) mat[a.sport][idx[w]] += val(a);
    }
    // top segment of each week gets the rounded data-end
    const top = weeks.map((_, i) => [...present].reverse().find((k) => mat[k][i] > 0));
    const unit = { hours: "h", km: "km", load: "" }[state.metric];
    const fmtv = (v) => state.metric === "load" ? f.num(v) : f.num(v, 1);
    const totals = weeks.map((_, i) => present.reduce((s, k) => s + mat[k][i], 0));
    draw(node, {
      animation: false,
      grid: { left: 40, right: 8, top: 14, bottom: 26 },
      tooltip: {
        trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(255,255,255,0.04)" } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const rows = present.filter((k) => mat[k][i] > 0).reverse().map((k) => ttRow(sport(k).color, `${fmtv(mat[k][i])} ${unit}`, sport(k).label, true)).join("");
          return ttTitle(`Semaine du ${f.dateShort(weeks[i])}`) + `<div class="tt-row"><span class="tt-val">${fmtv(totals[i])} ${unit}</span><span>au total</span></div>` + rows;
        },
      },
      xAxis: { type: "category", data: weeks, axisLabel: { formatter: (v) => f.dateShort(v), hideOverlap: true } },
      yAxis: { type: "value", splitNumber: 4, axisLabel: { formatter: (v) => `${v}${unit ? " " + unit : ""}` } },
      series: present.map((k) => ({
        name: sport(k).label, type: "bar", stack: "v", barMaxWidth: 24,
        itemStyle: { color: sport(k).color, borderColor: T.surface, borderWidth: 1 },
        emphasis: { focus: "series" },
        data: mat[k].map((v, i) => ({ value: v ? +v.toFixed(2) : 0, itemStyle: { borderRadius: top[i] === k ? [4, 4, 0, 0] : 0 } })),
      })),
    });
    view.querySelector("#j-weekly-legend").innerHTML = present.map((k) => `<span><i style="background:${sport(k).color}"></i>${sport(k).label}</span>`).join("");
  }

  // ---------------------------------------------------------------- summary
  function renderSummary() {
    const box = view.querySelector("#j-summary");
    const body = box.querySelector(".card-head") ? box : box;
    const sum = (fn, arr = acts) => arr.reduce((s, a) => s + (fn(a) || 0), 0);
    const runs = acts.filter((a) => a.sport === "run");
    const nWeeks = Math.max(1, (state.period === "all" && acts.length
      ? (f.today() - f.parseDate(acts[acts.length - 1].date)) / 864e5 + 1 : Number(state.period)) / 7);
    const hours = sum((a) => a.moving_time) / 3600;
    const bySport = SPORT_ORDER.map((k) => [k, sum((a) => a.moving_time, acts.filter((a) => a.sport === k)) / 3600]).filter(([, h]) => h > 0);
    const maxH = Math.max(...bySport.map(([, h]) => h), 1);
    const longest = runs.reduce((m, a) => (a.distance > (m?.distance || 0) ? a : m), null);
    body.innerHTML = `
      <div class="card-head"><div><h2>Sur la période</h2><div class="sub">${state.period === "all" ? "Tout l'historique" : `${PERIODS.find((p) => p[0] === state.period)[1]} glissants`}${state.sport ? ` · ${sport(state.sport).label}` : ""}</div></div></div>
      <div class="stat-grid three">
        ${stat("Séances", f.num(acts.length), "", `${f.num(acts.length / nWeeks, 1)} / sem.`)}
        ${stat("Volume", f.num(hours, 0), "h", `${f.num(hours / nWeeks, 1)} h / sem.`)}
        ${stat("Course", f.num(sum((a) => a.distance, runs) / 1000, 0), "km", `${f.num(sum((a) => a.distance, runs) / 1000 / nWeeks, 1)} km / sem.`)}
        ${stat("Dénivelé +", f.num(sum((a) => a.elev_gain)), "m")}
        ${stat("Charge", f.num(sum((a) => a.load)), "", `${f.num(sum((a) => a.load) / nWeeks)} / sem.`)}
        ${stat("Plus longue", longest ? f.km(longest.distance) : "–", longest ? "km" : "", longest ? f.dateShort(longest.date) : "")}
      </div>
      <div class="j-split">
        <div class="eyebrow" style="margin:16px 0 8px">Répartition du temps</div>
        ${bySport.map(([k, h]) => `<div class="j-split-row" data-tip="${f.esc(`<b>${f.num(h, 1)} h</b> ${sport(k).label} · ${f.num((h / hours) * 100)} %`)}">
          <span class="j-split-lbl">${sport(k).label}</span>
          <span class="j-split-bar"><i style="width:${(h / maxH) * 100}%;background:${sport(k).color}"></i></span>
          <span class="j-split-val num">${f.num(h, h < 10 ? 1 : 0)} h <span class="muted">${f.num((h / hours) * 100)} %</span></span></div>`).join("") || `<span class="muted">—</span>`}
      </div>`;
  }

  // ---------------------------------------------------------------- month calendar
  async function renderCalendar() {
    const box = view.querySelector("#j-cal");
    const m0 = state.month;
    const gridStart = f.mondayOf(m0);
    const mEnd = new Date(m0.getFullYear(), m0.getMonth() + 1, 0);
    const gridEnd = f.addDays(f.mondayOf(mEnd), 6);
    let rows = await api.get(`/api/calendar${qs({ start: f.isoDate(gridStart), end: f.isoDate(gridEnd) })}`);
    if (state.sport) rows = rows.filter((a) => a.sport === state.sport);
    if (state.q) {
      const q = state.q.toLowerCase();
      rows = rows.filter((a) => (a.strava?.name || a.name || "").toLowerCase().includes(q));
    }
    const byDay = {};
    rows.forEach((a) => (byDay[a.date] ||= []).push(a));
    const todayIso = f.isoDate(f.today());
    let weeksHtml = "";
    for (let w = gridStart; w <= gridEnd; w = f.addDays(w, 7)) {
      let cells = "", wh = 0, wkm = 0, wload = 0;
      for (let i = 0; i < 7; i++) {
        const d = f.addDays(w, i), iso = f.isoDate(d);
        const list = byDay[iso] || [];
        list.forEach((a) => { wh += (a.moving_time || 0) / 3600; if (a.sport === "run") wkm += (a.distance || 0) / 1000; wload += a.load || 0; });
        const pills = list.map((a) => {
          const sp = sport(a.sport);
          const name = a.strava?.name || a.name || sp.label;
          const main = a.distance > 0 ? `${f.km(a.distance)} km` : f.hm(a.moving_time);
          return `<a class="pill ${a.is_race ? "j-race" : ""}" href="#/activity/${a.id}" style="--c:${sp.color}"
            data-tip="${f.esc(`${ttTitle(f.dateDay(a.date))}<b>${f.esc(name)}</b><br>${main} · ${f.hm(a.moving_time)} · charge ${f.num(a.load)}`)}">
            <span class="pill-ic">${sportIcon(a.sport, 13)}</span><span class="pill-t">${main}</span></a>`;
        }).join("");
        cells += `<div class="j-day ${d.getMonth() !== m0.getMonth() ? "out" : ""} ${iso === todayIso ? "today" : ""}">
          <div class="j-dnum">${d.getDate()}</div><div class="j-pills">${pills}</div></div>`;
      }
      weeksHtml += wh > 0 ? `${cells}<div class="j-wtot">
        <div><b>${f.num(wh, 1)}</b> h</div>
        ${wkm ? `<div><b>${f.num(wkm, wkm < 100 ? 1 : 0)}</b> km</div>` : ""}
        <div class="muted">charge ${f.num(wload)}</div></div>` : `${cells}<div class="j-wtot"><span class="muted">—</span></div>`;
    }
    box.innerHTML = `
      <div class="card-head">
        <div><h2>Calendrier</h2><div class="sub">Clique sur une séance pour l'ouvrir · totaux hebdo à droite</div></div>
        <div class="actions j-monthnav">
          <button class="btn" data-m="-1" aria-label="Mois précédent"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
          <span class="j-month">${f.monthLabel(m0)}</span>
          <button class="btn" data-m="1" aria-label="Mois suivant"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
          <button class="btn" data-m="0">Aujourd'hui</button>
        </div>
      </div>
      <div class="j-cal">
        ${["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((x) => `<div class="j-dh">${x}</div>`).join("")}<div class="j-dh">Semaine</div>
        ${weeksHtml}
      </div>`;
    box.querySelector(".j-monthnav").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const k = Number(b.dataset.m);
      const t0 = f.today();
      state.month = k === 0 ? new Date(t0.getFullYear(), t0.getMonth(), 1) : new Date(m0.getFullYear(), m0.getMonth() + k, 1);
      renderCalendar();
    };
  }

  // ---------------------------------------------------------------- table
  const COLS = [
    ["start_local", "Date", (a) => `${f.dateDay(a.date)} <span class="muted">${f.timeOf(a.start_local)}</span>`],
    ["name", "Séance", (a) => `<span class="j-tname"><span class="sw sw-${a.sport}"></span>${f.esc(a.strava?.name || a.name || "")}${a.is_race ? ` <span class="chip j-racechip">Course</span>` : ""}</span>`],
    ["sport", "Sport", (a) => sport(a.sport).label],
    ["distance", "Distance", (a) => a.distance > 0 ? `${f.km(a.distance)} km` : "–", "r"],
    ["moving_time", "Durée", (a) => f.hm(a.moving_time), "r"],
    ["avg_speed", "Allure / vitesse", (a) => a.sport === "run" ? `${f.pace(a.avg_speed)} /km` : a.sport === "swim" ? `${f.pace100(a.avg_speed)} /100 m` : a.distance > 0 ? `${f.kmh(a.avg_speed)} km/h` : "–", "r"],
    ["avg_hr", "FC", (a) => a.avg_hr ? `${f.num(a.avg_hr)}` : "–", "r"],
    ["load", "Charge", (a) => f.num(a.load), "r"],
    ["aerobic_te", "TE", (a) => a.aerobic_te ? f.num(a.aerobic_te, 1) : "–", "r"],
    ["rpe", "RPE", (a) => a.rpe ? f.num(a.rpe) : "–", "r"],
  ];

  function renderTable() {
    const box = view.querySelector("#j-table");
    const k = state.sortKey, dir = state.sortDir;
    const sorted = [...acts].sort((a, b) => {
      const va = a[k] ?? (typeof a[k] === "string" ? "" : -Infinity), vb = b[k] ?? -Infinity;
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
    const rows = sorted.slice(0, state.shown);
    box.innerHTML = `
      <div class="card-head"><div><h2>Séances</h2><div class="sub">${f.num(acts.length)} séance${acts.length > 1 ? "s" : ""} · clique sur un en-tête pour trier</div></div></div>
      ${acts.length ? `<div class="table-wrap j-tablewrap"><table class="data">
        <thead><tr>${COLS.map(([key, label, , cls]) => `<th class="sortable ${cls || ""}" data-k="${key}">${label}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((a) => `<tr data-id="${a.id}">${COLS.map(([key, , fn, cls]) => `<td class="${key === "name" ? "name" : ""} ${cls || ""}">${fn(a)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      ${acts.length > state.shown ? `<div class="j-more"><button class="btn" id="j-more">Afficher ${Math.min(100, acts.length - state.shown)} de plus</button></div>` : ""}`
      : empty("Aucune séance", "Élargis la période ou retire un filtre.")}`;
    box.querySelector("thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      if (state.sortKey === th.dataset.k) state.sortDir *= -1;
      else { state.sortKey = th.dataset.k; state.sortDir = th.dataset.k === "name" || th.dataset.k === "sport" ? 1 : -1; }
      renderTable();
    });
    box.querySelector("tbody")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (tr) location.hash = `#/activity/${tr.dataset.id}`;
    });
    box.querySelector("#j-more")?.addEventListener("click", () => { state.shown += 100; renderTable(); });
  }

  // ---------------------------------------------------------------- route wall
  async function renderWall() {
    const box = view.querySelector("#j-wall");
    if (!routes) routes = await api.get("/api/routes?limit=5000");
    const ids = new Set(acts.map((a) => a.id));
    const list = routes.filter((r) => ids.has(r.id));
    const head = `<div class="card-head"><div><h2>Mur de tracés</h2><div class="sub">Chaque forme est une séance GPS · survole pour le détail, clique pour l'ouvrir</div></div>
      <div class="actions"><span class="chip">${f.num(list.length)} tracé${list.length > 1 ? "s" : ""}</span></div></div>`;
    if (!list.length) { box.innerHTML = head + empty("Aucun tracé GPS", "Les séances sans GPS (piscine, renfo, padel) n'apparaissent pas ici."); return; }
    const shown = list.slice(0, state.wall);
    box.innerHTML = head + `<div class="j-wall">${shown.map((r) => {
      const sp = sport(r.sport);
      return `<a class="j-tile" href="#/activity/${r.id}" data-tip="${f.esc(`${ttTitle(f.dateDay(r.date))}<b>${f.esc(r.name || sp.label)}</b><br>${f.km(r.distance)} km`)}">
        ${routeSvg(r.route, { w: 96, h: 72, color: sp.color, stroke: 1.8 })}
        <span class="j-tile-cap"><span>${f.dateShort(r.date)}</span><span class="num">${f.km(r.distance, 1)} km</span></span></a>`;
    }).join("")}</div>
    ${list.length > shown.length ? `<div class="j-more"><button class="btn" id="j-wall-more">Afficher plus (${f.num(list.length - shown.length)} restants)</button></div>` : ""}`;
    box.querySelector("#j-wall-more")?.addEventListener("click", () => { state.wall += 96; renderWall(); });
  }

  await refresh();
}
