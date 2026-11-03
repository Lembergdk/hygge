import {test} from 'node:test';import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';import {WorkspacePersistence} from '../src/workspace-persistence.ts';
import {createWorkspaceAdoption,type LegacyAdoptionDriver} from '../src/workspace-adoption.ts';
import type {WorkspaceDurabilityReceipt} from '../src/workspace-contract.ts';
const owner={environment:'staging' as const,userId:'alice',workspaceId:'workspace'};
function fixture(){
 const f=sqliteWorkspace(),db=new WorkspacePersistence(f.storage,owner),events:string[]=[];
 f.sqlite.exec("CREATE TABLE credentials (id TEXT PRIMARY KEY,domain TEXT NOT NULL,username TEXT NOT NULL,iv TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));INSERT INTO credentials VALUES ('cred','jobs.example','private-user','iv','ciphertext','date');CREATE TABLE memories (id TEXT PRIMARY KEY,hints TEXT);INSERT INTO memories VALUES ('m','private-hints');CREATE TABLE tasks (id TEXT PRIMARY KEY,task TEXT NOT NULL);INSERT INTO tasks VALUES ('task','{\"status\":\"needsHuman\",\"session_id\":\"session-old\"}');CREATE TABLE session_profiles (domain TEXT PRIMARY KEY,has_profile INTEGER,profile_iv TEXT,profile_ct TEXT);INSERT INTO session_profiles VALUES ('jobs.example',1,'sealed-iv','sealed-profile');");
 let key=true,profileSupported=true,quiescent=false,retired=false,currentRevision=5;
 const receipt:WorkspaceDurabilityReceipt={...owner,receiptId:'verified-final',writeId:'final',incarnation:'legacy-inc',generation:1,filesystemRevision:3,browserProfileRevision:2,coveredArtifactRefs:['preserved-files','profile'],committedAt:'2026-11-02',recoveryPoint:{...owner,checkpointId:'checkpoint',sequence:3,sourceIncarnation:'legacy-inc',sourceGeneration:1,manifestHash:'b'.repeat(64),storage:'r2',policyVersion:'1'}};
 const driver:LegacyAdoptionDriver={
  async sourceExecution(){return{runtimeId:'legacy-runtime',incarnation:'legacy-inc',generation:1,sourceRevision:5};},async legacySnapshotId(){return'old-snapshot';},async verifyKeyContinuity(){events.push('keys');return key;},async verifyLegacyProfiles(){return true;},
  async prepareTarget(){events.push('prepare');return true;},async copyOwnerProvenFiles(){events.push('copy');},async verifyCopiedFiles(){events.push('verify-copy');return true;},
  async quiesceLegacy(){events.push('quiesce');quiescent=true;},async captureFinal(){events.push('capture');return receipt;},async verifyProfileTransition(){events.push('profile-proof');return profileSupported;},
  async retireLegacy(){events.push('retire');retired=true;return{...owner,provider:'cloudflare',previousRuntimeId:'legacy-runtime',previousIncarnation:'legacy-inc',previousGeneration:1,browserRetired:true,providerRuntimeId:'provider-legacy',result:'exact_incarnation_stopped',verifiedAt:'2026-11-02',providerRequestIds:['retire']};},async restoreAndVerify(){events.push('restore');return{generation:2,checkpointId:'checkpoint'};},
  proofs:{assertQuiescent(){if(!quiescent)throw Error('NOT_QUIESCENT');},assertFence(){if(!retired)throw Error('FENCE_UNCONFIRMED');},assertLatestSourceRevision(rev){if(rev!==currentRevision)throw Error('SOURCE_ADVANCED');},assertCurrentCapture(){if(!quiescent)throw Error('NO_FREEZE');}},
 };
 const adoption=createWorkspaceAdoption({owner,storage:f.storage,db,driver,credentialPolicy:{verifyCurrentCiphertext:async()=>true,resolveLegacy:async()=>null},verifyDurability:async id=>{if(id!==receipt.receiptId)throw Error('UNVERIFIED');return receipt;}});
 return{...f,db,driver,adoption,receipt,events,setKey:(v:boolean)=>key=v,setProfiles:(v:boolean)=>profileSupported=v,setRevision:(v:number)=>currentRevision=v};
}
test('Actual populated DO inventory and adoption preserve ciphertext, memory, original profile and task IDs',async()=>{
 const f=fixture();const inv=await f.adoption.inventory();assert.equal(inv.credentialSchema,'current');assert.equal(inv.tableCounts.credentials,1);assert.deepEqual(inv.sessionIds,['session-old']);assert.deepEqual(inv.legacyProfileDomains,['jobs.example']);assert.equal(JSON.stringify(inv).includes('ciphertext'),false);assert.equal(JSON.stringify(inv).includes('sealed-profile'),false);
 const result=await f.adoption.adopt('migration');assert.equal(result.phase,'active');assert.equal(f.adoption.legacyProfilesReadOnly(),true);assert.ok(f.events.indexOf('capture')<f.events.indexOf('retire'));assert.ok(f.events.indexOf('retire')<f.events.indexOf('restore'));
 assert.equal(f.sqlite.prepare('SELECT ciphertext FROM credentials').get()!.ciphertext,'ciphertext');assert.equal(f.sqlite.prepare('SELECT hints FROM memories').get()!.hints,'private-hints');assert.equal(f.sqlite.prepare('SELECT profile_ct FROM session_profiles').get()!.profile_ct,'sealed-profile');assert.equal(f.sqlite.prepare('SELECT id FROM tasks').get()!.id,'task');
 const before=f.events.length;assert.equal((await f.adoption.adopt('migration')).phase,'active');assert.equal(f.events.length,before);f.sqlite.close();
});
test('Missing key blocks before copy, retirement or any profile read-only marker',async()=>{
 const f=fixture();f.setKey(false);await assert.rejects(f.adoption.adopt('migration'),/KEY_MISMATCH/);assert.equal(f.events.includes('copy'),false);assert.equal(f.adoption.status(),null);assert.equal(f.adoption.legacyProfilesReadOnly(),false);assert.equal(f.sqlite.prepare('SELECT profile_ct FROM session_profiles').get()!.profile_ct,'sealed-profile');f.sqlite.close();
});
test('Unproven full-profile transition blocks with original encrypted profiles writable and no retirement/reset',async()=>{
 const f=fixture();f.setProfiles(false);await assert.rejects(f.adoption.adopt('migration'),/FULL_PROFILE_TRANSITION_UNPROVEN/);assert.equal(f.adoption.status()!.phase,'quiescing');assert.equal(f.events.includes('retire'),false);assert.equal(f.adoption.legacyProfilesReadOnly(),false);assert.equal(f.sqlite.prepare('SELECT profile_ct FROM session_profiles').get()!.profile_ct,'sealed-profile');
 f.setProfiles(true);assert.equal((await f.adoption.adopt('migration')).phase,'active');assert.equal(f.adoption.legacyProfilesReadOnly(),true);f.sqlite.close();
});
test('New source writes after inventory cannot be discarded by final capture or cutover',async()=>{
 const f=fixture();f.setRevision(6);await assert.rejects(f.adoption.adopt('migration'),/SOURCE_ADVANCED/);assert.equal(f.events.includes('retire'),false);assert.equal(f.adoption.legacyProfilesReadOnly(),false);assert.equal(f.sqlite.prepare('SELECT hints FROM memories').get()!.hints,'private-hints');f.sqlite.close();
});
test('Root current legacy driver with no actual source execution identity cannot mint an empty adoption',async()=>{
 const f=fixture();f.driver.sourceExecution=async()=>({runtimeId:'',incarnation:'',generation:0,sourceRevision:0});await assert.rejects(f.adoption.adopt('migration'),/LEGACY_EXECUTION_IDENTITY_UNVERIFIED/);assert.equal(f.events.length,0);assert.equal(f.adoption.status(),null);f.sqlite.close();
});
