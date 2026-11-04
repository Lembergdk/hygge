import {test} from 'node:test';import assert from 'node:assert/strict';
import {imageReleaseEnabled,imageReleaseOwnerAllowed} from '../src/workspace-image-release.ts';
test('production release is explicit and forward-only; staging remains synthetic-only',()=>{
 const p={HYGGE_ENV:'production',HYGGE_WORKSPACE_IMAGE:'new'};
 assert.equal(imageReleaseEnabled(p),false);assert.equal(imageReleaseOwnerAllowed(p,'new','real@example.com'),false);
 const enabled={...p,HYGGE_WORKSPACE_UPGRADE_ENABLED:'1'};
 assert.equal(imageReleaseOwnerAllowed(enabled,'new','real@example.com'),true);assert.equal(imageReleaseOwnerAllowed(enabled,'old','real@example.com'),false);
 assert.equal(imageReleaseOwnerAllowed({HYGGE_ENV:'staging'},'new','real@example.com'),false);
 assert.equal(imageReleaseOwnerAllowed({HYGGE_ENV:'staging'},'new','workspace-upgrade-123@example.invalid'),true);
 assert.equal(imageReleaseEnabled({HYGGE_ENV:'unknown',HYGGE_WORKSPACE_UPGRADE_ENABLED:'1'}),false);
});
