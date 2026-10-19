import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer, ZH_MAIL_TEXTS } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import { EventLog } from '../src/protocol/events.js';
import type { Driver } from '../src/executor/types.js';

const dir=()=>fs.mkdtempSync('/private/tmp/pr16-round3-');
const file=(ex:Executor,capability:string,args:Record<string,string>,consent?:any)=>ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));

describe('PR16 third review probes',()=>{
  it('does not authorize changed outgoing content using an old observation and a fresh snapshot',async()=>{
    const sim=new SimComputer(),signer=ConsentSigner.fresh();
    const w=sim.addMail({app:'Mail',texts:ZH_MAIL_TEXTS,flagged:[],selected:'m1',composing:{to:'m1',body:'Approved A'},inbox:[{id:'m1',from:'Alice',subject:'Contract',body:['hello'],time:'10:00'}]});
    const ex=new Executor(sim,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe(w.id);
    const action={kind:'click' as const,window:w.id,target:obs.elements.find(e=>e.sends)!.id};
    const challenge=(await ex.act({action,epoch:obs.epoch})).challenge!;
    expect(challenge.text).toContain('Approved A');
    w.state.composing.body='Unapproved B';sim.epoch++;
    const snapshot=await ex.snapshot();
    // a snapshot gave a newer epoch, but the window was last observed with A: no card is made from it
    const fresh=await ex.act({action,epoch:snapshot.epoch});
    expect({status:fresh.status,challenge:fresh.challenge,sent:w.state.replies}).toEqual({status:'stale',challenge:undefined,sent:[]});
    // observed again, the card shows what would really go out
    const again=await ex.observe(w.id);
    const card=await ex.act({action,epoch:again.epoch});
    expect(card.status).toBe('needs_consent');expect(card.challenge!.text).toContain('Unapproved B');expect(card.challenge!.text).not.toContain('Approved A');
  });

  it('does not credit a different directory file merely because the basename matches a save',async()=>{
    const root=dir();build(root,{'output':null,'incoming':null});
    const ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='click'&&action.target.endsWith(':sheet_save'))fs.writeFileSync(path.join(root,'incoming/report.txt'),'user-owned report from sync');
      return sim.perform(action);
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();const opened=await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch});
    const w=opened.after!.window.id;
    const act=async(kind:string,key:string,more:Record<string,string>={})=>{
      const obs=await ex.observe(w);const target=obs.elements.find(e=>e.id.endsWith(':'+key))!.id;
      const result=await ex.act({action:{kind,window:w,target,...more} as any,epoch:obs.epoch});expect(result.status).toBe('ok');return result;
    };
    await act('click','menu_new');await act('set_value','textarea',{value:'task report'});
    await act('click','menu_save');await act('set_value','sheet_name',{value:'report.txt'});await act('select','sheet_folder',{option:'output'});
    const saved=await act('click','sheet_save');expect(ws.read('output/report.txt')).toBe('task report');
    const removed=await file(ex,'fs.trash',{target:'incoming/report.txt'});
    expect({credited:saved.files,owner:ex.ledger.ownerOf('path:incoming/report.txt'),status:removed.status,exists:ws.exists('incoming/report.txt')}).toEqual({credited:['output/report.txt'],owner:'user',status:'stale',exists:true});
  });

  it('without a driver receipt, credits nothing: both changes are of unconfirmed origin',async()=>{
    const root=dir();build(root,{'output':null,'incoming':null});
    const ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:action=>{
      if(action.kind==='click'&&action.target.endsWith(':sheet_save'))fs.writeFileSync(path.join(root,'incoming/report.txt'),'user-owned report from sync');
      const {files:_receipt,...r}=sim.perform(action) as any;return r;
    }};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();const w=(await ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch})).after!.window.id;
    const act=async(kind:string,key:string,more:Record<string,string>={})=>{
      const obs=await ex.observe(w);const target=obs.elements.find(e=>e.id.endsWith(':'+key))!.id;
      return ex.act({action:{kind,window:w,target,...more} as any,epoch:obs.epoch});
    };
    await act('click','menu_new');await act('set_value','textarea',{value:'task report'});
    await act('click','menu_save');await act('set_value','sheet_name',{value:'report.txt'});await act('select','sheet_folder',{option:'output'});
    const saved=await act('click','sheet_save');
    // nothing on screen proves a write (the save sheet named output/report.txt, a sync client wrote incoming/report.txt at
    // the same moment): neither is the task's, neither is called another program's — both are unconfirmed
    expect({credited:saved.files,mine:ex.ledger.ownerOf('path:output/report.txt'),theirs:ex.ledger.ownerOf('path:incoming/report.txt'),external:ex.externalChanges.map(c=>c.path),unconfirmed:ex.changes().unconfirmed.sort()}).toEqual({credited:undefined,mine:'user',theirs:'user',external:[],unconfirmed:['incoming/report.txt','output/report.txt']});
  });

  it('rejects directory deletion if a child changes while the intent judge is answering',async()=>{
    const root=dir();build(root,{'folder/note.txt':'old content'});
    const ws=new Workspace(root),signer=ConsentSigner.fresh();
    const judge={choose:async()=>{fs.writeFileSync(path.join(root,'folder/note.txt'),'new user content');return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(new SimComputer(root),{task:'t',raw:'trash folder',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const result=await file(ex,'fs.trash',{target:'folder'},signer.forObject('path:folder','modify_user','t'));
    expect({status:result.status,exists:ws.exists('folder/note.txt')}).toEqual({status:'stale',exists:true});
  });

  it('reopens the app event log when its last event was cut off mid-write',()=>{
    const root=dir(),p=path.join(root,'events.jsonl');
    const log=new EventLog(p,'t');log.emit({kind:'start',raw:'task',lang:'zh',engine:'runtime'});
    fs.appendFileSync(p,'{"seq":2,"kind":"step","text":');
    expect(()=>new EventLog(p,'t')).not.toThrow();
  });

  it('waits if the user starts using the computer during the intent check',async()=>{
    let active=false;const effects:string[]=[];const w={id:'w',app:'Editor',title:'User document'};
    const driver:Driver={snapshot:()=>({epoch:1,locked:false,front_app:w.app,windows:[w],user_active:active}),observe:()=>({epoch:1,window:w,modal:null,elements:[{id:'delete',role:'button',label:'Delete',actions:['click']}]}),perform:()=>{effects.push('delete');return {status:'ok',window:'w'};}};
    const signer=ConsentSigner.fresh(),judge={choose:async()=>{active=true;return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(driver,{task:'t',raw:'delete',publicKey:signer.publicKey,judge,userWait:{ms:5,pollMs:1}});
    await ex.begin();await ex.plan({steps:[]});await ex.observe('w');
    const result=await ex.act({action:{kind:'click',window:'w',target:'delete'},epoch:1,consent:signer.forObject('window:w','modify_user','t')});
    expect({status:result.status,effects}).toEqual({status:'blocked',effects:[]});
  });

  it('processes MCP stop while act is waiting for the user to become idle',async()=>{
    const root=dir();const fake=path.join(root,'fake-hands.mjs');
    fs.writeFileSync(fake,`import * as fs from 'node:fs';import * as readline from 'node:readline';let n=0;
      const rl=readline.createInterface({input:process.stdin});
      rl.on('line',line=>{const m=JSON.parse(line);let result;
        if(m.op==='begin'||m.op==='snapshot'){n++;fs.writeFileSync(${JSON.stringify(path.join(root,'snapshot'))},String(n));result={epoch:1,locked:false,front_app:'',windows:[],user_active:n<3};}
        else if(m.op==='perform'){fs.writeFileSync(${JSON.stringify(path.join(root,'effect'))},'opened');result={status:'ok'};}
        else result={};process.stdout.write(JSON.stringify({id:m.id,ok:true,result})+'\\n');});
      rl.on('close',()=>process.exit(0));`);
    const child=spawn(process.execPath,['--import','tsx','src/cli/mcp.ts','--driver','hands'],{cwd:process.cwd(),env:{...process.env,DESKMIND_HANDS_CMD:process.execPath+' '+fake,DESKMIND_HANDS_DIR:root},stdio:['pipe','pipe','pipe']});
    const replies=new Map<number,any>();let buffer='',errors='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{errors+=s;});
    child.stdout.on('data',s=>{buffer+=s;let i;while((i=buffer.indexOf('\n'))>=0){const row=buffer.slice(0,i);buffer=buffer.slice(i+1);if(row){const msg=JSON.parse(row);replies.set(msg.id,msg);}}});
    const send=(id:number,name:string,args:Record<string,unknown>={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');
    const until=async(f:()=>boolean)=>{const end=Date.now()+10000;while(!f()){if(Date.now()>end)throw new Error('wait timeout '+errors);await delay(10);}};
    try{
      send(1,'begin',{raw:'open editor'});await until(()=>replies.has(1));
      send(2,'act',{action:{kind:'open_window',app:'Editor'},epoch:1});
      await until(()=>fs.existsSync(path.join(root,'snapshot'))&&Number(fs.readFileSync(path.join(root,'snapshot'),'utf8'))>=2);
      send(3,'stop');await until(()=>replies.has(2)&&replies.has(3));
      expect({act:replies.get(2).result.structuredContent.status,stopped:replies.get(3).result.structuredContent.stopped,effect:fs.existsSync(path.join(root,'effect'))}).toEqual({act:'stopped',stopped:true,effect:false});
    }finally{child.stdin.end();child.kill();}
  },20000);
});
