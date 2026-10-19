import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

const dir=(tag:string)=>fs.mkdtempSync(`/private/tmp/pr16-round10-${tag}-`);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const file=(ex:Executor,capability:string,args:Record<string,string>)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch});

// a TextEdit-like window: "Save" writes hello.txt; `after` runs before perform returns (a sync client, say)
const saving=(root:string,receipt:(written:string)=>unknown,after?:()=>void)=>{
  let epoch=1;const w={id:'w',app:'TextEdit',title:'hello.txt'};
  const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,elements:[{id:'save',role:'menuItem',label:'Save',actions:['click']}]}),perform:()=>{
    epoch++;const written='你好 DeskMind';fs.writeFileSync(path.join(root,'hello.txt'),written);after?.();
    return {status:'ok',window:'w',files:receipt(written) as never};
  }};
  return driver;
};
const save=async(root:string,driver:Driver)=>{
  const ws=new Workspace(root),signer=ConsentSigner.fresh();
  const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
  await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe('w');
  const r=await ex.act({action:{kind:'click',window:'w',target:'save'},epoch:obs.epoch,consent:signer.forObject('window:w','modify_user','t')});
  return {ex,ws,r};
};

describe('PR16 tenth review probes',()=>{
  it('does not credit a receipted path a sync client changed again before perform returned',async()=>{
    const root=dir('race');
    const {ex,ws,r}=await save(root,saving(root,(w)=>[{path:path.join(root,'hello.txt'),sha256:sha(w)}],()=>fs.writeFileSync(path.join(root,'hello.txt'),'a sync client wrote this after the save')));
    const removed=await file(ex,'fs.trash',{target:'hello.txt'});
    expect({files:r.files,owner:ex.ledger.ownerOf('path:hello.txt'),unconfirmed:ex.changes().unconfirmed,trashed:removed.status==='ok',exists:ws.exists('hello.txt')})
      .toEqual({files:undefined,owner:'user',unconfirmed:['hello.txt'],trashed:false,exists:true});
  });

  it('credits a receipted path whose content is what the driver wrote',async()=>{
    const root=dir('ok');
    const {ex,r}=await save(root,saving(root,(w)=>[{path:path.join(root,'hello.txt'),sha256:sha(w)}]));
    expect({files:r.files,owner:ex.ledger.ownerOf('path:hello.txt'),created:ex.changes().created}).toEqual({files:['hello.txt'],owner:'task',created:['hello.txt']});
  });

  it('keeps a receipt that names a path without its content as unconfirmed',async()=>{
    const root=dir('bare');
    const {ex,r}=await save(root,saving(root,()=>[path.join(root,'hello.txt')]));
    expect({files:r.files,owner:ex.ledger.ownerOf('path:hello.txt'),unconfirmed:ex.changes().unconfirmed}).toEqual({files:undefined,owner:'user',unconfirmed:['hello.txt']});
  });

  it('refuses a file write when the screen locked while the intent judge answered',async()=>{
    const root=dir('lock');build(root,{'note.txt':'the user\'s text'});
    const ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const judge={choose:async()=>{sim.lock(true);return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(sim,{task:'t',raw:'replace the text',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const r=await ex.act({action:{kind:'file',capability:'fs.replace_text',args:{target:'note.txt',text:'replacement'}},epoch:ex.currentEpoch,consent:signer.forObject('path:note.txt','modify_user','t')});
    expect({status:r.status,text:ws.read('note.txt')}).toEqual({status:'environment',text:'the user\'s text'});
  });
});
