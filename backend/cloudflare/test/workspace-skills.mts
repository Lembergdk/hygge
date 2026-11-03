import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';
import {WorkspacePersistence, type RuntimeAuthority} from '../src/workspace-persistence.ts';
import {EffectLedger} from '../src/effect-ledger.ts';
import {CheckpointService} from '../src/runtime-checkpoints.ts';
import {createWorkspaceSkills} from '../src/workspace-skills.ts';
import {loadReviewedSkillRegistry} from '../src/skill-registry.ts';
import {SKILL_POLICY_VERSION} from '../src/skill-contract.ts';
import {skillDigest} from '../src/skill-policy.ts';
import {handleWorkspaceSkillRequest} from '../src/skill-routes.ts';
import {auditLegacySkillLibrary} from '../src/skill-legacy-audit.ts';
import {candidateFromReviewedTrace} from '../src/skill-trace.ts';
import type {RuntimeLease,WorkspaceDurabilityReceipt,WorkspaceIdentity} from '../src/workspace-contract.ts';

const now=Date.parse('2026-11-03T00:00:00.000Z'), secret=new Uint8Array(32).fill(55);
const config={schemaVersion:1,sites:[{siteId:'jobs',origin:'https://jobs.example.com',routes:{home:'/'},controls:['search'],fieldSets:['listings'],pitfalls:[],review:{policyVersion:SKILL_POLICY_VERSION,reviewedRevision:'review1',source:'developer_review'}}]};
const body={schemaVersion:2 as const,siteId:'jobs',outcome:'discover' as const,steps:[{op:'navigate' as const,routeId:'home'},{op:'extract' as const,fieldSetId:'listings'}],pitfalls:[]};
class SqliteD1{
  sql=new DatabaseSync(':memory:');
  constructor(){this.sql.exec('PRAGMA foreign_keys=ON');this.sql.exec(readFileSync(new URL('../migrations/0008_shared_skills_v2.sql',import.meta.url),'utf8'));}
  prepare(sql:string){const db=this.sql;const s={sql,values:[] as unknown[],bind(...values:unknown[]){return {...s,values};},async first<T>(){return (db.prepare(sql).get(...this.values as any[])??null) as T|null;}};return s;}
  async batch(statements:any[]){this.sql.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>({results:this.sql.prepare(s.sql).all(...s.values)}));this.sql.exec('COMMIT');return results;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
function fixture(d1=new SqliteD1(),userId='private-user-a',registryConfig:unknown=config){
  const f=sqliteWorkspace(),owner:WorkspaceIdentity={environment:'staging',userId,workspaceId:userId+'-workspace'};
  const db=new WorkspacePersistence(f.storage,owner);let generation=1,alive=true,durable=true;
  const lease=():RuntimeLease=>({...owner,runtimeId:'runtime-'+generation,incarnation:'incarnation-'+generation,generation,leaseId:'lease',expiresAt:'2099-01-01T00:00:00Z'});
  const authority:RuntimeAuthority={async authorize(token){if(token!=='valid'||!alive)throw new Error('UNAUTHORIZED');return lease();},assertCurrent(l){if(!alive||l.generation!==generation)throw new Error('STALE_GENERATION');}};
  const effects=new EffectLedger(db,authority,{assertDispatchAllowed(){}},async()=>true);
  const proofs=new Map<string,WorkspaceDurabilityReceipt>();
  const checkpoints=new CheckpointService(db,authority,effects,async(o,id)=>{const r=proofs.get(id);if(!durable||!r||JSON.stringify(o)!==JSON.stringify(owner))throw new Error('DURABILITY');return r;},async(_run,input)=>input.verification.evidenceRef==='evidence',()=>new Date(now).toISOString());
  const skills=createWorkspaceSkills({owner,persistence:db,authority,completions:checkpoints,sharedDatabase:d1,registryConfig,secret,
    async loadPrivateContext(taskId){return {knownValues:['Synthetic Personal Context',taskId],requiredArtifactRefs:['candidate','context']};},
    async maintainerAuthorize(token){return token==='maintainer';},now:()=>now});
  const ctx=(requestId:string,expectedRevision:number)=>({requestId,expectedRevision,capabilityToken:'valid'});
  async function finish(i:number,hash:string|null|undefined=undefined,runId='run'+i){
    if(hash===undefined)hash=await skillDigest(body);
    const taskId='task'+i;if(!db.get('run',runId))await checkpoints.startRun(ctx('start'+i,0),{taskId,runId,siteOrigin:'https://jobs.example.com',outcome:'discover',candidate:hash===null?{kind:'ordinary'}:{kind:'confirming',bodyHash:hash}});
    const proof:WorkspaceDurabilityReceipt={...owner,receiptId:'durable'+i,writeId:'write'+i,generation,incarnation:lease().incarnation,filesystemRevision:i,browserProfileRevision:0,coveredArtifactRefs:['candidate','context','evidence'],committedAt:new Date(now).toISOString(),
      recoveryPoint:{...owner,checkpointId:'checkpoint'+i,sequence:i,sourceIncarnation:lease().incarnation,sourceGeneration:generation,manifestHash:'a'.repeat(64),storage:'r2',policyVersion:'1'}};
    proofs.set(proof.receiptId,proof);
    return checkpoints.complete(ctx('finish'+i,1),{runId,checkpoint:{...owner,schemaVersion:1,taskId,runId,filesystemRevision:i,browserProfileRevision:0,workspaceDurabilityReceiptId:proof.receiptId,privateArtifactRefs:['candidate','context'],helpId:null},candidateBodyHash:hash,verification:{kind:'observed_postcondition',policyVersion:'1',evidenceRef:'evidence'}});
  }
  async function ready(){await skills.recordCandidate(ctx('candidate',0),{candidateId:'candidate-a',taskId:'authoring',body});let revision=1;for(let i=1;i<=3;i++){const r=await finish(i);const result=await skills.recordOutcome(ctx('outcome'+i,revision),{candidateId:'candidate-a',receiptId:r.receiptId});revision=result.revision;}return skills.publishCandidate('valid','candidate-a');}
  return {...f,d1,db,owner,authority,skills,checkpoints,effects,ctx,finish,ready,setAlive(v:boolean){alive=v;},nextGeneration(){generation++;},setDurable(v:boolean){durable=v;}};
}
test('owner SQLite candidate -> canonical C receipts -> real HMAC publisher -> other user safe advisory reuse',async()=>{
  const a=fixture(),b=fixture(a.d1,'private-user-b');
  try{
    const published=await a.ready();assert.equal(published.status,'published');
    const selection=await b.skills.resolve('https://jobs.example.com','discover');assert.ok(selection);
    assert.equal(selection.skill.body.steps[0],'Inspect the public https://jobs.example.com/ entry point.');
    assert.equal(selection.skill.status,'active');assert.ok(selection.skill.body.notes.includes('Advisory only'));
    assert.equal((await b.skills.publishCandidate('valid','candidate-a')).status,'held');
    const shared=JSON.stringify(a.d1.sql.prepare('SELECT * FROM public_skills_v2').all());
    for(const value of ['Synthetic Personal Context','private-user-a','private-user-b','authoring','durable1','context'])assert.equal(shared.includes(value),false,value);
    assert.ok(JSON.stringify(a.db.list('private_skill_candidate')).includes('Synthetic Personal Context'));
    // Replacement does not invalidate immutable canonical completion evidence.
    a.nextGeneration();assert.equal((await a.skills.publishCandidate('valid','candidate-a')).status,'existing');
  }finally{a.sqlite.close();b.sqlite.close();a.d1.sql.close();}
});
test('candidate revisions/immutable bodies and canonical evidence cannot be forged or duplicated',async()=>{
  const f=fixture();try{
    const first=await f.skills.recordCandidate(f.ctx('candidate',0),{candidateId:'candidate-a',taskId:'authoring',body});
    assert.deepEqual(await f.skills.recordCandidate(f.ctx('candidate',0),{candidateId:'candidate-a',taskId:'authoring',body}),first);
    await assert.rejects(f.skills.recordCandidate(f.ctx('changed',0),{candidateId:'candidate-a',taskId:'authoring',body:{...body,steps:[{op:'complete',outcome:'discover'}]}}),/CANDIDATE_IMMUTABLE/);
    assert.equal((await f.skills.publishCandidate('valid','candidate-a')).status,'held');
    const r=await f.finish(1);
    const outcome=await f.skills.recordOutcome(f.ctx('outcome',1),{candidateId:'candidate-a',receiptId:r.receiptId});assert.equal(outcome.distinctRuns,1);
    const duplicate=await f.skills.recordOutcome(f.ctx('duplicate',2),{candidateId:'candidate-a',receiptId:r.receiptId});assert.equal(duplicate.distinctRuns,1);
    await assert.rejects(f.skills.recordOutcome(f.ctx('fake',3),{candidateId:'candidate-a',receiptId:'model-made-up-receipt'}),/RECEIPT_MISSING/);
    const ordinary=await f.finish(2,null);await assert.rejects(f.skills.recordOutcome(f.ctx('ordinary',3),{candidateId:'candidate-a',receiptId:ordinary.receiptId}),/EVIDENCE_INVALID/);
    const r3=await f.finish(3);f.setDurable(false);await assert.rejects(f.skills.recordOutcome(f.ctx('undurable',3),{candidateId:'candidate-a',receiptId:r3.receiptId}),/EVIDENCE_NOT_DURABLE/);
    f.setAlive(false);await assert.rejects(f.skills.publishCandidate('valid','candidate-a'),/UNAUTHORIZED/);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('admission consumption requires current canonical dispatch effect and quarantines deny cached use',async()=>{
  const f=fixture();try{const pub=await f.ready();assert.ok('skillId'in pub);const selection=await f.skills.resolve('https://jobs.example.com','discover');assert.ok(selection);
    await f.checkpoints.startRun(f.ctx('begin-effect-run',0),{taskId:'effecttask',runId:'effectrun',siteOrigin:'https://jobs.example.com',outcome:'discover',candidate:{kind:'ordinary'}});
    await f.effects.prepare(f.ctx('prepare-effect',0),{effectId:'effect',taskId:'effecttask',runId:'effectrun',intentHash:'private-semantic-intent',approvalId:null,approvalScopeHash:null});
    const admission=await f.skills.admit('valid',{admissionId:'admission',skillId:selection.skillId,version:selection.version,epoch:selection.epoch,taskId:'effecttask'});assert.ok(admission);
    assert.equal(await f.skills.consume('valid',{admissionId:'admission',effectId:'effect',taskId:'effecttask'}),false);
    await f.effects.dispatch(f.ctx('dispatch-effect',1),'effect');
    assert.equal(await f.skills.consume('valid',{admissionId:'admission',effectId:'effect',taskId:'effecttask'}),true);
    const binding=String(f.d1.sql.prepare('SELECT consumed_by FROM skill_admissions_v2').get()!.consumed_by);assert.match(binding,/^[a-f0-9]{64}$/);assert.equal(binding.includes('private-semantic-intent'),false);
    assert.equal(await f.skills.quarantine('not-maintainer',{operationId:'bad-q',skillId:pub.skillId,reason:'privacy'}),false);
    assert.equal(await f.skills.quarantine('maintainer',{operationId:'good-q',skillId:pub.skillId,reason:'privacy'}),true);
    assert.equal(await f.skills.resolve('https://jobs.example.com','discover'),null);
    assert.equal(await f.skills.admit('valid',{admissionId:'new',skillId:selection.skillId,version:selection.version,epoch:selection.epoch,taskId:'effecttask'}),null);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('missing registry fails closed and owner route helper exposes no signing or context inputs',async()=>{
  const f=fixture(undefined,'private-user-a',undefined);try{
    // Explicit absence differs from fixture default.
    const noRegistry=createWorkspaceSkills({owner:f.owner,persistence:f.db,authority:f.authority,completions:f.checkpoints,sharedDatabase:f.d1,secret,async loadPrivateContext(){return {knownValues:[],requiredArtifactRefs:['context']};},now:()=>now});
    assert.equal(await noRegistry.resolve('https://jobs.example.com','discover'),null);
    await assert.rejects(noRegistry.recordCandidate(f.ctx('no-registry',0),{candidateId:'candidate',taskId:'task',body}),/UNKNOWN_SITE/);
    const r=await handleWorkspaceSkillRequest(new Request('https://api.test/workspace/skills/candidate',{method:'POST',headers:{'x-hygge-runtime-capability':'valid'},body:JSON.stringify({requestId:'request',expectedRevision:0,candidateId:'candidate',taskId:'task',body,privateKnownValues:['forged']})}),f.skills);
    assert.equal(r.status,409);assert.equal((await r.text()).includes('forged'),false);
    const signed=await handleWorkspaceSkillRequest(new Request('https://api.test/workspace/skills/sign',{method:'POST',headers:{'x-hygge-runtime-capability':'valid'},body:'{}'}),f.skills);assert.equal(signed.status,404);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('legacy audit returns redacted dry-run plan and never modifies legacy/private/shared data',async()=>{
  const f=fixture();try{
    f.d1.sql.exec('CREATE TABLE skills(id TEXT,site TEXT,outcome TEXT,version INTEGER,status TEXT,body TEXT)');
    const original=JSON.stringify({summary:'Synthetic Private Person',steps:['https://jobs.example.com/private?invite=short']});
    f.d1.sql.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?)').run('legacy-private-id','jobs.example.com','discover',1,'active',original);
    const result=await auditLegacySkillLibrary(f.d1,loadReviewedSkillRegistry(config));
    assert.equal(result.dryRun,true);assert.equal(result.mutations,0);assert.equal(result.entries[0].action,'hold_for_review');
    for(const value of ['Synthetic Private Person','invite=short','legacy-private-id'])assert.equal(JSON.stringify(result).includes(value),false);
    assert.equal(f.d1.sql.prepare('SELECT body FROM skills').get()!.body,original);assert.equal(f.d1.sql.prepare('SELECT COUNT(*) n FROM public_skills_v2').get()!.n,0);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('verified ordinary trace authors private candidate; only next three predeclared runs corroborate',async()=>{
  const f=fixture();try{
    const ordinary=await f.finish(0,null);
    const trace=[{action:'navigate',succeeded:true,urlString:'https://jobs.example.com/'},{action:'extract',succeeded:true,fieldSetId:'listings'},{action:'done',succeeded:true}];
    const result=await f.skills.captureTraceCandidate(f.ctx('trace-candidate',0),{candidateId:'trace-candidate',receiptId:ordinary.receiptId,trace});assert.equal(result.status,'candidate');
    const candidate=await f.skills.candidateForTask('https://jobs.example.com','discover');assert.ok(candidate);assert.equal(candidate.candidateId,'trace-candidate');assert.equal(candidate.body.steps.length,3);
    assert.equal((await f.skills.publishCandidate('valid','trace-candidate')).status,'held');
    await assert.rejects(f.skills.recordOutcome(f.ctx('no-author-credit',1),{candidateId:'trace-candidate',receiptId:ordinary.receiptId}),/EVIDENCE_INVALID/);
    for(let i=1;i<=3;i++){const r=await f.finish(i,candidate.candidateBodyHash);const count=await f.skills.recordOutcome(f.ctx('trace-outcome'+i,i),{candidateId:'trace-candidate',receiptId:r.receiptId});assert.equal(count.distinctRuns,i);}
    assert.equal((await f.skills.publishCandidate('valid','trace-candidate')).status,'published');
    assert.equal(f.d1.sql.prepare('SELECT source_run_count FROM public_skills_v2').get()!.source_run_count,3);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('unknown whole trajectories are held, never generalized from personal labels or URLs',async()=>{
  const f=fixture();try{const r=await f.finish(0,null);
    for(const trace of [
      [{action:'navigate',succeeded:true,urlString:'https://jobs.example.com/people/PrivatePerson?invite=short'}],
      [{action:'click',succeeded:true,target:'PrivatePerson'}],
      [{action:'type',succeeded:true,target:'search'}],
      [{action:'extract',succeeded:true,fieldSetId:'listings'},{action:'click',succeeded:false,target:'PrivatePerson'}],
    ]){const result=await f.skills.captureTraceCandidate(f.ctx('unknown'+Math.random(),0),{candidateId:'held',receiptId:r.receiptId,trace});assert.equal(result.status,'held');}
    assert.equal(f.db.list('private_skill_candidate').length,0);assert.equal(f.d1.sql.prepare('SELECT COUNT(*) n FROM public_skills_v2').get()!.n,0);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('canonical successful usage requires actual selected-skill pin and deduplicates receipts',async()=>{
  const f=fixture();try{const p=await f.ready();assert.ok('skillId'in p);
    await f.checkpoints.startRun(f.ctx('start9',0),{taskId:'task9',runId:'run9',siteOrigin:'https://jobs.example.com',outcome:'discover',candidate:{kind:'ordinary'}});
    const selection=await f.skills.pinRunSkill(f.ctx('pin9',0),{taskId:'task9',runId:'run9',skillId:p.skillId});assert.equal(selection.skillId,p.skillId);
    const r=await f.finish(9,null);assert.equal(await f.skills.usage('valid',{skillId:p.skillId,receiptId:r.receiptId}),true);
    assert.equal(await f.skills.usage('valid',{skillId:p.skillId,receiptId:r.receiptId}),true);
    assert.equal(f.d1.sql.prepare('SELECT source_run_count FROM public_skills_v2').get()!.source_run_count,4);
    const unpinned=await f.finish(10,null);assert.equal(await f.skills.usage('valid',{skillId:p.skillId,receiptId:unpinned.receiptId}),false);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
test('trace reference conversion is exact whitelisted identifiers, never values or arbitrary draft paths',()=>{
  const registry=loadReviewedSkillRegistry(config);
  for(const [ref,expected] of Object.entries({'draft.email':'profile.email','draft.name':'profile.displayName','draft.displayName':'profile.displayName','draft.location':'profile.location','draft.searchTerms':'search.terms','draft.rate':'search.rate','draft.coverLetter':'application.coverLetter'})){
    const mapped=candidateFromReviewedTrace('https://jobs.example.com','discover',[{action:'type',succeeded:true,target:'search',valueRef:ref}],registry);
    assert.ok(mapped);assert.equal((mapped.steps[0] as any).valueRef,expected);
  }
  for(const ref of ['draft.password','draft.privateBiography','a literal personal value','draft.email.extra'])assert.equal(candidateFromReviewedTrace('https://jobs.example.com','discover',[{action:'type',succeeded:true,target:'search',valueRef:ref}],registry),null);
});
test('trace conversion uses the actual browser operation and holds unreviewed operations private',()=>{
  const registry=loadReviewedSkillRegistry(config);
  // Old-client aliases must not launder hover/check/press/select into click/fill steps.
  for(const browserAction of ['hover','check','press','select','scroll','back','forward','wait'])
    assert.equal(candidateFromReviewedTrace('https://jobs.example.com','discover',[{action:'click',browserAction,succeeded:true,target:'search'} as any],registry),null,browserAction);
  // Ephemeral DOM references are never shared control identifiers.
  assert.equal(candidateFromReviewedTrace('https://jobs.example.com','discover',[{action:'click',browserAction:'click',succeeded:true,target:'Search jobs',targetRef:'e1-doc-9'} as any],registry),null);
  // Reviewed operations still convert when recorded with their actual action.
  const mapped=candidateFromReviewedTrace('https://jobs.example.com','discover',[{action:'type',browserAction:'type',succeeded:true,target:'search',targetRef:'e1-doc-1',valueRef:'draft.searchTerms'} as any],registry);
  assert.ok(mapped);assert.equal((mapped.steps[0] as any).op,'fill');
});
test('local audit CLI opens readonly, emits no private body and preserves database bytes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'hygge-skill-audit-'));
  try{
    const file=join(directory,'legacy.sqlite');const db=new DatabaseSync(file);
    db.exec('CREATE TABLE skills(id TEXT,site TEXT,outcome TEXT,version INTEGER,status TEXT,body TEXT)');
    db.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?)').run('private-id','jobs.example.com','discover',1,'active','Synthetic Confidential Body');db.close();
    const original=readFileSync(file);
    const result=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../scripts/audit-legacy-skills.mjs',import.meta.url)),file],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.includes('Synthetic Confidential Body'),false);assert.equal(result.stdout.includes('private-id'),false);
    assert.equal(JSON.parse(result.stdout).mutations,0);assert.deepEqual(readFileSync(file),original);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('a second owner cannot revive quarantined shared content through an unmapped private candidate',async()=>{
  const a=fixture(),b=fixture(a.d1,'private-user-b');
  try{
    await b.skills.recordCandidate(b.ctx('private-b',0),{candidateId:'private-b',taskId:'author-b',body});
    assert.ok(await b.skills.candidateForTask('https://jobs.example.com','discover'),'unpublished private body is eligible');
    const publication=await a.ready();assert.ok('skillId'in publication);
    assert.ok(await b.skills.candidateForTask('https://jobs.example.com','discover'),'matching validated active publication stays eligible');
    assert.equal(b.db.get('private_skill_publication_state','private-b'),null,'B never published and has no mapping');
    await a.skills.quarantine('maintainer',{operationId:'cross-owner-quarantine',skillId:publication.skillId,reason:'privacy'});
    assert.equal(await b.skills.resolve('https://jobs.example.com','discover'),null);
    assert.equal(await b.skills.candidateForTask('https://jobs.example.com','discover'),null);
    assert.equal(a.d1.sql.prepare('SELECT status FROM public_skills_v2').get()!.status,'quarantined');
  }finally{a.sqlite.close();b.sqlite.close();a.d1.sql.close();}
});
test('private fallback fails closed when shared body status cannot be checked',async()=>{
  const f=fixture();try{
    await f.skills.recordCandidate(f.ctx('private-candidate',0),{candidateId:'private',taskId:'author',body});
    assert.ok(await f.skills.candidateForTask('https://jobs.example.com','discover'));
    f.d1.sql.exec('DROP TABLE skill_publications_v2; DROP TABLE skill_usage_v2; DROP TABLE skill_quarantines_v2; DROP TABLE skill_admissions_v2; DROP TABLE public_skills_v2;');
    assert.equal(await f.skills.candidateForTask('https://jobs.example.com','discover'),null);
  }finally{f.sqlite.close();f.d1.sql.close();}
});
