# gohighlevel-mcp

Zelfgebouwde, lokale GoHighLevel-MCP die de officiële hosted MCP vervangt. Volledige typed-dekking van de kern-resources (contacts, opportunities, conversations, calendars, invoices, custom fields/objects, proposals) **plus typed guards** voor schrijf/send-acties — passend bij de draft-not-send-filosofie van de rest van de incasso-stack.

- **Architectuur:** hand-rolled JSON-RPC over stdio (consistent met `n8n-mcp`/`docuseal-api-mcp`). Eén `server.js`, `TOOLS`-array met inline handlers, **zero dependencies** (alleen Node ≥18 built-ins).
- **Auth:** Private Integration Token (PIT) uit `GHL_TOKEN` + `GHL_LOCATION` env. Hergebruikt de bestaande PIT in `/opt/projects/.mcp-secrets/secrets.env` (via `.env`-symlink).
- **Cloudflare-WAF:** elke call stuurt een browser-achtige `User-Agent` (default Node-UA geeft Error 1010).

## Setup

1. Zorg dat `GHL_TOKEN` (PIT, `pit-...`) en `GHL_LOCATION` (locationId, 20 tekens) beschikbaar zijn — via de `.env`-symlink naar `/opt/projects/.mcp-secrets/secrets.env` (al geconfigureerd) of een eigen `.env` (zie `.env.example`).
2. `node server.js` (MCP-server over stdio).

## Tools (25)

### Read-only discovery (4)
`ghl_whoami`, `ghl_list_workflows`, `ghl_list_custom_fields`, `ghl_list_custom_objects`

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

### Invoices (2)
`ghl_list_invoices`, `ghl_get_invoice` *(read)*

### Proposals/Documents (2)
`ghl_list_proposal_templates` *(read)* · `ghl_get_proposal_document` *(read; **scope-muur** op inhoud — vangt 403 op met instructie)*

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

## Scope-muur op proposals/documents

De huidige PIT heeft (typisch) géén read-scope voor de **inhoud** van proposals/documents. `ghl_list_proposal_templates` (metadata) werkt; `ghl_get_proposal_document` (inhoud) geeft 403 en wordt opgevangen met een duidelijke instructie om de PIT-read-scope bij te zetten in GHL → Settings → Private Integrations. Voor contract-templates als alternatief: zie de DocuSeal-MCP.

## Rate-limits

GHL: 100 requests/10s burst, 200.000/dag per app-locatie. Geen throttling in v1 (single-account, ruim voldoende). Op `429`: exponential backoff (caller); op `401`: PIT hergeneren; op `403`: scope ontbreekt.

## Buiten scope (Fase 3-kandidaten)

- Invoice update/create (velden eerst valideren).
- Custom Objects volledige CRUD (alleen read-schema in v1).
- OAuth-flow (PIT volstaat voor single-account).
- Webhooks/triggers registreren.

## Testen

```bash
# tools/list
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node server.js

# live read-only (bewijst PIT + endpoint + UA)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ghl_whoami","arguments":{}}}' | node server.js
```
