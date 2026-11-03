import {test} from 'node:test';import assert from 'node:assert/strict';
import {isMaintainerToken} from '../src/workspace-execution.ts';
const secret='wave4-maintainer-secret-with-32+chars';
test('maintainer token check is exact and fails closed when unconfigured',async()=>{
 assert.equal(await isMaintainerToken(secret,secret),true);
 assert.equal(await isMaintainerToken(secret+'x',secret),false);
 assert.equal(await isMaintainerToken('',secret),false);
 assert.equal(await isMaintainerToken(secret,undefined),false);
 assert.equal(await isMaintainerToken('short','short'),false);
});
