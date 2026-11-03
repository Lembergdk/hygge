import type { WorkspaceIdentity, WorkspaceDurabilityReceipt, RuntimeFenceEvidence } from './workspace-contract.ts';
import { WorkspacePersistence, digest, fail, sameOwner, type WorkspaceStorage } from './workspace-persistence.ts';
import { WorkspaceMigration, type AdoptionAuthority } from './workspace-migration.ts';
import { migrateCredentialSchema, type CredentialMigrationPolicy } from './schema-migrations.ts';
import { STATE_TABLES } from './state.ts';

export interface LegacyExecutionIdentity { runtimeId:string;incarnation:string;generation:number;sourceRevision:number }
export interface WorkspaceAdoptionInventory extends WorkspaceIdentity {
  schemaVersion:1;
  credentialSchema:'absent'|'current'|'legacy'|'unknown';
  tableCounts:Readonly<Record<string,number>>;
  activeTaskIds:readonly string[];
  sessionIds:readonly string[];
  legacyProfileDomains:readonly string[];
  legacySnapshotId:string|null;
  source:LegacyExecutionIdentity;
  inventoryHash:string;
}
const protectedTables=[...new Set([...Object.values(STATE_TABLES),'credentials','memories','profile_photo','email_codes','email_summaries','session_profiles','tasks','site_memory','approvals'])];
/** Private inventory only: never returns raw task bodies, ciphertext, cookies or keys. */
export async function inventoryWorkspaceAdoption(storage:WorkspaceStorage,owner:WorkspaceIdentity,source:LegacyExecutionIdentity,legacySnapshotId:string|null):Promise<WorkspaceAdoptionInventory>{
  if(!source.runtimeId||!source.incarnation||!Number.isSafeInteger(source.generation)||source.generation<0||!Number.isSafeInteger(source.sourceRevision)||source.sourceRevision<0)fail('LEGACY_EXECUTION_IDENTITY_UNVERIFIED');
  const schemas=new Map([...storage.sql.exec("SELECT name,sql FROM sqlite_schema WHERE type='table'")].map(r=>[String(r.name),String(r.sql)]));
  const tableCounts:Record<string,number>={},activeTaskIds:string[]=[],sessionIds:string[]=[],domains:string[]=[];
  for(const table of protectedTables){if(!schemas.has(table))continue;const row=[...storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)][0];tableCounts[table]=Number(row.n);}
  let credentialSchema:WorkspaceAdoptionInventory['credentialSchema']='absent';
  if(schemas.has('credentials')){const sql=schemas.get('credentials')!.replace(/\s+/g,' ').toLowerCase();credentialSchema=/\bid text primary key\b/.test(sql)&&/\bdomain text not null\b/.test(sql)?'current':/\bsite_id text primary key\b/.test(sql)&&/\bciphertext text\b/.test(sql)?'legacy':'unknown';}
  if(schemas.has('tasks'))for(const r of storage.sql.exec('SELECT id,task FROM tasks')){let task:any;try{task=JSON.parse(String(r.task));}catch{return fail('LEGACY_TASK_UNREADABLE');}if(['running','approved','needsHuman'].includes(task.status))activeTaskIds.push(String(r.id));if(typeof task.session_id==='string'&&task.session_id)sessionIds.push(task.session_id);}
  if(schemas.has('session_profiles'))for(const r of storage.sql.exec('SELECT domain,has_profile FROM session_profiles'))if(Number(r.has_profile)===1)domains.push(String(r.domain));
  const data={...owner,schemaVersion:1 as const,credentialSchema,tableCounts,activeTaskIds:activeTaskIds.sort(),sessionIds:[...new Set(sessionIds)].sort(),legacyProfileDomains:domains.sort(),legacySnapshotId,source:{...source}};
  return {...data,inventoryHash:await digest(data)};
}
export interface LegacyAdoptionDriver {
  /** Actual source executor identity; do not invent a generation or name for an untracked Browser Run session. */
  sourceExecution():Promise<LegacyExecutionIdentity>;
  legacySnapshotId():Promise<string|null>;
  verifyKeyContinuity(inventory:WorkspaceAdoptionInventory):Promise<boolean>;
  verifyLegacyProfiles(inventory:WorkspaceAdoptionInventory):Promise<boolean>;
  prepareTarget(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<boolean>;
  copyOwnerProvenFiles(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<void>;
  verifyCopiedFiles(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<boolean>;
  quiesceLegacy(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<void>;
  captureFinal(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<WorkspaceDurabilityReceipt>;
  /** Full-profile transition proof, not merely copied cookies/localStorage. False blocks without deletion. */
  verifyProfileTransition(inventory:WorkspaceAdoptionInventory,receipt:WorkspaceDurabilityReceipt):Promise<boolean>;
  retireLegacy(inventory:WorkspaceAdoptionInventory,operationId:string):Promise<RuntimeFenceEvidence>;
  restoreAndVerify(receipt:WorkspaceDurabilityReceipt,operationId:string):Promise<{generation:number;checkpointId:string}>;
  proofs:AdoptionAuthority;
}
export interface WorkspaceAdoptionConfig {
  owner:WorkspaceIdentity;storage:WorkspaceStorage;db:WorkspacePersistence;driver:LegacyAdoptionDriver;
  credentialPolicy:CredentialMigrationPolicy;
  verifyDurability(receiptId:string):Promise<WorkspaceDurabilityReceipt>;
}
/** Populated-user adoption orchestration. Provider callbacks are trusted adapters, never client claims. */
export function createWorkspaceAdoption(config:WorkspaceAdoptionConfig){
  const {db,storage,owner,driver}=config;if(!sameOwner(owner,db.owner))fail('OWNER_MISMATCH');
  const machine=new WorkspaceMigration(db,driver.proofs,config.verifyDurability);
  async function inventory(){return inventoryWorkspaceAdoption(storage,owner,await driver.sourceExecution(),await driver.legacySnapshotId());}
  async function adopt(operationId:string){
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(operationId))fail('INVALID_OPERATION_ID');
    let stored=db.get<WorkspaceAdoptionInventory>('adoption_inventory','initial')?.value;
    if(!stored){
      stored=await inventory();
      if(stored.credentialSchema==='unknown')fail('UNKNOWN_SCHEMA');
      if(!await driver.verifyKeyContinuity(stored))fail('KEY_MISMATCH');
      if(stored.legacyProfileDomains.length&&!await driver.verifyLegacyProfiles(stored))fail('LEGACY_PROFILE_UNREADABLE');
      // Actual verified migration preserves legacy ciphertext/archive; unknown mapping/key blocks before any reset.
      await migrateCredentialSchema(storage,config.credentialPolicy);
      db.storage.transactionSync(()=>db.put('adoption_inventory','initial',0,stored!));
    }
    db.storage.transactionSync(()=>{const prior=db.get<{operationId:string}>('adoption_operation','current');if(prior&&prior.value.operationId!==operationId)fail('IDEMPOTENCY_CONFLICT');if(!prior)db.put('adoption_operation','current',0,{operationId});});
    const original=stored;
    let record=machine.get();
    if(!record)record=await machine.initialize(`${operationId}_inventory`,{...owner,executionBackend:'legacy',sourceRevision:original.source.sourceRevision,schemaVersion:1,manifestHash:original.inventoryHash,generation:original.source.generation,targetGeneration:null,finalSourceRevision:null,initialized:true,sourceIncarnation:original.source.incarnation,sourceRuntimeId:original.source.runtimeId});
    for(;;){
      record=machine.get()!;
      if(record.phase==='inventoried'){if(!await driver.prepareTarget(original,`${operationId}_prepare`))fail('TARGET_PREPARATION_UNVERIFIED');record=await machine.advance(`${operationId}_provision`,record.revision,'provisioned');continue;}
      if(record.phase==='provisioned'){await driver.copyOwnerProvenFiles(original,`${operationId}_copy`);await machine.advance(`${operationId}_copy_done`,record.revision,'copying');continue;}
      if(record.phase==='copying'){if(!await driver.verifyCopiedFiles(original,`${operationId}_verify`))fail('COPIED_FILES_UNVERIFIED');await machine.advance(`${operationId}_verified`,record.revision,'verified');continue;}
      if(record.phase==='verified'){await driver.quiesceLegacy(original,`${operationId}_quiesce`);await machine.advance(`${operationId}_quiesced`,record.revision,'quiescing');continue;}
      if(record.phase==='quiescing'){
        const captured=await driver.captureFinal(original,`${operationId}_capture`);
        const committed=await config.verifyDurability(captured.receiptId);
        if(await digest(captured)!==await digest(committed))fail('DURABILITY_RECEIPT_MISMATCH');
        if(original.legacyProfileDomains.length&&(captured.browserProfileRevision<1||!await driver.verifyProfileTransition(original,captured)))fail('FULL_PROFILE_TRANSITION_UNPROVEN');
        await machine.capture(`${operationId}_captured`,record.revision,captured.receiptId,original.source.sourceRevision);continue;
      }
      if(record.phase==='finalizing'){const proof=await driver.retireLegacy(original,`${operationId}_retire`);await machine.retire(`${operationId}_retired`,record.revision,proof);continue;}
      if(record.phase==='ready'){
        if(!record.capturedReceiptId)fail('UNVERIFIED_CAPTURE');
        const receipt=await config.verifyDurability(record.capturedReceiptId!);
        const restored=await driver.restoreAndVerify(receipt,`${operationId}_restore`);
        if(restored.checkpointId!==receipt.recoveryPoint.checkpointId||restored.generation<=record.generation)fail('RESTORE_NOT_VERIFIED');
        await machine.activate(`${operationId}_active`,record.revision,restored.generation,'isolated_sandbox');continue;
      }
      if(record.phase==='active'||record.phase==='accepted'){
        // This marker is consulted by root old-profile writers; original encrypted blobs remain intact.
        db.storage.transactionSync(()=>{if(!db.get('legacy_profile_authority','current'))db.put('legacy_profile_authority','current',0,{readOnly:true,receiptId:record!.capturedReceiptId,legacyProfileDomains:original.legacyProfileDomains});});
        return record;
      }
      return fail('ADOPTION_RECOVERY_REQUIRED');
    }
  }
  return {inventory,adopt,status:()=>machine.get(),legacyProfilesReadOnly:()=>db.get<{readOnly:boolean}>('legacy_profile_authority','current')?.value.readOnly===true};
}
