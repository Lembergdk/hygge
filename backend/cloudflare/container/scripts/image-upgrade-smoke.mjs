// Actual old/new Linux images; no provider calls, real users, external network or persisted volumes.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const [sourceImage,targetImage]=process.argv.slice(2);
if(!sourceImage||!targetImage)throw Error('Pass exact source and candidate Docker image references');
const script=await fs.readFile(new URL('./image-pair-probe.mjs',import.meta.url),'utf8');
let snapshot=null;const results=[];
for(const [i,image] of [sourceImage,targetImage,sourceImage,targetImage].entries()){
 console.error(`IMAGE_PAIR_STEP ${i+1} START`);
 const name=`hygge-image-proof-${randomUUID()}`;
 const input={generation:i+1,expectProtocol1:i%2===1,snapshot};
 const code=`globalThis.__imageProbeInput=${JSON.stringify(input)};\n`+script;
 try{
  const output=execFileSync('docker',['run','--rm','-i','--name',name,'--network','none','--entrypoint','node',image,'--experimental-strip-types','--input-type=module','-'],{input:code,encoding:'utf8',timeout:300000,maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
  const result=JSON.parse(output.trim());if(!result.ok)throw Error('IMAGE_PROBE_FAILED');snapshot=result.snapshot;
  console.error(`IMAGE_PAIR_STEP ${i+1} PASS`);
  results.push({image,generation:i+1,chromium:result.chromium,protocol:result.protocol,files:snapshot.tree.files.length,bytes:snapshot.tree.files.reduce((n,f)=>n+f.size,0)});
 }catch(error){throw Error(`IMAGE_PROBE_STEP_${i+1}: ${String(error.stderr??error.message).slice(-1500)}`);}
 finally{try{execFileSync('docker',['rm','-f',name],{stdio:'ignore'});}catch{}}
}
console.log(JSON.stringify({ok:true,network:'none',syntheticOnly:true,upgradeRollbackAndUpgrade:true,profileAndLatestWorkRetained:true,deletionWatermarkRetained:true,results},null,2));
