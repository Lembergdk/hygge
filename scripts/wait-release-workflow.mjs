// Run only inside the authorized release workflow; credentials remain in GH_TOKEN.
import {execFileSync} from 'node:child_process';
const [mode]=process.argv.slice(2),repo=process.env.GITHUB_REPOSITORY,sha=process.env.RELEASE_SHA;
if(!repo||!sha||!['ci','testflight'].includes(mode))throw Error('RELEASE_CONTEXT_REQUIRED');
const api=(endpoint,body)=>JSON.parse(execFileSync('gh',['api',...(body?['--method','POST','--input','-']:[]),endpoint],{encoding:'utf8',input:body?JSON.stringify(body):undefined,stdio:['pipe','pipe','pipe']})||'null');
const started=Date.now(),file=mode==='ci'?'ci.yml':'testflight.yml',event=mode==='ci'?'push':'workflow_dispatch';
let selected,last;
if(mode==='testflight'){
 if(api(`repos/${repo}/git/ref/heads/main`).object.sha!==sha)throw Error('MAIN_ADVANCED_BEFORE_TESTFLIGHT; rerun the release on current main');
 const prior=api(`repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=workflow_dispatch&per_page=20`).workflow_runs;
 selected=prior.find(r=>r.head_sha===sha&&r.head_branch==='main'&&(r.conclusion==='success'||['queued','in_progress','waiting','pending','requested'].includes(r.status)));
 if(!selected)api(`repos/${repo}/actions/workflows/${file}/dispatches`,{ref:'main'});
}
while(Date.now()-started<75*60000){
 try{
  if(!selected){const runs=api(`repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}&event=${event}&per_page=20`).workflow_runs;selected=runs.find(r=>r.head_sha===sha&&r.head_branch==='main'&&(mode==='ci'||Date.parse(r.created_at)>=started-5000));}
  if(selected){const run=api(`repos/${repo}/actions/runs/${selected.id}`);if(last!==run.status){console.log(`${mode}: ${run.html_url} ${run.status}`);last=run.status;}
   if(run.status==='completed'){if(run.conclusion!=='success')throw Error(`${mode.toUpperCase()}_FAILED: ${run.html_url}`);console.log(`${mode} verified at ${sha}`);process.exit(0);}}
 }catch(e){if(String(e.message).includes('_FAILED:'))throw e;console.log('Waiting for GitHub workflow status');}
 await new Promise(resolve=>setTimeout(resolve,15000));
}
throw Error('RELEASE_WORKFLOW_TIMEOUT');
