import {runtime, seed} from './runtime.mjs';
import {fileURLToPath} from 'node:url';
const {mf, db} = await runtime({persist: fileURLToPath(new URL('./.local-d1/', import.meta.url)), port: 8787});
if (!(await db.prepare('SELECT generation FROM settings WHERE id=1').first()).generation) await seed(mf);
console.log('架空データ専用 Workers + D1: http://127.0.0.1:8787 （追加費用0円、クラウド接続なし）');
console.log('停止: Ctrl+C。再起動後もローカルの編集は保持されます。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await mf.dispose(); process.exit(0);});
