// Build-time assets only. No credentials, owner UID or analytics are included in the web configuration.
import fs from 'node:fs/promises';
import {validateLoginSettings} from './login-settings.mjs';
export async function onlineAssets(firebase){
  const config=validateLoginSettings({firebase}).firebase;
  const assets={};
  for(const [route,file] of [['','online.html'],['app.css','online.css'],['app.mjs','online-client.mjs'],['state.mjs','online-state.mjs'],['icon.svg','online-icon.svg']])assets[route]=await fs.readFile(new URL(file,import.meta.url),'utf8');
  assets['config.json']=JSON.stringify({firebase:config});
  assets['sdk.mjs']="export {initializeApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';export {initializeAuth,inMemoryPersistence,browserPopupRedirectResolver,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';";
  assets['manifest.webmanifest']=JSON.stringify({name:'PMID研究台帳 TEST',short_name:'研究台帳TEST',lang:'ja',start_url:'/api/app/',scope:'/api/app/',display:'standalone',background_color:'#f4f6f4',theme_color:'#153d35',icons:[{src:'icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]});
  return assets;
}
