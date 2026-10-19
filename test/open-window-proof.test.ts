import { describe, it, expect } from 'vitest';
import { Executor } from '../src/executor/executor.js';
import { ConsentSigner } from '../src/executor/consent.js';
import type { Driver, WindowInfo } from '../src/executor/types.js';

// an app that open_window launches comes back with a window it restored from its last session: the driver returns it
// to observe, without `new_window` (it cannot prove the action made it)
describe('open_window: a window is the task\'s only on the driver\'s proof',()=>{
  const setup=(proof:boolean)=>{
    let epoch=1;const wins:WindowInfo[]=[];const effects:string[]=[];
    const restored={id:'Notes#7',app:'Notes',title:'Shopping list'};
    const driver:Driver={snapshot:()=>({epoch,locked:false,front_app:wins[0]?.app??'',windows:[...wins]}),
      observe:id=>({epoch,window:wins.find(w=>w.id===id)!,modal:null,elements:[{id:'del',role:'button',label:'Delete note',actions:['click']}]}),
      perform:a=>{epoch++;if(a.kind==='open_window'){wins.push(restored);return {status:'ok',window:restored.id,...(proof?{new_window:restored}:{})};}effects.push(a.kind);return {status:'ok',window:restored.id};}};
    const signer=ConsentSigner.fresh(),ex=new Executor(driver,{task:'t',publicKey:signer.publicKey});
    return {ex,effects,restored};
  };
  it('a window it lands in without new_window stays the user\'s: acting in it needs a plan',async()=>{
    const {ex,effects,restored}=setup(false);
    await ex.begin();
    const opened=await ex.act({action:{kind:'open_window',app:'Notes'},epoch:ex.currentEpoch});
    const obs=await ex.observe(restored.id);
    const r=await ex.act({action:{kind:'click',window:restored.id,target:'del'},epoch:obs.epoch});
    expect({opened:opened.status,owner:ex.ledger.ownerOf(`window:${restored.id}`),status:r.status,effects,undo:ex.undoable().steps[0]?.can}).toEqual({opened:'ok',owner:'user',status:'needs_plan',effects:[],undo:false});
  });
  it('a window the driver says it made is the task\'s',async()=>{
    const {ex,restored}=setup(true);
    await ex.begin();
    await ex.act({action:{kind:'open_window',app:'Notes'},epoch:ex.currentEpoch});
    expect({owner:ex.ledger.ownerOf(`window:${restored.id}`),undo:ex.undoable().steps[0]?.can}).toEqual({owner:'task',undo:true});
  });
});
