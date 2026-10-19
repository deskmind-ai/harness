import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer, ZH_MAIL_TEXTS } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

const dir = () => fs.mkdtempSync('/private/tmp/pr16-round2-');
const file = (ex: Executor, capability: string, args: Record<string, string>, consent?: any) => ex.act({action:{kind:'file',capability,args},epoch:ex.currentEpoch,consent});
const mail = (body: string) => {
  const sim=new SimComputer();
  const w=sim.addMail({app:'Mail',texts:ZH_MAIL_TEXTS,flagged:[],selected:'m1',composing:{to:'m1',body},inbox:[{id:'m1',from:'Alice',subject:'Contract',body:['hello'],time:'10:00'}]});
  return {sim,w};
};

describe('PR16 second review probes', () => {
  it('does not reuse an approved send after the draft content changes', async () => {
    const {sim,w}=mail('Approved reply'), signer=ConsentSigner.fresh();
    const ex=new Executor(sim,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});
    let obs=await ex.observe(w.id);
    const action={kind:'click' as const,window:w.id,target:obs.elements.find(e=>e.sends)!.id};
    const first=await ex.act({action,epoch:obs.epoch});
    expect(first.status).toBe('needs_consent');
    expect(first.challenge!.text).toContain('Approved reply');
    const consent=signer.forAction(first.challenge!);
    w.state.composing.body='Unapproved replacement';sim.epoch++;
    obs=await ex.observe(w.id);
    const second=await ex.act({action,epoch:obs.epoch,consent});
    expect({status:second.status,sent:w.state.replies}).toEqual({status:'needs_consent',sent:[]});
  });

  it('keeps a write blocked after a conflict until the actor reads again', async () => {
    const root=dir();build(root,{'note.txt':'original'});
    const ws=new Workspace(root), signer=ConsentSigner.fresh();let changed=false;
    const judge={choose:async()=>{if(!changed){changed=true;fs.writeFileSync(path.join(root,'note.txt'),'new user edits');}return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(new SimComputer(root),{task:'t',raw:'replace the old text',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const consent=signer.forObject('path:note.txt','modify_user','t');
    expect((await file(ex,'fs.replace_text',{target:'note.txt',text:'replacement'},consent)).status).toBe('stale');
    const retry=await file(ex,'fs.replace_text',{target:'note.txt',text:'replacement'},consent);
    expect({status:retry.status,text:ws.read('note.txt')}).toEqual({status:'stale',text:'new user edits'});
  });

  it('requires consent before trashing user content inside a task-created directory', async () => {
    const root=dir(), ws=new Workspace(root), signer=ConsentSigner.fresh();
    const ex=new Executor(new SimComputer(root),{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    expect((await file(ex,'fs.mkdir',{path:'output'})).status).toBe('ok');
    fs.writeFileSync(path.join(root,'output','user.txt'),'user-owned document');ws.invalidate();
    // the file put in since the task last looked: first look again, then the user's consent
    const unseen=await file(ex,'fs.trash',{target:'output'});
    expect({status:unseen.status,exists:ws.exists('output/user.txt')}).toEqual({status:'stale',exists:true});
    expect((await file(ex,'fs.list',{path:'output'})).status).toBe('ok');
    const result=await file(ex,'fs.trash',{target:'output'});
    expect({status:result.status,exists:ws.exists('output/user.txt')}).toEqual({status:'needs_consent',exists:true});
  });

  it('does not adopt a concurrent external write during an unrelated GUI action', async () => {
    const root=dir(), ws=new Workspace(root), signer=ConsentSigner.fresh(), sim=new SimComputer(root);
    let release!:()=>void, started!:()=>void;
    const ready=new Promise<void>(r=>{started=r}), pending=new Promise<void>(r=>{release=r});
    const driver:Driver={snapshot:()=>sim.snapshot(),observe:id=>sim.observe(id),perform:async action=>{started();await pending;return sim.perform(action);}};
    const ex=new Executor(driver,{task:'t',publicKey:signer.publicKey,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();
    const opening=ex.act({action:{kind:'open_window',app:'Editor'},epoch:ex.currentEpoch});
    await ready;fs.writeFileSync(path.join(root,'user.txt'),'written by a sync client');release();
    expect((await opening).status).toBe('ok');
    const removal=await file(ex,'fs.trash',{target:'user.txt'});
    expect({status:removal.status,owner:ex.ledger.ownerOf('path:user.txt'),exists:ws.exists('user.txt')}).toEqual({status:'stale',owner:'user',exists:true});
  });

  it('includes the complete outgoing text in an external consent request', async () => {
    const body='x'.repeat(300)+' I accept the additional charge.';
    const {sim,w}=mail(body), signer=ConsentSigner.fresh();
    const ex=new Executor(sim,{task:'t',publicKey:signer.publicKey});
    await ex.begin();await ex.plan({steps:[]});const obs=await ex.observe(w.id);
    const r=await ex.act({action:{kind:'click',window:w.id,target:obs.elements.find(e=>e.sends)!.id},epoch:obs.epoch});
    expect(r.status).toBe('needs_consent');
    expect(r.challenge!.text).toContain('I accept the additional charge.');
  });

  it('recovers a durable intent when a crash leaves a partial trailing receipt', async () => {
    const root=dir(), journal=path.join(root,'journal.jsonl'), signer=ConsentSigner.fresh();
    const first=new Executor(new SimComputer(),{task:'t',publicKey:signer.publicKey,journal,crashAfterFirstEffect:true});
    await first.begin();
    await expect(first.act({action:{kind:'open_window',app:'Editor'},epoch:first.currentEpoch})).rejects.toThrow('crash after');
    fs.appendFileSync(journal,'{"kind":"receipt","status":');
    const next=new Executor(new SimComputer(),{task:'t',publicKey:signer.publicKey,journal});
    await expect(next.begin()).resolves.toBeDefined();
    expect(next.recovered?.finding).toBe('unknown');
    // the fragment is kept on a line of its own; the recovery's receipt after it is whole, so a third start finds nothing to recover
    const lines=fs.readFileSync(journal,'utf-8').split('\n');
    expect(lines).toContain('{"kind":"receipt","status":');
    expect(JSON.parse(lines.filter(Boolean).at(-1)!)).toMatchObject({kind:'receipt',recovered:true});
    const third=new Executor(new SimComputer(),{task:'t',publicKey:signer.publicKey,journal});
    await third.begin();
    expect(third.recovered).toBeNull();
  });
});
