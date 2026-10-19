import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import { SimComputer } from '../src/executor/sim.js';
import { Workspace, build } from '../src/registry/workspace.js';
import { fileRegistry } from '../src/registry/fs.js';
import type { Driver } from '../src/executor/types.js';

describe('PR16 eleventh review probes',()=>{
  it('leaves no wait between the last file check and the write (the lock look comes first)',async()=>{
    const root=fs.mkdtempSync('/private/tmp/pr16-round11-');build(root,{'note.txt':"the user's text"});
    const ws=new Workspace(root),signer=ConsentSigner.fresh(),sim=new SimComputer(root);
    let judged=false;
    // every look at the screen after the judge answered is a moment another program may write the file
    const driver:Driver={snapshot:async()=>{if(judged)fs.writeFileSync(path.join(root,'note.txt'),'edited while the screen was looked at');return sim.snapshot();},observe:id=>sim.observe(id),perform:a=>sim.perform(a)};
    const judge={choose:async()=>{judged=true;return {choice:'matches',by:'test'};}} as any;
    const ex=new Executor(driver,{task:'t',raw:'replace the text',publicKey:signer.publicKey,judge,files:{workspace:ws,registry:fileRegistry()}});
    await ex.begin();await ex.plan({steps:[]});
    const r=await ex.act({action:{kind:'file',capability:'fs.replace_text',args:{target:'note.txt',text:'replacement'}},epoch:ex.currentEpoch,consent:signer.forObject('path:note.txt','modify_user','t')});
    expect({status:r.status,text:ws.read('note.txt')}).toEqual({status:'stale',text:'edited while the screen was looked at'});
  });
});
