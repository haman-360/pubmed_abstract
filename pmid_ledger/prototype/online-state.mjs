// Per-tab memory only. Requests remain fixed until acknowledged or explicitly discarded.
export class OnlineEdits{
  constructor(uuid=()=>crypto.randomUUID()){this.uuid=uuid;this.reset();}
  reset(){this.drafts=new Map();this.pending=null;this.revision=null;this.issue=null;}
  observe(data){
    if(this.drafts.size&&this.revision!==data.revision)throw Error('metadata_changed_reload');
    this.revision=data.revision;this.issue=data.issue;
  }
  edit(row,status,note){
    if(this.pending)throw Error('pending_operation');
    const old=this.drafts.get(row.pmid),base=old?.base??row.review;
    if(status===base.status&&note===base.note)this.drafts.delete(row.pmid);
    else this.drafts.set(row.pmid,{pmid:row.pmid,status,note,expected_version:base.version,base:{...base}});
  }
  request(kind='save'){
    if(this.pending)return this.pending;
    if(!this.issue||!this.revision)throw Error('issue_required');
    if(!this.drafts.size&&kind==='save')return null;
    if(this.drafts.size>100)throw Error('too_many_changes');
    const changes=[...this.drafts.values()].map(({base,...change})=>({...change}));
    const body={operation_id:this.uuid(),revision:this.revision,issue_key:this.issue.issue_key,changes};
    let name='saveReviews';
    if(kind==='complete'){
      name='saveAndCompleteIssue';Object.assign(body,{expected_version:this.issue.version,content_version:this.issue.content_version});
      if(changes.length)body.review_operation_id=this.uuid();
    }else if(kind==='reopen'){
      if(changes.length)throw Error('save_before_reopen');
      name='saveIssueReview';Object.assign(body,{expected_version:this.issue.version,content_version:this.issue.content_version,status:'unreviewed'});
    }
    this.pending={name,body};return this.pending;
  }
  acknowledge(value){if(value?.saved!==true)throw Error('save_result_unknown');this.pending=null;this.drafts.clear();}
  get unreviewedAfterEdits(){
    if(!Number.isSafeInteger(this.issue?.unreviewed))return null;
    return [...this.drafts.values()].reduce((count,c)=>count+(c.status==='unreviewed'?1:0)-(c.base.status==='unreviewed'?1:0),this.issue.unreviewed);
  }
  get dirty(){return this.drafts.size>0||this.pending!==null;}
}
