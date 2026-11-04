import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
// Start reading only when iteration begins; opening readline before DB setup can lose early lines.
export async function* readBackupLines(file){
  const input=createReadStream(file),lines=createInterface({input,crlfDelay:Infinity});
  try{for await(const line of lines)yield line;}finally{lines.close();input.destroy();}
}
