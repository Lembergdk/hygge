import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../package.json',import.meta.url));
const {build}=require('esbuild');const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'hygge-router-smoke-'));
const seed=`import {DurableObject} from 'cloudflare:workers';
export class UserSandbox extends DurableObject {
 async fetch(request){
  if(new URL(request.url).pathname==='/seed')this.ctx.storage.sql.exec(\`CREATE TABLE credentials(site_id TEXT PRIMARY KEY, username TEXT, iv TEXT, ciphertext TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO credentials(site_id,username,iv,ciphertext) VALUES('fixture-site','synthetic@example.invalid','fixture-iv','fixture-ciphertext');
  CREATE TABLE memories(id TEXT PRIMARY KEY,domain TEXT NOT NULL,kind TEXT NOT NULL,hints TEXT NOT NULL DEFAULT '[]',success_count INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(domain,kind));
  INSERT INTO memories(id,domain,kind) VALUES('fixture-memory','jobs.example','signup');
  CREATE TABLE tasks(id TEXT PRIMARY KEY,task TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO tasks(id,task) VALUES('legacy-task','{"id":"legacy-task","status":"needsHuman","session_id":"legacy-session"}');\`);
  return Response.json({credentials:[...this.ctx.storage.sql.exec('SELECT site_id FROM credentials')].length,memories:[...this.ctx.storage.sql.exec('SELECT id FROM memories')].length,tasks:[...this.ctx.storage.sql.exec('SELECT id FROM tasks')].length});
 }
}
export default{fetch(request,env){return env.USER_SANDBOX.get(env.USER_SANDBOX.idFromName('legacy-owner')).fetch(request);}};`;
let mf;
function instance(script){return new Miniflare(convertV4MiniflareOptions({name:'hygge-router-smoke',modules:true,script,compatibilityDate:'2026-10-30',compatibilityFlags:['nodejs_compat'],durableObjects:{USER_SANDBOX:{className:'UserSandbox',useSQLite:true}},resourcePersistencePath:join(dir,'resources'),d1Databases:['DB'],serviceBindings:{BROWSER:()=>new Response('unused', {status:503})},bindings:{HYGGE_ENV:'staging',HYGGE_DEV_TOKENS:JSON.stringify({'fixture-a':'alice','fixture-b':'bob','fixture-legacy':'legacy-owner'})}}));}
try{
 mf=instance(seed);assert.equal((await mf.dispatchFetch('https://fixture.invalid/seed')).status,200);await mf.dispose();mf=null;
 const out=join(dir,'worker.mjs');await build({entryPoints:[join(root,'src/index.ts')],outfile:out,bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers','node:*'],conditions:['workerd','worker','browser']});
 const app=await readFile(out,'utf8');mf=instance(app);
 const request=(token,path,init={})=>mf.dispatchFetch('https://fixture.invalid'+path,{...init,headers:{authorization:'Bearer '+token,'content-type':'application/json',...init.headers}});
 const created=await request('fixture-a','/tasks',{method:'POST',body:JSON.stringify({kind:'discover',target_url:'https://jobs.example',goal:'synthetic private goal'})});assert.equal(created.status,201);const own=await created.json();
 assert.equal((await (await request('fixture-b','/tasks')).json()).tasks.length,0);
 const spoof=await request('fixture-a','/tasks',{headers:{'x-hygge-user-id':'bob'}});assert.equal((await spoof.json()).tasks[0].id,own.id);
 assert.equal((await request('fixture-legacy','/tasks')).status,409);
 await mf.dispose();mf=null;mf=instance(app);
 assert.equal((await (await request('fixture-a','/tasks')).json()).tasks[0].id,own.id);
 assert.equal((await (await request('fixture-b','/tasks')).json()).tasks.length,0);
 await mf.dispose();mf=null;mf=instance(seed);
 const preserved=await (await mf.dispatchFetch('https://fixture.invalid/inspect')).json();assert.deepEqual(preserved,{credentials:1,memories:1,tasks:1});
 console.log(JSON.stringify({ok:true,authenticatedOwnerRouting:true,spoofedOwnerHeaderOverwritten:true,doRestartPreservedTask:true,legacyRecoveryBlockedWithoutDeletion:preserved,compatibilityDate:'2026-10-30',providerAcceptance:false}));
}finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
