// Hash router + shell (sync status, page titles).
import { api } from "./api.js";
import { disposeCharts, hideTip } from "./ui.js";
import { esc } from "./fmt.js";

const ROUTES = {
  "": { key: "cockpit", title: "Cockpit", sub: "Ta forme, ta charge et ta récup en un coup d'œil", load: () => import("./pages/cockpit.js") },
  journal: { key: "journal", title: "Journal d'entraînement", sub: "Toutes tes séances, semaine après semaine", load: () => import("./pages/journal.js") },
  activity: { key: "journal", title: "Séance", sub: "", load: () => import("./pages/activity.js") },
  profile: { key: "profile", title: "Profil athlète", sub: "Ton profil de coureur, tes prédictions et ce qui les justifie", load: () => import("./pages/profile.js") },
  load: { key: "load", title: "Charge & objectifs", sub: "Fitness, fatigue, prédictions et progression", load: () => import("./pages/load.js") },
  sleep: { key: "sleep", title: "Sommeil & récupération", sub: "Nuits, HRV, FC de repos, Body Battery", load: () => import("./pages/sleep.js") },
  ml: { key: "ml", title: "Prédictions ML", sub: "Ce que tes données permettent de prévoir — évalué honnêtement sur une période jamais vue", load: () => import("./pages/ml.js") },
  lab: { key: "lab", title: "Labo", sub: "Explore les corrélations entre entraînement, sommeil et performance", load: () => import("./pages/lab.js") },
  settings: { key: "settings", title: "Réglages & sources", sub: "Connexions Garmin / Strava, paramètres physiologiques, objectifs", load: () => import("./pages/settings.js") },
};

const view = document.getElementById("view");
let cleanup = null;
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "", args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(query)) };
}

async function route() {
  const { name, args, query } = parseHash();
  const r = ROUTES[name] || ROUTES[""];
  const token = ++renderToken;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === r.key));
  document.getElementById("page-title").textContent = r.title;
  document.getElementById("page-sub").textContent = r.sub;
  document.getElementById("topbar-right").innerHTML = "";
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  hideTip();
  if (lastFp) renderedFp = lastFp;  // this render shows the latest synced data
  document.getElementById("data-toast")?.remove();
  view.classList.add("loading");
  try {
    const mod = await r.load();
    if (token !== renderToken) return;
    disposeCharts();
    view.innerHTML = "";
    window.scrollTo(0, 0);
    cleanup = (await mod.render(view, { args, query, setTitle, setActions })) || null;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><div class="empty"><h3>Oups, cette page a planté</h3><p class="muted">${esc(e.message)}</p></div></div>`;
  } finally {
    if (token === renderToken) view.classList.remove("loading");
  }
}

function setTitle(title, sub = "") {
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-sub").textContent = sub;
}
function setActions(html) {
  document.getElementById("topbar-right").innerHTML = html;
  return document.getElementById("topbar-right");
}

// ---------------------------------------------------------------- sync status
function dotClass(s) {
  if (!s) return "";
  if (s.running) return "busy";
  if (s.phase === "error") return "err";
  if (s.phase === "paused") return "warn";
  if (s.phase === "ok") return "ok";
  return "";
}

// Data fingerprint at the time the current page was rendered: when a sync cycle
// finishes with different data, offer a refresh instead of silently showing stale charts.
let renderedFp = null;
let lastFp = null;
const fingerprint = (g) => `${g.activities}|${g.with_fit}|${g.nights}|${g.last}|${g.nights_last}`;

function showDemoBanner() {
  if (document.getElementById("demo-banner")) return;
  const b = document.createElement("div");
  b.id = "demo-banner";
  b.className = "demo-banner";
  b.innerHTML = `<b>DONNÉES DE DÉMO</b> — séances et nuits synthétiques, ce ne sont pas les tiennes. Tes vraies données : <a href="http://127.0.0.1:8765">127.0.0.1:8765</a>`;
  document.querySelector(".main").prepend(b);
}

function newDataToast() {
  if (document.getElementById("data-toast")) return;
  const t = document.createElement("div");
  t.id = "data-toast";
  t.className = "toast";
  t.innerHTML = `<span>Nouvelles données Garmin synchronisées</span><button class="btn primary" type="button">Actualiser</button><button class="btn" type="button" aria-label="Fermer">✕</button>`;
  const [refresh, close] = t.querySelectorAll("button");
  refresh.onclick = () => { t.remove(); api.clearCache(); route(); };
  close.onclick = () => { t.remove(); renderedFp = lastFp; };
  document.body.appendChild(t);
}

async function refreshStatus() {
  try {
    const st = await api.get("/api/status");
    const g = st.garmin, s = st.strava;
    const box = document.getElementById("sync-box");
    if (st.demo) {
      showDemoBanner();
      box.innerHTML = `<div class="sync-row"><span class="dot warn"></span><span class="label"><b>Mode démo</b><br><span class="muted">données synthétiques</span></span></div>`;
      return;
    }
    lastFp = fingerprint(g);
    if (renderedFp === null) renderedFp = lastFp;
    if (!g.sync.running && lastFp !== renderedFp) newDataToast();
    const gs = g.sync;
    const when = gs.last_sync ? gs.last_sync.slice(11).replace(":", "h") : "";
    const gLine = !g.connected ? "Non connecté"
      : gs.running ? esc(gs.message || "Synchronisation…")
      : gs.phase === "ok" ? `À jour${when ? ` · ${when}` : ""} · ${g.activities} séances`
      : gs.phase === "paused" ? `En pause, reprise ${esc((gs.waiting_until || "").slice(11).replace(":", "h"))}`
      : gs.phase === "error" ? "Erreur — voir Réglages"
      : esc(gs.message || "Connecté");
    const sLine = s.connected ? esc(s.sync.message || "Connecté (7 j)") : "Optionnel";
    box.innerHTML = `
      <div class="sync-row"><span class="dot ${g.connected ? dotClass(g.sync) : ""}"></span><span class="label"><b>Garmin</b><br><span class="muted">${gLine}</span></span></div>
      <div class="sync-row"><span class="dot ${s.connected ? dotClass(s.sync) : ""}"></span><span class="label"><b>Strava</b><br><span class="muted">${sLine}</span></span></div>`;
  } catch { /* server restarting */ }
}

addEventListener("hashchange", route);
route();
refreshStatus();
setInterval(refreshStatus, 5000);
