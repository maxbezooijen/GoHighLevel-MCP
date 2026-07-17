// lib.mjs — GoHighLevel API client (zero-dependency, ESM).
//
// Auth: Private Integration Token (PIT), header `Authorization: Bearer pit-...` +
// `Version: 2021-07-28`. Vereist een browser-achtige User-Agent (zonder dit geeft
// Cloudflare Error 1010 — géén auth-fout maar een WAF-blok).
//
// Token/locatie uit env (GHL_TOKEN, GHL_LOCATION) met .env-auto-loader naast server.js
// (zelfde patroon als n8n-mcp/docuseal-api-mcp).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
// Cloudflare WAF blokt default-node-UA (Error 1010); een browser-UA is verplicht.
const USER_AGENT =
  process.env.GHL_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── .env auto-loader (respecteert reeds-gezette env) ─────────────────────────
function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  let raw = null;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (_) {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile();

export function loadToken() {
  const t = process.env.GHL_TOKEN;
  if (!t) {
    throw new Error(
      "GHL_TOKEN niet gevonden. Zet GHL_TOKEN (Private Integration Token, pit-...) in .env naast server.js of in de omgeving. Genereer een PIT in GHL → Settings → Private Integrations."
    );
  }
  return t;
}

export function loadLocation() {
  const l = process.env.GHL_LOCATION;
  if (!l) {
    throw new Error(
      "GHL_LOCATION niet gevonden. Zet GHL_LOCATION (sub-account locationId, 20 tekens) in .env of in de omgeving."
    );
  }
  return l;
}

// ─── Core request helper ──────────────────────────────────────────────────────
// method/path relatief t.o.v. BASE_URL (path begint met /). Optionele query/body.
// `locationId` wordt NIET automatisch toegevoegd (sommige endpoints willen hem in
// de query, andere in de body, andere helemaal niet) — de caller voegt hem toe waar
// nodig via de query/body. Retourneert parsed JSON (of ruwe tekst bij niet-JSON).
export async function ghlRequest(method, apiPath, { query, body } = {}) {
  const token = loadToken();
  let url = BASE_URL + (apiPath.startsWith("/") ? apiPath : "/" + apiPath);
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  const headers = {
    Authorization: "Bearer " + token,
    Version: API_VERSION,
    Accept: "application/json",
    // Cloudflare-WAF-vereiste: een browser-achtige UA (default Node-UA → 1010).
    "User-Agent": USER_AGENT,
  };
  let payload = undefined;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { method, headers, body: payload });
  const txt = await res.text();
  if (!res.ok) {
    const e = new Error(`GoHighLevel API ${res.status} op ${method} ${apiPath}: ${txt.slice(0, 500)}`);
    e.status = res.status;
    e.path = apiPath;
    throw e;
  }
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    return txt;
  }
}

// Handige guard-helper voor write/send-tools: retourneer een preview-plan.
export function plan(method, apiPath, { query, body } = {}) {
  return { method, path: apiPath, ...(query ? { query } : {}), ...(body ? { body } : {}) };
}
