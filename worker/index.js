const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function validatePins(input, now = Date.now()) {
  const list = input?.certificates;
  if (input?.version !== 1 || !Array.isArray(list) || list.length > 2 || !list.length) throw new Error('Invalid certificate document');
  return list.map(pin => {
    const start = Date.parse(pin.notBefore), end = Date.parse(pin.notAfter);
    if (pin.algorithm !== 'sha-256' || typeof pin.value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(pin.value) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 14*86400000) throw new Error('Invalid certificate pin');
    return {algorithm:'sha-256',value:pin.value,notBefore:pin.notBefore,notAfter:pin.notAfter};
  }).filter(pin => Date.parse(pin.notAfter) > now);
}
export async function configuration(env) {
  if (env.DEMO_MODE === 'true') return {version:1,backend:{name:'公开资源库',transport:'demo',endpoint:'',rootPath:'/',auth:'none',gatewayAuth:false,certificates:[]}};
  const transport = env.BACKEND_TRANSPORT || 'http';
  if (!['http','webtransport'].includes(transport)) throw new Error('BACKEND_TRANSPORT must be http or webtransport');
  let endpoint;
  try {endpoint = new URL(env.BACKEND_ENDPOINT);} catch {throw new Error('Configure BACKEND_ENDPOINT before connecting');}
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !['https:','http:'].includes(endpoint.protocol)) throw new Error('Invalid backend URL');
  if (transport === 'webtransport' && endpoint.protocol !== 'https:') throw new Error('WebTransport requires an HTTPS endpoint');
  if (transport === 'http' && endpoint.pathname !== '/') throw new Error('HTTP BACKEND_ENDPOINT must be an origin; put the WebDAV path in BACKEND_ROOT');
  const root = env.BACKEND_ROOT || '/';
  if (!root.startsWith('/') || /[?#\\\x00-\x1f]/.test(root) || root.split('/').some(part => ['.','..'].includes(part))) throw new Error('Invalid BACKEND_ROOT');
  const auth = env.BACKEND_AUTH || 'none';
  if (!['none','basic','bearer'].includes(auth)) throw new Error('Invalid BACKEND_AUTH');
  let certificates = [];
  if (transport === 'webtransport' && env.CERTIFICATE_MODE !== 'webpki') {
    const saved = env.PINS ? await env.PINS.get('certificate-pins','json') : JSON.parse(env.CERTIFICATES_JSON || 'null');
    certificates = validatePins(saved);
    if (!certificates.length) throw new Error('No unexpired certificate pins; publish the gateway certificate first');
  }
  return {version:1,backend:{name:env.BACKEND_NAME || 'Public files',transport,endpoint:transport === 'http' ? endpoint.origin : endpoint.href,rootPath:root.endsWith('/') ? root : root+'/',auth,gatewayAuth:transport === 'webtransport' && env.GATEWAY_AUTH === 'true',certificates}};
}
async function smallJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const parts = []; let size = 0;
  try {while (true) {const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 8192) {await reader.cancel();throw new Error('Body exceeds 8 KiB');}parts.push(value);}} finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) {bytes.set(part,offset);offset += part.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function equalSecret(a,b) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [x,y] = await Promise.all([digest(a),digest(b)]);let diff = 0;
  for (let i=0;i<x.length;i++) diff |= x[i]^y[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      try {return json(await configuration(env));} catch (error) {return json({error:error.message},503);}
    }
    if (url.pathname.startsWith('/api/certificates/')) {
      if (request.method !== 'PUT' || url.search || !env.PINS || !env.CERT_WEBHOOK_SECRET || env.CERT_WEBHOOK_SECRET.length < 32 || !(await equalSecret(url.pathname,`/api/certificates/${env.CERT_WEBHOOK_SECRET}`))) return json({error:'Not found'},404);
      if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return json({error:'Expected JSON'},415);
      let data;
      try {data = await smallJSON(request); const certificates = validatePins(data);if (!certificates.length) throw new Error('All certificates expired');data={version:1,certificates};} catch(error) {return json({error:error.message},400);}
      // Acknowledge only durable writes. A failed PUT is retried by the gateway.
      try {await env.PINS.put('certificate-pins',JSON.stringify(data));} catch {return json({error:'Certificate storage unavailable'},503);}
      return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
    }
    if (url.pathname.startsWith('/api/')) return json({error:'Not found'},404);
    return env.ASSETS.fetch(request);
  }
};
