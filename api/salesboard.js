// ===========================================================================
//  NSBA Sales Board — submitted-policies via External API (no DB needed)
//  Counts SUBMITTED POLICIES per agent for today and the current week
//  (Pacific business day), DEDUPED so that multiple policies for the SAME
//  CLIENT + SAME CARRIER count as ONE sale (e.g. a UHOne hospital + accident
//  policy for one client = 1). A different carrier for that client counts
//  separately. This reflects deals sold, so totals read lower than Onyx's
//  raw policy count by design.
//
//  Timeout-safe: agent/detail lookups run in parallel batches with a time
//  budget. A policy's client/carrier/agent never change, so each is looked up
//  once and cached; refreshes only look up newly submitted policies.
//
//  REQUIREMENTS
//    ONYX_API_KEY   onyx_sk_... key with External Policies + External Users
//    ONYX_ORG       national-senior-benefit-advisors
//    COUNT_ANCILLARY "true"(default) include riders (they dedupe into the deal);
//                    "false" exclude ancillary policies entirely
//    BOARD_TOKEN    optional. No npm deps (built-in fetch).
// ===========================================================================

export const config = { maxDuration: 30 };

const API_BASE = process.env.ONYX_API_BASE || "https://api.onyxplatform.com";
const ORG = process.env.ONYX_ORG;
const KEY = process.env.ONYX_API_KEY;
const COUNT_ANCILLARY = (process.env.COUNT_ANCILLARY || "true").toLowerCase() !== "false";
// Comma-separated policy statuses to EXCLUDE from the board (case-insensitive).
// e.g. EXCLUDE_STATUSES="Not Set,Submitted". Empty = count every status.
const EXCLUDE_STATUSES = new Set((process.env.EXCLUDE_STATUSES || "")
  .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
// When true, count ONLY policies whose "Verified Sale" custom field = "Verified".
// Default OFF: set VERIFIED_ONLY=true in Vercel to enable (instant revert by unsetting).
const VERIFIED_ONLY = (process.env.VERIFIED_ONLY || "false").toLowerCase() === "true";
const TZ = "America/Los_Angeles";
const LINES = ["medicare", "health", "life"];
const CACHE_TTL = 12000;
const MAX_NEW_DETAILS = 40;
const DETAIL_CONC = 8;
const TIME_BUDGET_MS = 6000;
const RECHECK_TTL_MS = 45000;
const USERS_TTL = 300000;

let cache = { at: 0, data: null };
// policy_id -> { email, person, carrier }   (immutable per policy)
const policyInfo = global._nsbaPolicyInfo || (global._nsbaPolicyInfo = new Map());
let usersCache = global._nsbaUsers || (global._nsbaUsers = { at: 0, map: null });

/* ---------- Pacific day boundaries (DST-safe), as naive-UTC ISO ---------- */
function partsInTZ(d){ const f=new Intl.DateTimeFormat("en-US",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
  const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value])); return {y:+p.year,m:+p.month,d:+p.day}; }
function tzOffsetMs(d){ const f=new Intl.DateTimeFormat("en-US",{timeZone:TZ,hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const p=Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value])); const hh=p.hour==="24"?"00":p.hour;
  return Date.UTC(+p.year,+p.month-1,+p.day,+hh,+p.minute,+p.second)-d.getTime(); }
function pacMidnightUTC(y,m,d){ const g=Date.UTC(y,m-1,d,0,0,0); return new Date(g-tzOffsetMs(new Date(g))); }
function fmtUTC(d){ return d.toISOString().slice(0,19); }
function bounds(){
  const now=new Date(); const {y,m,d}=partsInTZ(now);
  const dow=new Date(Date.UTC(y,m-1,d)).getUTCDay(); const back=(dow+6)%7;
  const mon=new Date(Date.UTC(y,m-1,d-back));
  const wsDate=`${mon.getUTCFullYear()}-${String(mon.getUTCMonth()+1).padStart(2,"0")}-${String(mon.getUTCDate()).padStart(2,"0")}`;
  return { todayISO:fmtUTC(pacMidnightUTC(y,m,d)),
           weekISO:fmtUTC(pacMidnightUTC(mon.getUTCFullYear(),mon.getUTCMonth()+1,mon.getUTCDate())),
           wsDate };
}

/* ----------------------------- API helpers ----------------------------- */
async function apiGet(path, params){
  const url=new URL(API_BASE+path);
  for(const [k,v] of Object.entries(params||{})) if(v!=null) url.searchParams.set(k,v);
  const r=await fetch(url,{headers:{"X-API-Key":KEY,Accept:"application/json"}});
  if(!r.ok){ const b=await r.text().catch(()=>""); throw new Error(`Onyx ${r.status} ${path} ${b.slice(0,160)}`); }
  return r.json();
}
async function listLine(line, afterISO){
  const out=[]; let page=1, pages=1;
  do{
    const data=await apiGet(`/api/external/v1/policies/${line}/${encodeURIComponent(ORG)}`,
      { page, page_size:1000, submitted_after:afterISO });
    for(const it of data.items||[]){ if(!global._nsbaFields && it) global._nsbaFields=Object.keys(it); out.push({ id:it.policy_id, line, anc:!!it.is_ancillary, status:it.policy_status??null }); }
    pages=data.total_pages||1; page++;
  } while(page<=pages && page<=10);
  return out;
}
// pull agent + client + carrier from the policy detail (one call, all three)
async function detailInfo(line, id){
  const d=await apiGet(`/api/external/v1/policies/${line}/${encodeURIComponent(ORG)}/${id}`);
  const cf = (d && d.custom_fields) || {};
  return {
    email:    d && d.agent  ? (d.agent.email || null) : null,
    person:   d && d.person ? (d.person.person_id ?? null) : null,
    carrier:  d && d.carrier_name ? String(d.carrier_name).trim().toLowerCase() : null,
    verified: String(cf["Verified Sale"] ?? "").trim().toLowerCase() === "verified",
  };
}
async function userMap(){
  if(usersCache.map && Date.now()-usersCache.at < USERS_TTL) return usersCache.map;
  const map={}; let page=1, pages=1;
  do{
    const data=await apiGet(`/api/external/v1/users/${encodeURIComponent(ORG)}`,{ page, page_size:1000, is_active:true });
    for(const u of data.items||[]) if(u.email) map[u.email.toLowerCase()]=`${u.first_name||""} ${u.last_name||""}`.trim()||u.email;
    pages=data.total_pages||1; page++;
  } while(page<=pages && page<=5);
  usersCache={ at:Date.now(), map };
  return map;
}
async function resolveDetails(ordered){
  const start=Date.now(), now=Date.now();
  // Read a policy if we've never seen it, OR (verified-only mode) it isn't
  // verified yet and is due for a re-check. Verified/cached ones are skipped.
  const work=ordered.filter(x=>{
    const info=policyInfo.get(x.id);
    if(!info) return true;
    return VERIFIED_ONLY && !info.verified && (now-(info.checkedAt||0))>RECHECK_TTL_MS;
  }).slice(0, MAX_NEW_DETAILS);
  for(let i=0;i<work.length;i+=DETAIL_CONC){
    if(Date.now()-start>TIME_BUDGET_MS) break;
    await Promise.all(work.slice(i,i+DETAIL_CONC).map(async x=>{
      try{ const info=await detailInfo(x.line,x.id); info.checkedAt=Date.now(); policyInfo.set(x.id, info); }catch(e){}
    }));
  }
}

/* ------------------------------- build -------------------------------- */
async function buildBoards(){
  const { todayISO, weekISO, wsDate }=bounds();
  const lists=await Promise.all([
    ...LINES.map(l=>listLine(l, weekISO)),
    ...LINES.map(l=>listLine(l, todayISO)),
  ]);
  const statusOk = x => !EXCLUDE_STATUSES.has((x.status||"Not Set").trim().toLowerCase());
  const keep = x => statusOk(x) && (COUNT_ANCILLARY || !x.anc);
  const weekItems = lists.slice(0,3).flat().filter(keep);
  const todayAll = lists.slice(3).flat().filter(statusOk);
  const todayItems = todayAll.filter(keep);

  const todayIds=new Set(todayItems.map(x=>x.id));
  const ordered=[...weekItems].sort((a,b)=>(todayIds.has(b.id)?1:0)-(todayIds.has(a.id)?1:0));
  await resolveDetails(ordered);

  const umap=await userMap();
  // dedupe: one sale per (client + carrier) per agent
  const tally=(items)=>{
    const perAgent={}; // email -> Set of dealKeys
    for(const x of items){
      const info=policyInfo.get(x.id); if(!info) continue;
      if(VERIFIED_ONLY && !info.verified) continue;
      const email=info.email; if(!email) continue;
      const dealKey = info.person!=null ? `p${info.person}|${info.carrier||""}` : `id${x.id}`;
      (perAgent[email] = perAgent[email] || new Set()).add(dealKey);
    }
    return Object.entries(perAgent)
      .map(([e,set])=>({ name:umap[e.toLowerCase()]||e.split("@")[0], sales:set.size }))
      .sort((a,b)=>b.sales-a.sales||a.name.localeCompare(b.name));
  };
  const statusCounts={};
  for(const x of lists.flat()){ const s=x.status==null?"(null/Not Set)":String(x.status); statusCounts[s]=(statusCounts[s]||0)+1; }
  let detailProbe=null;
  try{
    const first = lists.slice(3).flat()[0] || lists.flat()[0];
    if(first){
      const d=await apiGet(`/api/external/v1/policies/${first.line}/${encodeURIComponent(ORG)}/${first.id}`);
      detailProbe={ policy_id:first.id, detail_fields:Object.keys(d||{}), custom_fields:(d&&d.custom_fields!==undefined)?d.custom_fields:"(no custom_fields key)" };
    }
  }catch(e){ detailProbe={ error:String(e.message).slice(0,160) }; }
  const cAnc = x => { if(VERIFIED_ONLY){ const i=policyInfo.get(x.id); return i && i.verified; } return true; };
  return { updated_at:new Date().toISOString(), week_start:wsDate,
    today:tally(todayItems), week:tally(weekItems),
    today_core: todayAll.filter(x=>!x.anc && cAnc(x)).length,
    today_ancillary: todayAll.filter(x=>x.anc && cAnc(x)).length,
    _diag: { verified_only:VERIFIED_ONLY, api_status_values: statusCounts, sample_fields: global._nsbaFields||[], detail_probe: detailProbe } };
}

/* ------------------------------- handler ------------------------------- */
export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(req.method!=="GET") return res.status(405).json({error:"GET only"});
  if(process.env.BOARD_TOKEN && req.query.key!==process.env.BOARD_TOKEN) return res.status(401).json({error:"unauthorized"});
  if(!ORG||!KEY){ console.error("salesboard: missing ONYX_ORG or ONYX_API_KEY"); return res.status(500).json({error:"server not configured"}); }
  // Diagnostic: GET /api/salesboard?debug=status -> shows what status fields the
  // External API actually returns for this week's policies (one-off; safe to leave in).
  if(req.query.debug==="status"){
    try{
      const { weekISO }=bounds(); const out={};
      for(const line of LINES){
        const data=await apiGet(`/api/external/v1/policies/${line}/${encodeURIComponent(ORG)}`,{ page:1, page_size:200, submitted_after:weekISO });
        const items=data.items||[]; const counts={};
        for(const it of items){ const s=it.policy_status==null?"(null/Not Set)":String(it.policy_status); counts[s]=(counts[s]||0)+1; }
        out[line]={ count:items.length, status_counts:counts, available_fields:Object.keys(items[0]||{}) };
      }
      return res.status(200).json(out);
    }catch(e){ return res.status(502).json({error:"debug failed", detail:String(e.message).slice(0,200)}); }
  }
  try{
    if(cache.data && Date.now()-cache.at < CACHE_TTL){ res.setHeader("X-Cache","HIT"); }
    else{ cache={ at:Date.now(), data:await buildBoards() }; res.setHeader("X-Cache","MISS"); }
    res.setHeader("Cache-Control","s-maxage=10, stale-while-revalidate=20");
    return res.status(200).json(cache.data);
  }catch(err){
    console.error("salesboard error:", err.message);
    if(cache.data){ res.setHeader("X-Cache","STALE"); return res.status(200).json(cache.data); }
    return res.status(502).json({error:"onyx fetch failed", detail:String(err.message).slice(0,180)});
  }
}
