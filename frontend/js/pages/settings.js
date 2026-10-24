import { api } from "../api.js";
import { card, status, el } from "../ui.js";
import * as f from "../fmt.js";

const SPORT_OPTS = [["run", "Course"], ["trail", "Trail"], ["triathlon", "Triathlon"], ["bike", "Vélo"], ["swim", "Natation"]];
const GARMIN_KEY_URL = "https://connect.garmin.com/app/settings/personalApiToken";

export async function render(view, { query }) {
  let timer = null;
  const draw = async () => {
    const [st, settings, goals] = await Promise.all([api.get("/api/status"), api.get("/api/settings"), api.get("/api/goals")]);
    view.innerHTML = `
      ${query.strava === "ok" ? `<div class="callout">${status("good", "Strava connecté")} L'enrichissement des 7 derniers jours démarre.</div>` : ""}
      ${query.strava === "error" || query.strava === "denied" ? `<div class="callout warn">${status("warning", "Connexion Strava annulée ou refusée")}</div>` : ""}
      ${st.demo ? `<div class="callout warn">${status("warning", "Mode démo")} Les données affichées sont synthétiques. Lance <code>run.py</code> sans <code>SPORT_DEMO=1</code> pour utiliser tes vraies données.</div>` : ""}
      <div class="grid">
        <div class="span-6">${garminCard(st)}</div>
        <div class="span-6">${stravaCard(st)}</div>
        <div class="span-5">${physioCard(settings)}</div>
        <div class="span-7">${goalsCard(goals)}</div>
        <div class="span-12">${privacyCard()}</div>
      </div>`;
    bind(view, draw);
  };
  await draw();
  // live progress while a sync is running
  timer = setInterval(async () => {
    try {
      const st = await api.get("/api/status");
      const box = view.querySelector("#garmin-live");
      if (box) box.innerHTML = garminLive(st.garmin);
    } catch { /* server restarting */ }
  }, 3000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- Garmin
function garminLive(g) {
  const s = g.sync || {};
  const lvl = s.phase === "error" ? "critical" : s.phase === "paused" ? "warning" : s.running ? "neutral" : "good";
  const pct = s.todo ? Math.round((s.done / s.todo) * 100) : 0;
  return `
    <div class="sync-live">
      ${status(lvl, s.running ? "Synchronisation en cours" : s.phase === "error" ? "Erreur" : s.phase === "paused" ? "En pause" : "À jour")}
      <span class="muted">${f.esc(s.message || "")}${s.waiting_until ? ` · reprise ${f.esc(s.waiting_until.slice(11))}` : ""}</span>
    </div>
    ${s.running && s.todo ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ""}
    <dl class="kv" style="margin-top:12px">
      <dt>Activités</dt><dd>${f.num(g.activities)} ${g.first ? `<span class="muted">(${f.dateShort(g.first)} ${g.first.slice(0, 4)} → ${f.dateShort(g.last)})</span>` : ""}</dd>
      <dt>Fichiers FIT analysés</dt><dd>${f.num(g.with_fit)} / ${f.num(g.activities)}</dd>
      <dt>Nuits</dt><dd>${f.num(g.nights)} ${g.nights_first ? `<span class="muted">(depuis ${f.dateShort(g.nights_first)} ${g.nights_first.slice(0, 4)})</span>` : ""}</dd>
      <dt>Dernière synchro</dt><dd>${s.last_sync ? f.esc(s.last_sync.replace("T", " ")) : "–"}</dd>
    </dl>`;
}

function garminCard(st) {
  const g = st.garmin;
  if (g.connected) {
    return card({
      title: "Garmin Connect", sub: "API personnelle officielle · source principale",
      actions: `<button class="btn" data-act="garmin-sync" ${st.demo ? "disabled" : ""}>Synchroniser</button><button class="btn" data-act="garmin-forget">Supprimer la clé</button>`,
      body: `<div id="garmin-live">${garminLive(g)}</div>
        <p class="muted small">Pour révoquer l'accès : supprime aussi la clé sur <a href="${GARMIN_KEY_URL}" target="_blank" rel="noopener noreferrer">Garmin Connect</a>.</p>`,
    });
  }
  return card({
    title: "Garmin Connect", sub: "API personnelle officielle · ton mot de passe n'est jamais utilisé ici",
    body: `
      <ol class="steps">
        <li>Ouvre <a href="${GARMIN_KEY_URL}" target="_blank" rel="noopener noreferrer"><b>Garmin Connect → Personal API Key</b></a> (connecté à ton compte).</li>
        <li>Clique <b>Create Key</b>, lis les conditions, choisis une expiration (<b>90 ou 180 jours</b> conseillé).</li>
        <li>Copie la clé (affichée une seule fois) et colle-la ci-dessous.</li>
      </ol>
      <form class="key-form" id="garmin-form" autocomplete="off">
        <input class="input" type="password" name="key" placeholder="Colle ta clé API personnelle Garmin" autocomplete="off" spellcheck="false" ${st.demo ? "disabled" : ""} required>
        <button class="btn primary" type="submit" ${st.demo ? "disabled" : ""}>Connecter</button>
      </form>
      <div class="form-msg" id="garmin-msg"></div>
      <p class="muted small">La clé est vérifiée auprès de Garmin puis stockée dans <code>data/secrets/</code> (accès restreint à ta session Windows). Le jeton d'accès (24 h) reste en mémoire. Les seules requêtes partent vers <code>personal.connectapi.garmin.com</code>.</p>`,
  });
}

// ---------------------------------------------------------------- Strava
function stravaCard(st) {
  const s = st.strava;
  const policy = `<p class="muted small">Politique API Strava 2026 : les données obtenues via l'API ne peuvent pas être conservées plus de 7 jours ni indexées. TrainLab les garde donc dans un cache à part, purgé automatiquement, affiché seulement sur les séances récentes (noms, descriptions, chaussures) et jamais utilisé dans les calculs ni le labo.</p>`;
  if (!s.configured) {
    return card({
      title: "Strava", sub: "Optionnel · enrichit les 7 derniers jours",
      body: `
        <ol class="steps">
          <li>Crée une application sur <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener noreferrer"><b>strava.com/settings/api</b></a> (abonnement Strava requis).</li>
          <li><b>Authorization Callback Domain</b> : <code>127.0.0.1</code></li>
          <li>Copie le <b>Client ID</b> et le <b>Client Secret</b> dans le fichier <code>.env</code> à la racine du dossier (jamais dans un chat).</li>
          <li>Recharge cette page puis clique « Connecter Strava ».</li>
        </ol>${policy}`,
    });
  }
  if (!s.connected) {
    return card({
      title: "Strava", sub: "Application configurée",
      body: `<p>Autorise TrainLab à lire tes activités (lecture seule).</p>
        <a class="btn strava" href="/api/strava/connect">Connecter Strava</a>
        <p class="muted small">Redirection prévue : <code>${f.esc(s.redirect_uri)}</code></p>${policy}`,
    });
  }
  const who = s.athlete ? `${f.esc(s.athlete.firstname || "")} ${f.esc(s.athlete.lastname || "")}` : "";
  return card({
    title: "Strava", sub: `Connecté${who ? ` · ${who}` : ""}`,
    actions: `<button class="btn" data-act="strava-sync">Rafraîchir</button><button class="btn" data-act="strava-off">Déconnecter</button>`,
    body: `<div class="sync-live">${status(s.sync.phase === "error" ? "critical" : "good", s.sync.message || "Connecté")}</div>
      <dl class="kv" style="margin-top:12px">
        <dt>Séances en cache (≤ 7 j)</dt><dd>${f.num(s.cached)}</dd>
        <dt>Quota lecture 15 min</dt><dd>${f.num(s.rate.used_15)} / ${f.num(s.rate.limit_15)}</dd>
        <dt>Quota lecture jour</dt><dd>${f.num(s.rate.used_day)} / ${f.num(s.rate.limit_day)}</dd>
      </dl>${policy}`,
  });
}

// ---------------------------------------------------------------- physiology
function physioCard(s) {
  const z = s.hr_zones || [];
  const gz = s.garmin_zones;
  return card({
    title: "Paramètres physiologiques", sub: "Utilisés par le modèle de charge (TRIMP → hrTSS)",
    body: `
      <form id="physio-form" class="form-grid">
        <label class="toggle span-all"><input type="checkbox" name="auto_hr" ${s.auto_hr ? "checked" : ""}> Mettre à jour automatiquement depuis Garmin (zones, FC max, seuil, FC repos)</label>
        <label class="field">FC max<input class="input" name="hr_max" type="number" min="150" max="230" value="${s.hr_max}"></label>
        <label class="field">FC repos<input class="input" name="hr_rest" type="number" min="30" max="90" value="${s.hr_rest}"></label>
        <label class="field">FC seuil (LTHR)<input class="input" name="lthr" type="number" min="120" max="210" value="${s.lthr}"></label>
        <label class="field">Poids (kg)<input class="input" name="weight" type="number" step="0.1" value="${s.weight}"></label>
        <div class="span-all zones-edit">
          <div class="muted small">Bornes basses des zones Z2 → Z5 (bpm)</div>
          <div class="zone-inputs">${[0, 1, 2, 3].map((i) => `<label class="field">Z${i + 2}<input class="input" name="z${i}" type="number" value="${z[i] ?? ""}"></label>`).join("")}</div>
        </div>
        <label class="field">Fitness CTL (jours)<input class="input" name="ctl_days" type="number" min="14" max="90" value="${s.ctl_days}"></label>
        <label class="field">Fatigue ATL (jours)<input class="input" name="atl_days" type="number" min="3" max="21" value="${s.atl_days}"></label>
        <div class="span-all form-actions"><button class="btn primary" type="submit">Enregistrer & recalculer</button><span class="form-msg" id="physio-msg"></span></div>
      </form>
      ${gz ? `<p class="muted small">Zones Garmin (${f.esc(gz.trainingMethod || "")}) : FC max ${f.num(gz.maxHeartRateUsed)}, seuil ${f.num(gz.lactateThresholdHeartRateUsed)}, repos ${f.num(gz.restingHeartRateUsed)}.</p>` : ""}`,
  });
}

// ---------------------------------------------------------------- goals
function goalsCard(goals) {
  const row = (g) => `
    <tr data-id="${g.id}">
      <td><input class="input" name="name" value="${f.esc(g.name)}"></td>
      <td><input class="input" name="date" type="date" value="${f.esc(g.date)}"></td>
      <td><select class="input" name="sport">${SPORT_OPTS.map(([v, l]) => `<option value="${v}" ${g.sport === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><input class="input num" name="distance" type="number" step="0.001" value="${g.distance ? g.distance / 1000 : ""}" placeholder="km"></td>
      <td><input class="input num" name="target_time" value="${g.target_time ? f.duration(g.target_time, { hms: g.target_time >= 3600 }) : ""}" placeholder="h:mm:ss"></td>
      <td><select class="input" name="priority">${["A", "B", "C"].map((p) => `<option ${g.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></td>
      <td class="r"><button class="btn icon" type="button" data-act="goal-del" title="Supprimer">✕</button></td>
    </tr>`;
  return card({
    title: "Objectifs", sub: "Compte à rebours et prédictions sur le Cockpit",
    actions: `<button class="btn" data-act="goal-add">Ajouter</button><button class="btn primary" data-act="goal-save">Enregistrer</button>`,
    body: `<div class="table-wrap"><table class="data goals-table" id="goals"><thead><tr><th>Nom</th><th>Date</th><th>Type</th><th>Distance</th><th>Objectif</th><th>Prio.</th><th></th></tr></thead>
      <tbody>${goals.map(row).join("")}</tbody></table></div><span class="form-msg" id="goals-msg"></span>`,
  });
}

function parseHms(s) {
  if (!s) return null;
  const p = s.trim().split(":").map(Number);
  if (p.some((x) => !Number.isFinite(x))) return null;
  return p.reduce((acc, x) => acc * 60 + x, 0);
}

// ---------------------------------------------------------------- privacy
function privacyCard() {
  return card({
    title: "Données & confidentialité",
    body: `<div class="privacy">
      <div><h3>Où sont tes données</h3><p>Tout reste sur ce PC : base <code>data/sport.db</code> (SQLite), fichiers originaux Garmin dans <code>data/fit/</code>, secrets dans <code>data/secrets/</code>. Le serveur n'écoute que sur <code>127.0.0.1</code>.</p></div>
      <div><h3>Ce qui sort</h3><p>Uniquement les appels à <code>personal.connectapi.garmin.com</code> et (si activé) <code>www.strava.com</code>. Les cartes chargent des tuiles OpenStreetMap : seules les coordonnées des tuiles affichées sont demandées, jamais ta trace.</p></div>
      <div><h3>Analyse dans Jupyter</h3><pre class="code">import sqlite3, pandas as pd
con = sqlite3.connect(r"data/sport.db")
acts = pd.read_sql("select * from activities", con)
well = pd.read_sql("select * from daily_wellness", con)</pre></div>
    </div>`,
  });
}

// ---------------------------------------------------------------- events
function bind(view, redraw) {
  const msg = (id, text, ok = true) => { const m = view.querySelector(id); if (m) { m.textContent = text; m.className = `form-msg ${ok ? "ok" : "err"}`; } };

  view.querySelector("#garmin-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.key;
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    msg("#garmin-msg", "Vérification auprès de Garmin…");
    try {
      await api.post("/api/garmin/key", { key: input.value });
      input.value = "";
      await redraw();
    } catch (err) {
      msg("#garmin-msg", err.message.replace(/^\d+ /, ""), false);
      btn.disabled = false;
    }
  });

  view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "garmin-sync") { await api.post("/api/garmin/sync"); b.textContent = "Lancée…"; }
    if (act === "garmin-forget" && confirm("Supprimer la clé Garmin de ce PC ? (pense à la supprimer aussi sur Garmin Connect)")) { await api.del("/api/garmin/key"); await redraw(); }
    if (act === "strava-sync") { await api.post("/api/strava/sync"); b.textContent = "Lancé…"; }
    if (act === "strava-off" && confirm("Déconnecter Strava et vider le cache ?")) { await api.post("/api/strava/disconnect"); await redraw(); }
    if (act === "goal-add") {
      const tb = view.querySelector("#goals tbody");
      tb.appendChild(el(`<table><tbody><tr data-id="new"><td><input class="input" name="name" placeholder="Nouvel objectif"></td><td><input class="input" name="date" type="date"></td>
        <td><select class="input" name="sport">${SPORT_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></td>
        <td><input class="input num" name="distance" type="number" step="0.001" placeholder="km"></td><td><input class="input num" name="target_time" placeholder="h:mm:ss"></td>
        <td><select class="input" name="priority"><option>A</option><option selected>B</option><option>C</option></select></td><td class="r"><button class="btn icon" type="button" data-act="goal-del">✕</button></td></tr></tbody></table>`).querySelector("tr"));
    }
    if (act === "goal-del") {
      const tr = b.closest("tr");
      if (tr.dataset.id !== "new" && confirm("Supprimer cet objectif ?")) await api.del(`/api/goals/${tr.dataset.id}`);
      tr.remove();
    }
    if (act === "goal-save") {
      try {
        for (const tr of view.querySelectorAll("#goals tbody tr")) {
          const v = (n) => tr.querySelector(`[name="${n}"]`).value;
          if (!v("name") || !v("date")) continue;
          const body = { name: v("name"), date: v("date"), sport: v("sport"), distance: v("distance") ? Math.round(Number(v("distance")) * 1000) : null,
                         target_time: parseHms(v("target_time")), priority: v("priority"), notes: null };
          if (tr.dataset.id === "new") await api.post("/api/goals", body);
          else await api.put(`/api/goals/${tr.dataset.id}`, body);
        }
        await redraw();
        msg("#goals-msg", "Objectifs enregistrés");
      } catch (err) { msg("#goals-msg", err.message, false); }
    }
  });

  view.querySelector("#physio-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const n = (k) => Number(fd.get(k));
    const body = { auto_hr: fd.get("auto_hr") === "on", hr_max: n("hr_max"), hr_rest: n("hr_rest"), lthr: n("lthr"), weight: n("weight"),
                   hr_zones: [0, 1, 2, 3].map((i) => n(`z${i}`)), ctl_days: n("ctl_days"), atl_days: n("atl_days") };
    if (body.hr_zones.some((x, i) => i && x <= body.hr_zones[i - 1])) { msg("#physio-msg", "Les zones doivent être croissantes", false); return; }
    msg("#physio-msg", "Recalcul en cours…");
    try { await api.put("/api/settings", body); msg("#physio-msg", "Enregistré — charges recalculées"); }
    catch (err) { msg("#physio-msg", err.message, false); }
  });
}
