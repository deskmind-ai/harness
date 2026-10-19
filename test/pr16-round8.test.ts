import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

const file=(ex:Executor,capability:string,args:Record<string,string>)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch});

describe('PR16 eighth review probes',()=>{
  it('invalidates send consent when the recipient shown in the window title changes',async()=>{
    let epoch=1,recipient='Alice';const sent:string[]=[];
    const win=()=>({id:'w',app:'Chat',title:'Conversation with '+recipient});
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:'Chat',windows:[win()]}),observe:()=>({epoch,window:win(),modal:null,text:'Approved body',elements:[
      {id:'body',role:'textArea',label:'Message',value:'Approved body',actions:['set_value','type']},
      {id:'send',role:'button',label:'Send',actions:['click'],sends:true},
    ]}),perform:()=>{sent.push(recipient);epoch++;return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});let obs=await ex.observe('w');
    const action={kind:'click' as const,window:'w',target:'send'};
    const first=await ex.act({action,epoch:obs.epoch});expect(first.status).toBe('needs_consent');
    expect(first.challenge!.text).toContain('Conversation with Alice');
    const consent=signer.forAction(first.challenge!);
    recipient='Bob';epoch++;obs=await ex.observe('w');
    const r=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:r.status,sent}).toEqual({status:'needs_consent',sent:[]});
  });

  it('invalidates send consent when a recipient selection changes but labels do not',async()=>{
    let epoch=1,recipient='Alice';const sent:string[]=[];
    const win={id:'w',app:'Chat',title:'Choose recipient'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:'Chat',windows:[win]}),observe:()=>({epoch,window:win,modal:null,text:'Choose recipient\nAlice\nBob',elements:[
      {id:'alice',role:'row',label:'Alice',actions:['click'],focused:recipient==='Alice'},
      {id:'bob',role:'row',label:'Bob',actions:['click'],focused:recipient==='Bob'},
      {id:'body',role:'textArea',label:'Message',value:'Approved body',actions:['set_value','type']},
      {id:'send',role:'button',label:'Send',actions:['click'],sends:true},
    ]}),perform:()=>{sent.push(recipient);epoch++;return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});let obs=await ex.observe('w');
    const action={kind:'click' as const,window:'w',target:'send'};
    const first=await ex.act({action,epoch:obs.epoch});expect(first.status).toBe('needs_consent');
    const consent=signer.forAction(first.challenge!);
    recipient='Bob';epoch++;obs=await ex.observe('w');
    const r=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:r.status,sent}).toEqual({status:'needs_consent',sent:[]});
  });

  it('can undo nested mkdir including its implicitly created intermediate directory',async()=>{
    const root=fs.mkdtempSync('/private/tmp/pr16-round8-'),ws=new Workspace(root),signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'parent'})).status).toBe('ok');
    expect((await file(ex,'fs.mkdir',{path:'parent/child/grandchild'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'parent/child/grandchild',name:'note.txt',text:'result'})).status).toBe('ok');
    expect(ex.undoable().reversible).toBe(true);
    expect(await ex.undo()).toEqual({undone:3,total:3,refused:null});
    expect(ws.entries()).toEqual({});
  });

  it('does not treat an AXDocument path as proof that this action wrote a concurrent external edit',async()=>{
    const root=fs.mkdtempSync('/private/tmp/pr16-round8-contract-'),ws=new Workspace(root),signer=ConsentSigner.fresh();
    let opened=false,epoch=1;
    const win={id:'w',app:'Editor',title:'report.txt'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:opened?'Editor':'',windows:opened?[win]:[]}),observe:()=>({epoch,window:win,modal:null,elements:[
      {id:'preview',role:'button',label:'Preview',actions:['click']},
    ]}),perform:action=>{
      epoch++;
      if(action.kind==='open_window'){opened=true;return {status:'ok',window:'w',new_window:win};}
      // Preview does not write the file. A sync client changes the document concurrently.
      fs.writeFileSync(path.join(root,'report.txt'),'external user edits');
      // Under the corrected contract (PerformResult.files / document), a document that only changed while the action
      // ran is where the window points, not a write the driver vouches for: it comes back as `document`, not `files`.
      // (The review's version returned it in `files`, as the first draft of the hands contract had it.)
      return {status:'ok',window:'w',document:path.join(root,'report.txt')};
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    expect((await file(ex,'fs.create_text',{parent:'.',name:'report.txt',text:'task output'})).status).toBe('ok');
    expect((await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch})).status).toBe('ok');
    const obs=await ex.observe('w');
    const preview=await ex.act({action:{kind:'click',window:'w',target:'preview'},epoch:obs.epoch});
    const removed=await file(ex,'fs.trash',{target:'report.txt'});
    expect({credited:preview.files??[],deleted:removed.status==='ok',exists:ws.exists('report.txt')}).toEqual({credited:[],deleted:false,exists:true});
  });
});
