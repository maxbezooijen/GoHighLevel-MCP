# gohighlevel-mcp

Zelfgebouwde, lokale GoHighLevel-MCP die de officiële hosted MCP vervangt. Volledige typed-dekking van de kern-resources (contacts, opportunities, conversations, calendars, invoices, custom fields/objects, proposals) **plus typed guards** voor schrijf/send-acties — passend bij de draft-not-send-filosofie van de rest van de incasso-stack.

- **Architectuur:** hand-rolled JSON-RPC over stdio (consistent met `n8n-mcp`/`docuseal-api-mcp`). Eén `server.js`, `TOOLS`-array met inline handlers, **zero dependencies** (alleen Node ≥18 built-ins).
- **Auth:** Private Integration Token (PIT) uit `GHL_TOKEN` + `GHL_LOCATION` env. Hergebruikt de bestaande PIT in `/opt/projects/.mcp-secrets/secrets.env` (via `.env`-symlink).
- **Cloudflare-WAF:** elke call stuurt een browser-achtige `User-Agent` (default Node-UA geeft Error 1010).

## Setup

1. Zorg dat `GHL_TOKEN` (PIT, `pit-...`) en `GHL_LOCATION` (locationId, 20 tekens) beschikbaar zijn — via de `.env`-symlink naar `/opt/projects/.mcp-secrets/secrets.env` (al geconfigureerd) of een eigen `.env` (zie `.env.example`).
2. `node server.js` (MCP-server over stdio).

## Tools (48)

### Read-only discovery (4)
`ghl_whoami`, `ghl_list_custom_fields` *(default `model=all` — zie waarschuwing hieronder)*, `ghl_list_custom_objects`, `ghl_list_custom_object_records`

### Custom objects — write (2)
`ghl_create_custom_object_record`, `ghl_update_custom_object_record` *(write, `dryRun`)*

### Contacts (5)
`ghl_list_contacts`, `ghl_get_contact` *(read)* · `ghl_upsert_contact`, `ghl_update_contact`, `ghl_set_contact_tags` *(write, `dryRun`)*

### Opportunities/Pipelines (4)
`ghl_list_pipelines`, `ghl_search_opportunities`, `ghl_get_opportunity` *(read)* · `ghl_safe_update_opportunity` *(write, **`confirm`-guard**)*

### Conversations — SMS/Email (4)
`ghl_search_conversations`, `ghl_get_messages` *(read)* · `ghl_prepare_message` *(fail-closed default, `send_real_correspondence` opt-in)*, `ghl_send_message` *(`confirm`-guard)*

### Calendars/Events (2)
`ghl_list_calendars`, `ghl_list_events` *(read)*

### Tasks (1)
`ghl_list_contact_tasks` *(read)*

### Invoices (4)
`ghl_list_invoices`, `ghl_get_invoice` *(read)* · `ghl_update_invoice`, `ghl_create_invoice` *(write, `dryRun`)*

### Proposals/Documents (8)
`ghl_list_proposal_templates`, `ghl_list_proposal_documents`, `ghl_get_proposal_document`, `ghl_audit_proposal_documents`, `ghl_proposal_pdf_url` *(read)* · `ghl_create_proposal_document` *(`confirm` + duplicaatcheck, forceert `sendDocument:false`)* · `ghl_delete_proposal_document` *(`confirm`; 401 tot de write-scope erbij staat)* · `ghl_send_proposal_document` *(**fail-closed**, `send_real_correspondence` opt-in)*

### Workflows/Automatisering (8)
`ghl_list_workflows`, `ghl_audit_workflows`, `ghl_list_campaigns`, `ghl_list_trigger_links` *(read)* · `ghl_enroll_contact_in_workflow` *(**fail-closed**, `confirm`)* · `ghl_remove_contact_from_workflow`, `ghl_remove_contact_from_campaigns` *(`confirm`)* · `ghl_fire_inbound_webhook` *(**fail-closed**, `confirm`)*

### AI-agents — Agent Studio / Voice AI / Conversation AI (5, allemaal read-only)
`ghl_list_studio_agents`, `ghl_get_studio_agent`, `ghl_list_voice_agents`, `ghl_get_voice_agent`, `ghl_list_conversation_ai_agents`

Toegevoegd 12-8-2026 n.a.v. de Managed Agents-recon. Drie dingen om te weten:
- **Enkelvoud-pad**: `GET /agent-studio/agent` (enkelvoud) toont álle agents; het meervoud-pad
  `/agent-studio/agents` bestaat óók maar **filtert Managed Agents (productSlug `superagent`)
  eruit** — live bewezen 12-8 (meervoud: 1 agent, enkelvoud: 2). De tools gebruiken het enkelvoud.
- **Projectie verplicht**: het agent-detail is 150k–1,5MB (alle versies, volledige node-graph,
  systemPrompt, base64-iconen in plugins). De tools projecteren server-side; promptteksten komen
  standaard als tekenaantal (`include_prompt:true` voor de volledige tekst). Ruwe dump:
  `ghl_raw_api` met `file_path`.
- **List-endpoint is arm**: de agent-lijst geeft géén `productSlug`/versies terug — het onderscheid
  managed/flow agent (`type`) is alleen in het detail zichtbaar; in de lijst is `type` `null`.
- `ghl_get_voice_agent` haalt bewust de líjst op en filtert client-side (de per-agent-GET van GHL
  is buggy). Conversation AI: `/conversation-ai/agents/search` weigert `locationId` met 422 —
  de location zit impliciet in het token; `channels` wordt niet geëchood (null = onbekend).

Schrijven aan agents is bewust NIET getooled: `PUT/PATCH /voice-ai/actions` is stuk (wijzigen =
POST-nieuw-dan-DELETE-oud), en Agent Studio-writes (`PATCH versions`, `POST execute` — vereist
`agent-studio.write`) zijn nog niet getest. Eerst een curl-test op een kloon, dan pas tools.

### Raw API (1)
`ghl_raw_api` *(escape hatch, `dryRun`)*

## Veiligheidsmodel (consequent toegepast)

| Tool-categorie | Guard |
|----------------|-------|
| Lees-tools | altijd veilig |
| Schrijf-tools (contacts) | `dryRun`-preview of `confirm` |
| Status-mutaties (opportunities) | **`confirm`-guard** — kan workflows/correspondentie triggeren |
| Send-tools (SMS/Email) | **FAIL-CLOSED default** = niet verzenden; expliciete opt-in (`send_real_correspondence`/`confirm`) vereist. **Draft-not-send.** |
| `raw_api` | non-GET preview bij `dryRun` |

## Wat de GHL-API wél en niet kan (live geverifieerd 10-08-2026)

Uitputtend afgetast met het 404-vs-401-onderscheid op nep-id's (24 nullen). Dit staat hier zodat
niemand nog een uur verliest aan endpoints die niet bestaan.

### Workflows — één leesroute, nul beheerroutes
`GET /workflows/` (trailing slash **verplicht**, `locationId` is de **enige** toegestane queryparam)
geeft alle workflows met id/naam/status/versie/datums. Dat is alles.

**Bestaat niet** (404 `Cannot GET`, woordelijk gelijk voor een echt en een nep-id — dus geen route,
géén "niet gevonden"): `GET /workflows/{id}` en álle subroutes `/versions` `/actions` `/steps`
`/nodes` `/executions` `/history` `/stats` `/status` `/triggers` `/enrollments` `/contacts`
`/search` `/folders`, plus `POST /workflows/`, `PUT`, `PATCH`, `DELETE`, `/publish` en `/trigger`.

> **Van geen enkele workflow is machinaal leesbaar wát hij doet, wie erin zit of dat hij gedraaid
> heeft.** Aanmaken, wijzigen, publiceren en depubliceren kan alleen in de UI. Wie wil weten wat een
> workflow uitvoert, leidt dat af uit zijn sporen (aangemaakte records, tijdstempels).

**Wel bruikbaar — via de contact-kant:** `POST`/`DELETE /contacts/{contactId}/workflow/{workflowId}`
(in-/uitschrijven), `GET /hooks/{locationId}/webhook-trigger/{webhookId}` (de enige manier om een
workflow af te vuren), `GET /campaigns/` + `POST`/`DELETE /contacts/{id}/campaigns/{campaignId}` en
`.../campaigns/removeAll`, en `GET /links/` (trigger links).

### Proposals/Documents — vier endpoints, twee publieke routes
| Route | Status |
|---|---|
| `GET /proposals/templates`, `GET /proposals/document` | **200** (elk een eigen strikte param-whitelist; onbekende param → 422 die het contract verklapt) |
| `GET`/`PUT`/`DELETE /proposals/{document,templates}/{id}` | **401** — routes bestaan, PIT mist de scope |
| `POST /proposals/document/send` | **auth passeert** (404 "Document not found" op nep-id) |
| `POST /proposals/templates/send` | verplicht veld heet **`templateId`** — een 422 "required field `documentId` is missing" betekent dus dat *templateId* ontbreekt |
| `GET /proposals/document/public` en `/public/download-pdf` | **geen auth nodig** |

Paginatie: `limit` max **21**, `skip` (niet `offset`); `total` in de respons is **onbetrouwbaar** —
doorpagineren tot een uitgeputte pagina en dedupliceren op `_id`. Dat doet
`ghl_list_proposal_documents` automatisch.

**Twee dingen die geen scope ooit oplost:** een documentrecord bevat **geen bodytekst**, en de
bedragvelden zijn `fillableFields` die pas bij **ondertekening** resolven en die de ontvanger zelf
kan bewerken. `grand_total` is alleen gevuld bij sjablonen met geprijsde regels.

### 🚨 De PIT mag versturen maar niet lezen
`POST /proposals/document/send` passeert auth terwijl GET/PUT/DELETE 401 geven. Elk script met dit
token kan een ondertekenbaar contract naar een klant sturen en kan daarna niet nagaan wat erin stond
— en niet intrekken. Daarom staan `ghl_send_proposal_document` en `ghl_fire_inbound_webhook`
fail-closed. Zet in GHL → Settings → Private Integrations de scopes `proposals/document.readonly`
en `.write` bij en beoordeel of het verzendrecht eraf kan.

## Rate-limits

GHL: 100 requests/10s burst, 200.000/dag per app-locatie. Geen throttling in v1 (single-account, ruim voldoende). Op `429`: exponential backoff (caller); op `401`: PIT hergeneren; op `403`: scope ontbreekt.

## Buiten scope (Fase 3-kandidaten)

- Invoice update/create (velden eerst valideren).
- Custom Objects volledige CRUD (alleen read-schema in v1).
- OAuth-flow (PIT volstaat voor single-account).
- Webhooks/triggers registreren.

## Testen

`smoke.mjs` is de regressietest: hij start de server, doet de lees-tools live tegen GHL en roept
**elke** schrijf-/verzendtool aan **zonder** `confirm`, zodat bewezen wordt dat ze weigeren. Hij
muteert niets en verstuurt niets — veilig om altijd te draaien.

```bash
node smoke.mjs   # 17 controles; exit 1 zodra er één guard wegvalt
```

```bash
# tools/list
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node server.js

# live read-only (bewijst PIT + endpoint + UA)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ghl_whoami","arguments":{}}}' | node server.js
```
