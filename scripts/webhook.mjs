import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const origin=new URL(process.argv[2]);
if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('Pass an HTTPS Worker origin, without a path');
let secret;
try{secret=readFileSync('.webhook-secret','utf8').trim();}catch(error){if(error.code!=='ENOENT')throw error;secret=randomBytes(32).toString('hex');writeFileSync('.webhook-secret',secret+'\n',{flag:'wx',mode:0o600});}
if(!/^[0-9a-f]{64}$/.test(secret))throw new Error('Invalid saved secret');
console.log(origin.origin+'/api/certificates/'+secret);
