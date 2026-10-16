import {pairingPage, pairingRoute} from './pairing.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const PROFILE_LIMIT = 64 * 1024;
const BODY_LIMIT = 256 * 1024;
const REPO = 'Thomson67/ultimate-wine-toolbox-community';
const MODES = new Set(['keyboard','mousebutton','mousemovement','pause','hold','cycle','distance',
  'release','mousespeedmod','keypress','delay','setchange','textentry','mix']);
const enc = new TextEncoder();
const now = () => Math.floor(Date.now()/1000);
class Failure extends Error { constructor(status, message) { super(message); this.status=status; } }
function requireValue(ok, message, status=400) { if (!ok) throw new Failure(status, message); }
export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function text(value, max=2000) {
  requireValue(typeof value==='string' && value.length<=max && !/[\x00-\x1f\x7f]/.test(value), 'Invalid metadata text');
  return value.trim();
}
export async function validateSubmission(value) {
  requireValue(value && typeof value==='object' && value.metadata && typeof value.profile==='string', 'Invalid submission');
  const m=value.metadata;
  requireValue(['antimicrox','reshade'].includes(m.kind), 'Invalid profile type');
  requireValue(typeof m.id==='string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(m.id), 'Invalid identifier');
  const result={id:m.id, kind:m.kind};
  for (const field of ['game','title','author']) { result[field]=text(m[field],160); requireValue(result[field], 'Missing '+field); }
  for (const field of ['description','notes','tested_on','hotkey']) result[field]=text(m[field]??'');
  requireValue(Array.isArray(m.requirements) && m.requirements.length<=60, 'Invalid requirements');
  result.requirements=m.requirements.map(v=>text(v,160));
  result.file=`${m.kind}/${m.id}.${m.kind==='antimicrox'?'amgp':'ini'}`;
  requireValue(m.file===result.file, 'Invalid destination');
  const profile=value.profile;
  requireValue(enc.encode(profile).length<=PROFILE_LIMIT && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(profile), 'Profile exceeds 64 KiB or contains NUL');
  requireValue(!/\/userdata\/|\/home\/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\/.test(profile), 'Local paths are not accepted');
  if (m.kind==='antimicrox') {
    requireValue(!/<!DOCTYPE|<!ENTITY/i.test(profile), 'XML entities are forbidden');
    requireValue(XMLValidator.validate(profile)===true, 'Invalid XML');
    const parsed=new XMLParser({ignoreAttributes:true, parseTagValue:false, trimValues:true, processEntities:false}).parse(profile);
    requireValue(Object.hasOwn(parsed,'gamecontroller') && Object.keys(parsed).every(k=>k==='gamecontroller'||k==='?xml'), 'Expected SDL gamecontroller profile');
    let count=0;
    function walk(node, depth=0) {
      requireValue(++count<=4000 && depth<=32, 'XML profile too complex');
      if (!node || typeof node!=='object') return;
      for (const [key,child] of Object.entries(node)) {
        requireValue(!['uniqueid','guid','serial','sdlname'].includes(key.toLowerCase()) || child==='', 'Controller identity must be removed');
        if (key==='slot') {
          for (const slot of Array.isArray(child)?child:[child]) requireValue(MODES.has(slot?.mode??'keyboard'), 'External command or profile loading is forbidden');
        }
        walk(child, depth+1);
      }
    }
    walk(parsed.gamecontroller);
  } else {
    requireValue(/^\s*Techniques\s*=/im.test(profile), 'Expected a ReShade preset');
    requireValue(!/^\s*(EffectSearchPaths|TextureSearchPaths|PresetPath)\s*=/im.test(profile), 'Local ReShade configuration is forbidden');
    // Portable INI subset, checked before it can enter the review queue.
    const sections=new Map([['UWT_PRESET',new Set()]]); let section=sections.get('UWT_PRESET'), previousIndent=-1;
    for(const raw of profile.replace(/^\uFEFF/,'').split(/\r?\n/)) {
      const line=raw.trim(); if(!line || /^[#;]/.test(line)) continue;
      const indent=raw.length-raw.trimStart().length;
      if(previousIndent>=0 && indent>previousIndent) continue;
      if(line.startsWith('[')) {
        const match=line.match(/^\[([^\]]+)\]\s*(?:[#;].*)?$/);
        requireValue(match && !sections.has(match[1]),'Invalid or duplicate INI section');
        section=new Set(); sections.set(match[1],section); previousIndent=-1;
      } else {
        const match=line.match(/^([^=:]+)[=:](.*)$/);
        requireValue(match && match[1].trim() && !section.has(match[1].trim()),'Invalid or duplicate INI option');
        section.add(match[1].trim()); previousIndent=indent;
      }
    }
  }
  result.sha256=await sha256(profile);
  requireValue(m.sha256===result.sha256, 'Checksum mismatch');
  return {metadata:result, profile};
}
async function body(request, limit=BODY_LIMIT) {
  requireValue((request.headers.get('content-type')||'').split(';')[0]==='application/json', 'Expected JSON',415);
  const reader=request.body?.getReader(); requireValue(reader, 'Missing body');
  const chunks=[]; let size=0;
  try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length;
    if(size>limit) { await reader.cancel(); throw new Failure(413,'Request too large'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks) {bytes.set(c,offset);offset+=c.length;}
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new Failure(400,'Invalid JSON'); }
}
function response(value,status=200) {return Response.json(value,{status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function rate(env, key, max, seconds) {
  const bucket=Math.floor(now()/seconds);
  const r=await env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count')
    .bind(`${key}:${bucket}`, (bucket+1)*seconds, max).first();
  requireValue(r,'Too many requests; try later',429);
}
async function ipKey(request, env) {
  const key=await crypto.subtle.importKey('raw',enc.encode(env.ADMIN_KEY_HASH),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(request.headers.get('CF-Connecting-IP')||'unknown')))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
async function authorized(request,env) {
  const token=(request.headers.get('authorization')||'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  requireValue(token, 'Validator login required',401);
  const session=await env.DB.prepare("SELECT s.hash FROM sessions s LEFT JOIN device_sessions ds ON ds.session_hash=s.hash LEFT JOIN devices d ON d.hash=ds.device_hash WHERE s.hash=? AND s.expires>? AND (ds.session_hash IS NULL OR ds.device_hash='' OR d.expires>unixepoch())").bind(await sha256(token),now()).first();
  requireValue(session,'Validator session expired',401);
  return token;
}
export async function github(env, path, method='GET', data) {
  const r=await fetch(`https://api.github.com/repos/${REPO}/${path}`,{
    method, redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'UWT-community'},
    ...(data===undefined?{}:{body:JSON.stringify(data)})});
  if(!r.ok) throw new Failure(r.status===409||r.status===422?409:502,'GitHub publication failed ('+r.status+'); retry approval');
  return r.json();
}
// Profile and catalogue enter the same commit. Never force-update a Git ref.
export async function publish(env, submission, api=github) {
  for(let attempt=0;attempt<3;attempt++) {
    const ref=await api(env,'git/ref/heads/main');
    const head=await api(env,'git/commits/'+ref.object.sha);
    const file=await api(env,`contents/catalog.json?ref=${head.sha}`);
    requireValue(file.encoding==='base64' && file.size<=1024*1024, 'Catalogue too large',409);
    const current=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));
    requireValue(current.schema===1 && Array.isArray(current.entries) && current.entries.length<3000,'Invalid or full catalogue',409);
    const m=JSON.parse(submission.metadata);
    const existing=current.entries.find(v=>v.id===m.id);
    if(existing) {
      requireValue(JSON.stringify(existing)===JSON.stringify(m),'Identifier already published with different metadata',409);
      return head.sha; // Previous successful commit with a lost response: safe retry.
    }
    current.entries.push(m);
    const catalogText=JSON.stringify(current,null,2)+'\n';
    requireValue(enc.encode(catalogText).length<=1024*1024,'Catalogue full',409);
    const tree=await api(env,'git/trees','POST',{base_tree:head.tree.sha,tree:[
      {path:m.file,mode:'100644',type:'blob',content:submission.profile},
      {path:'catalog.json',mode:'100644',type:'blob',content:catalogText}]});
    const commit=await api(env,'git/commits','POST',{message:`Approve community contribution ${m.id}`,tree:tree.sha,parents:[head.sha]});
    try {await api(env,'git/refs/heads/main','PATCH',{sha:commit.sha,force:false}); return commit.sha;}
    catch(error) {if(error.status!==409||attempt===2) throw error;}
  }
}
async function route(request,env) {
  const url=new URL(request.url), path=url.pathname;
  if(request.method==='GET' && (path==='/'||path==='/health')) return response({service:'uwt-community',version:2,configured:!!(env.DB && env.GITHUB_TOKEN && /^[a-f0-9]{64}$/.test(env.ADMIN_KEY_HASH||'')),profile_limit:PROFILE_LIMIT});
  requireValue(env.DB && /^[a-f0-9]{64}$/.test(env.ADMIN_KEY_HASH||''),'Service is not configured',503);
  if(request.method==='GET' && path==='/pair') return pairingPage();
  const paired=await pairingRoute(request,env,{body,rate,ipKey,sha256,requireValue,response,authorized,text});
  if(paired) return paired;
  if(request.method==='POST' && path==='/v1/login') {
    await rate(env,'login:'+await ipKey(request,env),10,900);
    const value=await body(request,1024);
    requireValue(typeof value.key==='string' && /^[a-f0-9]{64}$/.test(value.key),'Invalid validator key',401);
    // The key is a generated 256-bit random secret, NOT a human-chosen password.
    requireValue(await sha256(value.key)===env.ADMIN_KEY_HASH,'Invalid validator key',401);
    const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    await env.DB.prepare('INSERT INTO sessions(hash,expires) VALUES(?,?)').bind(await sha256(token),now()+1800).run();
    return response({token,expires:now()+1800});
  }
  if(request.method==='POST' && path==='/v1/submissions') {
    await rate(env,'submit:'+await ipKey(request,env),5,86400);
    await rate(env,'submit-global',100,86400);
    const value=await validateSubmission(await body(request));
    const m=value.metadata;
    const existing=await env.DB.prepare('SELECT sha256,metadata,status FROM submissions WHERE id=?').bind(m.id).first();
    if(existing) {
      requireValue(existing.sha256===m.sha256 && existing.metadata===JSON.stringify(m),'Identifier collision',409);
      return response({id:m.id,status:existing.status});
    }
    const r=await env.DB.prepare("INSERT INTO submissions(id,kind,metadata,profile,sha256,created) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM submissions WHERE status IN ('pending','publishing'))<200")
      .bind(m.id,m.kind,JSON.stringify(m),value.profile,m.sha256,now()).run();
    requireValue(r.meta.changes===1,'Review queue is full; try later',503);
    return response({id:m.id,status:'pending'},201);
  }
  const token=await authorized(request,env);
  if(path==='/v1/logout' && request.method==='POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await sha256(token)).run(); return response({ok:true});
  }
  if(path==='/v1/pending' && request.method==='GET') {
    const kind=url.searchParams.get('kind'); requireValue(['antimicrox','reshade'].includes(kind),'Invalid profile type');
    const rows=await env.DB.prepare("SELECT metadata,status FROM submissions WHERE kind=? AND status IN ('pending','publishing') ORDER BY created LIMIT 200").bind(kind).all();
    return response({entries:rows.results.map(r=>({...JSON.parse(r.metadata),status:r.status}))});
  }
  const match=path.match(/^\/v1\/submissions\/([a-z0-9][a-z0-9-]{0,79})(?:\/(approve|reject))?$/);
  requireValue(match,'Unknown endpoint',404);
  const row=await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(match[1]).first();
  requireValue(row,'Unknown contribution',404);
  if(!match[2] && request.method==='GET') return response({metadata:JSON.parse(row.metadata),profile:row.profile,status:row.status});
  requireValue(request.method==='POST' && match[2],'Unsupported method',405);
  if(match[2]==='reject') {
    const r=await env.DB.prepare("UPDATE submissions SET status='rejected',profile='' WHERE id=? AND (status='pending' OR (status='publishing' AND lease_until<?))").bind(row.id,now()).run();
    requireValue(r.meta.changes===1,'Contribution already processed or being published',409); return response({status:'rejected'});
  }
  if(row.status==='approved') return response({status:'approved',commit:row.commit_sha});
  requireValue(env.GITHUB_TOKEN,'GitHub secret is missing',503);
  const lease=crypto.randomUUID();
  const claimed=await env.DB.prepare("UPDATE submissions SET status='publishing',lease=?,lease_until=? WHERE id=? AND (status='pending' OR (status='publishing' AND lease_until<?))")
    .bind(lease,now()+300,row.id,now()).run();
  requireValue(claimed.meta.changes===1,'Contribution already processed or being published; retry later',409);
  try {
    await validateSubmission({metadata:JSON.parse(row.metadata),profile:row.profile});
    const commit=await publish(env,row);
    await env.DB.prepare("UPDATE submissions SET status='approved',profile='',commit_sha=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?").bind(commit,row.id,lease).run();
    return response({status:'approved',commit});
  } catch(error) {
    await env.DB.prepare("UPDATE submissions SET status='pending',lease=NULL,lease_until=0 WHERE id=? AND lease=?").bind(row.id,lease).run(); throw error;
  }
}
export async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now()),
    env.DB.prepare('DELETE FROM pairings WHERE expires<?').bind(now()),
    env.DB.prepare('DELETE FROM devices WHERE expires<?').bind(now()),
    env.DB.prepare('DELETE FROM device_sessions WHERE session_hash NOT IN (SELECT hash FROM sessions)').bind(),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now()),
    env.DB.prepare("DELETE FROM submissions WHERE created<? AND status IN ('approved','rejected')").bind(now()-30*86400),
    env.DB.prepare("DELETE FROM submissions WHERE created<? AND (status='pending' OR (status='publishing' AND lease_until<unixepoch()))").bind(now()-30*86400)
  ]);
}
export default {
  async fetch(request,env) {try {return await route(request,env);} catch(error) {return response({error:error instanceof Failure?error.message:'Service unavailable; retry later'},error.status||503);}},
  async scheduled(_event,env) {await cleanup(env);}
};
