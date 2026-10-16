import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {sha256,validateSubmission,publish,cleanup} from '../src/worker.js';

async function setup() {
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const DB={prepare(q){return {bind(...a){const s=sql.prepare(q);return {
 async first(){return s.get(...a)||null},async all(){return {results:s.all(...a)}},async run(){return {meta:{changes:Number(s.run(...a).changes)}}}
 }}}},async batch(items){return Promise.all(items.map(i=>i.run()))}};
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
