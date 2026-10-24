// Chart tokens (mirrors css/app.css) + sport metadata + ECharts theme.
const css = getComputedStyle(document.documentElement);
const v = (name) => css.getPropertyValue(name).trim();

export const T = {
  page: v("--page"), surface: v("--surface-1"), surface2: v("--surface-2"), surface3: v("--surface-3"),
  text1: v("--text-1"), text2: v("--text-2"), text3: v("--text-3"),
  grid: v("--grid"), axis: v("--axis"), accent: v("--accent"),
  fitness: v("--m-fitness"), fatigue: v("--m-fatigue"),
  pos: v("--div-pos"), neg: v("--div-neg"), mid: v("--div-mid"),
  good: v("--good"), warning: v("--warning"), serious: v("--serious"), critical: v("--critical"),
  deep: v("--sl-deep"), light: v("--sl-light"), rem: v("--sl-rem"), awake: v("--sl-awake"),
  zones: [v("--z1"), v("--z2"), v("--z3"), v("--z4"), v("--z5")],
  // sequential blue ramp, dark mode: near-surface -> bright
  seq: ["#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4"],
};

export const SPORTS = {
  run: { label: "Course", color: v("--s-run"), icon: "M13 4a2 2 0 1 0 0 .1M7 21l3-6 3 2 1 4M10 15l1-5 4 2 3-1M8 9l3-1" },
  bike: { label: "Vélo", color: v("--s-bike"), icon: "M6 17a3 3 0 1 0 0 .1M18 17a3 3 0 1 0 0 .1M6 17l4-7h5l3 7M10 10l-1-3H7M15 10l-2 7" },
  swim: { label: "Natation", color: v("--s-swim"), icon: "M3 17c2 0 2-1.5 4.5-1.5S9.5 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17M7 13l4-5 4 2M16 7a1.6 1.6 0 1 0 0 .1" },
  strength: { label: "Renfo", color: v("--s-strength"), icon: "M4 10v4M7 8v8M17 8v8M20 10v4M7 12h10" },
  racket: { label: "Padel", color: v("--s-racket"), icon: "M10 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM13.5 12.5L20 19M18 6a1.4 1.4 0 1 0 0 .1" },
  other: { label: "Autre", color: v("--s-other"), icon: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" },
};
export const SPORT_ORDER = ["run", "bike", "swim", "strength", "racket", "other"];
export const sport = (k) => SPORTS[k] || SPORTS.other;

export function sportIcon(k, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${sport(k).icon}"/></svg>`;
}

export const ZONE_LABELS = ["Z1 récup", "Z2 endurance", "Z3 tempo", "Z4 seuil", "Z5 VO2max"];

// ---------------------------------------------------------------- ECharts base
export const AXIS = {
  axisLine: { lineStyle: { color: T.axis } },
  axisTick: { show: false },
  axisLabel: { color: T.text3, fontSize: 11 },
  splitLine: { lineStyle: { color: T.grid, width: 1, type: "solid" } },
};

echarts.registerTheme("allure", {
  backgroundColor: "transparent",
  textStyle: { fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif", color: T.text2 },
  color: SPORT_ORDER.map((k) => SPORTS[k].color),
  grid: { left: 44, right: 16, top: 16, bottom: 28, containLabel: false },
  categoryAxis: { ...AXIS, splitLine: { show: false } },
  valueAxis: { ...AXIS, axisLine: { show: false } },
  timeAxis: { ...AXIS, splitLine: { show: false } },
  line: { symbol: "none", lineStyle: { width: 2, cap: "round", join: "round" }, smooth: false },
  bar: { barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } },
  tooltip: {
    backgroundColor: "#1b2029", borderColor: "rgba(255,255,255,0.14)", borderWidth: 1,
    textStyle: { color: T.text2, fontSize: 12 }, extraCssText: "border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:8px 11px;",
    axisPointer: { lineStyle: { color: T.text3, width: 1 }, crossStyle: { color: T.text3 } },
  },
  legend: { textStyle: { color: T.text2 }, icon: "roundRect", itemWidth: 10, itemHeight: 10 },
  dataZoom: { borderColor: "transparent", fillerColor: "rgba(200,245,96,0.08)", handleStyle: { color: T.text3 }, textStyle: { color: T.text3 } },
});

// Tooltip row helpers (value leads, label follows, short line key)
export function ttRow(color, value, label, box = false) {
  return `<div class="tt-row"><span class="tt-key${box ? " box" : ""}" style="background:${color}"></span><span class="tt-val">${value}</span><span>${label}</span></div>`;
}
export function ttTitle(t) { return `<div class="tt-title">${t}</div>`; }
