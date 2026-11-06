const assets=typeof __LEDGER_APP_ASSETS__==='undefined'?null:__LEDGER_APP_ASSETS__;
const types={'':'text/html; charset=utf-8','app.css':'text/css; charset=utf-8','app.mjs':'text/javascript; charset=utf-8','state.mjs':'text/javascript; charset=utf-8','sdk.mjs':'text/javascript; charset=utf-8','config.json':'application/json; charset=utf-8','manifest.webmanifest':'application/manifest+json','icon.svg':'image/svg+xml'};
const csp="default-src 'none'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self'; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function onlineResponse(path,projectId){
  if(!path.startsWith('/api/app/'))return null;
  const key=path.slice('/api/app/'.length);
  if(!assets||JSON.parse(assets['config.json']).firebase.projectId!==projectId)return new Response('TESTアプリの設定を確認してください。',{status:503,headers:{'Cache-Control':'no-store'}});
  if(!Object.hasOwn(types,key))return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  return new Response(assets[key],{headers:{'Content-Type':types[key],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':csp,'X-Frame-Options':'DENY'}});
}
