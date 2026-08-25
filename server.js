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

// ─── Proposals/Documents helpers ──────────────────────────────────────────────
// GHL kapt /proposals/* hard af op limit=21 (hoger → 422) en pagineert met `skip`
// (niet `offset`). Het veld `total` in de respons is ONBETROUWBAAR — bij één sweep
// achtereenvolgens 48 → 42 → 41 terwijl de echte set 42 was. Daarom: doorpagineren
// tot een lege/uitgeputte pagina en dedupliceren op `_id`.
const PROPOSAL_PAGE_SIZE = 21;

// Een ondertekend document draagt de handtekening als base64-PNG in
// recipients[].imgUrl. Dát is wat een lijst van 21 documenten tot ~2MB opblaast en
// de MCP-stdio-verbinding in gevaar brengt. De compacte projectie laat hem weg.
function compactDocument(d) {
  const r = (d.recipients || [])[0] || {};
  const amount = d.grandTotal?.amount;
  return {
    id: d._id,
    name: d.name,
    status: d.status,
    // recipients[].id is het CONTACT-id (entityName: "contacts"), niet een eigen id.
    contact_id: r.id || null,
    recipient: r.contactName || [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
    recipient_email: r.email || null,
    signed: r.hasCompleted === true,
    signed_at: r.signedDate || null,
    // amount komt als string ("0.00") én als number (0) voor — normaliseren.
    grand_total: amount === undefined || amount === null ? null : Number(amount),
    currency: d.grandTotal?.currency || null,
    locale: d.locale || null,
    created_at: d.createdAt || null,
    updated_at: d.updatedAt || null,
    expires_on: d.expiresOn || null,
    is_expired: d.isExpired === true,
    // links is leeg zolang er niets verstuurd is — de betrouwbaarste "is dit de deur uit"-indicator.
    link_count: (d.links || []).length,
    has_reminder: (d.links || []).some((l) => !!l.reminderMessageId),
    fillable_field_count: (d.fillableFields || []).length,
  };
}

// Haalt alle documenten op over meerdere pagina's heen. `status`/`query` worden
// server-side gefilterd; al het andere filteren we client-side (GHL weigert elke
// andere queryparam met 422 "property should not exist").
async function fetchProposalDocuments({ status, query, date_from, date_to, payment_status, max_pages = 30 } = {}) {
  const seen = new Map();
  let pages = 0;
  let truncated = false;
  for (let page = 0; page < max_pages; page++) {
    const res = await ghlRequest("GET", "/proposals/document", {
      query: {
        locationId: LOC(),
        limit: PROPOSAL_PAGE_SIZE,
        skip: page * PROPOSAL_PAGE_SIZE,
        status,
        query,
        dateFrom: date_from,
        dateTo: date_to,
        paymentStatus: payment_status,
      },
    });
    pages++;
    const docs = res?.documents || res?.data || [];
    if (!docs.length) break;
    let fresh = 0;
    for (const d of docs) {
      if (d && d._id && !seen.has(d._id)) {
        seen.set(d._id, d);
        fresh++;
      }
    }
    // Geen nieuwe id's meer → GHL herhaalt zichzelf; doorgaan is zinloos.
    if (fresh === 0) break;
    if (docs.length < PROPOSAL_PAGE_SIZE) break;
    if (page === max_pages - 1) truncated = true;
  }
  return { documents: [...seen.values()], pages_fetched: pages, truncated };
}

// ─── AI-agent helpers (Agent Studio / Voice AI / Conversation AI) ─────────────
// ⚠️ Agent Studio: gebruik het ENKELVOUD-pad /agent-studio/agent — het meervoud
// /agent-studio/agents bestaat óók maar filtert Managed Agents (productSlug
// 'superagent') eruit (bewezen 12-8-2026). Detail-responses zijn 150k–1,5MB
// (volledige node-graph + systemPrompt per versie), dus alles hier projecteert
// server-side; een ruwe dump kan altijd nog via ghl_raw_api met file_path.
function countBy(arr, fn) {
  const out = Object.create(null);
  for (const x of Array.isArray(arr) ? arr : []) {
    const k = (x && fn(x)) || "onbekend";
    out[k] = (out[k] || 0) + 1;
  }
  return { ...out };
}
// Webhook-URL vinden: eerst de bekende directe velden, dan pas de regex-fallback —
// in een toolNode-config staat `description` vóór `url`, dus een docs-link in de
// beschrijving zou anders van de echte webhook winnen.
function firstUrl(obj) {
  const direct = obj?.url || obj?.apiDetails?.url || obj?.actionParameters?.apiDetails?.url;
  if (typeof direct === "string" && /^https?:\/\//.test(direct)) return direct;
  const m = JSON.stringify(obj || "").match(/https?:\/\/[^"\\ ]+/);
  return m ? m[0] : null;
}
// Passthrough-velden begrenzen: vandaag compact, maar het contract is onbegrensd —
// groeit zo'n veld ooit (bv. iconUrls in superAgentMetadata), dan niet stil doorlekken.
function capped(obj, maxBytes = 4000) {
  if (obj === undefined || obj === null) return obj;
  const s = JSON.stringify(obj);
  if (s.length <= maxBytes) return obj;
  return { ingekort: true, bytes: s.length, keys: typeof obj === "object" ? Object.keys(obj) : undefined };
}
function compactStudioAgent(a) {
  const slug = a.productSlug || a.productId || null;
  const prodV = a.productionVersion && typeof a.productionVersion === "object" ? a.productionVersion : null;
  return {
    id: a.id || a.agentId || a._id || null,
    name: a.name || null,
    description: a.description || null,
    // 'superagent' = Managed Agent (natural-language-gebouwd); 'agent_studio' = flow agent (node-canvas).
    // ⚠️ Het LIST-endpoint geeft geen productSlug terug — daar is type null; het detail wél.
    type: slug === "superagent" ? "managed_agent" : slug ? "flow_agent" : null,
    product_slug: slug,
    status: a.status || null,
    folder: a.folderName || a.folder || null,
    is_ootb: a.isOotb === true,
    version_count: Array.isArray(a.versions) ? a.versions.length : a.versionCount ?? null,
    production_version: prodV?.versionId || prodV?.id || (typeof a.productionVersion === "string" ? a.productionVersion : null),
    input_variables: (prodV?.inputVariables || a.inputVariables || []).map((v) =>
      typeof v === "string" ? v : v.key || v.name || v.id || null
    ),
    created_at: a.createdAt || null,
    updated_at: a.updatedAt || null,
  };
}
function compactStudioVersion(v, includePrompt) {
  const gc = v.globalConfig || {};
  const sac = gc.superAgentConfig;
  const nodes = v.nodes || [];
  const out = {
    version_id: v.versionId || v.id || v._id || null,
    version_name: v.versionName || null,
    state: v.state || null, // 'prod' | 'staging'
    is_published: v.isPublished === true,
    updated_at: v.updatedAt || null,
  };
  if (sac) {
    out.managed_agent = {
      model: sac.model || null,
      tools: sac.tools || [],
      custom_api_enabled: sac.customApiEnabled === true,
      knowledge_base_ids: sac.knowledgeBaseIds || [],
      triggers: (sac.triggers || []).map((t) => ({ type: t.type || null, name: t.name || null, enabled: t.enabled !== false })),
      plugins: (sac.plugins || []).map((p) => ({
        name: p.name || p.slug || null,
        source: p.source || null,
        skill_count: p.skillCount ?? null,
        all_skills: p.allSkills === true,
      })),
      system_prompt_chars: String(sac.systemPrompt || "").length,
      ...(includePrompt ? { system_prompt: sac.systemPrompt || null } : {}),
    };
  }
  if (v.superAgentMetadata) out.super_agent_metadata = capped(v.superAgentMetadata);
  if (nodes.length) {
    out.flow = {
      node_count: nodes.length,
      nodes_per_type: countBy(nodes, (n) => n.nodeType || n.type),
      nodes: nodes.map((n) => {
        const nc = n.nodeConfig || n.config || {};
        const type = n.nodeType || n.type || null;
        return {
          name: n.nodeDisplayName || n.nodeName || nc.name || null,
          type,
          ...(nc.llmModel ? { model: (nc.llmProvider || "?") + "/" + nc.llmModel } : {}),
          ...(String(type || "").toLowerCase().includes("tool") ? { webhook: firstUrl(nc) } : {}),
          ...(nc.prompt ? { prompt_chars: String(nc.prompt).length } : {}),
          ...(includePrompt && nc.prompt ? { prompt: nc.prompt } : {}),
        };
      }),
      ...(gc.globalPrompt
        ? { global_prompt_chars: String(gc.globalPrompt).length, ...(includePrompt ? { global_prompt: gc.globalPrompt } : {}) }
        : {}),
    };
  }
  return out;
}
function compactVoiceAgent(a) {
  return {
    id: a.id || a._id || null,
    name: a.agentName || a.name || null,
    language: a.language || a.locale || a.translation?.language || null,
    inbound_numbers: a.inboundNumbers || [],
    live: (a.inboundNumbers || []).length > 0,
    voice_id: a.voiceId || null,
    max_call_duration: a.maxCallDuration ?? null,
    action_count: (a.actions || []).length,
    actions_per_type: countBy(a.actions, (x) => x.actionType),
    prompt_chars: String(a.agentPrompt || "").length,
  };
}
function compactConvAiAgent(a) {
  const groot = {};
  // De grote tekstvelden heten hier fullPrompt/instructions (empirisch 12-8), niet prompt.
  for (const k of ["fullPrompt", "instructions", "personality", "summary"]) {
    if (a[k]) groot[k + "_chars"] = String(a[k]).length;
  }
  return {
    id: a.id || a._id || null,
    name: a.name || a.agentName || null,
    mode: a.mode || null,
    // ⚠️ channels wordt door de API niet altijd geëchood — null betekent 'onbekend', niet 'geen'.
    channels: a.channels || null,
    knowledge_base_ids: a.knowledgeBaseIds || a.knowledgeBases || null,
    ...groot,
    created_at: a.createdAt || null,
    updated_at: a.updatedAt || null,
  };
}

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
    description:
      "List automation workflows. Read-only, alles in één call (geen paginatie). Filters: status (published/draft), name_contains, updated_since (ISO-datum). ⚠️ Een workflowrecord bevat ALLEEN metadata (id, naam, status, versie, datums) — triggers en acties zijn NIET via de API leesbaar: GET /workflows/{id} geeft 404, net als /versions, /actions, /steps en /executions. Wat een workflow doet kun je dus alleen in de GHL-UI zien of afleiden uit zijn sporen (aangemaakte records, tijdstempels).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["published", "draft"], description: "Alleen gepubliceerde (= die écht vuren) of alleen concepten." },
        name_contains: { type: "string", description: "Filter op naam, hoofdletterongevoelig." },
        updated_since: { type: "string", description: "ISO-datum; alleen workflows die daarna gewijzigd zijn." },
      },
    },
    handler: async ({ status, name_contains, updated_since }) => {
      const res = await ghlRequest("GET", "/workflows/", { query: { locationId: LOC() } });
      let rows = res?.workflows || [];
      const totaal = rows.length;
      if (status) rows = rows.filter((w) => w.status === status);
      if (name_contains) {
        const n = String(name_contains).toLowerCase();
        rows = rows.filter((w) => String(w.name || "").toLowerCase().includes(n));
      }
      if (updated_since) {
        const t = Date.parse(updated_since);
        if (!Number.isNaN(t)) rows = rows.filter((w) => Date.parse(w.updatedAt || 0) >= t);
      }
      rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return {
        count: rows.length,
        totaal_in_location: totaal,
        workflows: rows.map(({ locationId, ...w }) => w),
      };
    },
  },
  {
    name: "ghl_audit_workflows",
    description:
      "Audit de workflows van de location. Read-only. Geeft: (1) de GEPUBLICEERDE workflows — alleen die vuren echt, dus dat is het volledige automatiseringsoppervlak dat je moet kennen, (2) lege placeholder-workflows ('New Workflow : <timestamp>' op versie 1, nooit geconfigureerd), (3) workflows die documenten of opportunities lijken te raken, op naam herkend, (4) recent gewijzigde workflows. Gebruik dit om te zien wát er in GHL automatisch kan gebeuren voordat je zelf iets bouwt of aanzet.",
    inputSchema: {
      type: "object",
      properties: { recent_days: { type: "number", description: "Venster voor 'recent gewijzigd' (default 14 dagen)." } },
    },
    handler: async ({ recent_days }) => {
      const res = await ghlRequest("GET", "/workflows/", { query: { locationId: LOC() } });
      const rows = (res?.workflows || []).map(({ locationId, ...w }) => w);
      const venster = Number(recent_days || 14);
      const grens = Date.now() - venster * 86400000;
      const isPlaceholder = (w) => /^New Workflow\s*:\s*\d+$/i.test(String(w.name || "")) && w.version === 1;
      const raaktDocumenten = /document|contract|opdrachtbevestig|aanbod|dagvaarding|proposal|bevestiging/i;
      const raaktOpportunities = /opportunit|pipeline|lead|formulier|intake|aanmeld/i;
      return {
        totaal: rows.length,
        per_status: rows.reduce((a, w) => ((a[w.status] = (a[w.status] || 0) + 1), a), {}),
        gepubliceerd: {
          aantal: rows.filter((w) => w.status === "published").length,
          toelichting: "Alleen deze vuren. Elke andere workflow staat op draft en doet niets — ongeacht wat de naam suggereert.",
          workflows: rows.filter((w) => w.status === "published").sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
        },
        lege_placeholders: {
          aantal: rows.filter(isPlaceholder).length,
          toelichting: "Aangemaakt en nooit ingevuld (versie 1, automatisch gegenereerde naam). Veilig op te ruimen in de UI.",
          workflows: rows.filter(isPlaceholder),
        },
        raakt_documenten: rows.filter((w) => raaktDocumenten.test(w.name || "")).map((w) => ({ ...w, vuurt: w.status === "published" })),
        raakt_opportunities: rows.filter((w) => raaktOpportunities.test(w.name || "")).map((w) => ({ ...w, vuurt: w.status === "published" })),
        recent_gewijzigd: rows.filter((w) => Date.parse(w.updatedAt || 0) >= grens).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
        beperking:
          "⚠️ Van geen enkele workflow is via de API leesbaar wát hij doet (GET /workflows/{id} → 404 op alle subroutes). Deze audit werkt op metadata en naamgeving; voor de inhoud is de GHL-UI de enige bron.",
      };
    },
  },
  {
    name: "ghl_enroll_contact_in_workflow",
    description:
      "⚠️⚠️ Schrijf een contact IN in een workflow (POST /contacts/{contactId}/workflow/{workflowId}). Dit START een automatisering die e-mail, sms of WhatsApp naar een ECHTE klant kan sturen en documenten kan aanmaken — de gepubliceerde workflow 'Documenten | Incasso aanbod klaarzetten' doet precies dat. FAIL-CLOSED: zonder confirm:true gebeurt er niets en krijg je een preview met de naam en status van de workflow. 🚨 Onomkeerbaar en niet controleerbaar: er bestaat GEEN route om op te vragen welke contacten in een workflow zitten (GET /contacts/{id}/workflow → 404), dus je kunt achteraf niet vaststellen wat je hebt aangezet. Gebruik dit alleen als je precies weet wat de workflow doet — en dat kun je alleen in de GHL-UI zien.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        workflow_id: { type: "string" },
        event_start_time: { type: "string", description: "Optioneel ISO-tijdstip waarop de workflow moet starten (body.eventStartTime)." },
        ...confirmProp,
      },
      required: ["contact_id", "workflow_id"],
    },
    handler: async ({ contact_id, workflow_id, event_start_time, confirm }) => {
      const path = "/contacts/" + contact_id + "/workflow/" + workflow_id;
      const body = event_start_time ? { eventStartTime: event_start_time } : {};
      let wf = null;
      try {
        const res = await ghlRequest("GET", "/workflows/", { query: { locationId: LOC() } });
        wf = (res?.workflows || []).find((w) => w.id === workflow_id) || null;
      } catch (_) {
        /* preview mag niet klappen op een leesfout */
      }
      if (confirm !== true) {
        return {
          enrolled: false,
          refused: true,
          reason:
            "Inschrijven start een automatisering die correspondentie naar een echte klant kan sturen. Geweigerd zonder confirm:true (draft-not-send).",
          workflow: wf ? { id: wf.id, name: wf.name, status: wf.status, version: wf.version } : { id: workflow_id, note: "workflow niet gevonden in de lijst" },
          ...(wf && wf.status !== "published"
            ? { let_op: "Deze workflow staat op DRAFT en vuurt dus niet — inschrijven heeft geen effect." }
            : { let_op: "⚠️ Deze workflow is PUBLISHED en vuurt dus echt." }),
          preview: plan("POST", path, { body }),
        };
      }
      const res = await ghlRequest("POST", path, { body });
      return {
        enrolled: true,
        note: "⚠️ confirm=true — contact is INGESCHREVEN. Niet machinaal te controleren of terug te draaien; gebruik ghl_remove_contact_from_workflow om uit te schrijven.",
        workflow: wf ? { id: wf.id, name: wf.name, status: wf.status } : { id: workflow_id },
        result: res,
      };
    },
  },
  {
    name: "ghl_remove_contact_from_workflow",
    description:
      "Schrijf een contact UIT een workflow (DELETE /contacts/{contactId}/workflow/{workflowId}). Vereist confirm:true. Dit stopt geplande stappen voor dit contact — nuttig als er per ongeluk iemand in een lopende automatisering is beland. ⚠️ Je kunt vooraf niet opvragen óf het contact erin zit (die route bestaat niet); de call is idempotent genoeg om blind uit te voeren, maar je krijgt geen bevestiging van wat er precies is afgebroken.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, workflow_id: { type: "string" }, ...confirmProp },
      required: ["contact_id", "workflow_id", "confirm"],
    },
    handler: async ({ contact_id, workflow_id, confirm }) => {
      if (confirm !== true) throw new Error("Refused: ghl_remove_contact_from_workflow requires confirm=true.");
      const res = await ghlRequest("DELETE", "/contacts/" + contact_id + "/workflow/" + workflow_id);
      return { removed: true, contact_id, workflow_id, result: res };
    },
  },
  {
    name: "ghl_list_campaigns",
    description:
      "List campaigns — de oudere automatiseringslaag naast workflows. Read-only. ⚠️ GET /campaigns/{id} geeft 401 (scope ontbreekt), dus ook hier is alleen de lijst leesbaar, niet de inhoud.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/campaigns/", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_remove_contact_from_campaigns",
    description:
      "Haal een contact uit één campagne of uit ALLE campagnes (DELETE /contacts/{id}/campaigns/{campaignId} of .../campaigns/removeAll). Vereist confirm:true. Dit is de noodrem als iemand ten onrechte in een geautomatiseerde reeks zit.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        campaign_id: { type: "string", description: "Campagne-id, of laat weg samen met all:true om alle campagnes te stoppen." },
        all: { type: "boolean", description: "true = removeAll (uit alle campagnes)." },
        ...confirmProp,
      },
      required: ["contact_id", "confirm"],
    },
    handler: async ({ contact_id, campaign_id, all, confirm }) => {
      if (confirm !== true) throw new Error("Refused: ghl_remove_contact_from_campaigns requires confirm=true.");
      if (!all && !campaign_id) throw new Error("Geef campaign_id, of all:true om uit alle campagnes te halen.");
      const path = "/contacts/" + contact_id + "/campaigns/" + (all ? "removeAll" : campaign_id);
      const res = await ghlRequest("DELETE", path);
      return { removed: true, contact_id, scope: all ? "alle campagnes" : campaign_id, result: res };
    },
  },
  {
    name: "ghl_list_trigger_links",
    description:
      "List trigger links (de 'Trigger Link Clicked'-kant van automatiseringen). Read-only. Bevat id, naam, redirectTo en fieldKey — géén waardeveld, dus een trigger link kan geen data per contact dragen.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/links/", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_fire_inbound_webhook",
    description:
      "⚠️⚠️ Vuur een workflow af via zijn Inbound-Webhook-trigger (GET /hooks/{locationId}/webhook-trigger/{webhookId}). Dit is de ENIGE manier om een workflow machinaal te starten zonder een contact in te schrijven. FAIL-CLOSED: zonder confirm:true wordt er niets afgevuurd. 🚨 Je kunt vooraf niet zien welke workflow aan een webhook-id hangt en achteraf niet zien wat hij deed — er is geen executie-log via de API. Alleen gebruiken met een webhook-id dat je zelf uit de GHL-UI hebt gehaald en waarvan je weet wat eraan hangt.",
    inputSchema: {
      type: "object",
      properties: {
        webhook_id: { type: "string", description: "Het webhook-id uit de Inbound Webhook-trigger in de GHL-UI." },
        payload: { type: "object", description: "Optionele queryparameters die als velden aan de workflow worden meegegeven." },
        ...confirmProp,
      },
      required: ["webhook_id"],
    },
    handler: async ({ webhook_id, payload, confirm }) => {
      const path = "/hooks/" + LOC() + "/webhook-trigger/" + webhook_id;
      if (confirm !== true) {
        return {
          fired: false,
          refused: true,
          reason:
            "Een webhooktrigger start een automatisering die correspondentie kan versturen of documenten kan aanmaken, zonder dat je achteraf kunt zien wat er gebeurde. Geweigerd zonder confirm:true.",
          preview: plan("GET", path, { query: payload }),
        };
      }
      const res = await ghlRequest("GET", path, { query: payload });
      return { fired: true, note: "⚠️ confirm=true — de workflow is getriggerd. Er is geen executie-log via de API; controleer het effect in de GHL-UI.", result: res };
    },
  },
  {
    name: "ghl_list_custom_fields",
    description:
      "List custom fields for the location. Read-only. ⚠️ Default is model='all' — zonder dat levert GHL ALLEEN de contactvelden en mis je stilzwijgend alle opportunity-velden (waaronder de geldvelden hoofdsom/incassokosten/btw). Filter met model (all/contact/opportunity) en/of name_contains.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: ["all", "contact", "opportunity"], description: "Default 'all'." },
        name_contains: { type: "string", description: "Client-side filter op veldnaam, hoofdletterongevoelig." },
      },
    },
    handler: async ({ model, name_contains }) => {
      const res = await ghlRequest("GET", "/locations/" + LOC() + "/customFields", { query: { model: model || "all" } });
      let velden = res?.customFields || [];
      const totaal = velden.length;
      if (name_contains) {
        const n = String(name_contains).toLowerCase();
        velden = velden.filter((f) => String(f.name || "").toLowerCase().includes(n));
      }
      return {
        count: velden.length,
        totaal_in_location: totaal,
        per_model: velden.reduce((a, f) => ((a[f.model || "onbekend"] = (a[f.model || "onbekend"] || 0) + 1), a), {}),
        customFields: velden,
      };
    },
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
      // GHL API: SMS/WhatsApp gebruiken `message`, Email gebruikt `html` + `subject`.
      // `body` wordt door GHL genegeerd → 422 "no message or attachments".
      const reqBody = { type, contactId: contact_id, locationId: LOC() };
      if (type === "Email") {
        reqBody.html = body;
        reqBody.subject = "Bericht van TodayIClaim";
      } else {
        reqBody.message = body;
      }
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
      // GHL API: SMS/WhatsApp gebruiken `message`, Email gebruikt `html` + `subject`.
      const reqBody = { type, contactId: contact_id, locationId: LOC() };
      if (type === "Email") {
        reqBody.html = body;
        reqBody.subject = "Bericht van TodayIClaim";
      } else {
        reqBody.message = body;
      }
      const res = await ghlRequest("POST", "/conversations/messages", { body: reqBody });
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

  // ===== H. Proposals / Documents =====
  //
  // Harde grenzen van dit product (live geverifieerd 10-8-2026 — niet "nog niet",
  // maar structureel; zie de memory ghl-proposal-bedragen-onbewerkbaar-probleem):
  //  - Er zijn maar 4 endpoints: GET /proposals/templates, GET /proposals/document,
  //    POST /proposals/templates/send, POST /proposals/document/send.
  //  - Item-routes (GET/PUT/DELETE /proposals/document/{id}) bestaan wél in de router
  //    maar geven 401: er is voor PUT geen enkele scope die ze dekt; voor GET/DELETE
  //    helpt `proposals/document.write`/`.readonly` bijzetten op de PIT.
  //  - Een documentrecord bevat GEEN bodytekst — de inhoud verlaat GHL nooit via de API.
  //  - Bedragvelden zijn fillableFields die pas bij ONDERTEKENING resolven en die de
  //    ontvanger zelf kan bewerken. Lees `grand_total` dus niet als "het bedrag op het
  //    document": dat is alleen gevuld bij sjablonen met geprijsde regels.
  {
    name: "ghl_list_proposal_templates",
    description:
      "List proposal/document templates (metadata: id, name, grandTotal). Read-only. ⚠️ Sjabloon-INHOUD is niet leesbaar (GET /proposals/templates/{id} → 401, geen scope bestaat ervoor). Een template met een echte grandTotal heeft geprijsde regels; grandTotal 0 betekent dat alle bedragen uit fillableFields/merge-tokens moeten komen.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ghlRequest("GET", "/proposals/templates", { query: { locationId: LOC() } }),
  },
  {
    name: "ghl_list_proposal_documents",
    description:
      "List proposal/contract documents, gepagineerd en gededupliceerd. Read-only. DIT IS DE TOOL om documenten te overzien — ghl_raw_api op /proposals/document levert tot 2MB per pagina (base64-handtekeningen) en loopt je context vol. Default = compacte projectie zonder handtekeningafbeeldingen. Filters: status (draft/sent/viewed/completed), query (zoekt op de naam van de ONTVANGER, niet de debiteur), contact_id, name_contains, unsigned_only, expired_only. Zet full:true voor de ruwe records (alleen met een kleine limit).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "sent", "viewed", "completed", "accepted", "declined"], description: "Server-side statusfilter." },
        query: { type: "string", description: "Server-side zoekterm op de naam van de ONTVANGER (de opdrachtgever), niet de debiteur." },
        date_from: { type: "string", description: "ISO-8601 begindatum (server-side)." },
        date_to: { type: "string", description: "ISO-8601 einddatum (server-side)." },
        payment_status: { type: "string", enum: ["waiting_for_payment", "paid", "no_payment"], description: "Server-side betaalstatusfilter." },
        contact_id: { type: "string", description: "Client-side filter op recipients[].id (= het contact-id)." },
        name_contains: { type: "string", description: "Client-side filter op de documentnaam (hoofdletterongevoelig)." },
        unsigned_only: { type: "boolean", description: "Alleen documenten die nog niet getekend zijn." },
        expired_only: { type: "boolean", description: "Alleen verlopen documenten." },
        limit: { type: "number", description: "Max aantal terug te geven documenten na filtering." },
        max_pages: { type: "number", description: "Max op te halen pagina's à 21 (default 30)." },
        full: { type: "boolean", description: "true = ruwe records inclusief fillableFields en handtekeningen. Gebruik alleen met een kleine limit." },
      },
    },
    handler: async ({ status, query, date_from, date_to, payment_status, contact_id, name_contains, unsigned_only, expired_only, limit, max_pages, full }) => {
      const { documents, pages_fetched, truncated } = await fetchProposalDocuments({ status, query, date_from, date_to, payment_status, max_pages });
      let rows = documents;
      if (contact_id) rows = rows.filter((d) => (d.recipients || []).some((r) => r.id === contact_id));
      if (name_contains) {
        const needle = String(name_contains).toLowerCase();
        rows = rows.filter((d) => String(d.name || "").toLowerCase().includes(needle));
      }
      if (unsigned_only) rows = rows.filter((d) => !(d.recipients || []).some((r) => r.hasCompleted === true));
      if (expired_only) rows = rows.filter((d) => d.isExpired === true);
      rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const matched = rows.length;
      if (limit) rows = rows.slice(0, limit);
      return {
        count: rows.length,
        matched_before_limit: matched,
        fetched_total: documents.length,
        pages_fetched,
        ...(truncated ? { truncated: true, note: "max_pages bereikt — er kunnen meer documenten zijn." } : {}),
        documents: full ? rows : rows.map(compactDocument),
      };
    },
  },
  {
    name: "ghl_get_proposal_document",
    description:
      "Get one proposal/document by id. Read-only. Probeert eerst de item-route (GET /proposals/document/{id}) en valt bij de 401-scopemuur automatisch terug op doorpagineren van de lijst en het record lokaal uitlichten — dat werkt met de huidige PIT. ⚠️ Levert NOOIT de bodytekst: die zit in geen enkele API-respons. Wat je wél krijgt: status, ontvanger, ondertekenstatus, fillableFields (met hun merge-tokens), links en grandTotal.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        include_signature_image: { type: "boolean", description: "true = laat recipients[].imgUrl (base64-handtekening, vaak >1MB) staan. Default false." },
      },
      required: ["document_id"],
    },
    handler: async ({ document_id, include_signature_image }) => {
      const strip = (d) => {
        if (include_signature_image || !d) return d;
        return { ...d, recipients: (d.recipients || []).map(({ imgUrl, ...r }) => (imgUrl ? { ...r, imgUrl: "<base64 weggelaten — zet include_signature_image:true>" } : r)) };
      };
      try {
        const direct = await ghlRequest("GET", "/proposals/document/" + document_id, { query: { locationId: LOC() } });
        return { via: "item-route", document: strip(direct?.document || direct) };
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) throw e;
        const { documents, pages_fetched } = await fetchProposalDocuments({});
        const hit = documents.find((d) => d._id === document_id || d.documentId === document_id);
        if (!hit) {
          return {
            retrieved: false,
            document_id,
            pages_fetched,
            reason:
              "Item-route geeft 401 (scope ontbreekt) en het id is niet gevonden in de doorgepagineerde lijst. Controleer het id, of zet in GHL → Settings → Private Integrations de scope 'proposals/document.readonly' bij op deze PIT.",
          };
        }
        return { via: "lijst-fallback (item-route gaf 401)", pages_fetched, document: strip(hit) };
      }
    },
  },
  {
    name: "ghl_audit_proposal_documents",
    description:
      "Audit alle documenten op de bekende probleempatronen. Read-only, geen mutaties. Vindt: (1) verweesde drafts met de kale sjabloonnaam (nooit hernoemd = waarschijnlijk machinaal aangemaakt en blijven liggen), (2) meerdere documenten op hetzelfde contact (dubbele bevestigingen — dit is echt gebeurd), (3) verstuurd maar nooit getekend, (4) verlopen, (5) documenten zonder verzendlink. Gebruik dit vóór je een nieuw document aanmaakt: een liggende draft of een nog geldige 'sent' is de meest voorkomende blokkade.",
    inputSchema: {
      type: "object",
      properties: {
        max_pages: { type: "number", description: "Max op te halen pagina's à 21 (default 30)." },
        stale_days: { type: "number", description: "Vanaf hoeveel dagen een ongetekend document als blijven-liggen telt (default 7)." },
      },
    },
    handler: async ({ max_pages, stale_days }) => {
      const { documents, pages_fetched, truncated } = await fetchProposalDocuments({ max_pages });
      const drempel = Number(stale_days || 7);
      const nu = Date.now();
      const rows = documents.map(compactDocument);
      const dagenOud = (d) => (d.created_at ? (nu - Date.parse(d.created_at)) / 86400000 : null);

      const perContact = new Map();
      for (const r of rows) {
        if (!r.contact_id) continue;
        if (!perContact.has(r.contact_id)) perContact.set(r.contact_id, []);
        perContact.get(r.contact_id).push(r);
      }
      const duplicaten = [...perContact.entries()]
        .filter(([, v]) => v.length > 1)
        .map(([contact_id, v]) => ({
          contact_id,
          recipient: v[0].recipient,
          aantal: v.length,
          documenten: v.map((x) => ({ id: x.id, status: x.status, created_at: x.created_at, name: x.name })),
        }))
        .sort((a, b) => b.aantal - a.aantal);

      const kaleNaam = rows.filter((r) => /-\s*Template$/i.test(String(r.name || "")));
      const perStatus = rows.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});

      return {
        totaal: rows.length,
        pages_fetched,
        ...(truncated ? { truncated: true } : {}),
        per_status: perStatus,
        bevindingen: {
          kale_sjabloonnaam: {
            aantal: kaleNaam.length,
            toelichting: "Naam is nooit aangepast — typisch machinaal aangemaakt en blijven liggen. Handmatig gemaakte documenten heten '<Sjabloon> - <opdrachtgever> / <debiteur>'.",
            documenten: kaleNaam.slice(0, 40),
          },
          meerdere_per_contact: {
            aantal_contacten: duplicaten.length,
            toelichting: "Meer dan één document op hetzelfde contact. Controleer dit ALTIJD vóór je een nieuw document aanmaakt.",
            contacten: duplicaten.slice(0, 40),
          },
          verstuurd_niet_getekend: rows
            .filter((r) => (r.status === "sent" || r.status === "viewed") && !r.signed)
            .map((r) => ({ ...r, dagen_oud: Math.round(dagenOud(r) ?? 0) }))
            .filter((r) => r.dagen_oud >= drempel),
          verlopen: rows.filter((r) => r.is_expired),
          zonder_verzendlink: rows.filter((r) => r.link_count === 0 && r.status !== "draft"),
        },
      };
    },
  },
  {
    name: "ghl_proposal_pdf_url",
    description:
      "Bouw (en download optioneel) de PUBLIEKE PDF-link van een document. Deze route werkt ZONDER Authorization-header — dat is precies waarom hij bruikbaar is nu de API-routes 401 geven, én waarom hij gevoelig is: 🚨 iedereen met deze link downloadt handtekening, NAW en IBAN zonder in te loggen. Deel hem niet en zet hem niet in een ticket. Geef file_path om de PDF server-side weg te schrijven in plaats van hem inline terug te krijgen.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        document_name: { type: "string", description: "Documentnaam. Weglaten = automatisch opzoeken via de lijst." },
        download: { type: "boolean", description: "true = de PDF ophalen. Default false: alleen de URL teruggeven." },
        file_path: { type: "string", description: "Absoluut pad om de PDF weg te schrijven (aanbevolen boven inline base64)." },
      },
      required: ["document_id"],
    },
    handler: async ({ document_id, document_name, download, file_path }) => {
      let naam = document_name;
      if (!naam) {
        const { documents } = await fetchProposalDocuments({});
        naam = documents.find((d) => d._id === document_id)?.name;
        if (!naam) throw new Error("Documentnaam niet gevonden voor id " + document_id + " — geef document_name expliciet mee.");
      }
      const p = `location/${LOC()}/documents/${document_id}/${naam}.pdf`;
      const url = "/proposals/document/public/download-pdf?p=" + encodeURIComponent(p);
      if (!download) {
        return {
          url: (process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com") + url,
          warning: "🚨 Publieke, niet-geauthenticeerde link naar een ondertekend document (handtekening + NAW + IBAN). Niet delen.",
        };
      }
      return ghlRequest("GET", url, { file_path });
    },
  },
  {
    name: "ghl_create_proposal_document",
    description:
      "Maak een nieuw document uit een sjabloon (POST /proposals/templates/send met sendDocument:false = DRAFT, niets verstuurd). Vereist confirm:true. ⚠️ Het verplichte veld heet `templateId` — een 422 'The required field documentId is missing' betekent dat templateId ontbreekt, niet dat je een documentId moet meegeven (misleidende foutboodschap van GHL). Geef opportunityId mee, anders resolven de {{opportunity.debiteur_*}}-tokens niet. 🚨 INGEBOUWDE DUPLICAATCHECK: weigert als er al een niet-afgewezen document op dit contact staat — een dubbele opdrachtbevestiging naar een echte cliënt is hier al eens gebeurd. Overrulen met allow_duplicate:true. Wat je NIET kunt zetten: naam, bedragen en document-variabelen — die worden door de API geweigerd; het document krijgt de sjabloonnaam en grandTotal 0.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "Sjabloon-id uit ghl_list_proposal_templates." },
        contact_id: { type: "string", description: "Ontvanger (de opdrachtgever)." },
        opportunity_id: { type: "string", description: "Sterk aanbevolen: zonder dit resolven de opportunity-merge-tokens niet." },
        user_id: { type: "string", description: "GHL-gebruiker als afzender. Default s4OyY4zFwqtIPC5hP3CY (Max)." },
        locale: { type: "string", description: "Bv. 'nl-NL'. Let op: bestaande NL-documenten staan grotendeels op en-US." },
        send_document: { type: "boolean", description: "DEFAULT FALSE = alleen draft. true VERSTUURT het document naar de klant." },
        allow_duplicate: { type: "boolean", description: "true = maak ook aan als er al een document op dit contact staat." },
        ...confirmProp,
      },
      required: ["template_id", "contact_id", "confirm"],
    },
    handler: async ({ template_id, contact_id, opportunity_id, user_id, locale, send_document, allow_duplicate, confirm }) => {
      if (confirm !== true) throw new Error("Refused: ghl_create_proposal_document requires confirm=true.");
      if (send_document === true) {
        throw new Error(
          "Refused: send_document:true zou het document direct naar de klant versturen. Maak eerst een draft (send_document weglaten) en verstuur bewust met ghl_send_proposal_document, of vanuit de GHL-UI."
        );
      }
      if (!allow_duplicate) {
        const { documents } = await fetchProposalDocuments({});
        const bestaand = documents
          .filter((d) => (d.recipients || []).some((r) => r.id === contact_id))
          .filter((d) => d.status !== "declined")
          .map(compactDocument);
        if (bestaand.length) {
          return {
            created: false,
            refused: true,
            reason:
              "Er staat al " + bestaand.length + " document(en) op dit contact. Een tweede bevestiging naar dezelfde cliënt is een reëel risico — controleer of het bestaande document nog geldig is (status sent/viewed = ligt bij de klant). Overrulen met allow_duplicate:true.",
            bestaande_documenten: bestaand,
          };
        }
      }
      const body = {
        templateId: template_id,
        contactId: contact_id,
        locationId: LOC(),
        userId: user_id || "s4OyY4zFwqtIPC5hP3CY",
        sendDocument: false,
        ...(opportunity_id ? { opportunityId: opportunity_id } : {}),
        ...(locale ? { locale } : {}),
      };
      const res = await ghlRequest("POST", "/proposals/templates/send", { body });
      return {
        created: true,
        sent: false,
        note: "Draft aangemaakt, niets verstuurd (sendDocument:false). Naam = sjabloonnaam en grandTotal = 0; beide zijn niet via de API te zetten.",
        ...(opportunity_id ? {} : { waarschuwing: "⚠️ Geen opportunity_id meegegeven — de {{opportunity.debiteur_*}}-tokens blijven leeg." }),
        result: res,
      };
    },
  },
  {
    name: "ghl_delete_proposal_document",
    description:
      "Delete a proposal document (DELETE /proposals/document/{id}). Write — vereist confirm:true. ⚠️ De route BESTAAT (een onbekende route geeft 404, deze geeft 401) maar de huidige PIT mist de schrijfscope. Zet in GHL → Settings → Private Integrations de scope 'proposals/document.write' bij; zolang dat niet is gebeurd faalt deze tool met een uitleg in plaats van een kale 401. Zonder die scope is opruimen UI-werk.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" }, ...confirmProp },
      required: ["document_id", "confirm"],
    },
    handler: async ({ document_id, confirm }) => {
      if (confirm !== true) throw new Error("Refused: ghl_delete_proposal_document requires confirm=true (verwijdert een document bij de klant uit beeld).");
      try {
        const res = await ghlRequest("DELETE", "/proposals/document/" + document_id, { query: { locationId: LOC() } });
        return { deleted: true, document_id, result: res };
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          return {
            deleted: false,
            scope_blocked: true,
            document_id,
            reason:
              "401 'token is not authorized for this scope'. De route bestaat, de PIT mag alleen niet schrijven. Fix: GHL → Settings → Private Integrations → scope 'proposals/document.write' bijzetten op de bestaande PIT. Tot dan: verwijderen kan alleen in de GHL-UI.",
          };
        }
        throw e;
      }
    },
  },
  {
    name: "ghl_send_proposal_document",
    description:
      "⚠️⚠️ VERSTUURT een bestaand document ter ondertekening naar de klant (POST /proposals/document/send). FAIL-CLOSED: zonder expliciet send_real_correspondence:true wordt er NIETS verstuurd en krijg je een preview plus de huidige status van het document. Dit is een onomkeerbare handeling naar een echte klant — conform draft-not-send hoort verzenden een menselijke klik te zijn. Let op de asymmetrie: deze PIT MAG versturen maar mag documenten niet lezen of intrekken (PUT/DELETE geven 401), dus een verkeerd verstuurd document is niet machinaal terug te halen.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        send_real_correspondence: { type: "boolean", description: "Expliciete opt-in. DEFAULT FALSE = preview, verstuurt NIETS." },
      },
      required: ["document_id"],
    },
    handler: async ({ document_id, send_real_correspondence }) => {
      const body = { documentId: document_id, locationId: LOC() };
      if (send_real_correspondence !== true) {
        let huidig = null;
        try {
          const { documents } = await fetchProposalDocuments({});
          const hit = documents.find((d) => d._id === document_id);
          if (hit) huidig = compactDocument(hit);
        } catch (_) {
          /* preview mag niet klappen op een leesfout */
        }
        return {
          sent: false,
          refused: true,
          would_send_correspondence: true,
          reason:
            "POST /proposals/document/send stuurt een ondertekenbaar contract naar de klant. Geweigerd conform draft-not-send. Controleer het document en verstuur vanuit de GHL-UI, óf geef expliciet send_real_correspondence:true.",
          document: huidig,
          ...(huidig && huidig.link_count > 0
            ? { waarschuwing: "⚠️ Dit document heeft al een verzendlink — er is al eens iets naar deze klant gegaan. Controleer op een dubbele bevestiging." }
            : {}),
          preview: plan("POST", "/proposals/document/send", { body }),
        };
      }
      const res = await ghlRequest("POST", "/proposals/document/send", { body });
      return { sent: true, note: "⚠️ send_real_correspondence=true — het document is VERSTUURD en is niet machinaal in te trekken (DELETE geeft 401).", result: res };
    },
  },

  // ===== I. Raw API (escape hatch) =====
  {
    name: "ghl_raw_api",
    description:
      "Escape hatch: call any authenticated GHL Marketplace endpoint. path relative to the API host (must start with /). For non-GET, pass dryRun:true to preview. Use sparingly — prefer the typed tools (they have guards). Binary responses (e.g. GET /documents/download/{id}) are never lossy-decoded as text: small ones come back as base64 (`content`/`mimeType`/`encoding:'base64'`), larger ones are refused with a clear error unless `file_path` is given, in which case the bytes are written server-side and only metadata is returned.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Path relative to the API host, must start with /." },
        query: { type: "object", description: "Optional query params." },
        body: { type: "object", description: "Optional JSON body." },
        file_path: {
          type: "string",
          description:
            "Optional: absolute path to write a binary/large response (e.g. a downloaded PDF) server-side to disk instead of returning it inline as base64. Prevents corruption/truncation on large files and avoids crashing the MCP connection. Only relevant for binary content-types — JSON responses are always returned inline as JSON.",
        },
        agency: {
          type: "boolean",
          description:
            "Gebruik het AGENCY-token (GHL_AGENCY_TOKEN) i.p.v. het sub-account-token. Nodig voor company-niveau routes zoals /snapshots/ en /companies/{id}: die geven op het gewone token 401, en dat is een niveauverschil, geen ontbrekende scope (bewezen 12-8: GET /locations/{id} → 200, GET /companies/{id} → 401). Laat weg voor alle normale sub-account-calls; het agency-token heeft veel bredere rechten.",
        },
        v1: {
          type: "boolean",
          description:
            "Praat met de LEGACY v1-API (https://rest.gohighlevel.com/v1) met GHL_V1_KEY i.p.v. de v2-API. Paden zijn relatief t.o.v. /v1, dus gebruik '/workflows/'. Reden dat dit bestaat: v2 heeft GEEN enkele workflow-detail- of schrijfroute (alles 'Cannot GET/POST', ook met agency-token), maar v1 heeft aantoonbaar wél een workflows-endpoint (12-8: GET /v1/workflows/ → 401 tegenover een neproute → 404). Foutformaat daar is {\"msg\":...} i.p.v. {\"message\":...}.",
        },
        ...dryRunProp,
      },
      required: ["method", "path"],
    },
    handler: async ({ method, path: p, query, body, dryRun, file_path, agency, v1 }) => {
      if (dryRun && method !== "GET")
        return { dryRun: true, plan: { ...plan(method, p, { query, body }), agency: !!agency, v1: !!v1 } };
      return ghlRequest(method, p, { query, body, file_path, agency, v1 });
    },
  },

  // ===== J. AI-agents (Agent Studio / Voice AI / Conversation AI) — read-only =====
  {
    name: "ghl_list_studio_agents",
    description:
      "List Agent Studio-agents: Managed Agents (ex-'Super Agents', natural-language-gebouwd, productSlug 'superagent') én flow agents (node-canvas). Read-only. ⚠️ Gebruikt bewust het ENKELVOUD-pad /agent-studio/agent — het meervoud-pad filtert Managed Agents eruit en is dus misleidend. Compacte projectie per agent; detail via ghl_get_studio_agent.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max aantal (default 50)." },
        offset: { type: "number", description: "Paginatie-offset (default 0)." },
      },
    },
    handler: async ({ limit, offset }) => {
      const res = await ghlRequest("GET", "/agent-studio/agent", {
        query: { locationId: LOC(), limit: limit ?? 50, offset: offset ?? 0 },
      });
      const rows = res?.agents || res?.data || (Array.isArray(res) ? res : []);
      return {
        count: rows.length,
        total: res?.pagination?.total ?? res?.total ?? null,
        has_more: res?.pagination?.hasMore ?? null,
        agents: rows.map(compactStudioAgent),
        toelichting:
          "type 'managed_agent' = Super/Managed Agent (chat-gebouwd, superAgentConfig); 'flow_agent' = node-canvas. ⚠️ De lijst geeft geen productSlug — type is hier null; het detail (ghl_get_studio_agent) wél.",
      };
    },
  },
  {
    name: "ghl_get_studio_agent",
    description:
      "Detail van één Agent Studio-agent (Managed of flow). Read-only. De ruwe API-respons is 150k–1,5MB (alle versies, volledige node-graph en systemPrompt); deze tool projecteert server-side: metadata + per default alleen de PRODUCTIE-versie (model, tools, triggers, plugins/MCP-connectors, knowledge bases, node-overzicht met webhook-URLs). Prompts komen als tekenaantal; zet include_prompt:true om de volledige promptteksten mee te krijgen. all_versions:true geeft alle versies (zonder prompts).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent-id (uuid uit ghl_list_studio_agents)." },
        include_prompt: { type: "boolean", description: "Neem volledige promptteksten op (kan tienduizenden tekens zijn). Default false." },
        all_versions: { type: "boolean", description: "Projecteer alle versies i.p.v. alleen de productieversie. Default false." },
      },
      required: ["agent_id"],
    },
    handler: async ({ agent_id, include_prompt, all_versions }) => {
      const res = await ghlRequest("GET", "/agent-studio/agent/" + encodeURIComponent(agent_id), {
        query: { locationId: LOC() },
      });
      const a = res?.agent || res?.data || res || {};
      const versies = a.versions || [];
      const prodId =
        a.productionVersion?.versionId ||
        a.productionVersion?.id ||
        (typeof a.productionVersion === "string" ? a.productionVersion : null);
      const kies = (v) => v.versionId === prodId || v.id === prodId || v._id === prodId;
      let geprojecteerd;
      if (all_versions) {
        geprojecteerd = versies.map((v) => compactStudioVersion(v, false));
      } else {
        // Productieversie; anders de gepubliceerde versie; anders de laatste. ⚠️ Niet op
        // state matchen: 4 van de 5 versies dragen state 'prod' terwijl er één isPublished is.
        const prod = versies.find(kies) || versies.find((v) => v.isPublished === true) || versies[versies.length - 1];
        geprojecteerd = prod ? [compactStudioVersion(prod, include_prompt === true)] : [];
      }
      return {
        ...compactStudioAgent(a),
        production_version_id: prodId,
        versions_shown: all_versions ? "alle" : "alleen productie (of laatste)",
        versions: geprojecteerd,
        toelichting:
          "Volledige ruwe definitie nodig (uiNodes, edges, alle prompts)? ghl_raw_api GET /agent-studio/agent/{id} met file_path — de respons kan 1,5MB zijn.",
      };
    },
  },
  {
    name: "ghl_list_voice_agents",
    description:
      "List Voice AI-agents (o.a. de live TIC-telefonist) met compacte projectie: naam, taal, inbound-nummers (live = nummer gekoppeld), acties per type, promptlengte. Read-only. De ruwe lijst-respons is >100k chars; detail per agent via ghl_get_voice_agent. ⚠️ Voice AI wijzigen: PUT/PATCH op /voice-ai/actions is stuk — wijzigen kan alleen via POST-nieuw-dan-DELETE-oud (zie README).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await ghlRequest("GET", "/voice-ai/agents", { query: { locationId: LOC() } });
      const rows = res?.agents || res?.data || (Array.isArray(res) ? res : []);
      const total = res?.total ?? null;
      return {
        count: rows.length,
        total,
        ...(total !== null && total > rows.length
          ? { let_op: `Respons toont ${rows.length} van ${total} agents (default-paginagrootte) — rest via ghl_raw_api met page-param.` }
          : {}),
        agents: rows.map(compactVoiceAgent),
      };
    },
  },
  {
    name: "ghl_get_voice_agent",
    description:
      "Detail van één Voice AI-agent, inclusief alle acties (naam, type, webhook-URL, KB-koppeling). Read-only. Haalt bewust de LIJST op en filtert client-side — de per-agent-GET van GHL is buggy. Prompt komt als tekenaantal; include_prompt:true geeft de volledige agentPrompt (30k+ tekens bij de telefonist).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent-id uit ghl_list_voice_agents." },
        include_prompt: { type: "boolean", description: "Neem de volledige agentPrompt op. Default false." },
      },
      required: ["agent_id"],
    },
    handler: async ({ agent_id, include_prompt }) => {
      const res = await ghlRequest("GET", "/voice-ai/agents", { query: { locationId: LOC() } });
      const rows = res?.agents || res?.data || (Array.isArray(res) ? res : []);
      const a = rows.find((x) => (x.id || x._id) === agent_id);
      if (!a)
        return {
          gevonden: false,
          agent_id,
          ...(res?.total > rows.length ? { let_op: `Alleen pagina 1 (${rows.length} van ${res.total}) doorzocht.` } : {}),
          beschikbaar: rows.map((x) => ({ id: x.id || x._id, name: x.agentName || x.name })),
        };
      return {
        ...compactVoiceAgent(a),
        working_hours: capped(a.agentWorkingHours ?? a.workingHours ?? null),
        tool_call_strict_mode: a.toolCallStrictMode ?? null,
        actions: (a.actions || []).map((act) => ({
          id: act.id || act._id || null,
          name: act.name || act.actionName || null,
          type: act.actionType || null,
          webhook: firstUrl(act.actionParameters || act),
          knowledge_base_id: act.actionParameters?.knowledgeBaseId || act.knowledgeBaseId || null,
        })),
        ...(include_prompt ? { agent_prompt: a.agentPrompt || null } : {}),
      };
    },
  },
  {
    name: "ghl_list_conversation_ai_agents",
    description:
      "List Conversation AI-agents (inbound tekstkanaal: webchat/SMS/WhatsApp/FB/IG) met mode (off/suggestive/auto-pilot). Read-only. Dit is een ÁNDER objecttype dan Agent Studio (geen versies). ⚠️ Endpoint-eigenaardigheid: /conversation-ai/agents/search weigert een locationId-queryparam met 422 — de location zit impliciet in het token. channels wordt niet altijd geëchood: null = onbekend, niet 'geen'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Zoekterm op naam." },
        limit: { type: "number", description: "Max aantal (default 25)." },
      },
    },
    handler: async ({ query, limit }) => {
      const res = await ghlRequest("GET", "/conversation-ai/agents/search", {
        query: { limit: limit ?? 25, query },
      });
      const rows = res?.agents || res?.data || (Array.isArray(res) ? res : []);
      return { count: rows.length, total: res?.totalCount ?? res?.total ?? null, agents: rows.map(compactConvAiAgent) };
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ─── minimal MCP stdio (JSON-RPC, newline-delimited) ──────────────────────────
function log(m) {
  try {
    process.stderr.write("[gohighlevel-mcp] " + m + "\n");
  } catch (_) {}
}
function fmtBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}
// Laatste vangnet: nooit een regel de pipe op sturen die de MCP-client doet disconnecten
// (de client kapt af op 16MB). Zonder deze guard zou bv. een grote base64-payload via
// ghl_raw_api (die geen file_path meekreeg) de hele verbinding + gelijktijdig lopende
// calls slopen; hier wordt zo'n respons vervangen door een nette isError.
const MAX_RPC_BYTES = Number(process.env.GHL_MAX_RPC_BYTES || 8 * 1024 * 1024);
function send(msg) {
  let line = JSON.stringify(msg);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_RPC_BYTES) {
    log(`respons van ${fmtBytes(bytes)} > limiet ${fmtBytes(MAX_RPC_BYTES)} — vervangen door foutmelding`);
    if (msg.id === undefined || msg.id === null) return; // notificatie: gewoon laten vallen
    line = JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Fout: respons te groot (${fmtBytes(bytes)}, limiet ${fmtBytes(MAX_RPC_BYTES)}).\n` +
              "Zo'n regel verbreekt de MCP-stdio-verbinding en sloopt ook gelijktijdig lopende calls. " +
              "Geef `file_path` aan ghl_raw_api om een binaire/grote respons server-side naar schijf te schrijven, of beperk de query.",
          },
        ],
      },
    });
  }
  try {
    process.stdout.write(line + "\n");
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
// Zelf-opruiming: stdin is hier een socket die soms nooit EOF krijgt (de host lekt de
// fd), waardoor servers zich eindeloos opstapelen - 6-8-2026 gemeten: 403 node-MCP's /
// 9,2 GB, met 0 GB vrij geheugen op de server. Afsluiten is veilig: de host herstart een
// dode stdio-server transparant bij de eerstvolgende call (empirisch getest 6-8-2026).
// Nooit midden in werk: er wordt alleen afgesloten bij inFlight === 0. 0 = uit.
  const IDLE_EXIT_MS = Number(
    process.env.GHL_IDLE_EXIT_MS ?? process.env.MCP_IDLE_EXIT_MS ?? 30 * 60 * 1000
  );
  let inFlight = 0;
  let lastActivity = Date.now();
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
    inFlight++;
    lastActivity = Date.now();
    Promise.resolve(onMessage(msg)).catch((e) => log("handler error: " + (e && e.message)))
      .then(() => { inFlight--; lastActivity = Date.now(); });
  });
  rl.on("close", () => process.exit(0));
  if (IDLE_EXIT_MS > 0) {
    setInterval(() => {
      if (inFlight === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
        log('geen activiteit in ' + Math.round(IDLE_EXIT_MS / 60000) + ' min - afsluiten om opstapeling te voorkomen');
        process.exit(0);
      }
    }, 60000).unref();
  }
  log("server gestart (" + SERVER_VERSION + ")");
}

main();
