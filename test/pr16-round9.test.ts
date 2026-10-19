import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';
import { createHash } from 'node:crypto';
const sha=(t:string)=>createHash('sha256').update(t).digest('hex');

describe('PR16 ninth review probes',()=>{
  it('invalidates send consent when a webview switches the destination URL',async()=>{
    let epoch=1,url='https://approved.example/submit';const sent:string[]=[];
    const win=()=>({id:'w',app:'WebView',title:'Submit document',url});
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:'WebView',windows:[win()]}),observe:()=>({epoch,window:win(),modal:null,text:'Submit document',elements:[
      {id:'body',role:'textArea',label:'Document',value:'Confidential document',actions:['set_value','type']},
      {id:'send',role:'button',label:'Submit',actions:['click'],sends:true},
    ]}),perform:()=>{sent.push(url);epoch++;return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});let obs=await ex.observe('w');
    const action={kind:'click' as const,window:'w',target:'send'};
    const first=await ex.act({action,epoch:obs.epoch});expect(first.status).toBe('needs_consent');
    const consent=signer.forAction(first.challenge!);
    url='https://unapproved.example/submit';epoch++;obs=await ex.observe('w');
    const r=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:r.status,sent}).toEqual({status:'needs_consent',sent:[]});
  });

  it('credits by a hands-style receipt (absolute paths): the receipt is the task\'s, a concurrent change another program\'s',async()=>{
    const root=fs.mkdtempSync('/private/tmp/pr16-round9-receipt-'),ws=new Workspace(root),signer=ConsentSigner.fresh();
    let epoch=1;const w={id:'w',app:'TextEdit',title:'hello.txt'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,elements:[{id:'save',role:'menuItem',label:'Save',actions:['click']}]}),perform:()=>{
      epoch++;
      fs.writeFileSync(path.join(root,'hello.txt'),'你好 DeskMind');              // the app's save, which the driver vouches for
      fs.writeFileSync(path.join(root,'synced.txt'),'from a sync client');      // at the same moment, not in the receipt
      return {status:'ok',window:'w',files:[{path:path.join(fs.realpathSync(root),'hello.txt'),sha256:sha('你好 DeskMind')}],document:path.join(root,'hello.txt')};
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe('w');
    const r=await ex.act({action:{kind:'click',window:'w',target:'save'},epoch:obs.epoch,consent:signer.forObject('window:w','modify_user','t')});
    expect({status:r.status,files:r.files,mine:ex.ledger.ownerOf('path:hello.txt'),theirs:ex.ledger.ownerOf('path:synced.txt'),changes:ex.changes()}).toEqual({status:'ok',files:['hello.txt'],mine:'task',theirs:'user',changes:{created:['hello.txt'],modified:[],deleted:[],external:['synced.txt'],unconfirmed:[]}});
  });

  it('matches a receipt in resolved form when the task folder is given through a link (/tmp is /private/tmp)',async()=>{
    const real=fs.mkdtempSync('/private/tmp/pr16-round9-real-'),linked=real+'-link';fs.symlinkSync(real,linked);
    const ws=new Workspace(linked),signer=ConsentSigner.fresh();let epoch=1;const w={id:'w',app:'TextEdit',title:'hello.txt'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:w.app,windows:[w]}),observe:()=>({epoch,window:w,modal:null,elements:[{id:'save',role:'menuItem',label:'Save',actions:['click']}]}),perform:()=>{
      epoch++;fs.writeFileSync(path.join(real,'hello.txt'),'你好 DeskMind');return {status:'ok',window:'w',files:[{path:path.join(real,'hello.txt'),sha256:sha('你好 DeskMind')}]};
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe('w');
    const r=await ex.act({action:{kind:'click',window:'w',target:'save'},epoch:obs.epoch,consent:signer.forObject('window:w','modify_user','t')});
    expect({files:r.files,mine:ex.ledger.ownerOf('path:hello.txt')}).toEqual({files:['hello.txt'],mine:'task'});
  });

  it('refuses a move when its destination parent becomes a symlink during the intent check',async()=>{
    const root=fs.mkdtempSync('/private/tmp/pr16-round9-root-'),outside=fs.mkdtempSync('/private/tmp/pr16-round9-outside-');
    build(root,{'source.txt':'task source content','destination':null});
    fs.writeFileSync(path.join(outside,'renamed.txt'),'outside user document');
    const ws=new Workspace(root),signer=ConsentSigner.fresh();let swapped=false;
    const judge={choose:async()=>{
      if(!swapped){swapped=true;fs.rmdirSync(path.join(root,'destination'));fs.symlinkSync(outside,path.join(root,'destination'));}
      return {choice:'matches',by:'test'};
    }} as any;
    const ex=new Executor(new SimComputer(root),{task:'t',raw:'move source.txt to destination/renamed.txt',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});expect(swapped).toBe(false);
    const r=await ex.act({action:{kind:'file',capability:'fs.move',args:{source:'source.txt',destination:'destination/renamed.txt'}},epoch:ex.currentEpoch,consent:signer.forObject('path:source.txt','modify_user','t')});
    expect({status:r.status,source:fs.existsSync(path.join(root,'source.txt')),outside:fs.readFileSync(path.join(outside,'renamed.txt'),'utf8')}).toEqual({status:'stale',source:true,outside:'outside user document'});
  });
});
