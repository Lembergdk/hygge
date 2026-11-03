import {test} from 'node:test';import assert from 'node:assert/strict';
import {sqliteWorkspace} from './helpers/workspace-sqlite.mts';import {migrateCredentialSchema,type CredentialMigrationPolicy} from '../src/schema-migrations.ts';
const policy:CredentialMigrationPolicy={verifyCurrentCiphertext:async()=>true,resolveLegacy:async row=>({id:'id-'+row.site_id,domain:'jobs.example',username:String(row.username),iv:String(row.iv),ciphertext:String(row.ciphertext),created_at:String(row.updated_at)})};
const legacy=`CREATE TABLE credentials (site_id TEXT PRIMARY KEY, username TEXT, iv TEXT, ciphertext TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`;
test('Known historical scaffold migrates populated credential bytes without deleting unrelated state or legacy rows',async()=>{
 const f=sqliteWorkspace();f.sqlite.exec(legacy);f.sqlite.exec("INSERT INTO credentials VALUES ('site','alice','iv','ciphertext','2026-11-02');CREATE TABLE site_memory (site_id TEXT PRIMARY KEY,memory TEXT);INSERT INTO site_memory VALUES ('site','private');CREATE TABLE approvals (site_id TEXT PRIMARY KEY,status TEXT);INSERT INTO approvals VALUES ('site','approved');");
 const result=await migrateCredentialSchema(f.storage,policy);assert.equal(result.archived,true);assert.equal(result.count,1);
 assert.equal(f.sqlite.prepare('SELECT ciphertext FROM credentials').get()!.ciphertext,'ciphertext');assert.equal(f.sqlite.prepare('SELECT ciphertext FROM credentials_legacy_v0').get()!.ciphertext,'ciphertext');
 assert.equal(f.sqlite.prepare('SELECT memory FROM site_memory').get()!.memory,'private');assert.equal(f.sqlite.prepare('SELECT status FROM approvals').get()!.status,'approved');
 assert.deepEqual(await migrateCredentialSchema(f.storage,policy),result);f.sqlite.close();
});
test('Unknown credential schema blocks without adding migration ledger or altering existing bytes',async()=>{
 const f=sqliteWorkspace();f.sqlite.exec('CREATE TABLE credentials (mystery TEXT)');f.sqlite.exec("INSERT INTO credentials VALUES ('keep')");
 await assert.rejects(migrateCredentialSchema(f.storage,policy),/UNKNOWN_SCHEMA/);assert.equal(f.sqlite.prepare('SELECT mystery FROM credentials').get()!.mystery,'keep');assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='hygge_schema_migrations'").get()!.n,0);f.sqlite.close();
});
test('Missing key or unexplained site mapping cannot create a fresh credential store over populated legacy data',async()=>{
 for(const kind of ['key','mapping','bytes']){const f=sqliteWorkspace();f.sqlite.exec(legacy);f.sqlite.exec("INSERT INTO credentials VALUES ('site','alice','iv','ciphertext','date')");
 await assert.rejects(migrateCredentialSchema(f.storage,{...policy,verifyCurrentCiphertext:async()=>kind!=='key',resolveLegacy:async row=>kind==='mapping'?null:{...(await policy.resolveLegacy(row))!,ciphertext:kind==='bytes'?'changed':'ciphertext'}}));
 assert.equal(f.sqlite.prepare('SELECT site_id FROM credentials').get()!.site_id,'site');assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='credentials_legacy_v0'").get()!.n,0);f.sqlite.close();}
});
test('Source mutation during async crypto preflight rejects rather than copying a stale credential snapshot',async()=>{
 const f=sqliteWorkspace();f.sqlite.exec(legacy);f.sqlite.exec("INSERT INTO credentials VALUES ('site','alice','iv','ciphertext','date')");
 await assert.rejects(migrateCredentialSchema(f.storage,{...policy,verifyCurrentCiphertext:async()=>{f.sqlite.exec("UPDATE credentials SET username='newer'");return true;}}),/MIGRATION_SOURCE_ADVANCED/);
 assert.equal(f.sqlite.prepare('SELECT username FROM credentials').get()!.username,'newer');f.sqlite.close();
});
test('Absent schema creates current table; migration checksum tampering blocks restart',async()=>{
 const f=sqliteWorkspace();const result=await migrateCredentialSchema(f.storage,policy);assert.equal(result.source,'absent');
 f.sqlite.exec("UPDATE hygge_schema_migrations SET checksum='tampered'");await assert.rejects(migrateCredentialSchema(f.storage,policy),/MIGRATION_CHECKSUM_MISMATCH/);f.sqlite.close();
});
test('Transactional copy error rolls back rename/new table and ledger together',async()=>{
 const f=sqliteWorkspace();f.sqlite.exec(legacy);f.sqlite.exec("INSERT INTO credentials VALUES ('site','alice','iv','ciphertext','date')");
 const normal=f.storage.sql.exec.bind(f.storage.sql);f.storage.sql.exec=(sql,...args)=>{if(sql.startsWith('INSERT INTO credentials ('))throw new Error('copy failed');return normal(sql,...args);};
 await assert.rejects(migrateCredentialSchema(f.storage,policy),/copy failed/);assert.equal(f.sqlite.prepare('SELECT site_id FROM credentials').get()!.site_id,'site');assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='hygge_schema_migrations'").get()!.n,0);f.sqlite.close();
});
