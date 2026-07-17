#!/usr/bin/env node
/**
 * gohighlevel-mcp — zelfgebouwde, lokale GoHighLevel-MCP (vervangt de hosted MCP).
 *
 * Hand-rolled JSON-RPC over stdio (zelfde skelet als n8n-mcp/docuseal-api-mcp).
 * Zero dependencies (alleen Node ≥18 built-ins). Hergebruikt de bestaande PIT
 * uit /opt/projects/.mcp-secrets/secrets.env (via .env-symlink).
 *
 * Veiligheidsmodel (consequent toegepast, analoog aan de rest van de stack):
 *  - Lees-tools: altijd veilig.
 *  - Schrijf-tools: dryRun-preview (default) of confirm-opt-in.
 *  - Send-tools (SMS/Email): FAIL-CLOSED default = niet verzenden; expliciete
 *    opt-in (send_real_correspondence / confirm) vereist. Draft-not-send.
 *  - Status-mutaties (opportunities): confirm-guard (kan triggers activeren).
 *  - raw_api: non-GET preview bij dryRun.
 */
import readline from "readline";
import { ghlRequest, loadLocation, plan } from "./lib.mjs";

const SERVER_NAME = "gohighlevel";
const SERVER_VERSION = "0.1.0";

const LOC = () => loadLocation(); // lazy: pas bij eerste tool-call (start niet falen)

// ─── Herbruikbare schema-fragmenten ────────────────────────────────────────────
const dryRunProp = {
  dryRun: {
    type: "boolean",
    description: "If true, return the planned request (method/path/body) WITHOUT sending it. Default false.",
  },
};
const confirmProp = {
  confirm: {
    type: "boolean",
    description: "Must be true to actually execute (writes can trigger workflows/correspondence).",
  },
};

// ─── Tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  // ===== A. Read-only discovery =====
  {
    name: "ghl_whoami",
    description: "Show the authenticated sub-account/location (name, companyId, contact info). Verifies the PIT works. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/locations/" + LOC()),
  },
  {
    name: "ghl_list_workflows",
    description: "List automation workflows for the location. Read-only. NOTE: GHL returns all workflows in one call (no pagination).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/workflows/", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_list_custom_fields",
    description: "List custom fields defined for the location. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/locations/" + LOC() + "/customFields"),
  },
  {
    name: "ghl_list_custom_objects",
    description: "List custom object schemas for the location. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/objects/", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_list_custom_object_records",
    description: "List records of a specific custom object schema. Read-only. Verplicht: object_key (de schema-key, bv. 'debiteurdossier' uit ghl_list_custom_objects). Optioneel: limit, cursor.",
    inputSchema: {
      type: "object",
      properties: { object_key: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } },
      required: ["object_key"],
    },
    handler: async ({ object_key, limit, cursor }) =>
      ghlRequest("GET", "/objects/" + object_key + "/records", { query: { locationId: LOC(), limit, startAfter: cursor } }),
  },
  {
    name: "ghl_create_custom_object_record",
    description: "Create a record in a custom object schema (POST /objects/{key}/records). Write — dryRun:true to preview. Verplicht: object_key, fields (record-body met custom-field-values).",
    inputSchema: {
      type: "object",
      properties: { object_key: { type: "string" }, fields: { type: "object", description: "Record body (custom-field key/values)." }, ...dryRunProp },
      required: ["object_key", "fields"],
    },
    handler: async ({ object_key, fields, dryRun }) => {
      const body = { locationId: LOC(), ...fields };
      if (dryRun) return { dryRun: true, plan: plan("POST", "/objects/" + object_key + "/records", { body }) };
      return ghlRequest("POST", "/objects/" + object_key + "/records", { body });
    },
  },
  {
    name: "ghl_update_custom_object_record",
    description: "Update a custom object record (PUT /objects/{key}/records/{id}). Write — dryRun:true to preview. Verplicht: object_key, record_id, fields.",
    inputSchema: {
      type: "object",
      properties: { object_key: { type: "string" }, record_id: { type: "string" }, fields: { type: "object", description: "Partial record body." }, ...dryRunProp },
      required: ["object_key", "record_id", "fields"],
    },
    handler: async ({ object_key, record_id, fields, dryRun }) => {
      const body = { id: record_id, locationId: LOC(), ...fields };
      if (dryRun) return { dryRun: true, plan: plan("PUT", "/objects/" + object_key + "/records/" + record_id, { body }) };
      return ghlRequest("PUT", "/objects/" + object_key + "/records/" + record_id, { body });
    },
  },

  // ===== B. Contacts =====
  {
    name: "ghl_list_contacts",
    description: "List/search contacts (paginated). Read-only. Filters: query (name/email/phone), limit, startAfter (cursor id).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search by name/email/phone." },
        limit: { type: "number", description: "Page size (max 100, default 25)." },
        startAfter: { type: "string", description: "Cursor: last contact id from previous page." },
      },
    },
    handler: async ({ query, limit, startAfter }) =>
      ghlRequest("GET", "/contacts/", { query: { locationId: LOC(), query, limit, startAfter } }),
  },
  {
    name: "ghl_get_contact",
    description: "Get a single contact by id. Read-only.",
    inputSchema: { type: "object", properties: { contact_id: { type: "string" } }, required: ["contact_id"] },
    handler: async ({ contact_id }) => ghlRequest("GET", "/contacts/" + contact_id),
  },
  {
    name: "ghl_upsert_contact",
    description: "Upsert a contact by matching key (email/phone). Write — pass dryRun:true to preview. `fields` is the contact body (firstName, lastName, email, phone, name, customFields{}, etc.).",
    inputSchema: {
      type: "object",
      properties: { fields: { type: "object", description: "Contact body. See GHL POST /contacts/upsert." }, ...dryRunProp },
      required: ["fields"],
    },
    handler: async ({ fields, dryRun }) => {
      const body = { locationId: LOC(), ...fields };
      if (dryRun) return { dryRun: true, plan: plan("POST", "/contacts/upsert", { body }) };
      return ghlRequest("POST", "/contacts/upsert", { body });
    },
  },
  {
    name: "ghl_update_contact",
    description: "Update an existing contact (partial). Write — dryRun:true to preview.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, fields: { type: "object", description: "Partial contact body." }, ...dryRunProp },
      required: ["contact_id", "fields"],
    },
    handler: async ({ contact_id, fields, dryRun }) => {
      if (dryRun) return { dryRun: true, plan: plan("PUT", "/contacts/" + contact_id, { body: fields }) };
      return ghlRequest("PUT", "/contacts/" + contact_id, { body: fields });
    },
  },
  {
    name: "ghl_set_contact_tags",
    description: "Add tags to a contact (`tags` array). Write — dryRun:true to preview. Pass `remove:true` to remove instead.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, remove: { type: "boolean" }, ...dryRunProp },
      required: ["contact_id", "tags"],
    },
    handler: async ({ contact_id, tags, remove, dryRun }) => {
      const body = { tags };
      if (dryRun) return { dryRun: true, plan: plan("POST", "/contacts/" + contact_id + "/tags", { body }) };
      return ghlRequest(remove ? "DELETE" : "POST", "/contacts/" + contact_id + "/tags", { body });
    },
  },

  // ===== C. Opportunities / Pipelines =====
  {
    name: "ghl_list_pipelines",
    description: "List all pipelines + their stages. Read-only. Use to find pipelineId/stageId for opportunities.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/opportunities/pipelines", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_search_opportunities",
    description: "Search opportunities. Read-only. Filters: pipeline_id, stage_id, status (open/won/lost/abandoned), q (name), limit, startAfter.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "string" }, stage_id: { type: "string" }, status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] },
        q: { type: "string" }, limit: { type: "number" }, startAfter: { type: "string" },
      },
    },
    handler: async ({ pipeline_id, stage_id, status, q, limit, startAfter }) =>
      ghlRequest("GET", "/opportunities/search", { query: { locationId: LOC(), pipeline_id, stage_id, status, q, limit, startAfter } }),
  },
  {
    name: "ghl_get_opportunity",
    description: "Get one opportunity by id. Read-only.",
    inputSchema: { type: "object", properties: { opportunity_id: { type: "string" } }, required: ["opportunity_id"] },
    handler: async ({ opportunity_id }) => ghlRequest("GET", "/opportunities/" + opportunity_id),
  },
  {
    name: "ghl_safe_update_opportunity",
    description: "SAFE WRAPPER rond PUT /opportunities/{id}. Status/stage-overgangen kunnen workflows, automations en correspondentie triggeren. Default = FAIL-CLOSED (refused + preview). Geef expliciet confirm:true om door te voeren. `fields`: monitored (pipelineStageId), status, name, value, contactId, etc.",
    inputSchema: {
      type: "object",
      properties: { opportunity_id: { type: "string" }, fields: { type: "object", description: "Partial opportunity body." }, ...confirmProp },
      required: ["opportunity_id", "fields"],
    },
    handler: async ({ opportunity_id, fields, confirm }) => {
      const reqPlan = plan("PUT", "/opportunities/" + opportunity_id, { body: fields });
      if (confirm !== true) {
        return {
          applied: false,
          refused: true,
          reason:
            "Opportunity-mutaties (status/stage) kunnen geautomatiseerde workflows en correspondentie triggeren. Geweigerd conform draft-not-send. Review de preview en voer door in de GHL-UI, óf geef expliciet confirm:true.",
          opportunity_id,
          preview: reqPlan,
        };
      }
      const res = await ghlRequest("PUT", "/opportunities/" + opportunity_id, { body: fields });
      return { applied: true, opportunity_id, note: "⚠️ confirm=true — mutatie doorgevoerd (kan workflows hebben geactiveerd).", result: res };
    },
  },

  // ===== D. Conversations — SMS / Email (draft-not-send!) =====
  {
    name: "ghl_search_conversations",
    description: "Search conversations. Read-only. Filters: contact_id, type (SMS/Email/WhatsApp/...), limit, startAfter.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, type: { type: "string" }, limit: { type: "number" }, startAfter: { type: "string" } },
    },
    handler: async ({ contact_id, type, limit, startAfter }) =>
      ghlRequest("POST", "/conversations/search", { body: { locationId: LOC(), contactId: contact_id, type, limit, startAfter } }),
  },
  {
    name: "ghl_get_messages",
    description: "List messages in a conversation. Read-only.",
    inputSchema: {
      type: "object",
      properties: { conversation_id: { type: "string" }, limit: { type: "number" }, sort: { type: "string", enum: ["asc", "desc"] } },
      required: ["conversation_id"],
    },
    handler: async ({ conversation_id, limit, sort }) =>
      ghlRequest("GET", "/conversations/" + conversation_id + "/messages", { query: { locationId: LOC(), limit, sort: sort || "desc" } }),
  },
  {
    name: "ghl_prepare_message",
    description:
      "SAFE WRAPPER rond POST /conversations/messages. ⚠️ Dit endpoint VERSTUURT direct een echt SMS/Email naar de contact. Default = FAIL-CLOSED: zonder expliciet send_real_correspondence:true retourneert de tool een preview (type, contactId, body) en stuurt NIETS. Geef expliciet send_real_correspondence:true om echt te (laten) versturen. Verplicht: type (SMS/Email/WhatsApp/...), contact_id, body.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["SMS", "Email", "WhatsApp", "IG", "FB", "Custom", "Live_Chat"], description: "Berichtkanaal." },
        contact_id: { type: "string", description: "GHL contact id van de ontvanger." },
        body: { type: "string", description: "Berichtinhoud (SMS-body, email-HTML, etc.)." },
        send_real_correspondence: { type: "boolean", description: "Expliciete opt-in. DEFAULT FALSE = preview. true = bericht wordt VERSTUURD." },
      },
      required: ["type", "contact_id", "body"],
    },
    handler: async ({ type, contact_id, body, send_real_correspondence }) => {
      const reqBody = { type, contactId: contact_id, locationId: LOC(), body };
      if (send_real_correspondence !== true) {
        return {
          sent: false,
          refused: true,
          would_send_correspondence: true,
          reason:
            "POST /conversations/messages VERSTUURT direct een echt bericht naar de contact. Geweigerd conform draft-not-send. Review de preview en verstuur vanuit de GHL-UI, óf geef expliciet send_real_correspondence:true om alsnog te (laten) versturen.",
          preview: plan("POST", "/conversations/messages", { body: reqBody }),
        };
      }
      const res = await ghlRequest("POST", "/conversations/messages", { body: reqBody });
      return { sent: true, note: "⚠️ send_real_correspondence=true — bericht is VERSTUURD.", result: res };
    },
  },
  {
    name: "ghl_send_message",
    description: "Send a message directly — ALTERNATIEVE send-tool met confirm-guard (i.p.v. de fail-closed prepare_message). Verplicht: confirm:true + type + contact_id + body. Voor bewuste, expliciete verzending.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["SMS", "Email", "WhatsApp", "IG", "FB", "Custom", "Live_Chat"] },
        contact_id: { type: "string" }, body: { type: "string" }, ...confirmProp,
      },
      required: ["type", "contact_id", "body", "confirm"],
    },
    handler: async ({ type, contact_id, body, confirm }) => {
      if (confirm !== true) throw new Error("Refused: ghl_send_message requires confirm=true (would send a real message to the contact).");
      const res = await ghlRequest("POST", "/conversations/messages", { body: { type, contactId: contact_id, locationId: LOC(), body } });
      return { sent: true, note: "⚠️ confirm=true — bericht is VERSTUURD.", result: res };
    },
  },

  // ===== E. Calendars / Events =====
  {
    name: "ghl_list_calendars",
    description: "List calendars for the location. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/calendars/", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_list_events",
    description: "List calendar events/appointments. Read-only. Filters: calendar_id, start_time, end_time (unix), group, limit.",
    inputSchema: {
      type: "object",
      properties: { calendar_id: { type: "string" }, start_time: { type: "number" }, end_time: { type: "number" }, limit: { type: "number" } },
    },
    handler: async ({ calendar_id, start_time, end_time, limit }) =>
      ghlRequest("GET", "/calendars/" + (calendar_id || "events"), { query: { locationId: LOC(), startTime: start_time, endTime: end_time, limit } }),
  },

  // ===== F. Tasks (contact-level) =====
  {
    name: "ghl_list_contact_tasks",
    description: "List tasks for a contact. Read-only. NOTE: GHL Custom-Object tasks have no API support yet — only contact-tasks.",
    inputSchema: { type: "object", properties: { contact_id: { type: "string" } }, required: ["contact_id"] },
    handler: async ({ contact_id }) => ghlRequest("GET", "/contacts/" + contact_id + "/tasks"),
  },

  // ===== G. Invoices (read-only; update later) =====
  {
    name: "ghl_list_invoices",
    description: "List invoices for the location. Read-only. Filters: contact_id, limit, offset. Uses altId/altType (GHL multi-tenant parametrisatie).",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, limit: { type: "number" }, offset: { type: "string", description: "Pagination cursor (string, bv. '0')." } },
    },
    handler: async ({ contact_id, limit, offset }) =>
      ghlRequest("GET", "/invoices/", { query: { altId: LOC(), altType: "location", contactId: contact_id, limit, offset: String(offset === undefined ? 0 : offset) } }),
  },
  {
    name: "ghl_get_invoice",
    description: "Get one invoice by id (incl. line items, status, amount). Read-only.",
    inputSchema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
    handler: async ({ invoice_id }) => ghlRequest("GET", "/invoices/" + invoice_id, { query: { altId: LOC(), altType: "location" } }),
  },
  {
    name: "ghl_update_invoice",
    description: "Update an invoice (PUT /invoices/{id}). Write — dryRun:true to preview. `fields` is the partial invoice body (status, amount, lineItems, etc. — see marketplace.gohighlevel.com/docs/invoices).",
    inputSchema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, fields: { type: "object", description: "Partial invoice body." }, ...dryRunProp },
      required: ["invoice_id", "fields"],
    },
    handler: async ({ invoice_id, fields, dryRun }) => {
      const body = { altType: "location", altId: LOC(), ...fields };
      if (dryRun) return { dryRun: true, plan: plan("PUT", "/invoices/" + invoice_id, { body }) };
      return ghlRequest("PUT", "/invoices/" + invoice_id, { body });
    },
  },
  {
    name: "ghl_create_invoice",
    description: "Create a new invoice (POST /invoices/). Write — dryRun:true to preview. `fields`: name, contactId, email, issueDate, dueDate, currency, lineItems[], etc.",
    inputSchema: {
      type: "object",
      properties: { fields: { type: "object", description: "Invoice body (name, contactId, email, lineItems[], ...)." }, ...dryRunProp },
      required: ["fields"],
    },
    handler: async ({ fields, dryRun }) => {
      const body = { altType: "location", altId: LOC(), ...fields };
      if (dryRun) return { dryRun: true, plan: plan("POST", "/invoices/", { body }) };
      return ghlRequest("POST", "/invoices/", { body });
    },
  },

  // ===== H. Proposals / Documents (scope-muur) =====
  {
    name: "ghl_list_proposal_templates",
    description: "List proposal/document templates (metadata only). Read-only. Works with current PIT scope.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/proposals/templates", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_get_proposal_document",
    description:
      "Get a single proposal/document (full content). Read-only. ⚠️ SCOPE-MUUR: de huidige PIT heeft (typisch) géén read-scope voor document-inhoud → 403 'not authorized for this scope'. Vangt dat op met een duidelijke instructie om de PIT-read-scope bij te zetten in GHL → Settings → Private Integrations.",
    inputSchema: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"] },
    handler: async ({ document_id }) => {
      try {
        return await ghlRequest("GET", "/proposals/document", { query: { locationId: LOC(), id: document_id } });
      } catch (e) {
        if (e.status === 403 || String(e.message).includes("not authorized")) {
          return {
            retrieved: false,
            scope_blocked: true,
            reason:
              "PIT heeft geen read-scope voor document-inhoud (403). Breid in GHL → Settings → Private Integrations de scopes van deze PIT uit met 'Documents & Contracts: read', of gebruik de DocuSeal-MCP als alternatief voor contract-templates.",
            document_id,
          };
        }
        throw e;
      }
    },
  },

  // ===== I. Raw API (escape hatch) =====
  {
    name: "ghl_raw_api",
    description: "Escape hatch: call any authenticated GHL Marketplace endpoint. path relative to the API host (must start with /). For non-GET, pass dryRun:true to preview. Use sparingly — prefer the typed tools (they have guards).",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Path relative to the API host, must start with /." },
        query: { type: "object", description: "Optional query params." },
        body: { type: "object", description: "Optional JSON body." },
        ...dryRunProp,
      },
      required: ["method", "path"],
    },
    handler: async ({ method, path: p, query, body, dryRun }) => {
      if (dryRun && method !== "GET") return { dryRun: true, plan: plan(method, p, { query, body }) };
      return ghlRequest(method, p, { query, body });
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ─── minimal MCP stdio (JSON-RPC, newline-delimited) ──────────────────────────
function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch (_) {}
}
function log(m) {
  try {
    process.stderr.write("[gohighlevel-mcp] " + m + "\n");
  } catch (_) {}
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method && method.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    const tools = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    return send({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const tool = TOOL_MAP[name];
    if (!tool) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Onbekende tool: ${name}` }], isError: true } });
    try {
      const result = await tool.handler(args || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (err) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Fout: ${err.message}` }], isError: true } });
    }
  }
  if (id !== undefined) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Methode niet gevonden: ${method}` } });
}

function main() {
  process.on("uncaughtException", (e) => log("uncaughtException: " + ((e && e.stack) || e)));
  process.on("unhandledRejection", (e) => log("unhandledRejection: " + ((e && e.stack) || e)));
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch (_) {
      return;
    }
    Promise.resolve(onMessage(msg)).catch((e) => log("handler error: " + (e && e.message)));
  });
  rl.on("close", () => process.exit(0));
  log("server gestart (" + SERVER_VERSION + ")");
}

main();
