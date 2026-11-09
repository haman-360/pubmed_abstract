export function readLink(hash=''){
  if(!hash||hash==='#')return null;
  const params=new URLSearchParams(hash.slice(1));
  if([...params.keys()].some(k=>!['issue','pmid'].includes(k))||['issue','pmid'].some(k=>params.getAll(k).length>1))throw Error('invalid_ledger_link');
  const issue_key=params.get('issue'),pmid=params.get('pmid');
  if(issue_key===null&&pmid===null)throw Error('invalid_ledger_link');
  if(issue_key!==null){
    let pair;try{pair=JSON.parse(issue_key);}catch{}
    if(issue_key.length>2000||!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string'||!v)||JSON.stringify(pair)!==issue_key)throw Error('invalid_ledger_link');
  }
  if(pmid!==null&&!/^[1-9][0-9]{0,8}$/.test(pmid))throw Error('invalid_ledger_link');
  return {...(issue_key!==null?{issue_key}:{}),...(pmid!==null?{pmid}:{})};
}
