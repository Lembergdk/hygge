// Read-only App Store Connect receipt check, using the key already installed by TestFlight.yml.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sign} from 'node:crypto';
const kid=process.env.ASC_KEY_ID,issuer=process.env.ASC_ISSUER,version=String(Number(process.env.BUILD_NUMBER)+100);
if(!kid||!issuer||!process.env.BUILD_NUMBER)throw Error('APP_STORE_RELEASE_CONTEXT_REQUIRED');
const key=await fs.readFile(path.join(os.homedir(),'.appstoreconnect/private_keys',`AuthKey_${kid}.p8`),'utf8');
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function api(endpoint){const now=Math.floor(Date.now()/1000),body=encode({alg:'ES256',kid,typ:'JWT'})+'.'+encode({iss:issuer,iat:now-20,exp:now+600,aud:'appstoreconnect-v1'});const token=body+'.'+sign('sha256',Buffer.from(body),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');const r=await fetch('https://api.appstoreconnect.apple.com'+endpoint,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`APP_STORE_READBACK_HTTP_${r.status}`);return r.json();}
const apps=await api('/v1/apps?filter%5BbundleId%5D=app.usehygge');if(apps.data?.length!==1)throw Error('EXACT_HYGGE_APP_REQUIRED');const app=apps.data[0].id;
let previous;
for(let attempt=0;attempt<60;attempt++){
 const result=await api(`/v1/builds?filter%5Bapp%5D=${encodeURIComponent(app)}&filter%5Bversion%5D=${encodeURIComponent(version)}&limit=10`);
 const build=result.data?.find(b=>b.attributes.version===version),state=build?.attributes.processingState??'WAITING_FOR_BUILD';
 if(state!==previous){console.log(`TestFlight build ${version}: ${state}`);previous=state;}
 if(state==='VALID'){
  if(build.attributes.expired)throw Error('TESTFLIGHT_BUILD_EXPIRED');
  console.log(`TestFlight processing verified: build ${version}`);
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`\n### TestFlight receipt\n\nBuild **${version}** processed successfully.\n`);
  process.exit(0);
 }
 if(['FAILED','INVALID'].includes(state))throw Error('TESTFLIGHT_PROCESSING_'+state);
 await new Promise(resolve=>setTimeout(resolve,30000));
}
throw Error('TESTFLIGHT_PROCESSING_NOT_CONFIRMED_WITHIN_30_MINUTES');
