import { needsActionApproval, actionFingerprint } from './task-help.ts';
import { probeAuthenticated } from './session-profile.ts';

export interface CompletionRule {
  origin: string;
  outcome: string;
  pathname: string;
  requiredLabels: string[];
  reviewedRevision: string;
}
/** Deployment-owned public rules; never accept matching rules from a model or request. */
export function reviewedCompletionRules(raw?: string): readonly CompletionRule[] {
  if (!raw) return [];
  const rules = JSON.parse(raw);
  if (!Array.isArray(rules)) throw new Error('INVALID_POSTCONDITION_REGISTRY');
  for (const rule of rules) {
    if (!rule || Object.keys(rule).sort().join(',') !== 'origin,outcome,pathname,requiredLabels,reviewedRevision'
      || typeof rule.origin !== 'string' || new URL(rule.origin).origin !== rule.origin || new URL(rule.origin).protocol !== 'https:'
      || !['signup','update_profile','apply','message','book','discover'].includes(rule.outcome)
      || typeof rule.pathname !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(rule.pathname)
      || !Array.isArray(rule.requiredLabels) || !rule.requiredLabels.length || rule.requiredLabels.some((x:unknown) => typeof x !== 'string' || !x || x.length > 200)
      || typeof rule.reviewedRevision !== 'string' || !rule.reviewedRevision) throw new Error('INVALID_POSTCONDITION_REGISTRY');
  }
  return Object.freeze(structuredClone(rules));
}

/** Uses canonical owner task consent, never the model's consentGranted flag. */
export function assertWorkspaceActionConsent(canonicalTask:any, input:{decision:any;snapshot:any;approvedActionProof?:unknown}, runningTask:any):void {
  if (!canonicalTask || canonicalTask.id !== runningTask.id || !['approved','running'].includes(canonicalTask.status)
    || ['kind','target_url','goal'].some(key=>canonicalTask[key]!==runningTask[key])
    || JSON.stringify(canonicalTask.drafted_payload) !== JSON.stringify(runningTask.drafted_payload)) throw new Error('TASK_SCOPE_CHANGED');
  if (!['navigate','click','type','upload','select','check','press','hover','scroll','back','forward','wait','extract'].includes(input.decision?.action)) throw new Error('INVALID_BROWSER_ACTION');
  // Private/draft references may only fill a field or attach the profile photo.
  if (input.decision.valueRef && !['type','upload'].includes(input.decision.action)) throw new Error('INVALID_BROWSER_ACTION');
  // Older clients receive the same strict impact checks in the durable path.
  const task = {...canonicalTask, interaction_version:1};
  if (canonicalTask.scheduled_scan === true && (input.decision.effect !== 'reversible' && input.decision.action !== 'extract')) throw new Error('READ_ONLY_SCAN');
  // Approval is required only when the action itself is consequential (a scope expansion: pay, delete,
  // publish). There is no blanket "fresh approval" flag: after an uncertain effect the agent
  // self-verifies from the live page and continues; the next action is judged on its own impact.
  if (needsActionApproval(task,input.decision)) {
    const proof:any=input.approvedActionProof;
    if (!proof || !input.snapshot || JSON.stringify(proof) !== JSON.stringify(canonicalTask.authorized_action)
      || proof.fingerprint !== actionFingerprint(input.decision,input.snapshot,canonicalTask.drafted_payload)) throw new Error('ACTION_APPROVAL_REQUIRED');
  }
}

export function verifyObservedMission(task:any,result:any,snapshot:any,outcome:string,rules:readonly CompletionRule[]):string|null {
  if (result?.status !== 'succeeded' || !snapshot || snapshot.humanControlled === true) return null;
  let observed:URL,approved:URL;
  try { observed=new URL(snapshot.currentURLString);approved=new URL(task.target_url); } catch { return null; }
  if (observed.origin !== approved.origin || !['https:','http:'].includes(observed.protocol)) return null;
  if (task.drafted_payload?.setupMode === 'connect') return probeAuthenticated(snapshot)==='authenticated' ? 'trusted-sign-in-v1' : null;
  if (task.kind==='discover') return Array.isArray(result.extractedItems) && result.extractedItems.length>0 ? 'observed-listings-v1' : null;
  const labels=new Set((snapshot.elements??[]).map((e:any)=>e.label));
  const matched=rules.find(rule=>rule.origin===observed.origin && rule.outcome===outcome && rule.pathname===observed.pathname && rule.requiredLabels.every(label=>labels.has(label)));
  return matched ? `reviewed-postcondition:${matched.reviewedRevision}` : null;
}
