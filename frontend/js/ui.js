// Shared UI building blocks: DOM helpers, cards, tiles, status chips, tooltip, charts.
import { esc } from "./fmt.js";
import { T } from "./theme.js";

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function card({ title = "", sub = "", actions = "", body = "", cls = "", id = "" } = {}) {
  const head = title || actions
    ? `<div class="card-head"><div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="actions">${actions}</div></div>`
    : "";
  return `<div class="card ${cls}"${id ? ` id="${id}"` : ""}>${head}${body}</div>`;
}

export function stat(label, value, unit = "", delta = "") {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}${unit ? `<small>${unit}</small>` : ""}</div>${delta ? `<div class="delta">${delta}</div>` : ""}</div>`;
}

const STATUS_ICONS = {
  good: '<path d="M5 12.5l4 4L19 7"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  serious: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.5"/>',
  critical: '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/>',
  neutral: '<circle cx="12" cy="12" r="4"/>',
};
export function status(level, label) {
  return `<span class="status ${level}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${STATUS_ICONS[level] || STATUS_ICONS.neutral}</svg>${esc(label)}</span>`;
}

export function empty(title, text = "", action = "") {
  return `<div class="empty"><svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 5-8 4 5"/><path d="M3 21h18"/></svg><h3>${title}</h3>${text ? `<p>${text}</p>` : ""}${action}</div>`;
}

export function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? "on" : ""}">${l}</button>`).join("")}</div>`;
}

export function onSeg(root, name, cb) {
  const s = root.querySelector(`[data-seg="${name}"]`);
  if (!s) return;
  s.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    s.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    cb(b.dataset.v);
  });
}

// ---------------------------------------------------------------- tooltip (for SVG/HTML marks)
const tip = () => document.getElementById("tooltip");
export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export function hideTip() { tip().hidden = true; }

// Delegated tooltips: any element with data-tip="<html>" (already escaped by caller)
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.dataset.tip);
  else if (!tip().dataset.sticky) hideTip();
});

// ---------------------------------------------------------------- charts registry
let charts = [];
export function chart(node, option, { group } = {}) {
  if (typeof node === "string") node = document.querySelector(node);
  if (!node) return null;
  const c = echarts.init(node, "allure", { renderer: "canvas" });
  c.setOption(option);
  if (group) { c.group = group; echarts.connect(group); }
  charts.push(c);
  return c;
}
export function disposeCharts() {
  charts.forEach((c) => { try { c.dispose(); } catch { /* already gone */ } });
  charts = [];
}
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => charts.forEach((c) => c.resize()), 120);
});

// Common axis snippets
export const gridLine = { lineStyle: { color: T.grid, width: 1, type: "solid" } };
export const noLine = { show: false };

// Small inline SVG route thumbnail from [[lat,lng],...]
export function routeSvg(route, { w = 120, h = 80, color = T.text2, stroke = 2 } = {}) {
  if (!route || route.length < 2) return "";
  const lat0 = route[0][0] * Math.PI / 180;
  const pts = route.map(([la, ln]) => [ln * Math.cos(lat0), -la]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const s = Math.min((w - 8) / (maxx - minx || 1), (h - 8) / (maxy - miny || 1));
  const ox = (w - (maxx - minx) * s) / 2, oy = (h - (maxy - miny) * s) / 2;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(ox + (p[0] - minx) * s).toFixed(1)},${(oy + (p[1] - miny) * s).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Form (TSB) interpretation — status tokens carry meaning, always with label
export function formState(tsb) {
  if (tsb == null) return ["neutral", "—"];
  if (tsb > 15) return ["warning", "Très frais — perte de forme"];
  if (tsb > 5) return ["good", "Frais — prêt à performer"];
  if (tsb > -10) return ["good", "Équilibré"];
  if (tsb > -30) return ["serious", "Productif — charge élevée"];
  return ["critical", "Surcharge — risque"];
}
export function acwrState(r) {
  if (r == null) return ["neutral", "—"];
  if (r < 0.8) return ["warning", "Sous-charge"];
  if (r <= 1.3) return ["good", "Optimal"];
  if (r <= 1.5) return ["serious", "Hausse rapide"];
  return ["critical", "Pic de charge"];
}
