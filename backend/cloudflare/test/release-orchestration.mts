import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const script=new URL('../../../scripts/wait-release-workflow.mjs',import.meta.url).pathname;
async function fixture(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hygge-release-test-')),log=path.join(dir,'calls');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'gh'),`#!/usr/bin/env node
const fs=require('node:fs'),p=process.argv.at(-1),sha=process.env.RELEASE_SHA;
fs.appendFileSync(process.env.RELEASE_TEST_LOG,p+'\\n');
if(p.endsWith('/git/ref/heads/main'))console.log(JSON.stringify({object:{sha:process.env.RELEASE_TEST_ADVANCED?'other':sha}}));
else if(p.endsWith('/dispatches')){if(JSON.parse(fs.readFileSync(0,'utf8')).ref!=='main')process.exit(2);}
else if(p.includes('/runs?'))console.log(JSON.stringify({workflow_runs:[{id:7,head_sha:sha,head_branch:'main',created_at:new Date().toISOString(),status:process.env.RELEASE_TEST_EXISTING?'completed':undefined,conclusion:process.env.RELEASE_TEST_EXISTING?'success':undefined}]}));
else console.log(JSON.stringify({status:'completed',conclusion:process.env.RELEASE_TEST_FAILED?'failure':'success',html_url:'https://example.invalid/run/7'}));
`,{mode:0o700});return {log,env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,GITHUB_REPOSITORY:'example/hygge',RELEASE_SHA:'a'.repeat(40),RELEASE_TEST_LOG:log}};}
test('release reuses exact main CI without dispatching another build',async t=>{const f=await fixture(t),r=spawnSync(process.execPath,[script,'ci'],{env:f.env,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.ok(!(await fs.readFile(f.log,'utf8')).includes('/dispatches'));});
test('release refuses TestFlight when main advances before publication',async t=>{const f=await fixture(t),r=spawnSync(process.execPath,[script,'testflight'],{env:{...f.env,RELEASE_TEST_ADVANCED:'1'},encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);assert.match(r.stderr,/MAIN_ADVANCED/);assert.ok(!(await fs.readFile(f.log,'utf8')).includes('/dispatches'));});
test('failed main CI prevents release acceptance',async t=>{const f=await fixture(t),r=spawnSync(process.execPath,[script,'ci'],{env:{...f.env,RELEASE_TEST_FAILED:'1'},encoding:'utf8',timeout:5000});assert.notEqual(r.status,0);assert.match(r.stderr,/CI_FAILED/);});

test('release reuses an already verified TestFlight build for the same commit',async t=>{const f=await fixture(t),r=spawnSync(process.execPath,[script,'testflight'],{env:{...f.env,RELEASE_TEST_EXISTING:'1'},encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.ok(!(await fs.readFile(f.log,'utf8')).includes('/dispatches'));});
