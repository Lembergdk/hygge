import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedCompletionRules,verifyObservedMission,assertWorkspaceActionConsent } from '../src/workspace-postconditions.ts';
import { actionFingerprint } from '../src/task-help.ts';
const task={id:'task',status:'running',kind:'apply',target_url:'https://jobs.example/apply',drafted_payload:{coverLetter:'private'}};
const snap={sessionID:'s',currentURLString:'https://jobs.example/success',title:'Done',elements:[{label:'Application received'}]};
test('model done cannot establish success; reviewed current DOM postcondition can',()=>{
 const result={status:'succeeded',extractedItems:[]};
 assert.equal(verifyObservedMission(task,result,snap,'apply',[]),null);
 const rules=reviewedCompletionRules(JSON.stringify([{origin:'https://jobs.example',outcome:'apply',pathname:'/success',requiredLabels:['Application received'],reviewedRevision:'review-1'}]));
 assert.equal(verifyObservedMission(task,result,snap,'apply',rules),'reviewed-postcondition:review-1');
 assert.equal(verifyObservedMission(task,result,{...snap,currentURLString:'https://attacker.example/success'},'apply',rules),null);
 assert.equal(verifyObservedMission(task,result,{...snap,humanControlled:true},'apply',rules),null);
});
test('consent verifies private canonical proof and ignores forged model flag',()=>{
 const decision={action:'click',target:'Delete account',effect:'reversible',consentGranted:true};
 assert.throws(()=>assertWorkspaceActionConsent(task,{decision,snapshot:snap},task),/APPROVAL/);
 const proof={decision,fingerprint:actionFingerprint(decision,snap,task.drafted_payload)};
 assertWorkspaceActionConsent({...task,authorized_action:proof},{decision,snapshot:snap,approvedActionProof:proof},task);
 assert.throws(()=>assertWorkspaceActionConsent({...task,status:'rejected'},{decision,snapshot:snap,approvedActionProof:proof},task),/SCOPE/);
});
test('durable consent admits the full browser operation set without weakening approval gates',()=>{
 const page={sessionID:'s',currentURLString:'https://jobs.example/form',title:'Form',elements:[{ref:'e1-doc-1',label:'Category',kind:'click'},{ref:'e1-doc-2',label:'Subscribe',kind:'click'}]};
 // Reversible navigation/inspection needs no exact approval.
 for(const decision of [{action:'scroll',value:'down',effect:'reversible'},{action:'wait',value:'500',effect:'reversible'},{action:'back',effect:'reversible'},{action:'forward',effect:'reversible'},{action:'hover',target:'e1-doc-1',targetLabel:'Category',effect:'reversible'},{action:'select',target:'e1-doc-1',targetLabel:'Category',value:'design',effect:'reversible'}])
   assertWorkspaceActionConsent(task,{decision,snapshot:page},task);
 // Keyboard submission and consequential controls still require exact private proof.
 for(const decision of [{action:'press',target:'e1-doc-1',targetLabel:'Category',value:'Enter',effect:'reversible'},{action:'check',target:'e1-doc-2',targetLabel:'Subscribe',value:'true',effect:'reversible'}])
   assert.throws(()=>assertWorkspaceActionConsent(task,{decision,snapshot:page},task),/APPROVAL/);
 const enter={action:'press',target:'e1-doc-1',targetLabel:'Category',value:'Enter',effect:'reversible'};
 const proof={decision:enter,fingerprint:actionFingerprint(enter,page,task.drafted_payload)};
 assertWorkspaceActionConsent({...task,authorized_action:proof},{decision:enter,snapshot:page,approvedActionProof:proof},task);
 // Private references are only valid for typing or photo attachment.
 assert.throws(()=>assertWorkspaceActionConsent(task,{decision:{action:'click',target:'e1-doc-1',targetLabel:'Category',valueRef:'credential.secret',effect:'reversible'},snapshot:page},task),/INVALID_BROWSER_ACTION/);
 assert.throws(()=>assertWorkspaceActionConsent(task,{decision:{action:'evaluate',effect:'reversible'},snapshot:page},task),/INVALID_BROWSER_ACTION/);
});
