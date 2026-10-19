import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

const dir=()=>fs.mkdtempSync('/private/tmp/pr16-round6-');
const file=(ex:Executor,capability:string,args:Record<string,string>)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch});
const setup=()=>{
  const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh();
  const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
  return {root,ws,ex};
};

describe('PR16 sixth review probes',()=>{
  it('does not adopt an external file when cancelling the save dialog',async()=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='click'&&action.target.endsWith(':sheet_cancel'))fs.writeFileSync(path.join(root,'report.txt'),'external user document');
      return sim.perform(action);
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();const w=(await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch})).after!.window.id;
    const act=async(kind:string,key:string,more:Record<string,string>={})=>{
      const obs=await ex.observe(w);const target=obs.elements.find(e=>e.id.endsWith(':'+key))!.id;
      const r=await ex.act({action:{kind,window:w,target,...more} as any,epoch:obs.epoch});expect(r.status).toBe('ok');return r;
    };
    await act('click','menu_new');await act('set_value','textarea',{value:'task result'});
    await act('click','menu_save');await act('set_value','sheet_name',{value:'report.txt'});
    const cancelled=await act('click','sheet_cancel');
    const removed=await file(ex,'fs.trash',{target:'report.txt'});
    expect({credited:cancelled.files??[],owner:ex.ledger.ownerOf('path:report.txt'),status:removed.status,exists:ws.exists('report.txt')}).toEqual({credited:[],owner:'user',status:'stale',exists:true});
  });

  it('invalidates send consent when readonly confirmation details change',async()=>{
    let epoch=1,recipient='alice@example.test';const sent:string[]=[];
    const w={id:'w',app:'Mail',title:'Confirm send'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,text:'Confirm send\nRecipient: '+recipient+'\nMessage: Approved body',elements:[
      {id:'to',role:'staticText',label:'Recipient',value:recipient,actions:[]},
      {id:'body',role:'staticText',label:'Message',value:'Approved body',actions:[]},
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

  it("keeps the hands driver's .hands folder out of the task folder",async()=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    // a new TextEdit document is a file in <task folder>/.hands until it is saved as something
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='open_window'){fs.mkdirSync(path.join(root,'.hands'),{recursive:true});fs.writeFileSync(path.join(root,'.hands','未命名-1'),'');}
      return sim.perform(action);
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    const opened=await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch});
    expect({files:opened.files,entries:ws.entries(),external:ex.externalChanges,changes:ex.changes()}).toEqual({files:undefined,entries:{},external:[],changes:{created:[],modified:[],deleted:[],external:[],unconfirmed:[]}});
  });

  it('can undo a file rename followed by its parent directory rename',async()=>{
    const {ex,ws}=setup();await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'draft'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'draft',name:'note.txt',text:'result'})).status).toBe('ok');
    expect((await file(ex,'fs.move',{source:'draft/note.txt',destination:'draft/renamed.txt'})).status).toBe('ok');
    expect((await file(ex,'fs.move',{source:'draft',destination:'final'})).status).toBe('ok');
    expect(ex.undoable().reversible).toBe(true);
    expect(await ex.undo()).toEqual({undone:4,total:4,refused:null});
    expect(ws.entries()).toEqual({});
  });

  it('preflights external files inside a moved nested directory before undoing anything',async()=>{
    const {root,ex,ws}=setup();await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'draft'})).status).toBe('ok');
    expect((await file(ex,'fs.mkdir',{path:'draft/inner'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'draft/inner',name:'own.txt',text:'result'})).status).toBe('ok');
    expect((await file(ex,'fs.move',{source:'draft',destination:'final'})).status).toBe('ok');
    fs.writeFileSync(path.join(root,'final/inner/user.txt'),'external user file');ws.invalidate();
    const result=await ex.undo();
    expect({undone:result.undone,refused:!!result.refused,final:ws.exists('final/inner/own.txt'),draft:ws.exists('draft')}).toEqual({undone:0,refused:true,final:true,draft:false});
  });
});
