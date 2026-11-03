import type { WorkspaceIdentity } from './workspace-contract.ts';
import { createWorkspaceAuthorizationBroker } from './workspace-brokers.ts';
import { assertLease } from './workspace-security.ts';
import { WorkspaceRegistry, sqliteWorkspaceRegistryStorage, UnsupportedRuntimeProvider, type RuntimeProvider, type WorkspaceSqlStorage } from './workspace-runtime.ts';
import { WorkspaceCaptureService, UnsupportedNativeCapture, type CaptureWrite, type NativeCaptureDriver, type PrivateObjectStore, type CaptureLimits } from './workspace-capture.ts';
import { WorkspacePersistence, runtimeAuthority } from './workspace-persistence.ts';
import { EffectLedger, type ConsentAuthority } from './effect-ledger.ts';
import { CheckpointService } from './runtime-checkpoints.ts';

export interface WorkspaceFoundationConfig {
  owner: WorkspaceIdentity;
  storage: WorkspaceSqlStorage;
  signingKey: Uint8Array;
  objects: PrivateObjectStore;
  /** Trusted policy callbacks; never accept constructors/functions from a request or sandbox. */
  consent: ConsentAuthority;
  verifyOutcome: ConstructorParameters<typeof EffectLedger>[3];
  verifyCompletion: ConstructorParameters<typeof CheckpointService>[4];
  provider?: RuntimeProvider;
  captureDriver?: NativeCaptureDriver;
  captureLimits?: CaptureLimits;
  leaseDurationMs?: number;
  now?: () => number;
}
/** Trusted owner DO composition; no returned authority is exposed to the runtime. */
export function createWorkspaceFoundation(config: WorkspaceFoundationConfig) {
  if (!config.objects || !config.consent || typeof config.verifyOutcome !== 'function' || typeof config.verifyCompletion !== 'function') throw new Error('TRUSTED_WORKSPACE_ADAPTERS_REQUIRED');
  const owner = Object.freeze({ ...config.owner });
  const now = config.now ?? Date.now;
  const sqlRegistry = sqliteWorkspaceRegistryStorage(config.storage);
  const registry = new WorkspaceRegistry(sqlRegistry, config.provider ?? new UnsupportedRuntimeProvider(), now, {leaseDurationMs:config.leaseDurationMs});
  const broker = createWorkspaceAuthorizationBroker({ owner, audience: 'hygge-private-workspace-v1', signingKey: config.signingKey, now,
    allowedOperations: ['state.read', 'state.commit', 'workspace.commit', 'checkpoint.commit', 'task.complete', 'action.prepare', 'action.dispatch', 'action.resolve', 'credential.fill', 'emailCode.fill', 'model.invoke', 'skill.read', 'skill.candidate.submit', 'browser.connect'],
    readCurrentLease: () => registry.readLease(owner, owner),
    assertCurrent: lease => assertLease(owner, sqlRegistry.readCurrentLease(owner), lease, now()),
  });
  const authority = runtimeAuthority(broker.authorize, o => sqlRegistry.readCurrentLease(o), now);
  const persistence = new WorkspacePersistence(config.storage, owner);
  const capture = new WorkspaceCaptureService(registry, config.objects, config.captureDriver ?? new UnsupportedNativeCapture(), now, config.captureLimits);
  const effects = new EffectLedger(persistence, authority, config.consent, config.verifyOutcome);
  const checkpoints = new CheckpointService(persistence, authority, effects, (o, id) => capture.verifyReceipt(owner, o, id), config.verifyCompletion, () => new Date(now()).toISOString());
  return {
    registry, broker, effects, checkpoints, persistence, authority,
    /** Authenticated save boundary. Promotes a receipt only under current persisted lease/CAS. */
    async save(capabilityToken: string, request: CaptureWrite) {
      const lease = await broker.authorize(capabilityToken, 'workspace.commit');
      return capture.commit(owner, lease, request);
    },
    verifyDurability: (receiptId: string) => capture.verifyReceipt(owner, owner, receiptId),
  };
}
