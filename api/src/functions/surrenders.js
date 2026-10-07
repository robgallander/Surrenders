// Surrenders website API (Azure Static Web Apps, Node 20, Functions v4).
// HubSpot pushes deals here from a workflow "Send a webhook" step (/api/ingest).
// Deals are kept in Azure Table Storage; the page reads /api/status, /api/counts and /api/month.
// No HubSpot key is used anywhere.
const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");
const COORDS = require("../../coordinators.json");

const TABLE = "surrenders";
const TZ = process.env.REPORT_TIMEZONE || "America/Los_Angeles";
const PRELIT_PIPELINE = "147213186";
const EXCLUDED_STAGES = ["148011378", "148011377", "1084046343"]; // Case Settled, Fee Motion, Closed
const PIPELINE_BY_LABEL = { "document gathering": "6906894", "settlement": "77637672", "pre-litigation": "147213186", "litigation": "70128010" };
const STAGE_BY_LABEL = { "financials": "148040364", "pending disbursement": "148048054", "pending 998": "148048052", "update financials": "241154734",
  "pending release": "148011374", "pending surrender": "148011372", "need to coordinate surrender": "1212471581",
  "pending settlement funds (bb)": "1072094529", "pending settlement funds (ck)": "148011373", "case settled": "148011378",
  "fee motion": "148011377", "closed": "1084046343" };

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d)); x.setUTCDate(x.getUTCDate() + n); return ymd(x); };
function windowMonths() {
  const [y, m] = todayIso().split("-").map(Number);
  const out = [];
  for (let i = 12; i >= 0; i--) {
    const first = new Date(Date.UTC(y, m - 1 - i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    out.push({ id: ymd(first).slice(0, 7), first: ymd(first), last: ymd(last) });
  }
  return out;
}
function normDate(v) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return ymd(new Date(Number(s.length === 10 ? s + "000" : s)));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return us[3] + "-" + pad(us[1]) + "-" + pad(us[2]);
  const d = new Date(s);
  return isNaN(d) ? "" : ymd(d);
}

/* ---------- storage ---------- */
let table = null, tableReady = null;
function getTable() {
  if (!table) {
    const cs = process.env.STORAGE_CONNECTION_STRING;
    if (!cs) { const e = new Error("STORAGE_CONNECTION_STRING is not set in the app's settings."); e.status = 500; throw e; }
    table = TableClient.fromConnectionString(cs, TABLE);
    tableReady = table.createTable().catch(e => { if (e.statusCode !== 409) throw e; });
  }
  return tableReady.then(() => table);
}
let cache = { at: 0, rows: null };
async function allRows(refresh) {
  if (!refresh && cache.rows && Date.now() - cache.at < 30000) return cache.rows;
  const t = await getTable();
  const start = windowMonths()[0].first;
  const rows = [];
  for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey eq 'deal' and date ge '${start}'` } })) rows.push(e);
  cache = { at: Date.now(), rows };
  return rows;
}
const lastReceived = rows => rows.reduce((m, r) => (r.receivedAt && r.receivedAt > m ? r.receivedAt : m), "") || null;
const toRow = e => ({
  id: e.rowKey, matter: e.matter || "—", client: e.client || "—", deal: e.deal || "", date: e.date || "", time: e.time || "",
  coordId: e.coordId || "", coord: e.coord || "", atty: e.atty || "", notes: e.notes || "", stage: e.stage || "", pipeline: e.pipeline || "",
  surrendered: e.surrendered || "", packet: e.packet || "", paid: e.paid || ""
});

/* ---------- incoming HubSpot webhook ---------- */
function secretOk(req) {
  const want = process.env.WEBHOOK_SECRET || "";
  const got = req.headers.get("x-webhook-secret") || req.query.get("secret") || "";
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function flatten(o) {
  // Accepts a custom request body ({ prop: value }), or HubSpot's full-record body ({ objectId, properties: { prop: { value } } }).
  const src = o && typeof o.properties === "object" && o.properties ? o.properties : (o || {});
  const out = {};
  Object.keys(src).forEach(k => { const v = src[k]; out[k] = v && typeof v === "object" && "value" in v ? v.value : v; });
  out.hs_object_id = out.hs_object_id || out.dealId || out.deal_id || (o && (o.objectId || o.id)) || "";
  return out;
}
function toEntity(p) {
  const cm = String(p.clio_matter || "").trim();
  const mm = /^(\d+)\s*-\s*(.+)$/.exec(cm);
  // Client: HubSpot "Plaintiff Name Short"; falls back to the name in the Clio matter, then the deal name.
  let client = String(p.plaintiff_name_short || "").trim() || (mm ? mm[2] : "");
  if (!client && p.dealname) client = String(p.dealname).split(/\s+V\.?\s+/i)[0].replace(/,\s*$/, "");
  const rawC = p.surrender_coodinator == null ? "" : String(p.surrender_coodinator).split(";")[0].trim();
  const coordId = /^\d+$/.test(rawC) ? rawC : (rawC ? "name:" + rawC : "");
  const coord = String(p.surrender_coordinator_text || "").trim() || (/^\d+$/.test(rawC) ? (COORDS[rawC] || "") : rawC);
  const stage = String(p.dealstage || ""), pipeline = String(p.pipeline || "");
  const sur = String(p.surrendered == null ? "" : p.surrendered).toLowerCase();
  return {
    partitionKey: "deal", rowKey: String(p.hs_object_id),
    matter: cm || "—", client: client || "—", deal: String(p.dealname || ""),
    date: normDate(p.surrender_date), time: String(p.surrender_time || ""),
    coordId, coord, atty: String(p.handling_attorney || ""), notes: String(p.surrender_notes || "").slice(0, 4000),
    stage: STAGE_BY_LABEL[stage.toLowerCase()] || stage, pipeline: PIPELINE_BY_LABEL[pipeline.toLowerCase()] || pipeline,
    surrendered: sur === "true" || sur === "yes" ? "true" : (sur === "false" || sur === "no" ? "false" : ""),
    packet: String(p.surrender_packet_completed || ""), paid: String(p.paid_at_surrender || ""),
    receivedAt: new Date().toISOString()
  };
}
app.http("ingest", { methods: ["POST"], authLevel: "anonymous", route: "ingest", handler: async (req, ctx) => {
  if (!secretOk(req)) return { status: 401, jsonBody: { error: "bad or missing secret" } };
  let body;
  try { body = await req.json(); } catch (_) { return { status: 400, jsonBody: { error: "body must be JSON" } }; }
  const items = Array.isArray(body) ? body : [body];
  const t = await getTable();
  let saved = 0, removed = 0, skipped = 0;
  for (const it of items) {
    const p = flatten(it);
    if (!p.hs_object_id) { skipped++; continue; }
    const e = toEntity(p);
    if (!e.date) { await t.deleteEntity("deal", e.rowKey).catch(() => {}); removed++; continue; } // surrender date cleared
    await t.upsertEntity(e, "Replace"); saved++;
  }
  cache = { at: 0, rows: null };
  ctx.log(`ingest: saved ${saved}, removed ${removed}, skipped ${skipped}`);
  return { status: 200, jsonBody: { saved, removed, skipped } };
} });

/* ---------- report endpoints ---------- */
const json = body => ({ status: 200, jsonBody: body, headers: { "Cache-Control": "no-store" } });
const fail = (ctx, e) => { ctx.error(e); return { status: e.status || 500, jsonBody: { error: e.message } }; };
const counted = r => r.pipeline !== PRELIT_PIPELINE && !EXCLUDED_STAGES.includes(r.stage) && r.surrendered !== "true";

app.http("status", { methods: ["GET"], authLevel: "anonymous", route: "status", handler: async (req, ctx) => {
  try {
    const rows = await allRows(req.query.get("refresh") === "1");
    const today = todayIso(), windowStart = windowMonths()[0].first, upEnd = addDays(today, 6);
    const sort = (a, b) => a.date.localeCompare(b.date) || a.client.localeCompare(b.client);
    const pastDue = rows.filter(r => counted(r) && r.date >= windowStart && r.date < today).map(toRow).sort(sort);
    const upcoming = rows.filter(r => counted(r) && r.date >= today && r.date <= upEnd).map(toRow).sort(sort);
    return json({ today, windowStart, upEnd, pastDue, upcoming, fetchedAt: lastReceived(rows) ? Date.parse(lastReceived(rows)) : null });
  } catch (e) { return fail(ctx, e); }
} });

app.http("counts", { methods: ["GET"], authLevel: "anonymous", route: "counts", handler: async (req, ctx) => {
  try {
    const rows = await allRows(req.query.get("refresh") === "1");
    const months = windowMonths().map(mo => ({ id: mo.id, count: rows.filter(r => r.surrendered === "true" && r.date >= mo.first && r.date <= mo.last).length }));
    return json({ months, fetchedAt: lastReceived(rows) ? Date.parse(lastReceived(rows)) : null });
  } catch (e) { return fail(ctx, e); }
} });

app.http("month", { methods: ["GET"], authLevel: "anonymous", route: "month", handler: async (req, ctx) => {
  try {
    const mo = windowMonths().find(x => x.id === (req.query.get("m") || ""));
    if (!mo) return { status: 400, jsonBody: { error: "Month must be one of the last 13 months, as YYYY-MM." } };
    const rows = await allRows(req.query.get("refresh") === "1");
    const list = rows.filter(r => r.surrendered === "true" && r.date >= mo.first && r.date <= mo.last).map(toRow);
    return json({ id: mo.id, rows: list, fetchedAt: lastReceived(rows) ? Date.parse(lastReceived(rows)) : null });
  } catch (e) { return fail(ctx, e); }
} });

/* ---------- sign-in roles: only members of ALLOWED_GROUP_ID get in ---------- */
app.http("GetRoles", { methods: ["POST"], authLevel: "anonymous", route: "GetRoles", handler: async (req) => {
  let b = {}; try { b = await req.json(); } catch (_) {}
  const claims = Array.isArray(b.claims) ? b.claims : [];
  const groups = claims.filter(c => c.typ === "groups" || /\/groups$/.test(c.typ || "")).map(c => String(c.val).toLowerCase());
  const want = String(process.env.ALLOWED_GROUP_ID || "").toLowerCase().trim();
  const email = String(b.userDetails || "").toLowerCase();
  const admins = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(/[,;\s]+/).filter(Boolean);
  const roles = [];
  if (!want || groups.includes(want) || admins.includes(email)) roles.push("member");
  if (admins.includes(email)) roles.push("admin");
  return { status: 200, jsonBody: { roles } };
} });
