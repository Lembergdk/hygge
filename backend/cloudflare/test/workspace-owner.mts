import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWorkspaceOwner,workspaceSecret,workspaceMode } from '../src/workspace-owner.ts';
import { sqliteWorkspace } from './helpers/workspace-sqlite.mts';
test('durable owner cannot be rebound after reconstruction or environment change', () => {
  const {storage}=sqliteWorkspace();
  const owner=bindWorkspaceOwner(storage,'alice','staging','do-a');
  assert.deepEqual(bindWorkspaceOwner(storage,'alice','staging','do-a'),owner);
  for(const args of [['bob','staging','do-a'],['alice','production','do-a'],['alice','staging','do-b']]) assert.throws(()=>bindWorkspaceOwner(storage,...args as [string,string,string]),/OWNER_MISMATCH/);
});
test('owner keys persist independently and invalid runtime mode fails closed',()=>{
  const {storage}=sqliteWorkspace(), other=sqliteWorkspace();
  const key=workspaceSecret(storage,'capability');
  assert.deepEqual(workspaceSecret(storage,'capability'),key);
  assert.notDeepEqual(workspaceSecret(storage,'container-rpc'),key);
  assert.notDeepEqual(workspaceSecret(other.storage,'capability'),key);
  assert.equal(workspaceMode(undefined),'legacy');
  assert.throws(()=>workspaceMode('typo'),/INVALID_WORKSPACE_MODE/);
});
