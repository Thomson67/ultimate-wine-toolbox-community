import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {sha256,validateSubmission,publish,cleanup,github} from '../src/worker.js';

async function setup() {
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const DB={prepare(q){return {bind(...a){const s=sql.prepare(q);return {
 async first(){return s.get(...a)||null},async all(){return {results:s.all(...a)}},async run(){return {meta:{changes:Number(s.run(...a).changes)}}}
 }}}},async batch(items){sql.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const key='ab'.repeat(32);return {sql,key,env:{DB,ADMIN_KEY_HASH:await sha256(key),GITHUB_TOKEN:'mock-only'}};
}
async function payload(kind='antimicrox',id='my-game-12345678') {
 const profile=kind==='antimicrox'?'<gamecontroller><sets><set index="1"><button index="1"><slots><slot><code>65</code><mode>keyboard</mode></slot></slots></button></set></sets></gamecontroller>':'Techniques=CAS@CAS.fx\n[CAS.fx]\nSharpness=0.5\n';
 return {profile,metadata:{id,kind,game:'My Game',title:'My profile',author:'Tester',requirements:[],description:'',notes:'',tested_on:'',hotkey:'',file:`${kind}/${id}.${kind==='antimicrox'?'amgp':'ini'}`,sha256:await sha256(profile)}};
}
async function call(env,path,{method='GET',data,token,ip='192.0.2.1'}={}) {
 const r=await worker.fetch(new Request('https://example.workers.dev'+path,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':ip,...(token?{Authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
 return {status:r.status,body:await r.json()};
}
async function login(env,key){return (await call(env,'/v1/login',{method:'POST',data:{key}})).body.token}

test('portable AntiMicroX and ReShade validate',async()=>{for(const kind of ['antimicrox','reshade']){const p=await payload(kind);assert.deepEqual((await validateSubmission(p)).metadata,p.metadata)}});
test('reject XML entities, commands, identity, paths, malformed and oversized profiles',async()=>{
 const p=await payload();for(const profile of [p.profile.replace('keyboard','execute'),p.profile.replace('keyboard','loadprofile'),
 '<!DOCTYPE gamecontroller [<!ENTITY e "boom">]><gamecontroller/>','<gamecontroller><uniqueID>private</uniqueID></gamecontroller>',
 '<gamecontroller><sdlname>Private Pad</sdlname></gamecontroller>','<gamecontroller><name>/userdata/secret</name></gamecontroller>',
 '<gamecontroller><sets></gamecontroller>','x'.repeat(65537)]) await assert.rejects(validateSubmission({...p,profile}));
});
test('metadata destination, checksum and controls cannot be forged',async()=>{const p=await payload();for(const patch of [{file:'../escape.amgp'},{sha256:'0'.repeat(64)},{title:'bad\x1b[2J'},{kind:'script'}])await assert.rejects(validateSubmission({...p,metadata:{...p.metadata,...patch}}))});
test('health exposes configuration but no secrets',async()=>{const {env}=await setup();const r=await call(env,'/health');assert.equal(r.body.configured,true);assert.ok(!JSON.stringify(r.body).includes('mock-only'))});
test('queue is private',async()=>{const {env}=await setup();assert.equal((await call(env,'/v1/pending?kind=antimicrox')).status,401)});
test('login submit review reject with real SQLite; rejected bytes are removed',async()=>{
 const {env,key,sql}=await setup(),p=await payload();assert.equal((await call(env,'/v1/login',{method:'POST',data:{key:'ff'.repeat(32)}})).status,401);
 const token=await login(env,key);assert.ok(token);assert.equal((await call(env,'/v1/submissions',{method:'POST',data:p})).status,201);
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).body.entries.length,1);
 assert.equal((await call(env,'/v1/pending?kind=reshade',{token})).body.entries.length,0);
 assert.equal((await call(env,'/v1/submissions/'+p.metadata.id,{token})).body.profile,p.profile);
 assert.equal((await call(env,'/v1/submissions/'+p.metadata.id+'/reject',{method:'POST',data:{},token})).body.status,'rejected');
 assert.equal(sql.prepare('SELECT profile FROM submissions').get().profile,'');
});
test('submit retry is idempotent and metadata collision is rejected',async()=>{
 const {env,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});assert.equal((await call(env,'/v1/submissions',{method:'POST',data:p})).body.status,'pending');
 p.metadata.title='Changed';assert.equal((await call(env,'/v1/submissions',{method:'POST',data:p})).status,409);assert.equal(sql.prepare('SELECT count(*) n FROM submissions').get().n,1);
});
test('submit and login rate limits',async()=>{
 const {env}=await setup(),p=await payload();for(let i=0;i<5;i++)await call(env,'/v1/submissions',{method:'POST',data:p});assert.equal((await call(env,'/v1/submissions',{method:'POST',data:p})).status,429);
 for(let i=0;i<10;i++)await call(env,'/v1/login',{method:'POST',data:{key:'ff'.repeat(32)}});assert.equal((await call(env,'/v1/login',{method:'POST',data:{key:'ff'.repeat(32)}})).status,429);
});
test('logout revokes session and expired session is refused',async()=>{
 const {env,key,sql}=await setup();let token=await login(env,key);await call(env,'/v1/logout',{method:'POST',data:{},token});assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).status,401);
 token=await login(env,key);sql.prepare('UPDATE sessions SET expires=0').run();assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).status,401);
});
function gitMock({conflict=false,existing=null}={}) {
 const calls=[];let patches=0;const api=async(_env,path,method='GET',data)=>{calls.push({path,method,data});
 if(path==='git/ref/heads/main')return {object:{sha:'head'}};
 if(path==='git/commits/head')return {sha:'head',tree:{sha:'oldtree'}};
 if(path.startsWith('contents/catalog.json'))return {encoding:'base64',size:100,content:Buffer.from(JSON.stringify({schema:1,entries:existing?[existing]:[]})).toString('base64')};
 if(path==='git/trees')return {sha:'newtree'};if(path==='git/commits')return {sha:'newcommit'};
 if(path==='git/refs/heads/main'){if(conflict&&++patches===1){const e=new Error('conflict');e.status=409;throw e}return {}}throw Error(path);
 };return {calls,api};
}
test('atomic Git commit, race retry, and no forced update',async()=>{
 const p=await payload(),m=gitMock({conflict:true});assert.equal(await publish({}, {metadata:JSON.stringify(p.metadata),profile:p.profile},m.api),'newcommit');
 const trees=m.calls.filter(c=>c.path==='git/trees');assert.equal(trees.length,2);assert.deepEqual(trees[0].data.tree.map(v=>v.path),[p.metadata.file,'catalog.json']);assert.ok(m.calls.filter(c=>c.path==='git/refs/heads/main').every(c=>c.data.force===false));
});
test('lost publish response does not create a duplicate',async()=>{const p=await payload(),m=gitMock({existing:p.metadata});assert.equal(await publish({}, {metadata:JSON.stringify(p.metadata),profile:p.profile},m.api),'head');assert.ok(m.calls.every(c=>c.method==='GET'))});
test('GitHub failure returns approval to pending',async()=>{
 const {env,key,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});const token=await login(env,key),saved=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:403});
 try{assert.equal((await call(env,'/v1/submissions/'+p.metadata.id+'/approve',{method:'POST',data:{},token})).status,502)}finally{globalThis.fetch=saved}
 assert.equal(sql.prepare('SELECT status FROM submissions').get().status,'pending');
});
test('active publication lease cannot be rejected or claimed again',async()=>{
 const {env,key,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});const token=await login(env,key);
 sql.prepare("UPDATE submissions SET status='publishing',lease='other',lease_until=?").run(Math.floor(Date.now()/1000)+200);
 for(const action of ['approve','reject'])assert.equal((await call(env,'/v1/submissions/'+p.metadata.id+'/'+action,{method:'POST',data:{},token})).status,409);
});
test('oversized requests stop before JSON parsing',async()=>{const {env}=await setup();assert.equal((await call(env,'/v1/submissions',{method:'POST',data:{profile:'x'.repeat(300000)}})).status,413)});
test('cleanup removes expired pending entries and rate counters',async()=>{
 const {env,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});sql.prepare('UPDATE submissions SET created=0').run();sql.prepare('UPDATE rate_limits SET expires=0').run();await cleanup(env);
 assert.equal(sql.prepare('SELECT count(*) n FROM submissions').get().n,0);assert.equal(sql.prepare('SELECT count(*) n FROM rate_limits').get().n,0);
});
test('successful approval and repeated approval publish only once',async()=>{
 const {env,key,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});const token=await login(env,key),saved=globalThis.fetch,m=gitMock();
 globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith('https://api.github.com/repos/Thomson67/ultimate-wine-toolbox-community/'));
  const path=String(url).split('/ultimate-wine-toolbox-community/')[1];
  return Response.json(await m.api(env,path,options.method,options.body?JSON.parse(options.body):undefined));
 };
 try{
  const route='/v1/submissions/'+p.metadata.id+'/approve';
  assert.equal((await call(env,route,{method:'POST',data:{},token})).body.status,'approved');
  const count=m.calls.length;assert.equal((await call(env,route,{method:'POST',data:{},token})).body.status,'approved');assert.equal(m.calls.length,count);
 }finally{globalThis.fetch=saved}
 const row=sql.prepare('SELECT * FROM submissions').get();assert.equal(row.status,'approved');assert.equal(row.commit_sha,'newcommit');assert.equal(row.profile,'');
});
test('migrated catalogue fixtures pass the same server-side checks',async()=>{
 const catalog=JSON.parse(readFileSync(new URL('../../catalog.json',import.meta.url),'utf8'));
 for(const metadata of catalog.entries){const profile=readFileSync(new URL('../../'+metadata.file,import.meta.url),'utf8');await validateSubmission({metadata,profile})}
});
test('malformed and duplicate ReShade INI is refused before entering queue',async()=>{
 const p=await payload('reshade');for(const profile of ['Techniques=CAS\nnot an option\n','Techniques=CAS\n[CAS]\na=1\na=2\n','Techniques=CAS\n[bad\n'])await assert.rejects(validateSubmission({...p,profile,metadata:{...p.metadata,sha256:await sha256(profile)}}));
});
async function startPair(env,secret='12'.repeat(32)){return call(env,'/v1/pair/start',{method:'POST',data:{secret,name:'BATOCERA Test'}})}
async function approvePair(env,key,code,remember=false){const token=await login(env,key);return {token,result:await call(env,'/v1/pair/approve',{method:'POST',token,data:{code,remember}})}}
test('pairing without remembering requires approval, yields a short session, and cannot manage devices',async()=>{
 const {env,key,sql}=await setup(),secret='12'.repeat(32),started=await startPair(env,secret),code=started.body.code;
 assert.equal(started.status,200);assert.match(code,/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token:secret})).status,401);
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',data:{code,remember:false}})).status,401);
 assert.equal((await call(env,'/v1/pair/poll',{method:'POST',data:{secret:code}})).status,400);
 const master=await login(env,key);
 const inspected=await call(env,'/v1/pair/inspect',{method:'POST',token:master,data:{code}});assert.equal(inspected.body.name,'BATOCERA Test');
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',token:master,data:{code,remember:false}})).status,200);
 const polled=await call(env,'/v1/pair/poll',{method:'POST',data:{secret}});assert.equal(polled.body.status,'approved');assert.equal(polled.body.remember,false);
 assert.ok(polled.body.expires<=Math.floor(Date.now()/1000)+1800);
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token:secret})).status,200);
 assert.equal((await call(env,'/v1/devices',{token:secret})).status,403);
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',token:master,data:{code,remember:false}})).status,410);
 assert.equal(sql.prepare('SELECT count(*) n FROM devices').get().n,0);
 assert.notEqual(sql.prepare('SELECT device_hash FROM pairings').get().device_hash,secret);
});
test('remembered grant creates short sessions; master revocation invalidates all of them',async()=>{
 const {env,key}=await setup(),secret='34'.repeat(32),code=(await startPair(env,secret)).body.code;
 const {token:master,result}=await approvePair(env,key,code,true);assert.equal(result.status,200);
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token:secret})).status,401);
 const a=await call(env,'/v1/device/login',{method:'POST',data:{secret}}),b=await call(env,'/v1/device/login',{method:'POST',data:{secret}});
 assert.equal(a.status,200);assert.notEqual(a.body.token,b.body.token);assert.ok(a.body.expires<=Math.floor(Date.now()/1000)+1800);
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token:a.body.token})).status,200);
 assert.equal((await call(env,'/v1/devices',{token:a.body.token})).status,403);
 const list=await call(env,'/v1/devices',{token:master});assert.equal(list.body.devices.length,1);assert.notEqual(list.body.devices[0].id,secret);
 await call(env,'/v1/devices/revoke',{method:'POST',token:master,data:{id:list.body.devices[0].id}});
 for(const token of [a.body.token,b.body.token])assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).status,401);
 assert.equal((await call(env,'/v1/device/login',{method:'POST',data:{secret}})).status,401);
});
test('cancelling after approval revokes both temporary and remembered access',async()=>{
 for(const remember of [false,true]){
  const {env,key}=await setup(),secret='56'.repeat(32),code=(await startPair(env,secret)).body.code;await approvePair(env,key,code,remember);
  const token=remember?(await call(env,'/v1/device/login',{method:'POST',data:{secret}})).body.token:secret;
  await call(env,'/v1/pair/cancel',{method:'POST',data:{secret}});
  assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).status,401);
  assert.equal((await call(env,'/v1/pair/poll',{method:'POST',data:{secret}})).status,410);
 }
});
test('expired pairings and expired grants cannot authorize access',async()=>{
 const {env,key,sql}=await setup(),secret='78'.repeat(32),code=(await startPair(env,secret)).body.code,master=await login(env,key);
 sql.prepare('UPDATE pairings SET expires=0').run();
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',token:master,data:{code,remember:true}})).status,410);
 assert.equal((await call(env,'/v1/pair/poll',{method:'POST',data:{secret}})).status,410);
 const next='90'.repeat(32),code2=(await startPair(env,next)).body.code;await approvePair(env,key,code2,true);
 const token=(await call(env,'/v1/device/login',{method:'POST',data:{secret:next}})).body.token;sql.prepare('UPDATE devices SET expires=0').run();
 assert.equal((await call(env,'/v1/pending?kind=antimicrox',{token})).status,401);
});
test('failed credential creation rolls back pairing approval atomically',async()=>{
 const {env,key,sql}=await setup(),code=(await startPair(env)).body.code,master=await login(env,key);
 sql.exec("CREATE TRIGGER test_fail BEFORE INSERT ON device_sessions BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',token:master,data:{code,remember:false}})).status,503);
 assert.equal(sql.prepare('SELECT status FROM pairings').get().status,'pending');
 assert.equal(sql.prepare('SELECT count(*) n FROM sessions').get().n,1);
});
test('pairing creation is limited and malformed approval cannot grant access',async()=>{
 const {env,key}=await setup();const code=(await startPair(env)).body.code,master=await login(env,key);
 assert.equal((await call(env,'/v1/pair/approve',{method:'POST',token:master,data:{code,remember:'true'}})).status,400);
 for(let i=1;i<5;i++)await startPair(env,String(i).repeat(64));
 assert.equal((await startPair(env,'ff'.repeat(32))).status,429);
});
test('pairing page has restrictive CSP, no persistent browser key storage, and valid script',async()=>{
 const {env}=await setup();const r=await worker.fetch(new Request('https://example.workers.dev/pair'),env),html=await r.text();
 assert.equal(r.status,200);assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.ok(!html.includes('__NONCE__'));assert.ok(!html.includes('localStorage'));assert.ok(!html.includes('sessionStorage'));assert.ok(!html.includes('innerHTML'));
 const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];new Function(script);
});
test('rerunning schema migration preserves existing proposals',async()=>{
 const {env,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 assert.equal(sql.prepare('SELECT id FROM submissions').get().id,p.metadata.id);
});
test('pairing page browser handlers sign in, inspect, approve, and revoke without persisting key',async()=>{
 const {runInNewContext}=await import('node:vm');const {env}=await setup();
 const html=await (await worker.fetch(new Request('https://example.workers.dev/pair'),env)).text();const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
 const nodes=new Map();function node(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,disabled:false,textContent:'',events:{},children:[],addEventListener(event,fn){this.events[event]=fn},replaceChildren(){this.children=[]},append(...a){this.children.push(...a)}});return nodes.get(id)}
 const requests=[];const replies=[{token:'ab'.repeat(32)},{devices:[]},{code:'K7MP4RXN',name:'BATOCERA',expires:9999999999},{ok:true},{devices:[{id:'cd'.repeat(32),name:'BATOCERA',expires:9999999999}]},{ok:true},{devices:[]}];
 const context={document:{documentElement:{},getElementById:node,querySelectorAll:()=>[],createElement:type=>node(type+Math.random())},navigator:{language:'fr'},window:{addEventListener(){}},confirm:()=>true,fetch:async(path,options)=>{requests.push({path,options});return {ok:true,status:200,json:async()=>replies.shift()}}};
 runInNewContext(script,context);
 async function event(id,type='click'){node(id).events[type]({preventDefault(){},submitter:node(id)});await new Promise(setImmediate);}
 node('key').value='12'.repeat(32);await event('loginForm','submit');assert.equal(node('key').value,'');assert.equal(node('authorized').hidden,false);
 node('code').value='K7MP-4RXN';await event('inspectForm','submit');assert.equal(node('requestName').textContent,'BATOCERA');assert.equal(node('remember').checked,false);
 node('remember').checked=true;await event('approve');assert.ok(requests.some(r=>r.path==='/v1/pair/approve'&&JSON.parse(r.options.body).remember===true));
 const row=node('devices').children[0];assert.ok(row);const revoke=row.children[1];revoke.events.click();await new Promise(setImmediate);
 assert.ok(requests.some(r=>r.path==='/v1/devices/revoke'));assert.equal(node('devices').textContent,'Aucun appareil mémorisé.');
 assert.ok(requests.every(r=>!r.path.includes('12'.repeat(32))));assert.equal(replies.length,0);
});
test('GitHub requests use trimmed token, JSON headers and a portable timeout signal',async()=>{
 const saved=globalThis.fetch;globalThis.fetch=async(_url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer mock-token');assert.equal(options.headers['Content-Type'],'application/json');assert.ok(options.signal instanceof AbortSignal);return Response.json({ok:true});
 };
 try {assert.equal((await github({GITHUB_TOKEN:'  mock-token\n'},'git/trees','POST',{tree:[]})).ok,true);}finally{globalThis.fetch=saved}
});
test('publication exceptions include a safe stage and correlation id but never credentials',async()=>{
 const {env,key,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});const token=await login(env,key);
 const savedFetch=globalThis.fetch,savedLog=console.error,logs=[];const secret='never-publish-this-token';
 globalThis.fetch=async()=>{throw new TypeError('fetch failed '+secret)};console.error=value=>logs.push(value);
 try {
  const r=await call(env,'/v1/submissions/'+p.metadata.id+'/approve',{method:'POST',data:{},token});
  assert.equal(r.status,503);assert.equal(r.body.stage,'github_ref_read');assert.equal(r.body.code,'NETWORK_ERROR');assert.match(r.body.ref,/^[a-f0-9]{8}$/);
  assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(logs).includes(secret));assert.equal(JSON.parse(logs[0]).ref,r.body.ref);
 }finally{globalThis.fetch=savedFetch;console.error=savedLog}
 assert.equal(sql.prepare('SELECT status FROM submissions').get().status,'pending');
});
test('missing publication column is identified before claiming a submission',async()=>{
 const {env,key,sql}=await setup(),p=await payload();await call(env,'/v1/submissions',{method:'POST',data:p});const token=await login(env,key);
 sql.exec('ALTER TABLE submissions DROP COLUMN lease');const saved=console.error;console.error=()=>{};
 try{
  const r=await call(env,'/v1/submissions/'+p.metadata.id+'/approve',{method:'POST',data:{},token});assert.equal(r.status,503);assert.equal(r.body.stage,'d1_publication_claim');assert.equal(r.body.code,'D1_MISSING_COLUMN');
 }finally{console.error=saved}
});
