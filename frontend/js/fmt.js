// Formatting helpers (French conventions).
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function num(v, digits = 0) {
  if (!isNum(v)) return "–";
  if (digits === 1) return nf1.format(v);
  if (digits === 2) return nf2.format(v);
  return nf0.format(v);
}

export function signed(v, digits = 0) {
  if (!isNum(v)) return "–";
  const s = num(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function km(m, digits = 1) {
  return isNum(m) ? num(m / 1000, digits) : "–";
}

// seconds -> 1:23:45 or 23:45
export function duration(s, { hms = false } = {}) {
  if (!isNum(s)) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h || hms) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// seconds -> "1 h 23" / "45 min"
export function hm(s) {
  if (!isNum(s)) return "–";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (!h) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

// m/s -> "4:05" (min/km)
export function pace(speed) {
  if (!isNum(speed) || speed <= 0.3) return "–";
  const spk = 1000 / speed;
  const m = Math.floor(spk / 60), s = Math.round(spk % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

// s/km -> "4:05"
export function paceSec(spk) {
  if (!isNum(spk)) return "–";
  const m = Math.floor(spk / 60), s = Math.round(spk % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

// m/s -> km/h
export function kmh(speed, digits = 1) {
  return isNum(speed) ? num(speed * 3.6, digits) : "–";
}

// 100m swim pace
export function pace100(speed) {
  if (!isNum(speed) || speed <= 0) return "–";
  return duration(100 / speed);
}

const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export const parseDate = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

export function dateShort(iso) {
  if (!iso) return "–";
  const d = parseDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function dateLong(iso) {
  if (!iso) return "–";
  const d = parseDate(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
export function dateDay(iso) {
  const d = parseDate(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function monthLabel(d) { return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`; }
export function monthShort(d) { return MONTHS[d.getMonth()]; }
export function timeOf(isoDateTime) { return isoDateTime ? isoDateTime.slice(11, 16).replace(":", "h") : ""; }

export function relDays(n) {
  if (n === 0) return "aujourd'hui";
  if (n === 1) return "demain";
  if (n < 0) return `il y a ${-n} j`;
  return `J-${n}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
