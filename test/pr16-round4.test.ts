import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver, PerformResult } from '../src/executor/types.js';

const dir=()=>fs.mkdtempSync('/private/tmp/pr16-round4-');
const file=(ex:Executor,capability:string,args:Record<string,string>,consent?:any)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});

describe('PR16 fourth review probes',()=>{
  it('checks observation freshness before using it to classify an action as task-owned',async()=>{
    let epoch=1,opened=false,sendStep=false;const effects:string[]=[];
    const w={id:'w',app:'Wizard',title:'Compose'};
    const driver:Driver={
      snapshot:()=>({epoch,locked:false,front_app:opened?w.app:'',windows:opened?[w]:[]}),
      observe:()=>({epoch,window:w,modal:null,elements:[{id:'primary',role:'button',label:sendStep?'Send':'Preview',actions:['click'],sends:sendStep}]}),
      perform:action=>{
        if(action.kind==='open_window'){opened=true;epoch++;return {status:'ok',window:w.id,new_window:w};}
        effects.push(sendStep?'sent':'previewed');epoch++;return {status:'ok',window:w.id};
      },
    };
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();expect((await ex.act({action:{kind:'open_window',app:w.app},epoch:ex.currentEpoch})).status).toBe('ok');
    await ex.observe(w.id);sendStep=true;epoch++;
    const snapshot=await ex.snapshot();
    const result=await ex.act({action:{kind:'click',window:w.id,target:'primary'},epoch:snapshot.epoch});
    expect({status:result.status,effects}).toEqual({status:'stale',effects:[]});
  });

  it('checks for newly created descendants during the directory intent check',async()=>{
    const root=dir();build(root,{'folder/old.txt':'original'});
    const ws=new Workspace(root),signer=ConsentSigner.fresh();
    const judge={choose:async()=>{fs.writeFileSync(path.join(root,'folder/new.txt'),'new user document');return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(new SimComputer(root),{task:'t',raw:'trash folder',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const result=await file(ex,'fs.trash',{target:'folder'},signer.forObject('path:folder','modify_user','t'));
    expect({status:result.status,exists:ws.exists('folder/new.txt')}).toEqual({status:'stale',exists:true});
  });

  it('does not confuse equal leaf-folder and file names when the driver has no file receipt',async()=>{
    const root=dir();build(root,{'output':null,'incoming/output':null});
    const ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='click'&&action.target.endsWith(':sheet_save'))fs.writeFileSync(path.join(root,'incoming/output/report.txt'),'user-owned report from sync');
      const {files:_receipt,...r}=sim.perform(action) as PerformResult;return r;
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();const w=(await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch})).after!.window.id;
    const act=async(kind:string,key:string,more:Record<string,string>={})=>{
      const obs=await ex.observe(w);const target=obs.elements.find(e=>e.id.endsWith(':'+key))!.id;
      const r=await ex.act({action:{kind,window:w,target,...more} as any,epoch:obs.epoch});expect(r.status).toBe('ok');return r;
    };
    await act('click','menu_new');await act('set_value','textarea',{value:'task report'});
    await act('click','menu_save');await act('set_value','sheet_name',{value:'report.txt'});await act('select','sheet_folder',{option:'output'});
    const saved=await act('click','sheet_save');
    const removed=await file(ex,'fs.trash',{target:'incoming/output/report.txt'});
    expect({credited:saved.files,owner:ex.ledger.ownerOf('path:incoming/output/report.txt'),status:removed.status,exists:ws.exists('incoming/output/report.txt')}).toEqual({credited:['output/report.txt'],owner:'user',status:'stale',exists:true});
  });

  it('says stopped, not blocked, when the stop comes as the action finds the user at the keyboard',async()=>{
    let snaps=0;const effects:string[]=[];const w={id:'w',app:'Editor',title:'Doc'};
    let ex!:Executor;
    const driver:Driver={snapshot:()=>{snaps++;if(snaps===2)ex.stop();return {epoch:1,locked:false,front_app:w.app,windows:[w],user_active:snaps>=2};},observe:()=>({epoch:1,window:w,modal:null,elements:[{id:'b',role:'button',label:'Go',actions:['click']}]}),perform:()=>{effects.push('go');return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh();ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,userWait:{ms:1000,pollMs:5}});
    await ex.begin();await ex.observe('w');
    const r=await ex.act({action:{kind:'click',window:'w',target:'b'},epoch:1});
    expect({status:r.status,effects}).toEqual({status:'stopped',effects:[]});
  });

  it('preflights all undo steps before deleting any output when an earlier file changed',async()=>{
    const root=dir(),ws=new Workspace(root),signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    expect((await file(ex,'fs.create_text',{parent:'.',name:'first.txt',text:'first result'})).status).toBe('ok');
    expect((await file(ex,'fs.create_text',{parent:'.',name:'second.txt',text:'second result'})).status).toBe('ok');
    fs.appendFileSync(path.join(root,'first.txt'),' user edit');
    const result=await ex.undo();
    expect(result.refused).not.toBeNull();
    expect({undone:result.undone,first:ws.exists('first.txt'),second:ws.exists('second.txt')}).toEqual({undone:0,first:true,second:true});
  });
});
