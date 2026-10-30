import {mkdirSync,accessSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePublicOrigin} from '../server/core.js';
export function hostingChecks(env=process.env) {
  const checks=[];
  checks.push(['Node 24 or newer',Number(process.versions.node.split('.')[0])>=24]);
  checks.push(['Production mode',env.NODE_ENV==='production']);
  checks.push(['Listen on the hosting network',env.HOST==='0.0.0.0']);
  let origin=false;try{origin=!!validatePublicOrigin(env.PUBLIC_ORIGIN);}catch{}
  checks.push(['Public HTTPS origin',origin]);
  checks.push(['Workspace password (12+ characters)',typeof env.APP_PASSWORD==='string' && env.APP_PASSWORD.length>=12]);
  checks.push(['Session secret (32+ characters)',typeof env.SESSION_SECRET==='string' && env.SESSION_SECRET.length>=32]);
  checks.push(['ngrok disabled on host',env.NGROK_ENABLED==='false']);
  checks.push(['Explicit database path on persistent storage',!!env.DATABASE_PATH && env.DATABASE_PATH!==':memory:']);
  return checks;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const checks=hostingChecks();
  if(process.env.DATABASE_PATH && process.env.DATABASE_PATH!==':memory:') {
    let writable=false;try{const dir=dirname(resolve(process.env.DATABASE_PATH));mkdirSync(dir,{recursive:true});accessSync(dir,constants.W_OK);writable=true;}catch{}
    checks.push(['Database directory writable',writable]);
  }
  for(const [name,pass] of checks)console.log(`${pass?'PASS':'FIX'}  ${name}`);
  console.log('Also verify in your hosting dashboard: a persistent volume, one replica, sleeping disabled, backups and provider connections. This command checks configuration; it does not prove a live meeting works.');
  process.exitCode=checks.every(([,pass])=>pass)?0:1;
}
