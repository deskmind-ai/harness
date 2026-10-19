import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

const dir=()=>fs.mkdtempSync('/private/tmp/pr16-round7-');
const file=(ex:Executor,capability:string,args:Record<string,string>,consent?:any)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});
const setup=(initial:Record<string,string|null>={})=>{
  const root=dir();build(root,initial);const ws=new Workspace(root),signer=ConsentSigner.fresh();
  const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
  return {root,ws,ex,signer};
};

describe('PR16 seventh review probes',()=>{
  it.each(['.keep','link'])('preflights a real directory member omitted from entries: %s',async(name)=>{
    const {root,ex,ws}=setup();await ex.begin();
    expect((await file(ex,'fs.mkdir',{path:'output'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'output',name:'own.txt',text:'result'})).status).toBe('ok');
    if(name==='link')fs.symlinkSync('/nonexistent-user-document',path.join(root,'output',name));
    else fs.writeFileSync(path.join(root,'output',name),'external entry');
    ws.invalidate();
    const r=await ex.undo();
    expect({undone:r.undone,refused:!!r.refused,output:ws.exists('output/own.txt')}).toEqual({undone:0,refused:true,output:true});
  });

  it('preflights a moved user directory version before undoing later outputs',async()=>{
    const {root,ex,ws,signer}=setup({'source/note.txt':'user note'});await ex.begin();await ex.plan({steps:[]});
    expect((await file(ex,'fs.move',{source:'source',destination:'destination'},signer.forObject('path:source','modify_user','t'))).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'.',name:'result.txt',text:'task output'})).status).toBe('ok');
    fs.writeFileSync(path.join(root,'destination/new.txt'),'new user document');ws.invalidate();
    const r=await ex.undo();
    expect({undone:r.undone,refused:!!r.refused,output:ws.exists('result.txt'),userFile:ws.exists('destination/new.txt')}).toEqual({undone:0,refused:true,output:true,userFile:true});
  });

  it('shows readonly confirmation content held in labels and text on the action card',async()=>{
    const w={id:'w',app:'Mail',title:'Confirm send'};
    const driver:Driver={snapshot:()=>({epoch:1,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch:1,window:w,modal:null,text:'Confirm send\nRecipient: alice@example.test\nMessage: I accept the additional charge.',elements:[
      {id:'to',role:'staticText',label:'Recipient: alice@example.test',actions:[]},
      {id:'body',role:'staticText',label:'Message: I accept the additional charge.',actions:[]},
      {id:'send',role:'button',label:'Send',actions:['click'],sends:true},
    ]}),perform:()=>({status:'ok',window:w.id})};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});await ex.observe(w.id);
    const r=await ex.act({action:{kind:'click',window:w.id,target:'send'},epoch:1});
    expect(r.status).toBe('needs_consent');
    expect(r.challenge!.text).toContain('alice@example.test');
    expect(r.challenge!.text).toContain('I accept the additional charge.');
  });

  it('binds label-only outgoing details even when optional observation text is omitted',async()=>{
    let epoch=1,recipient='alice@example.test';const sent:string[]=[];
    const w={id:'w',app:'Mail',title:'Confirm send'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,elements:[
      {id:'to',role:'staticText',label:'Recipient: '+recipient,actions:[]},
      {id:'body',role:'staticText',label:'Message: Approved body',actions:[]},
      {id:'send',role:'button',label:'Send',actions:['click'],sends:true},
    ]}),perform:()=>{sent.push(recipient);epoch++;return {status:'ok',window:w.id};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});let obs=await ex.observe(w.id);
    const action={kind:'click' as const,window:w.id,target:'send'};
    const first=await ex.act({action,epoch:obs.epoch});expect(first.status).toBe('needs_consent');
    const consent=signer.forAction(first.challenge!);
    recipient='bob@example.test';epoch++;obs=await ex.observe(w.id);
    const r=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:r.status,sent}).toEqual({status:'needs_consent',sent:[]});
  });
});
