import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{configuration,validatePins} from '../worker/index.js';
const base={BACKEND_TRANSPORT:'http',BACKEND_ENDPOINT:'https://files.example.com',BACKEND_ROOT:'/dav/',ASSETS:{fetch:async()=>new Response('static')}};
const pin={algorithm:'sha-256',value:'A'.repeat(43)+'=',notBefore:new Date(Date.now()-1000).toISOString(),notAfter:new Date(Date.now()+13*86400000).toISOString()};
test('config contains endpoint metadata, never backend credentials or webhook secret',async()=>{
 const env={...base,BRIDGE_TOKEN:'never-publish',PASSWORD:'secret',CERT_WEBHOOK_SECRET:'hook-secret'};const r=await worker.fetch(new Request('https://portal.example.com/api/config'),env);assert.equal(r.status,200);const data=await r.json();assert.equal(data.backend.endpoint,base.BACKEND_ENDPOINT);assert.ok(!JSON.stringify(data).includes('secret'));assert.equal(r.headers.get('Cache-Control'),'no-store');
});
test('Worker never fetches backend file contents',async()=>{
 let assets=0;const r=await worker.fetch(new Request('https://portal.example.com/anything'),{...base,ASSETS:{fetch:async()=>{assets++;return new Response('static');}}});assert.equal(await r.text(),'static');assert.equal(assets,1);
 const unknown=await worker.fetch(new Request('https://portal.example.com/api/proxy?url=https://target.example'),base);assert.equal(unknown.status,404);
});
test('WebTransport requires published valid pins unless using Web PKI',async()=>{
 await assert.rejects(configuration({...base,BACKEND_TRANSPORT:'webtransport'}),/certificate/);
 const env={...base,BACKEND_TRANSPORT:'webtransport',BACKEND_ENDPOINT:'https://bridge.example.com:4433/webtransport',PINS:{get:async()=>({version:1,certificates:[pin]})}};
 const config=await configuration(env);assert.equal(config.backend.certificates.length,1);assert.equal(config.backend.endpoint,env.BACKEND_ENDPOINT);
 assert.equal((await configuration({...env,CERTIFICATE_MODE:'webpki',PINS:undefined})).backend.certificates.length,0);
});
test('private webhook authenticates, validates and acknowledges storage',async()=>{
 let stored;const secret='a'.repeat(64);const env={...base,CERT_WEBHOOK_SECRET:secret,PINS:{put:async(_,value)=>stored=JSON.parse(value)}};
 const url='https://portal.example.com/api/certificates/'+secret;
 const req=path=>new Request(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,certificates:[pin]})});
 assert.equal((await worker.fetch(req(url+'wrong'),env)).status,404);
 assert.equal((await worker.fetch(req(url),env)).status,204);assert.equal(stored.certificates.length,1);
 assert.equal((await worker.fetch(req(url),{...env,PINS:{put:async()=>{throw new Error('offline')}}})).status,503);
});
test('certificate lifespan has a 14-day upper bound',()=>{
 assert.equal(validatePins({version:1,certificates:[pin]}).length,1);
 assert.throws(()=>validatePins({version:1,certificates:[{...pin,notAfter:new Date(Date.parse(pin.notBefore)+14*86400000+1).toISOString()}]}));
});
test('configuration rejects credential-bearing endpoints and invalid roots',async()=>{
 for(const env of [{...base,BACKEND_ENDPOINT:'https://user:secret@files.example.com'},{...base,BACKEND_ENDPOINT:'https://files.example.com/dav/'},{...base,BACKEND_ROOT:'/../secret/'}])await assert.rejects(configuration(env));
});
