import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver, PerformResult } from '../src/executor/types.js';

const dir=()=>fs.mkdtempSync('/private/tmp/pr16-round5-');
const file=(ex:Executor,capability:string,args:Record<string,string>,consent?:any)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});

describe('PR16 fifth review probes',()=>{
  it('invalidates send consent when a select-only recipient changes',async()=>{
    let epoch=1,recipient='alice@example.test';const sent:string[]=[];
    const w={id:'w',app:'Mail',title:'New message'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,text:'New message',elements:[
      {id:'to',role:'popUpButton',label:'Recipient',value:recipient,actions:['select'],options:['alice@example.test','bob@example.test']},
      {id:'body',role:'textArea',label:'Message',value:'Approved body',actions:['set_value','type']},
      {id:'send',role:'button',label:'Send',actions:['click'],sends:true},
    ]}),perform:()=>{sent.push(recipient);epoch++;return {status:'ok',window:w.id};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});let obs=await ex.observe(w.id);
    const action={kind:'click' as const,window:w.id,target:'send'};
    const first=await ex.act({action,epoch:obs.epoch});expect(first.status).toBe('needs_consent');
    const consent=signer.forAction(first.challenge!);
    recipient='bob@example.test';epoch++;obs=await ex.observe(w.id);
    const result=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:result.status,sent}).toEqual({status:'needs_consent',sent:[]});
  });

  it.each([['data.txt','a.txt'],['report.txt','report.csv']])('saving %s does not adopt an external %s in the same folder',async(own,external)=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='click'&&action.target.endsWith(':sheet_save'))fs.writeFileSync(path.join(root,external),'user-owned content from sync');
      const {files:_receipt,...r}=sim.perform(action) as PerformResult;return r;
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();const w=(await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch})).after!.window.id;
    const act=async(kind:string,key:string,more:Record<string,string>={})=>{
      const obs=await ex.observe(w);const target=obs.elements.find(e=>e.id.endsWith(':'+key))!.id;
      const r=await ex.act({action:{kind,window:w,target,...more} as any,epoch:obs.epoch});expect(r.status).toBe('ok');return r;
    };
    await act('click','menu_new');await act('set_value','textarea',{value:'task result'});
    await act('click','menu_save');await act('set_value','sheet_name',{value:own});
    const saved=await act('click','sheet_save');
    const removed=await file(ex,'fs.trash',{target:external});
    // without a driver receipt nothing is credited, not even the task's own save: it is unconfirmed (crediting by receipts
    // only, after hands' PerformResult.files); what this probe guards still holds — the other file is not adopted
    expect({credited:saved.files,owner:ex.ledger.ownerOf('path:'+external),status:removed.status,exists:ws.exists(external)}).toEqual({credited:undefined,owner:'user',status:'stale',exists:true});
  });

  it('can undo mkdir, create child, and rename directory when nothing external changed',async()=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'draft'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'draft',name:'note.txt',text:'result'})).status).toBe('ok');
    expect((await file(ex,'fs.move',{source:'draft',destination:'final'})).status).toBe('ok');
    expect(ex.undoable().reversible).toBe(true);
    expect(await ex.undo()).toEqual({undone:3,total:3,refused:null});
    expect(ws.entries()).toEqual({});
  });

  it('finds a user edit inside a renamed directory before undoing anything',async()=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'draft'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'draft',name:'note.txt',text:'result'})).status).toBe('ok');
    expect((await file(ex,'fs.move',{source:'draft',destination:'final'})).status).toBe('ok');
    fs.appendFileSync(path.join(root,'final/note.txt'),' user edit');ws.invalidate();
    const result=await ex.undo();
    expect({undone:result.undone,refused:result.refused,final:ws.exists('final/note.txt'),draft:ws.exists('draft')}).toEqual({undone:0,refused:'changed since the action: final',final:true,draft:false});
  });

  it('does not mark entries omitted by a bounded listing as observed',async()=>{
    const root=dir();build(root,{'folder':null});const ws=new Workspace(root),signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const consent=signer.forObject('path:folder','modify_user','t');
    for(let i=0;i<201;i++)fs.writeFileSync(path.join(root,'folder',String(i).padStart(3,'0')+'.txt'),'new user document');
    const listing=await file(ex,'fs.list',{path:'folder'});
    expect(listing.output?.truncated).toBe(true);expect((listing.output?.entries as any[]).length).toBe(200);
    expect((listing.output?.entries as any[]).some(e=>e.path==='folder/200.txt')).toBe(false);
    const result=await file(ex,'fs.trash',{target:'folder'},consent);
    expect({status:result.status,unseenFilePresent:ws.exists('folder/200.txt')}).toEqual({status:'stale',unseenFilePresent:true});
  });
});
