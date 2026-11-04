// CI only. Temporary pull-only registry credentials stay out of logs and shared Docker configuration.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [source,target]=process.argv.slice(2),account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(account!=='89a95a21e6a6b7c15bbd8e148a6c6242'||![source,target].every(ref=>new RegExp('^registry\\.cloudflare\\.com/'+account+'/hygge-workspace@sha256:[a-f0-9]{64}$').test(ref??'')))throw Error('EXACT_HYGGE_IMAGE_PAIR_REQUIRED');
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-registry-proof-'));
const context=execFileSync('docker',['context','show'],{encoding:'utf8'}).trim();
const host=execFileSync('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim();
const env={...process.env,DOCKER_CONFIG:folder,DOCKER_HOST:host,WRANGLER_SEND_METRICS:'false'};
let phase='credentials';
try{
 const raw=execFileSync('./node_modules/.bin/wrangler',['containers','registries','credentials','registry.cloudflare.com','--pull','--expiration-minutes','30','--json','-c','wrangler.staging.jsonc'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const credentials=JSON.parse(raw.slice(raw.indexOf('{')));if(!credentials.username||!credentials.password)throw Error('REGISTRY_CREDENTIAL_SHAPE');
 execFileSync('docker',['login','registry.cloudflare.com','--username',credentials.username,'--password-stdin'],{env,input:credentials.password,encoding:'utf8',stdio:['pipe','pipe','pipe']});
 phase='pull';for(const image of [source,target])execFileSync('docker',['pull',image],{env,stdio:['ignore','pipe','pipe'],timeout:240000});
 phase='isolated-proof';const proof=execFileSync(process.execPath,['container/scripts/image-upgrade-smoke.mjs',source,target],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:900000,maxBuffer:1024*1024});
 const value=JSON.parse(proof);if(!value.ok)throw Error('IMAGE_PROOF_FAILED');
 await fs.writeFile('workspace-image-upgrade-proof.json',JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value,null,2));
}catch(error){console.error(JSON.stringify({ok:false,phase,status:error.status??null,error:'REGISTRY_IMAGE_PROOF_FAILED'}));process.exitCode=1;}
finally{await fs.rm(folder,{recursive:true,force:true});}
