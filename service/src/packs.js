// Binary packs use a private R2 bucket and a separate moderated D1 catalogue.
// Never mix binary entries into the legacy text-profile Git catalogue.
import {Inflate} from 'fflate';
export const ZIP_LIMIT=16*1024*1024, EXPANDED_LIMIT=64*1024*1024;
const decode=new TextDecoder('utf-8',{fatal:true}), encode=new TextEncoder();
const now=()=>Math.floor(Date.now()/1000);
export class PackError extends Error {}
const ok=(condition,message,status=400)=>{if(!condition){const e=new PackError(message);e.status=status;throw e}};
export async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')}
function path(name){
 ok(typeof name==='string' && name.length<=512 && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith('/') && name.split('/').every(p=>p && p!=='.' && p!=='..' && !/[ .]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'Invalid pack member path');
 return name;
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
function crc32(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0}
class ZipMembers extends Map {get(name){return super.get(name)?.()}}
function unpack(bytes){
 ok(bytes.length>22 && bytes.length<=ZIP_LIMIT,'Pack ZIP exceeds 16 MiB',413);
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50 && i+22+view.getUint16(i+20,true)===bytes.length){end=i;break}
 ok(end>=0,'Invalid ZIP directory');
 const count=view.getUint16(end+10,true),start=view.getUint32(end+16,true);
 ok(!view.getUint16(end+4,true) && !view.getUint16(end+6,true) && view.getUint16(end+8,true)===count && count>0 && count<=4096 && start+view.getUint32(end+12,true)===end,'Unsupported ZIP directory');
 const files=new ZipMembers(),seen=new Set(),records=[];let pos=start,total=0;
 for(let i=0;i<count;i++){
  ok(pos+46<=end && view.getUint32(pos,true)===0x02014b50,'Invalid ZIP record');
  const flags=view.getUint16(pos+8,true),method=view.getUint16(pos+10,true),compressed=view.getUint32(pos+20,true),size=view.getUint32(pos+24,true),length=view.getUint16(pos+28,true),extra=view.getUint16(pos+30,true),comment=view.getUint16(pos+32,true),offset=view.getUint32(pos+42,true);
  ok(pos+46+length+extra+comment<=end && !(flags&1) && [0,8].includes(method) && (view.getUint32(pos+38,true)>>>16&0xf000)!==0xa000,'Encrypted/linked/unsupported ZIP member');
  const name=path(decode.decode(bytes.subarray(pos+46,pos+46+length)));
  ok(!seen.has(name.toLowerCase()),'Duplicate pack member');seen.add(name.toLowerCase());
  total+=size;ok(size<=32*1024*1024 && total<=EXPANDED_LIMIT,'Expanded pack exceeds 64 MiB',413);
  ok(offset+30<=start && view.getUint32(offset,true)===0x04034b50,'Invalid ZIP local record');
  const localName=view.getUint16(offset+26,true),localExtra=view.getUint16(offset+28,true),from=offset+30+localName+localExtra;
  ok(from+compressed<=start && decode.decode(bytes.subarray(offset+30,offset+30+localName))===name && view.getUint16(offset+8,true)===method,'Inconsistent ZIP member');
  records.push({name,method,compressed,size,from,crc:view.getUint32(pos+16,true)});pos+=46+length+extra+comment;
 }
 ok(pos===end,'Unexpected ZIP directory data');
 // All declared sizes are checked before allocating/inflating any member.
 for(const r of records){
  files.set(r.name,()=>{
  const raw=bytes.subarray(r.from,r.from+r.compressed);let data=raw;
  if(r.method===8){data=new Uint8Array(r.size);let written=0;const inflater=new Inflate(chunk=>{ok(written+chunk.length<=r.size,'ZIP expands beyond declared size',413);data.set(chunk,written);written+=chunk.length});
   for(let i=0;i<raw.length;i+=1024)inflater.push(raw.subarray(i,i+1024),i+1024>=raw.length);
   ok(written===r.size,'ZIP size mismatch');
  }
  ok(data.length===r.size && crc32(data)===r.crc,'ZIP size/CRC mismatch');return data;
  });
 }
 return files;
}
function publicText(value,max=4000,required=false){ok(typeof value==='string' && value.length<=max && !/[\x00-\x1f\x7f]/.test(value) && (!required||value.trim()),'Invalid public pack metadata');return value.trim()}
async function parsePack(bytes){
 const files=unpack(bytes);ok(files.has('uwt-pack.json'),'Missing portable pack manifest');
 ok(files.get('uwt-pack.json').length<=1024*1024,'Manifest too large');
 const manifest=JSON.parse(decode.decode(files.get('uwt-pack.json')));
 ok(manifest.schema===1 && manifest.kind==='uwt-reshade-pack','Unsupported pack manifest');
 const metadata={};for(const key of ['game','title','author','credits','description','tested_on'])metadata[key]=publicText(manifest[key]??'', ['game','title','author'].includes(key)?160:4000,['game','title','author','credits'].includes(key));
 ok(manifest.files && typeof manifest.files==='object' && !Array.isArray(manifest.files),'Missing member checksums');
 const members=Object.keys(manifest.files);ok(members.length>0 && members.length+2===files.size && files.has('README.txt'),'Unexpected pack members');
 ok(manifest.presets && !Array.isArray(manifest.presets) && Object.keys(manifest.presets).length>0 && Object.keys(manifest.presets).length<=200,'Invalid pack presets');
 ok(manifest.addons && !Array.isArray(manifest.addons),'Invalid add-ons');
 for(const name of members){
  path(name);ok(files.has(name),'Missing member');const data=files.get(name);ok(/^[a-f0-9]{64}$/.test(manifest.files[name]) && await digest(data)===manifest.files[name],'Member checksum mismatch');
  const preset=Object.hasOwn(manifest.presets,name),addon=Object.hasOwn(manifest.addons,name);
  ok(name==='ReShade.ini'||preset||addon||/^reshade-shaders\/(Shaders|Textures)\/.+\.(fx|fxh|h|hlsl|png|jpg|jpeg|dds|bmp|tga|gif|txt|md)$/i.test(name),'Unexpected pack payload');
  if(preset){ok(/\.ini$/i.test(name),'Invalid preset name');publicText(manifest.presets[name],512,true);const text=decode.decode(data);ok(/^Techniques=/m.test(text) && !/^[ \t]*(?:EffectSearchPaths|TextureSearchPaths|PresetPath)=/im.test(text),'Non-portable preset')}
  if(addon){ok(/\.addon(?:32|64)?$/.test(name) && [32,64].includes(manifest.addons[name]) && data.length>=64 && data[0]===77 && data[1]===90,'Invalid add-on');const v=new DataView(data.buffer,data.byteOffset,data.length),p=v.getUint32(60,true);ok(p+6<=data.length && v.getUint32(p,true)===0x4550 && v.getUint16(p+4,true)===(manifest.addons[name]===64?0x8664:0x14c),'Add-on architecture mismatch')}
  if(preset||name==='ReShade.ini')ok(!/[A-Za-z]:[\\/]|\/userdata\/|\/home\//.test(decode.decode(data)),'Machine-specific path in pack');
 }
 ok(members.includes('ReShade.ini') && Object.keys(manifest.presets).every(n=>members.includes(n)) && Object.keys(manifest.addons).every(n=>members.includes(n)),'Missing configured member');
 metadata.release=publicText(manifest.release??'',160);metadata.api=publicText(manifest.api??'',32);metadata.arch=manifest.arch??null;ok([null,32,64].includes(metadata.arch),'Invalid pack architecture');
 metadata.presets=Object.keys(manifest.presets);metadata.addons=Object.keys(manifest.addons);metadata.requires_full_addons=metadata.addons.length>0;
 metadata.sha256=await digest(bytes);metadata.id='pack-'+metadata.sha256;metadata.kind='reshade-pack';metadata.bytes=bytes.length;
 ok(encode.encode(JSON.stringify(metadata)).length<=32768,'Pack metadata too large');
 return metadata;
}
export async function validatePack(bytes){try{return await parsePack(bytes)}catch(e){if(e instanceof PackError)throw e;ok(false,'Invalid portable pack ZIP')}}
async function binary(request){
 ok((request.headers.get('content-type')||'').split(';')[0]==='application/zip','Expected ZIP',415);
 const reader=request.body?.getReader();ok(reader,'Missing ZIP');let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>ZIP_LIMIT){await reader.cancel();ok(false,'Pack ZIP exceeds 16 MiB',413)}chunks.push(value)}}finally{reader.releaseLock()}
 const result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length}return result;
}
export async function packsRoute(request,env,h){
 const url=new URL(request.url),p=url.pathname;if(!p.startsWith('/v1/packs'))return null;
 const {response,authorized,rate,ipKey,body}=h;
 ok(env.PACKS,'Pack storage is not enabled; configure the PACKS R2 binding',503);
 if(p==='/v1/packs' && request.method==='GET'){
  const rows=await env.DB.prepare("SELECT metadata FROM pack_submissions WHERE status='approved' ORDER BY created DESC LIMIT 1000").bind().all();return response({schema:1,entries:rows.results.map(r=>{const m=JSON.parse(r.metadata);return Object.fromEntries(['id','kind','game','title','author','sha256','bytes','release','requires_full_addons'].map(k=>[k,m[k]]))})});
 }
 if(p==='/v1/packs/submissions' && request.method==='POST'){
  await rate(env,'pack-submit:'+await ipKey(request,env),5,86400);await rate(env,'pack-submit-global',30,86400);
  const bytes=await binary(request),m=await validatePack(bytes),metadata=JSON.stringify(m);
  const existing=await env.DB.prepare('SELECT metadata,status FROM pack_submissions WHERE id=?').bind(m.id).first();
  if(existing){ok(existing.metadata===metadata,'Pack identity collision',409);if(existing.status==='pending')await env.PACKS.put('packs/'+m.sha256+'.zip',bytes,{httpMetadata:{contentType:'application/zip'}});return response({id:m.id,status:existing.status})}
  const key='packs/'+m.sha256+'.zip';
  const result=await env.DB.prepare("INSERT OR IGNORE INTO pack_submissions(id,metadata,sha256,object_key,created) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM pack_submissions WHERE status='pending')<50").bind(m.id,metadata,m.sha256,key,now()).run();
  if(result.meta.changes!==1){const row=await env.DB.prepare('SELECT status FROM pack_submissions WHERE id=?').bind(m.id).first();ok(row,'Pack review queue full',503);return response({id:m.id,status:row.status})}
  await env.PACKS.put(key,bytes,{httpMetadata:{contentType:'application/zip'}});
  return response({id:m.id,status:'pending'},201);
 }
 const download=p.match(/^\/v1\/packs\/(pack-[a-f0-9]{64})\/download$/);
 if(download && request.method==='GET'){
  const row=await env.DB.prepare("SELECT object_key FROM pack_submissions WHERE id=? AND status='approved'").bind(download[1]).first();ok(row,'Pack unavailable',404);
  const object=await env.PACKS.get(row.object_key);ok(object,'Pack file unavailable',404);
  return new Response(object.body,{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="'+download[1]+'.zip"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 const detail=p.match(/^\/v1\/packs\/(pack-[a-f0-9]{64})$/);
 if(detail && request.method==='GET'){const row=await env.DB.prepare("SELECT metadata FROM pack_submissions WHERE id=? AND status='approved'").bind(detail[1]).first();if(row)return response({metadata:JSON.parse(row.metadata),status:'approved'})}
 await authorized(request,env);
 if(p==='/v1/packs/pending' && request.method==='GET'){
  const rows=await env.DB.prepare("SELECT metadata FROM pack_submissions WHERE status='pending' ORDER BY created LIMIT 50").bind().all();return response({entries:rows.results.map(r=>JSON.parse(r.metadata))});
 }
 const match=p.match(/^\/v1\/packs\/(pack-[a-f0-9]{64})(?:\/(approve|reject|remove|review-download))?$/);ok(match,'Unknown pack endpoint',404);
 const row=await env.DB.prepare('SELECT * FROM pack_submissions WHERE id=?').bind(match[1]).first();ok(row,'Unknown pack',404);
 if(!match[2] && request.method==='GET')return response({metadata:JSON.parse(row.metadata),status:row.status});
 if(match[2]==='review-download' && request.method==='GET'){
  const object=await env.PACKS.get(row.object_key);ok(object,'Pack file unavailable',404);return new Response(object.body,{headers:{'Content-Type':'application/zip','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 ok(request.method==='POST' && ['approve','reject','remove'].includes(match[2]),'Unsupported pack action',405);
 const value=await body(request,1024);ok(value.sha256===row.sha256,'Review this exact pack first',409);
 if(match[2]==='approve'){
  if(row.status==='approved')return response({id:row.id,status:'approved'});
  ok(row.status==='pending','Pack already processed',409);
  const object=await env.PACKS.get(row.object_key);ok(object,'Pack file unavailable',409);ok(object.size<=ZIP_LIMIT,'Stored pack too large',413);
  const m=await validatePack(new Uint8Array(await object.arrayBuffer()));ok(JSON.stringify(m)===row.metadata,'Stored pack changed',409);
 }
 const target=match[2]==='approve'?'approved':'rejected',expected=match[2]==='remove'?'approved':'pending';
 const changed=await env.DB.prepare('UPDATE pack_submissions SET status=? WHERE id=? AND status=?').bind(target,row.id,expected).run();
 ok(changed.meta.changes===1 || row.status===target,'Pack state changed; refresh',409);
 // Retain immutable bytes for lost-response retries; rejected bytes are never public.
 return response({id:row.id,status:target});
}

export async function cleanupPacks(env){
 if(!env.PACKS)return;
 const rows=await env.DB.prepare("SELECT id,object_key FROM pack_submissions WHERE status!='approved' AND created<? LIMIT 100").bind(now()-30*86400).all();
 for(const row of rows.results){const r=await env.DB.prepare("DELETE FROM pack_submissions WHERE id=? AND status!='approved' AND created<?").bind(row.id,now()-30*86400).run();if(r.meta.changes)await env.PACKS.delete(row.object_key)}
}
