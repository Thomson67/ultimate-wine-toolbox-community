import {page} from './pairing-page.js';
const now=()=>Math.floor(Date.now()/1000);
const randomToken=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
const tokenPattern=/^[a-f0-9]{64}$/;
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codes=value=>typeof value==='string'?value.toUpperCase().replace(/[ -]/g,''):'';

export function pairingPage() {
 const nonce=randomToken();
 return new Response(page.replaceAll('__NONCE__',nonce),{headers:{
  'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
 }});
}
export async function pairingRoute(request,env,h) {
 const {body,rate,ipKey,sha256,requireValue:check,response,authorized,text}=h;
 const path=new URL(request.url).pathname;
 if(!['/v1/pair/start','/v1/pair/poll','/v1/pair/cancel','/v1/pair/inspect','/v1/pair/approve','/v1/device/login','/v1/device/forget','/v1/devices','/v1/devices/revoke'].includes(path))return null;
 const db=env.DB;
 async function master() {
  const token=await authorized(request,env);
  const paired=await db.prepare('SELECT session_hash FROM device_sessions WHERE session_hash=?').bind(await sha256(token)).first();
  check(!paired,'Use the validator key on the pairing page to manage devices',403);
  await rate(env,'manage:'+await ipKey(request,env),60,900);
 }
 async function secretHash(value) {check(tokenPattern.test(value?.secret||''),'Invalid device secret');return sha256(value.secret);}
 async function revoke(hash) {
  await db.batch([
   db.prepare('DELETE FROM sessions WHERE hash=? OR hash IN (SELECT session_hash FROM device_sessions WHERE device_hash=?)').bind(hash,hash),
   db.prepare('DELETE FROM device_sessions WHERE device_hash=? OR session_hash=?').bind(hash,hash),
   db.prepare('DELETE FROM devices WHERE hash=?').bind(hash),
   db.prepare('DELETE FROM pairings WHERE device_hash=?').bind(hash)
  ]);
 }
 if(path==='/v1/pair/start'&&request.method==='POST') {
  await rate(env,'pair-start:'+await ipKey(request,env),5,3600);
  await rate(env,'pair-start-global',100,3600);
  const v=await body(request,1024), hash=await secretHash(v),name=text(v.name,80);
  check(name,'Missing device name');
  const code=[...crypto.getRandomValues(new Uint8Array(8))].map(v=>alphabet[v&31]).join('');
  const expires=now()+300;
  const r=await db.prepare('INSERT INTO pairings(device_hash,code,name,expires) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM pairings WHERE expires>?)<100')
   .bind(hash,code,name,expires,now()).run();
  check(r.meta.changes===1,'Too many pending pairings',429);
  return response({code:code.slice(0,4)+'-'+code.slice(4),expires,interval:5});
 }
 if(['/v1/pair/poll','/v1/pair/cancel'].includes(path)&&request.method==='POST') {
  await rate(env,'pair-poll:'+await ipKey(request,env),300,600);
  const hash=await secretHash(await body(request,1024));
  const p=await db.prepare('SELECT * FROM pairings WHERE device_hash=? AND expires>?').bind(hash,now()).first();
  check(p,'Pairing expired or cancelled',410);
  if(path.endsWith('/cancel')) {
   // A cancellation racing approval must also revoke the newly granted access.
   await revoke(hash);return response({ok:true});
  }
  return response({status:p.status,remember:p.remember===1,expires:p.access_expires,pair_expires:p.expires});
 }
 if(path==='/v1/device/login'&&request.method==='POST') {
  await rate(env,'device-login:'+await ipKey(request,env),60,900);
  const hash=await secretHash(await body(request,1024));
  const d=await db.prepare('SELECT hash,expires FROM devices WHERE hash=? AND expires>?').bind(hash,now()).first();
  check(d,'Device access expired or revoked',401);
  const token=randomToken(), tokenHash=await sha256(token), expires=Math.min(now()+1800,d.expires);
  // The grant must still exist when the session is inserted (revocation may race).
  await db.batch([
   db.prepare('INSERT INTO sessions(hash,expires) SELECT ?,? FROM devices WHERE hash=? AND expires>?').bind(tokenHash,expires,hash,now()),
   db.prepare('INSERT INTO device_sessions(session_hash,device_hash) SELECT hash,? FROM sessions WHERE hash=?').bind(hash,tokenHash)
  ]);
  const created=await db.prepare('SELECT hash FROM sessions WHERE hash=?').bind(tokenHash).first();
  check(created,'Device access revoked',401);return response({token,expires});
 }
 if(path==='/v1/device/forget'&&request.method==='POST') {
  await rate(env,'device-forget:'+await ipKey(request,env),30,900);
  const hash=await secretHash(await body(request,1024));await revoke(hash);return response({ok:true});
 }
 await master();
 if(path==='/v1/devices'&&request.method==='GET') {
  const rows=await db.prepare('SELECT hash AS id,name,created,expires FROM devices WHERE expires>? ORDER BY created DESC LIMIT 100').bind(now()).all();
  return response({devices:rows.results});
 }
 check(request.method==='POST','Unsupported method',405);
 const v=await body(request,1024);
 if(path==='/v1/devices/revoke') {check(tokenPattern.test(v.id||''),'Invalid device identifier');await revoke(v.id);return response({ok:true});}
 const code=codes(v.code);check(/^[A-HJ-NP-Z2-9]{8}$/.test(code),'Invalid pairing code');
 const p=await db.prepare("SELECT * FROM pairings WHERE code=? AND status='pending' AND expires>?").bind(code,now()).first();
 check(p,'Pairing code expired, already used or unknown',410);
 if(path==='/v1/pair/inspect')return response({code:p.code,name:p.name,expires:p.expires});
 check(path==='/v1/pair/approve'&&typeof v.remember==='boolean','Invalid pairing approval');
 const expires=now()+(v.remember?30*86400:1800), args=[p.device_hash,now()];
 // Approval and credential creation happen in one D1 transaction.
 const statements=v.remember?[
  db.prepare("INSERT INTO devices(hash,name,created,expires) SELECT device_hash,name,?,? FROM pairings WHERE device_hash=? AND status='pending' AND expires>?")
   .bind(now(),expires,...args)
 ]:[
  db.prepare("INSERT INTO sessions(hash,expires) SELECT device_hash,? FROM pairings WHERE device_hash=? AND status='pending' AND expires>?").bind(expires,...args),
  db.prepare("INSERT INTO device_sessions(session_hash,device_hash) SELECT device_hash,'' FROM pairings WHERE device_hash=? AND status='pending' AND expires>?").bind(...args)
 ];
 statements.push(db.prepare("UPDATE pairings SET status='approved',remember=?,access_expires=? WHERE device_hash=? AND status='pending' AND expires>?").bind(v.remember?1:0,expires,...args));
 const results=await db.batch(statements);check(results.at(-1).meta.changes===1,'Pairing already processed',409);
 return response({ok:true,remember:v.remember,expires});
}
