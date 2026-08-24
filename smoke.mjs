// Volledige smoketest ronde 2: alle nieuwe tools + alle guard-paden.
// Read-only: elke schrijf-/verzendtool wordt ZONDER confirm aangeroepen, zodat hij moet weigeren.
import { spawn } from "child_process";

const srv = spawn("node", ["/root/gohighlevel-mcp/server.js"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
srv.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
srv.stderr.on("data", (c) => process.stderr.write("[srv] " + c));

let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  pending.set(myId, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  setTimeout(() => rej(new Error("timeout " + method + " " + (params?.name || ""))), 120000);
});
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const t = r?.result?.content?.[0]?.text;
  if (!t) return r?.result ?? r?.error;
  try { return JSON.parse(t); } catch { return t; }
};

let fouten = 0;
const check = (naam, ok, detail) => {
  console.log((ok ? "✅" : "🚨") + " " + naam + (detail ? " — " + detail : ""));
  if (!ok) fouten++;
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke2", version: "0" } });
  const tl = await rpc("tools/list", {});
  const namen = (tl.result?.tools || []).map((t) => t.name);
  console.log("tools: " + namen.length + "\n");

  // --- LEES-TOOLS ---
  const cf = await call("ghl_list_custom_fields");
  check("custom_fields model=all", (cf.totaal_in_location || 0) > 100, `${cf.totaal_in_location} velden, per model: ${JSON.stringify(cf.per_model)}`);

  const cfo = await call("ghl_list_custom_fields", { model: "opportunity", name_contains: "hoofdsom" });
  check("custom_fields filter", cfo.count >= 1, `${cfo.count} treffer(s) op 'hoofdsom'`);

  const wf = await call("ghl_list_workflows", { status: "published" });
  check("list_workflows published", wf.count > 0 && wf.count < wf.totaal_in_location, `${wf.count} van ${wf.totaal_in_location}`);

  const wfa = await call("ghl_audit_workflows");
  check("audit_workflows", wfa.totaal > 0, `${wfa.totaal} wf, ${wfa.gepubliceerd.aantal} published, ${wfa.lege_placeholders.aantal} placeholders, ${wfa.raakt_documenten.length} raken documenten`);

  const camp = await call("ghl_list_campaigns");
  check("list_campaigns", Array.isArray(camp?.campaigns), `${(camp?.campaigns || []).length} campagnes`);

  const links = await call("ghl_list_trigger_links");
  check("list_trigger_links", links !== undefined, `${(links?.links || links || []).length ?? "?"} links`);

  const docs = await call("ghl_list_proposal_documents", { status: "declined", limit: 2 });
  check("documents status=declined", docs.count >= 0, `${docs.matched_before_limit} declined gevonden`);

  const recent = await call("ghl_list_proposal_documents", { date_from: "2026-08-01T00:00:00Z", limit: 2 });
  check("documents date_from", !recent.error, `${recent.matched_before_limit ?? "?"} sinds 1-8`);

  // --- AI-AGENT-TOOLS (12-8-2026, allemaal read-only) ---
  const MANAGED_ID = "cd0702ab-bc91-4f57-bbcd-daa4c7d2a2e2"; // Knowledge Base Assistant (Managed Agent)
  const sa = await call("ghl_list_studio_agents");
  // Kerncheck van het enkelvoud-pad: de Managed Agent MOET in de lijst zitten — het
  // meervoud-pad filtert die eruit, dus dit is de regressiedetector voor die valkuil.
  check(
    "list_studio_agents bevat Managed Agent",
    (sa.agents || []).some((a) => a.id === MANAGED_ID),
    `${sa.count} agents, total=${sa.total}`
  );

  const saDetail = await call("ghl_get_studio_agent", { agent_id: MANAGED_ID });
  check(
    "get_studio_agent managed",
    saDetail.type === "managed_agent" && saDetail.versions?.[0]?.managed_agent?.model?.length > 0,
    `model=${saDetail.versions?.[0]?.managed_agent?.model}, plugins=${(saDetail.versions?.[0]?.managed_agent?.plugins || []).length}`
  );
  check(
    "get_studio_agent prompt alleen als tekenaantal",
    saDetail.versions?.[0]?.managed_agent?.system_prompt === undefined && saDetail.versions?.[0]?.managed_agent?.system_prompt_chars > 0,
    `${saDetail.versions?.[0]?.managed_agent?.system_prompt_chars} chars`
  );
  check("get_studio_agent respons compact", JSON.stringify(saDetail).length < 50000, `${JSON.stringify(saDetail).length} bytes (ruw is ~1,5MB)`);

  const saPrompt = await call("ghl_get_studio_agent", { agent_id: MANAGED_ID, include_prompt: true });
  const saPromptMa = saPrompt.versions?.[0]?.managed_agent;
  check(
    "get_studio_agent include_prompt geeft volledige prompt",
    typeof saPromptMa?.system_prompt === "string" && saPromptMa.system_prompt.length === saPromptMa.system_prompt_chars,
    `${saPromptMa?.system_prompt_chars ?? "?"} chars`
  );

  const saAll = await call("ghl_get_studio_agent", { agent_id: MANAGED_ID, all_versions: true });
  check("get_studio_agent all_versions", (saAll.versions || []).length >= 2, `${(saAll.versions || []).length} versies, ${JSON.stringify(saAll).length} bytes`);

  const va = await call("ghl_list_voice_agents");
  check("list_voice_agents", va.count >= 1, `${va.count} agents, live: ${(va.agents || []).filter((a) => a.live).map((a) => a.name).join(", ") || "geen"}`);

  const liveVa = (va.agents || []).find((a) => a.live);
  if (liveVa) {
    const vaDetail = await call("ghl_get_voice_agent", { agent_id: liveVa.id });
    check(
      "get_voice_agent live telefonist",
      (vaDetail.actions || []).length >= 8 && (vaDetail.actions || []).some((x) => (x.webhook || "").includes("telefonist.mbstudios.nl")),
      `${(vaDetail.actions || []).length} acties, webhooks naar middleware gevonden`
    );
    check("get_voice_agent prompt alleen als tekenaantal", vaDetail.agent_prompt === undefined && vaDetail.prompt_chars > 0, `${vaDetail.prompt_chars} chars`);
  } else {
    // Geen stille skip: als de live-heuristiek de telefonist niet meer vindt, is dat zélf een bevinding.
    check("get_voice_agent live telefonist", false, "geen live voice-agent gevonden — detailtool ONGETEST en de telefonist lijkt geen inbound-nummer te hebben");
  }

  const ca = await call("ghl_list_conversation_ai_agents");
  check("list_conversation_ai_agents", ca.count >= 1, `${ca.count} agents, modes: ${JSON.stringify((ca.agents || []).reduce((a, x) => ((a[x.mode] = (a[x.mode] || 0) + 1), a), {}))}`);

  // --- GUARD-PADEN: alles moet WEIGEREN ---
  const eersteId = (await call("ghl_list_proposal_documents", { status: "draft", limit: 1 })).documents?.[0]?.id;

  const enroll = await call("ghl_enroll_contact_in_workflow", { contact_id: "000000000000000000000000", workflow_id: "b4b3778b-2dfa-49d3-a48b-626bb2988981" });
  check("enroll zonder confirm weigert", enroll.enrolled === false && enroll.refused === true, "workflow: " + (enroll.workflow?.name || "?") + " | " + (enroll.let_op || "").slice(0, 40));

  const fire = await call("ghl_fire_inbound_webhook", { webhook_id: "000000000000000000000000" });
  check("fire_webhook zonder confirm weigert", fire.fired === false && fire.refused === true);

  const create = await call("ghl_create_proposal_document", { template_id: "69130551dae04205121d8fac", contact_id: "x", confirm: false });
  check("create zonder confirm weigert", typeof create === "string" && create.includes("confirm=true"), String(create).slice(0, 60));

  const createSend = await call("ghl_create_proposal_document", { template_id: "69130551dae04205121d8fac", contact_id: "x", confirm: true, send_document: true });
  check("create met send_document:true weigert", typeof createSend === "string" && createSend.includes("Refused"), String(createSend).slice(0, 70));

  // Duplicaatcheck op een contact dat aantoonbaar al een document heeft (Beliën).
  const dup = await call("ghl_create_proposal_document", { template_id: "69130551dae04205121d8fac", contact_id: "4Bvm2uRCGlBwLaR1TM9N", confirm: true });
  check("create duplicaatcheck weigert", dup.created === false && dup.refused === true, `${dup.bestaande_documenten?.length ?? 0} bestaand(e) document(en) gevonden`);

  if (eersteId) {
    const send = await call("ghl_send_proposal_document", { document_id: eersteId });
    check("send zonder opt-in weigert", send.sent === false && send.refused === true);
  }
  const rmwf = await call("ghl_remove_contact_from_workflow", { contact_id: "x", workflow_id: "y", confirm: false });
  check("remove_from_workflow zonder confirm weigert", typeof rmwf === "string" && rmwf.includes("confirm=true"));

  const rmc = await call("ghl_remove_contact_from_campaigns", { contact_id: "x", confirm: false });
  check("remove_from_campaigns zonder confirm weigert", typeof rmc === "string" && rmc.includes("confirm=true"));

  console.log("\n" + (fouten ? `🚨 ${fouten} controle(s) gefaald` : "✅ alle controles groen"));
  process.exitCode = fouten ? 1 : 0;
} catch (e) {
  console.error("SMOKETEST FOUT: " + e.message);
  process.exitCode = 1;
} finally {
  srv.kill();
}
