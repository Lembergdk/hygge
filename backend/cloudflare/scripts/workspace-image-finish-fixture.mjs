// Read-only receipts for exact, already-retired synthetic fixtures. No browser start, migration or rollback.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const ids=['f1be7865-1a4b-435c-a4ca-f8320779308c','46117391-ba70-4ecf-abb1-13efc3bf829e','bb827883-f30e-4dc7-8bd0-7e9cd7d68fbd'];
const owners=ids.map(id=>({id,token:randomBytes(32).toString('base64url'),session:randomUUID()}));
const sql=q=>execFileSync('npx',['wrangler','d1','execute','hygge-staging','-c','wrangler.staging.jsonc','--remote','--command',q],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function state(o){const r=await fetch('https://api-staging.usehygge.app/sandbox/image-upgrade',{headers:{authorization:`Bearer ${o.token}`},signal:AbortSignal.timeout(60000)});assert.equal(r.status,200);const s=await r.json();assert.equal(s.current.lifecycleState,'stopped');return s;}
async function verify(o,s,names){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-finished-fixture-')),prefix=`hygge-workspaces/v1/staging/${o.id}/${s.current.workspaceId}`;
 async function object(key){const file=path.join(folder,randomUUID());execFileSync('npx',['wrangler','r2','object','get',`hygge-workspace-checkpoints-staging/${key}`,'--file',file,'--remote','-c','wrangler.staging.jsonc'],{stdio:['ignore','pipe','pipe']});return fs.readFile(file);}
 try{const point=s.current.recoveryPoint;assert.ok(point);const raw=await object(`${prefix}/manifests/${point.manifestHash}`);assert.equal(hash(raw),point.manifestHash);const manifest=JSON.parse(raw);assert.equal(manifest.userId,o.id);assert.equal(manifest.generation,s.current.generation);assert.ok(manifest.files.some(f=>f.path.startsWith('profile/')));
  for(const name of names){const logical=`upgrade-validation/${s.fixtureMarker}/${name}`,ref=`file_${hash(logical).slice(0,32)}_1`,entry=manifest.files.find(f=>f.path===`artifacts/${ref}`);assert.ok(entry,`Missing ${name}`);const bytes=await object(`${prefix}/blobs/${entry.hash}`);assert.equal(hash(bytes),entry.hash);const expected=name==='source'?`Source ${s.fixtureMarker}`:`Latest ${s.fixtureMarker}. `.repeat(11000);assert.equal(hash(bytes),hash(expected));if(name==='latest')assert.ok(bytes.length>262144);}
 }finally{await fs.rm(folder,{recursive:true,force:true});}
}
try{
 for(const o of owners){console.log(`::add-mask::${o.token}`);const email=`workspace-upgrade-${o.id}@example.invalid`;sql(`INSERT OR IGNORE INTO users (id,do_instance,contact_email) VALUES ('${o.id}','${o.id}','${email}')`);sql(`INSERT INTO auth_sessions (id,user_id,token_hash,created_at,expires_at) SELECT '${o.session}',id,'${hash(o.token)}','${new Date().toISOString()}','${new Date(Date.now()+3600000).toISOString()}' FROM users WHERE id='${o.id}' AND contact_email='${email}'`);}
 const [a,b,c]=owners,sa=await state(a),sb=await state(b),sc=await state(c);
 assert.equal(sa.current.generation,2);assert.ok(sa.current.desiredImageDigest.endsWith('1c7dcb73cd6ddd7bf9bea12fdbb8b4a7d6498bf87d95a772434797562f95b5f9'));assert.ok(sa.operations.some(op=>op.phase==='verified'));await verify(a,sa,['source']);console.log('STAGING actual upgrade and preserved source/profile checkpoint integrity PASS');
 assert.equal(sb.current.generation,1);assert.ok(sb.current.desiredImageDigest.endsWith('ae26f5d92b203d94f18bc13f1c121975459053c3b34d9ee2ea664d68f01d55ff'));console.log('STAGING second-owner original image/generation isolation PASS');
 // The earlier canary completed its large write before live rollback testing was stopped.
 // Read that existing immutable receipt; do not repeat the write or any transition.
 await verify(c,sc,['source','latest']);console.log('STAGING earlier canary large-file durability receipt PASS');
 console.log('STAGING all synthetic containers already retired PASS; no rollback test or migration performed');
}finally{for(const o of owners)sql(`DELETE FROM auth_sessions WHERE user_id='${o.id}'; DELETE FROM users WHERE id='${o.id}' AND contact_email='workspace-upgrade-${o.id}@example.invalid'`);console.log('STAGING synthetic authentication cleanup PASS');}
