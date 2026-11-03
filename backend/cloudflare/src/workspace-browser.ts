import type {Snapshot} from './browser.ts';
import type {SessionState} from './session-profile.ts';
import {profilePhotoTargetAllowed} from './profile-photo.ts';
export interface WorkspaceBrowserRpc {
 call<T>(op:string,args?:Record<string,unknown>):Promise<T>;
 stream(sessionId:string):Promise<Response>;
}
/** Browser surface used by existing mission loop; authoritative epoch remains in the owner container. */
export class WorkspaceBrowser {
 mode='private-workspace';
 private rpc:WorkspaceBrowserRpc;private controls=new Map<string,{human:boolean;epoch:number}>();private epochs=new Map<string,number>();
 constructor(rpc:WorkspaceBrowserRpc){this.rpc=rpc;}
 private remember(snapshot:Snapshot|null){if(snapshot)this.controls.set(snapshot.sessionID,{human:snapshot.humanControlled,epoch:snapshot.controlEpoch??0});return snapshot;}
 async createSession(url:string,restore?:SessionState|null,sessionId?:string):Promise<Snapshot>{if(sessionId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))throw Error('INVALID_SESSION_ID');return this.remember(await this.rpc.call<Snapshot>('browser.create',{url,restore,...(sessionId?{sessionId}:{})}))!;}
 hasSession(id:string){return this.controls.has(id);}
 controlState(id:string){return this.controls.get(id);}
 async snapshot(id:string):Promise<Snapshot|null>{try{return this.remember(await this.rpc.call<Snapshot>('browser.snapshot',{id}));}catch(e){if(e instanceof Error&&e.message==='SESSION_NOT_FOUND')return null;throw e;}}
 async agentStep<T>(id:string,epoch:number,operation:()=>Promise<T>):Promise<T>{const state=await this.snapshot(id);if(!state||state.humanControlled||state.controlEpoch!==epoch)throw Error('browser control changed');if(this.epochs.has(id))throw Error('AGENT_STEP_ALREADY_ACTIVE');this.epochs.set(id,epoch);try{return await operation();}finally{this.epochs.delete(id);}}
 async act(id:string,body:{action:string;target?:string;value?:string;sensitive?:boolean},legacyHuman=false):Promise<Snapshot|null>{if(legacyHuman||body.action==='setHumanControl')throw Error('Use the live connection to transfer browser control.');const epoch=this.epochs.get(id)??this.controls.get(id)?.epoch;if(epoch===undefined)throw Error('SESSION_NOT_FOUND');return this.remember(await this.rpc.call<Snapshot>('browser.act',{id,...body,epoch}));}
 async legacyAct():Promise<never>{throw Error('Use the live connection to transfer browser control.');}
 async exportState(id:string):Promise<SessionState|null>{return this.rpc.call('browser.export',{id});}
 async extract(id:string):Promise<string[]>{return this.rpc.call('browser.extract',{id});}
 async uploadProfilePhoto(id:string,target:string,base64:string,approvedURL:string):Promise<void>{const snap=await this.snapshot(id);if(!snap||!profilePhotoTargetAllowed(snap.currentURLString,approvedURL))throw Error('photo target is outside the approved site');await this.rpc.call('browser.photo',{id,target,base64,approvedURL,epoch:this.epochs.get(id)??snap.controlEpoch});}
 async uploadArtifact(id:string,target:string,ref:string):Promise<void>{const snap=await this.snapshot(id);if(!snap)throw Error('SESSION_NOT_FOUND');await this.rpc.call('browser.upload',{id,target,ref,epoch:this.epochs.get(id)??snap.controlEpoch});}
 async closeSession(id:string):Promise<boolean>{const closed=await this.rpc.call<boolean>('browser.close',{id});this.controls.delete(id);return closed;}
 async stream(id:string,onResume:()=>Promise<(()=>void)|void>):Promise<Response>{
  const remote=await this.rpc.stream(id);
  // Preserve the container's admission verdict (410 ended, 401/403 auth,
  // 503 saving) so the client can tell terminal from transient failures.
  if(remote.status!==101)return remote;
  if(!remote.webSocket)return new Response('Browser stream unavailable',{status:503});
  const upstream=remote.webSocket;upstream.accept();
  const pair=new WebSocketPair();const app=pair[1];app.accept();
  // Establishment already verified owner/incarnation/lease. Forwarding never
  // queues behind container RPCs: pings and frame acks stay responsive during
  // long tools and handoffs, while a throttled background refresh revalidates
  // the lease and the container independently expires this socket with it.
  let lastRefresh=Date.now(),refreshing=false,closed=false;
  const closeBoth=(code:number,reason:string)=>{if(closed)return;closed=true;try{app.close(code,reason);}catch{}try{upstream.close(code,reason);}catch{}};
  const refresh=()=>{const now=Date.now();if(refreshing||now-lastRefresh<30_000)return;refreshing=true;lastRefresh=now;
    void this.rpc.call('lease.refresh').catch(()=>closeBoth(1008,'Workspace authorization expired')).finally(()=>{refreshing=false;});};
  app.addEventListener('message',event=>{
   if(typeof event.data!=='string'||event.data.length>10000){app.close(1008,'Invalid input');return;}
   let type:string|undefined;try{type=JSON.parse(event.data)?.type;}catch{app.close(1008,'Invalid input');return;}
   if(type!=='ping')refresh();
   try{upstream.send(event.data);}catch{closeBoth(1011,'Connection ended');}
  });
  upstream.addEventListener('message',event=>{
   if(typeof event.data!=='string'||event.data.length>2*1024*1024){app.close(1008,'Invalid browser frame');return;}
   try{const m=JSON.parse(event.data);
    if(m.type==='state')this.controls.set(id,{human:m.humanControlled===true,epoch:m.epoch});
    if(m.type==='resumeAgent'){if(!Number.isSafeInteger(m.epoch))throw Error('INVALID_CONTROL_EPOCH');this.controls.set(id,{human:false,epoch:m.epoch});void onResume().then(fn=>fn?.()).catch(()=>{});return;}
    app.send(event.data);
   }catch{app.close(1008,'Invalid browser frame');}
  });
  const forwardClose=(from:WebSocket,to:WebSocket)=>from.addEventListener('close',(event:any)=>{
   const code=Number.isInteger(event?.code)&&event.code>=1000&&event.code<=4999&&![1004,1005,1006].includes(event.code)?event.code:1001;
   try{to.close(code,typeof event?.reason==='string'?event.reason.slice(0,120):'');}catch{}
  });
  forwardClose(app,upstream);forwardClose(upstream,app);
  app.addEventListener('error',()=>{try{upstream.close(1011,'Connection ended');}catch{}});
  upstream.addEventListener('error',()=>{try{app.close(1011,'Connection ended');}catch{}});
  return new Response(null,{status:101,webSocket:pair[0]});
 }
}
