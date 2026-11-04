import {runtime, seed} from './runtime.mjs';
import {fileURLToPath} from 'node:url';
const restored=process.argv[2]==='--restored'?process.argv[3]:null;
if(process.argv.length>2&&(!restored||!/^[a-f0-9-]{36}$/.test(restored)))throw new Error('Usage: node local.mjs [--restored <database-id>]');
const directory=restored?`./.restored-d1/${restored}/`:'./.local-d1/';
if(restored){const {access}=await import('node:fs/promises');await access(new URL(directory,import.meta.url));}
const {mf, db} = await runtime({persist: fileURLToPath(new URL(directory, import.meta.url)), port: 8787});
if (!(await db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation) await seed(mf);
console.log('架空データ専用 Workers + D1: http://127.0.0.1:8787 （追加費用0円、クラウド接続なし）');
console.log('停止: Ctrl+C。再起動後もローカルの編集は保持されます。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await mf.dispose(); process.exit(0);});
