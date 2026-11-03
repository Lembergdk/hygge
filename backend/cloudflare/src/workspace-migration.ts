import type { MigrationPhase, MigrationRecord, RuntimeFenceEvidence, WorkspaceDurabilityReceipt } from './workspace-contract.ts';
import { WorkspacePersistence, digest, fail, sameOwner } from './workspace-persistence.ts';

export interface AdoptionRecord extends MigrationRecord {
  initialized: boolean;
  sourceIncarnation: string;
  sourceRuntimeId: string;
  capturedReceiptId: string | null;
  capturedSourceRevision: number | null;
  capturedFilesystemRevision: number | null;
  capturedProfileRevision: number | null;
  retiredIncarnation: string | null;
}
export interface AdoptionAuthority {
  /** Trusted controller proofs. These synchronous checks run in the same DO transaction. */
  assertQuiescent(incarnation: string): void;
  assertFence(evidence: RuntimeFenceEvidence): void;
  assertLatestSourceRevision(expected: number): void;
  /** Read current A registry; ensures no stale capture or later native write is discarded. */
  assertCurrentCapture(receipt: WorkspaceDurabilityReceipt): void;
}
export class WorkspaceMigration {
  readonly db:WorkspacePersistence; readonly proofs:AdoptionAuthority; readonly verifyDurability:(receiptId:string)=>Promise<WorkspaceDurabilityReceipt>;
  constructor(db: WorkspacePersistence, proofs: AdoptionAuthority,
    verifyDurability: (receiptId: string) => Promise<WorkspaceDurabilityReceipt>) {this.db=db;this.proofs=proofs;this.verifyDurability=verifyDurability;}
  get(): AdoptionRecord | null { return this.db.get<AdoptionRecord>('adoption','current')?.value ?? null; }
  async initialize(requestId: string, record: Omit<AdoptionRecord,'revision'|'phase'|'capturedReceiptId'|'capturedSourceRevision'|'capturedFilesystemRevision'|'capturedProfileRevision'|'retiredIncarnation'>): Promise<AdoptionRecord> {
    if (!sameOwner(this.db.owner, record)) fail('OWNER_MISMATCH');
    return this.change(requestId, 0, record, () => ({ ...record, revision:1, phase:'inventoried', capturedReceiptId:null, capturedSourceRevision:null, capturedFilesystemRevision:null, capturedProfileRevision:null, retiredIncarnation:null }));
  }
  async advance(requestId: string, expectedRevision: number, to: 'provisioned'|'copying'|'verified'|'quiescing'|'accepted'): Promise<AdoptionRecord> {
    const next: Partial<Record<MigrationPhase,MigrationPhase>> = { inventoried:'provisioned', provisioned:'copying', copying:'verified', verified:'quiescing', active:'accepted' };
    return this.change(requestId,expectedRevision,{to}, () => {
      const old=this.require(); if(next[old.phase]!==to) fail('INVALID_TRANSITION');
      if(to==='quiescing') this.proofs.assertQuiescent(old.sourceIncarnation);
      return {...old,phase:to,revision:expectedRevision+1};
    });
  }
  /** Capture and verify BEFORE physical retirement; holding quiescence through stop is mandatory. */
  async capture(requestId:string, expectedRevision:number, receiptId:string, finalSourceRevision:number):Promise<AdoptionRecord> {
    const receipt=await this.verifyDurability(receiptId);
    return this.change(requestId,expectedRevision,{receiptId,finalSourceRevision},()=>{
      const old=this.require(); if(!['quiescing','rollback_pending'].includes(old.phase)) fail('INVALID_TRANSITION');
      if(!sameOwner(this.db.owner,receipt) || !sameOwner(this.db.owner,receipt.recoveryPoint)) fail('OWNER_MISMATCH');
      if(receipt.incarnation!==old.sourceIncarnation || receipt.generation!==old.generation) fail('STALE_GENERATION');
      this.proofs.assertQuiescent(old.sourceIncarnation); this.proofs.assertLatestSourceRevision(finalSourceRevision); this.proofs.assertCurrentCapture(receipt);
      return {...old,phase:'finalizing',revision:expectedRevision+1,capturedReceiptId:receipt.receiptId,capturedSourceRevision:finalSourceRevision,capturedFilesystemRevision:receipt.filesystemRevision,capturedProfileRevision:receipt.browserProfileRevision,manifestHash:receipt.recoveryPoint.manifestHash,finalSourceRevision};
    });
  }
  async retire(requestId:string,expectedRevision:number,evidence:RuntimeFenceEvidence):Promise<AdoptionRecord>{
    return this.change(requestId,expectedRevision,{evidence},()=>{
      const old=this.require(); if(old.phase!=='finalizing'||!old.capturedReceiptId) fail('UNVERIFIED_CAPTURE');
      if(!sameOwner(this.db.owner,evidence)||evidence.previousIncarnation!==old.sourceIncarnation||evidence.previousRuntimeId!==old.sourceRuntimeId||evidence.previousGeneration!==old.generation) fail('FENCE_UNCONFIRMED');
      this.proofs.assertLatestSourceRevision(old.finalSourceRevision!); this.proofs.assertFence(evidence);
      return {...old,phase:'ready',revision:expectedRevision+1,retiredIncarnation:evidence.previousIncarnation};
    });
  }
  async activate(requestId:string,expectedRevision:number,targetGeneration:number,backend:'isolated_sandbox'|'legacy'):Promise<AdoptionRecord>{
    return this.change(requestId,expectedRevision,{targetGeneration,backend},()=>{
      const old=this.require(); if(old.phase!=='ready'||!old.retiredIncarnation||!old.capturedReceiptId||targetGeneration<=old.generation||!Number.isSafeInteger(targetGeneration)) fail('ACTIVATION_UNVERIFIED');
      this.proofs.assertLatestSourceRevision(old.finalSourceRevision!);
      return {...old,phase:backend==='legacy'?'legacy_active':'active',executionBackend:backend,targetGeneration,revision:expectedRevision+1};
    });
  }
  /** Rollback adopts latest source state, never an old manifest. All capture/fence gates repeat. */
  async beginRollback(requestId:string,expectedRevision:number,current:{incarnation:string;runtimeId:string;generation:number;sourceRevision:number}):Promise<AdoptionRecord>{
    return this.change(requestId,expectedRevision,current,()=>{
      const old=this.require(); if(!['active','accepted'].includes(old.phase)||current.generation!==old.targetGeneration) fail('INVALID_TRANSITION');
      this.proofs.assertQuiescent(current.incarnation); this.proofs.assertLatestSourceRevision(current.sourceRevision);
      return {...old,phase:'rollback_pending',sourceIncarnation:current.incarnation,sourceRuntimeId:current.runtimeId,generation:current.generation,sourceRevision:current.sourceRevision,targetGeneration:null,finalSourceRevision:null,capturedReceiptId:null,capturedSourceRevision:null,capturedFilesystemRevision:null,capturedProfileRevision:null,retiredIncarnation:null,revision:expectedRevision+1};
    });
  }
  /** No API exists for resetting an initialized workspace or restoring an arbitrary older head. */
  private async change(requestId:string,expected:number,payload:unknown,action:()=>AdoptionRecord):Promise<AdoptionRecord>{
    const hash=await digest({expected,payload});
    return this.db.atomic('migration.transition',requestId,hash,()=>{
      const result=action(); this.db.put('adoption','current',expected,result); return result;
    });
  }
  private require():AdoptionRecord{return this.get()??fail('UNKNOWN_WORKSPACE');}
}
