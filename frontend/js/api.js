// Thin fetch wrapper. Writes carry a custom header the server requires (CSRF guard).
const cache = new Map();

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (method !== "GET") {
    opts.headers["X-Sport-Platform"] = "1";
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch { /* not json */ }
    throw new Error(`${r.status} ${detail}`);
  }
  return r.json();
}

export const api = {
  get: (url, { ttl = 0 } = {}) => {
    if (ttl) {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.t < ttl) return hit.p;
      const p = request("GET", url).catch((e) => { cache.delete(url); throw e; });
      cache.set(url, { t: Date.now(), p });
      return p;
    }
    return request("GET", url);
  },
  post: (url, body) => { cache.clear(); return request("POST", url, body); },
  put: (url, body) => { cache.clear(); return request("PUT", url, body); },
  del: (url) => { cache.clear(); return request("DELETE", url); },
  clearCache: () => cache.clear(),
};

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
