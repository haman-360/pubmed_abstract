// Build-time assets only. No credentials, owner UID or analytics are included in the web configuration.
import fs from 'node:fs/promises';
import {validateLoginSettings} from './login-settings.mjs';
export async function onlineAssets(firebase){
  const config=validateLoginSettings({firebase}).firebase;
  const assets={};
  for(const [route,file] of [['','online.html'],['app.css','online.css'],['app.mjs','online-client.mjs'],['state.mjs','online-state.mjs'],['links.mjs','online-links.mjs'],['icon.svg','online-icon.svg']])assets[route]=await fs.readFile(new URL(file,import.meta.url),'utf8');
  for(const name of ['apple-touch-icon.png','icon-192.png','icon-512.png','icon-maskable-512.png'])assets[name]=await fs.readFile(new URL('app-icons/'+name,import.meta.url),'base64');
  assets['config.json']=JSON.stringify({firebase:config});
  assets['sdk.mjs']="export {initializeApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';export {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';";
  assets['manifest.webmanifest']=JSON.stringify({id:'/api/app/',name:'研究台帳 TEST',short_name:'研究台帳TEST',lang:'ja',start_url:'/api/app/',scope:'/api/app/',display:'standalone',background_color:'#f4f6f4',theme_color:'#153d35',icons:[{src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]});
  return assets;
}
