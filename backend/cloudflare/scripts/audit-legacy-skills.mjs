// Read-only local SQLite audit. No remote binding, migration or update command exists.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { auditLegacySkillLibrary } from '../src/skill-legacy-audit.ts';
import { loadReviewedSkillRegistry } from '../src/skill-registry.ts';

const [databasePath,registryPath]=process.argv.slice(2);
if(!databasePath){process.stderr.write('Usage: node --experimental-strip-types scripts/audit-legacy-skills.mjs <local.sqlite> [reviewed-registry.json]\n');process.exitCode=2;}
else{
  let sql;
  try{
    const registry=loadReviewedSkillRegistry(registryPath?JSON.parse(readFileSync(registryPath,'utf8')):undefined);
    sql=new DatabaseSync(databasePath,{readOnly:true});
    const database={prepare(query){return {query,values:[],bind(...values){return {...this,values};}};},
      async batch(statements){return statements.map(s=>({results:sql.prepare(s.query).all(...s.values)}));}};
    process.stdout.write(JSON.stringify(await auditLegacySkillLibrary(database,registry),null,2)+'\n');
  }catch{process.stderr.write('Legacy skill audit failed; no changes were made.\n');process.exitCode=1;}
  finally{sql?.close();}
}
