import type { SkillSqlDatabase } from './skill-publication.ts';
import type { WorkspaceSkillRegistry } from './skill-registry.ts';
import { skillDigest } from './skill-policy.ts';

/** Read-only conversion/quarantine plan. It never writes to V1/V2, and never emits raw legacy contents. */
export async function auditLegacySkillLibrary(db:SkillSqlDatabase|D1Database,registry:WorkspaceSkillRegistry){
  const source=db as SkillSqlDatabase;
  const result=await source.batch([source.prepare('SELECT id,site,outcome,version,status,body FROM skills')]);
  const entries=[];
  for(const row of result[0]?.results??[]){
    let origin:string|null=null;try{const url=new URL(`https://${String(row.site)}`);if(url.hostname===row.site&&url.origin===`https://${String(row.site)}`)origin=url.origin;}catch{}
    // V1 arbitrary text has no original private evidence/context, so a regex pass cannot certify migration.
    entries.push({sourceRef:await skillDigest({id:String(row.id)},'hygge:legacy-skill-audit-ref:v1'),
      action:'hold_for_review' as const,reasonCodes:origin&&registry.siteIdForOrigin(origin)?['V1_REQUIRES_STRUCTURED_CONVERSION_AND_PRIVATE_EVIDENCE']:['UNREVIEWED_SITE','V1_REQUIRES_STRUCTURED_CONVERSION_AND_PRIVATE_EVIDENCE']});
  }
  return {dryRun:true as const,total:entries.length,mutations:0,entries};
}
