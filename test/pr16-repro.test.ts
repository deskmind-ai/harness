import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { ConsentSigner } from '../src/executor/consent.js';
import { Executor } from '../src/executor/executor.js';
import { SimComputer, ZH_MAIL_TEXTS } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import { FrontierRuntime } from '../src/runtime/loop.js';
import { Gateway } from '../src/gateway/index.js';
import { scriptedStream } from '../src/runtime/scripted.js';
import { LineReader, StdioUser } from '../src/cli/app.js';
import { EventLog } from '../src/protocol/events.js';
import type { Driver } from '../src/executor/types.js';

const dir = () => fs.mkdtempSync('/private/tmp/pr16-repro-');
const table = Object.fromEntries(['goal','plan','bind','intent','choice','skill','verify','transform'].map(r => [r, { backend: 'scripted', model: 'scripted' }])) as any;
const model = { id:'scripted', name:'scripted', api:'openai-completions', provider:'test', baseUrl:'', input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, reasoning:false, contextWindow:1e6,maxTokens:1e5 } as any;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const file = (ex: Executor, capability: string, args: Record<string,string>, consent?: any) => ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});

describe('PR16 independent regression probes', () => {
  it('shows the recipient and actual outgoing message on an external consent card', async () => {
    const sim=new SimComputer(), signer=ConsentSigner.fresh();
    const w=sim.addMail({app:'Mail',texts:ZH_MAIL_TEXTS,flagged:[],selected:'m1',composing:{to:'m1',body:'Approved reply body'},inbox:[{id:'m1',from:'Alice',subject:'Contract',body:['hello'],time:'10:00'}]});
    const ex=new Executor(sim,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe(w.id);
    const r=await ex.act({action:{kind:'click',window:w.id,target:obs.elements.find(e=>e.sends)!.id},epoch:obs.epoch});
    expect(r.status).toBe('needs_consent');
    expect(r.challenge!.text).toContain('Approved reply body');
    expect(r.challenge!.text).toContain('Alice');
  });

  it('produces a rewrite when the runtime exposes fs_transform_text', async () => {
    const root=dir();build(root,{'source.txt':'你好'});
    const ws=new Workspace(root), signer=ConsentSigner.fresh(), ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey});
    const gw=new Gateway(table);gw.script=Array(20).fill((role:string)=>role==='transform'?{text:'Hello'}:{choice:'matches'});
    const rt=new FrontierRuntime({task:'t',raw:'translate source.txt into English as english.txt',executor:ex,signer,gateway:gw,workspace:ws,registry:fileRegistry(),user:{ask:()=>({option:0})},model:{model,streamFn:scriptedStream([
      {calls:[{name:'fs_transform_text',args:{source:'source.txt',instruction:'translate to English',destination:'english.txt'}}]},
      {calls:[{name:'finish',args:{outcome:'cannot',summary:'stop'}}]}
    ])}});
    await rt.run();
    const receipt=ex.receipts.find(r=>r.request.action.kind==='file');
    expect({status:receipt?.result.status,why:receipt?.result.why,exists:ws.exists('english.txt')}).toEqual({status:'ok',why:undefined,exists:true});
  });

  it('does not adopt an externally created file after an unrelated GUI action', async () => {
    const root=dir(), ws=new Workspace(root), signer=ConsentSigner.fresh(), sim=new SimComputer(root);
    const ex=new Executor(sim,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    fs.writeFileSync(path.join(root,'user.txt'),'user-owned data');
    await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch});
    // never read by the task: refused before the plan gate; once read, the plan gate holds (the user's file)
    const r=await file(ex,'fs.trash',{target:'user.txt'});
    expect({status:r.status,exists:ws.exists('user.txt'),owner:ex.ledger.ownerOf('path:user.txt')}).toEqual({status:'stale',exists:true,owner:'user'});
    expect((await file(ex,'fs.read_text',{target:'user.txt'})).status).toBe('ok');
    const r2=await file(ex,'fs.trash',{target:'user.txt'});
    expect({status:r2.status,exists:ws.exists('user.txt')}).toEqual({status:'needs_plan',exists:true});
  });

  it('does not sign sibling objects whose names are substrings of an approved path', async () => {
    const root=dir(); build(root,{'a.txt':'do not touch','data.txt':'approved'});
    const ws=new Workspace(root), signer=ConsentSigner.fresh(), ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey});
    const gw=new Gateway(table); gw.script=Array(20).fill(()=>({choice:'matches'}));
    const cards:any[]=[];
    const rt=new FrontierRuntime({task:'t',raw:'modify data.txt',executor:ex,signer,gateway:gw,workspace:ws,registry:fileRegistry(),user:{ask:c=>{cards.push(c);return {option:0};}},model:{model,streamFn:scriptedStream([
      {calls:[{name:'plan',args:{steps:[{purpose:'modify data.txt',objects:['path:data.txt'],consequence:'modify_user'}]}}]},
      {calls:[{name:'finish',args:{outcome:'cannot',summary:'stop'}}]}
    ])}});
    const result=await rt.run();
    expect(result.consents.map(c=>c.object)).toEqual(['path:data.txt']);
  });

  it('rejects an action when the user changed the selected row during the idle wait', async () => {
    let active=false, epoch=1, selected='row A'; const effects:string[]=[];
    const w={id:'w',app:'App',title:'Items'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:'App',windows:[w],user_active:active}),observe:()=>({epoch,window:w,modal:null,elements:[{id:'delete',role:'button',label:'Delete selected row',actions:['click']}]}),perform:()=>{effects.push(selected);return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh(), ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,userWait:{ms:500,pollMs:5}});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe('w');active=true;
    setTimeout(()=>{selected='row B';epoch++;active=false;},10);
    const r=await ex.act({action:{kind:'click',window:'w',target:'delete'},epoch:obs.epoch,consent:signer.forObject('window:w','modify_user','t')});
    expect({status:r.status,effects}).toEqual({status:'stale',effects:[]});
  });

  it('rejects a window action when the user changed the selected row while the intent judge answered', async () => {
    let epoch=1, selected='row A'; const effects:string[]=[];
    const w={id:'w',app:'App',title:'Items'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:'App',windows:[w]}),observe:()=>({epoch,window:w,modal:null,elements:[{id:'delete',role:'button',label:'Delete selected row',actions:['click']}]}),perform:()=>{effects.push(selected);return {status:'ok',window:'w'};}};
    const judge={choose:async()=>{await delay(1);selected='row B';epoch++;return {choice:'matches',by:'test'};}} as any;
    const signer=ConsentSigner.fresh(), ex=new Executor(driver,{task:'t',raw:'delete row A',publicKey:signer.publicKey,judge});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe('w');
    const r=await ex.act({action:{kind:'click',window:'w',target:'delete'},epoch:obs.epoch,consent:signer.forObject('window:w','modify_user','t')});
    expect({status:r.status,effects}).toEqual({status:'stale',effects:[]});
  });

  it('rechecks file versions after the asynchronous intent judge', async () => {
    const root=dir(); build(root,{'note.txt':'old'});const ws=new Workspace(root), signer=ConsentSigner.fresh();
    const judge={choose:async()=>{await delay(1);fs.writeFileSync(path.join(root,'note.txt'),'new user edits');return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(new SimComputer(root),{task:'t',raw:'replace the old text',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const r=await file(ex,'fs.replace_text',{target:'note.txt',text:'replacement'},signer.forObject('path:note.txt','modify_user','t'));
    expect({status:r.status,content:ws.read('note.txt')}).toEqual({status:'stale',content:'new user edits'});
  });

  it('finishes a runtime when stop arrives while a card is waiting', async () => {
    const root=dir(), input=new PassThrough(), reader=new LineReader(input), log=new EventLog(path.join(root,'events.jsonl'),'t');
    const signer=ConsentSigner.fresh(), ex=new Executor(new SimComputer(),{task:'t',publicKey:signer.publicKey});
    const rt=new FrontierRuntime({task:'t',raw:'ask me',executor:ex,signer,gateway:new Gateway(table),user:new StdioUser(log,reader),model:{model,streamFn:scriptedStream([{calls:[{name:'ask_user',args:{question:'which?',options:['a','b']}}]}])}});
    reader.onStop=()=>rt.stop();
    const running=rt.run();
    for(let i=0;i<100&&!log.events.some(e=>e.kind==='waiting');i++) await delay(5);
    expect(log.events.some(e=>e.kind==='waiting')).toBe(true);
    input.write('{"stop":true}\n');
    const result=await Promise.race([running.then(r=>r.status),delay(100).then(()=> 'still waiting')]);
    input.end(); await running;
    expect(result).toBe('stopped');
  });

  it('does not close the existing user browser window when undoing a newly opened tab', async () => {
    const sim=new SimComputer(), w=sim.addBrowser('Safari',[{title:'User work',url:'https://example.com/user'}]);
    const original=sim.perform.bind(sim);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:a=>{
      if(a.kind==='open_window') {w.state.tabs.push({id:'task-tab',title:'Task',url:a.url});sim.epoch++;return {status:'ok',window:w.id};}
      return original(a);
    }};
    const signer=ConsentSigner.fresh(), ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});
    const result=await ex.act({action:{kind:'open_window',app:'Safari',url:'https://example.com/task'},epoch:ex.currentEpoch,consent:signer.forObject(`window:${w.id}`,'modify_user','t')});
    expect(result.status).toBe('ok');
    await ex.undo();
    expect(sim.snapshot().windows.map(w=>w.id)).toContain(w.id);
  });
});
