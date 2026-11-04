/** Deployment policy only. Production permits forward promotion to its default image. */
export function imageReleaseEnabled(env:{HYGGE_ENV:string;HYGGE_WORKSPACE_UPGRADE_ENABLED?:string}){
 return env.HYGGE_ENV==='staging'||env.HYGGE_ENV==='production'&&env.HYGGE_WORKSPACE_UPGRADE_ENABLED==='1';
}
export function imageReleaseOwnerAllowed(env:{HYGGE_ENV:string;HYGGE_WORKSPACE_UPGRADE_ENABLED?:string;HYGGE_WORKSPACE_IMAGE?:string},target:string,email:string){
 return imageReleaseEnabled(env)&&(env.HYGGE_ENV==='production'?target===env.HYGGE_WORKSPACE_IMAGE:/^workspace-upgrade-[a-z0-9-]+@example\.invalid$/.test(email));
}
