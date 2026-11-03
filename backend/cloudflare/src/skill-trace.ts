import type { SharedSkillBodyV2, SkillOutcomeV2, ParamRef } from './skill-contract.ts';
import { PARAM_REFS, SKILL_OUTCOMES_V2 } from './skill-contract.ts';
import type { WorkspaceSkillRegistry } from './skill-registry.ts';
import { validateSkillBody } from './skill-policy.ts';

export interface PrivateBrowserTraceEntry { action:string; browserAction?:string; succeeded:boolean; target?:string; targetRef?:string; urlString?:string; valueRef?:string; fieldSetId?:string; checkpoint?:string }
const PRIVATE_REF_ALIASES:Readonly<Record<string,ParamRef>>={
  'draft.email':'profile.email','draft.displayName':'profile.displayName','draft.name':'profile.displayName',
  'draft.location':'profile.location','draft.searchTerms':'search.terms','draft.rate':'search.rate','draft.coverLetter':'application.coverLetter',
};
/** Whole trajectory is held when any operation lacks an exact reviewed representation. No raw prose is distilled. */
export function candidateFromReviewedTrace(siteOrigin:string,outcome:string,trace:readonly PrivateBrowserTraceEntry[],registry:WorkspaceSkillRegistry):SharedSkillBodyV2|null{
  const siteId=registry.siteIdForOrigin(siteOrigin),site=siteId?registry.getSite(siteId):null;
  if(!site||!(SKILL_OUTCOMES_V2 as readonly string[]).includes(outcome)||!Array.isArray(trace)||!trace.length)return null;
  const steps:SharedSkillBodyV2['steps']=[];
  for(const t of trace){
    if(!t||typeof t.action!=='string'||typeof t.succeeded!=='boolean')return null;
    // The actual browser operation governs; old-client trace aliases (hover as
    // click, upload as type) must never launder unreviewed operations. Ephemeral
    // DOM refs (targetRef) are ignored: only reviewed control IDs may publish.
    const op=typeof t.browserAction==='string'&&t.browserAction?t.browserAction:t.action;
    if(op==='done'){if(!t.succeeded)return null;continue;}
    if(!t.succeeded)return null;
    switch(op){
      case 'navigate':{
        const route=Object.entries(site.routes).find(([,path])=>new URL(path,site.origin).href===t.urlString);
        if(!route)return null;steps.push({op:'navigate',routeId:route[0]});break;
      }
      case 'click':case 'inspect':
        if(!t.target||!site.controls.includes(t.target))return null;
        steps.push({op,controlId:t.target});break;
      case 'type':case 'fill':case 'upload':
        if(!t.target||!site.controls.includes(t.target)||typeof t.valueRef!=='string')return null;
        const ref=(PARAM_REFS as readonly string[]).includes(t.valueRef)?t.valueRef as ParamRef:PRIVATE_REF_ALIASES[t.valueRef];
        if(!ref)return null;
        if(op==='upload'){if(ref!=='application.resume')return null;steps.push({op:'upload',controlId:t.target,valueRef:'application.resume'});}
        else steps.push({op:'fill',controlId:t.target,valueRef:ref});break;
      case 'extract':{
        const field=t.fieldSetId??t.target;if(!field||!site.fieldSets.includes(field))return null;steps.push({op:'extract',fieldSetId:field});break;
      }
      default:return null;
    }
  }
  if(!steps.length||steps.length>=12)return null;
  steps.push({op:'complete',outcome:outcome as SkillOutcomeV2});
  try{return validateSkillBody({schemaVersion:2,siteId:site.siteId,outcome,steps,pitfalls:[]},registry);}catch{return null;}
}
