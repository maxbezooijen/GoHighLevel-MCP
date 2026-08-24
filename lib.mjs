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

// Boven dit aantal bytes wordt een binaire respons (bv. een gedownload document) niet
// meer inline als base64 teruggegeven tenzij `file_path` is gegeven — base64 blaast
// ~33% op, en een grote inline payload riskeert de MCP-stdio-verbinding te slopen
// (de client kapt af op 16MB; zie MAX_RPC_BYTES-guard in server.js).
const MAX_BINARY_INLINE_BYTES = Number(process.env.GHL_MAX_BINARY_INLINE_BYTES || 2 * 1024 * 1024);
function fmtBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}
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

// Agency-PIT (company-niveau). Apart van GHL_TOKEN, want dat is een sub-account-token:
// agency-routes (/snapshots/, /companies/{id}) geven daarop 401 en dat is géén
// scope-kwestie maar een niveauverschil — vastgesteld 12-8-2026 met
// GET /locations/{id} → 200 tegenover GET /companies/{id} → 401.
// Bewust NIET het standaardtoken: een agency-token heeft veel bredere rechten en zou
// stilzwijgend alle bestaande sub-account-calls verbreden. Opt-in per call.
export function loadAgencyToken() {
  const t = process.env.GHL_AGENCY_TOKEN;
  if (!t) {
    throw new Error(
      "GHL_AGENCY_TOKEN niet gevonden. Zet GHL_AGENCY_TOKEN (agency-level Private Integration Token, pit-...) in /opt/projects/.mcp-secrets/secrets.env. Genereer hem in GHL op AGENCY-niveau (Settings → Private Integrations op de agency, niet op het sub-account)."
    );
  }
  return t;
}

export function loadCompany() {
  return process.env.GHL_COMPANY || "";
}

// v1 (legacy) API. Andere host, ander credential, ander foutformaat ({"msg":...}).
// Bestaansbewijs 12-8-2026: GET /v1/workflows/ → 401 {"msg":"Unauthorized"} tegenover
// GET /v1/nonsense/ → 404 {"msg":"Not found"}. De v2-API heeft GEEN workflow-detailroute
// (alles "Cannot GET", ook met agency-token), dus dit is de enige overgebleven kandidaat
// om workflow-inhoud machinaal te lezen.
// Sleutel: GHL → Settings → Business Info → API Key (location-niveau, legacy JWT).
const V1_BASE_URL = process.env.GHL_V1_BASE_URL || "https://rest.gohighlevel.com/v1";

export function loadV1Key() {
  const t = process.env.GHL_V1_KEY;
  if (t) return t;
  // Diagnostische terugval: accepteert de v1-API misschien gewoon een v2-PIT? Zo ja,
  // dan is de legacy sleutel niet nodig. Zo nee (verwacht: 401), dan is dat een
  // definitief antwoord en hoeft niemand meer in de UI te zoeken.
  const pit = process.env.GHL_AGENCY_TOKEN || process.env.GHL_TOKEN;
  if (pit) return pit;
  throw new Error(
    "GHL_V1_KEY niet gevonden en geen PIT om op terug te vallen. Zet GHL_V1_KEY (legacy v1 API key, JWT) in /opt/projects/.mcp-secrets/secrets.env."
  );
}

// ─── Core request helper ──────────────────────────────────────────────────────
// method/path relatief t.o.v. BASE_URL (path begint met /). Optionele query/body.
// `locationId` wordt NIET automatisch toegevoegd (sommige endpoints willen hem in
// de query, andere in de body, andere helemaal niet) — de caller voegt hem toe waar
// nodig via de query/body. Retourneert parsed JSON (of ruwe tekst bij niet-JSON).
//
// Binaire responses (bv. document-downloads via ghl_raw_api op /documents/download/{id})
// worden NOOIT via res.text() gelezen — dat decodeert lossy als UTF-8 en corrumpeert elk
// byte-patroon dat geen geldige UTF-8-sequentie is (zichtbaar als U+FFFD replacement
// characters; bevestigd 23-7 met een crash van de hele MCP-verbinding op een 10,7MB
// download). De body wordt binary-safe gelezen (arrayBuffer) en pas op basis van de
// content-type-header als tekst geparsed of als base64 geëncodeerd. Geef `file_path` om
// grote/binaire responses server-side naar schijf te schrijven i.p.v. inline terug te geven.
export async function ghlRequest(method, apiPath, { query, body, file_path, agency, v1 } = {}) {
  const token = v1 ? loadV1Key() : agency ? loadAgencyToken() : loadToken();
  const base = v1 ? V1_BASE_URL : BASE_URL;
  let url = base + (apiPath.startsWith("/") ? apiPath : "/" + apiPath);
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
    // v1 kent de Version-header niet; die alleen op v2 meesturen.
    ...(v1 ? {} : { Version: API_VERSION }),
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
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isTextual = !contentType || contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml");

  if (isTextual) {
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

  // Binaire respons — binary-safe lezen, nooit als tekst decoderen.
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const e = new Error(`GoHighLevel API ${res.status} op ${method} ${apiPath}: [binair ${contentType || "onbekend"}, ${buf.length} bytes]`);
    e.status = res.status;
    e.path = apiPath;
    throw e;
  }
  if (file_path) {
    fs.writeFileSync(file_path, buf);
    return { savedTo: file_path, mimeType: contentType, size: buf.length, encoding: "file" };
  }
  if (buf.length > MAX_BINARY_INLINE_BYTES) {
    const e = new Error(
      `Binaire respons is ${fmtBytes(buf.length)} (${contentType || "onbekend"}), groter dan de inline-limiet van ${fmtBytes(MAX_BINARY_INLINE_BYTES)}. ` +
        `Geef \`file_path\` mee aan ghl_raw_api om het bestand server-side naar schijf te schrijven (voorkomt afkapping/corruptie en verbindingscrash).`
    );
    e.status = res.status;
    e.path = apiPath;
    throw e;
  }
  return { content: buf.toString("base64"), mimeType: contentType, size: buf.length, encoding: "base64" };
}

// Handige guard-helper voor write/send-tools: retourneer een preview-plan.
export function plan(method, apiPath, { query, body } = {}) {
  return { method, path: apiPath, ...(query ? { query } : {}), ...(body ? { body } : {}) };
}
