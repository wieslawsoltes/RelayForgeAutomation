import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createDemo} from '../src/demo.js';
function harness(t){
  const worker=new Worker(new URL('./worker-adapter.mjs',import.meta.url));
  let serial=0;const pending=new Map();
  worker.on('message',data=>{const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);p.resolve(data);}});
  worker.on('error',error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();});
  t.after(()=>worker.terminate());
  return (type,values={})=>new Promise((resolve,reject)=>{
    const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${type}`));},5000);
    pending.set(id,{resolve,reject,timer});worker.postMessage({id,type,revision:1,...values});
  });
}
test('ES-module worker: download, scan, force, safe STOP and release',async t=>{
  const request=harness(t),project=createDemo();project.plantEnabled=false;
  assert.equal((await request('load',{project})).ok,true);
  await request('io',{kind:'input',tag:'Start',value:true});
  let r=await request('step');assert.equal(r.data.values.RunRequest,true);assert.equal(r.data.outputs.Motor,false);
  await request('io',{kind:'input',tag:'Start',value:false});
  for(let i=0;i<40;i++)r=await request('step');
  assert.equal(r.data.scan,41);assert.equal(r.data.outputs.Motor,true);
  await request('io',{kind:'force',tag:'Motor',value:false});r=await request('step');
  assert.equal(r.data.outputs.Motor,false);assert.equal(r.data.programValues.Motor,true);
  r=await request('stop');assert.equal(r.mode,'STOP');assert.equal(r.data.outputs.Motor,false);
  r=await request('releaseAll');assert.deepEqual(r.data.forces,{});
});
test('worker rejects stale revisions and invalid compilation without replacing CPU',async t=>{
  const request=harness(t),project=createDemo();await request('load',{project});
  assert.equal((await request('run',{revision:0})).ok,false);
  project.blocks[2].source='Motor := 7;';
  assert.equal((await request('load',{project,revision:2})).ok,false);
  const r=await request('step');assert.equal(r.ok,true);assert.equal(r.revision,1);
});
test('worker preserves one-scan momentary input events while paused',async t=>{
  const request=harness(t),project=createDemo();project.plantEnabled=false;await request('load',{project});
  await request('io',{kind:'input',tag:'Start',value:true});
  await request('io',{kind:'input',tag:'Start',value:false,afterScans:1});
  let r=await request('step');assert.equal(r.data.values.Start,true);assert.equal(r.data.values.RunRequest,true);
  r=await request('step');assert.equal(r.data.values.Start,false);assert.equal(r.data.values.RunRequest,true);
});
test('worker fault latches, clears physical outputs, requires reset',async t=>{
  const request=harness(t),project=createDemo();project.plantEnabled=false;
  project.blocks=[{id:'main',kind:'OB',name:'Main',number:1,language:'ST',source:'Motor := TRUE; PartsCount := 1 / 0;'}];
  await request('load',{project});let r=await request('step');assert.equal(r.ok,false);assert.equal(r.mode,'FAULT');assert.equal(r.data.outputs.Motor,false);
  assert.equal((await request('run')).ok,false);r=await request('reset');assert.equal(r.mode,'STOP');assert.equal(r.data.fault,null);
});
test('worker scheduler advances fixed virtual time and pause freezes it',async t=>{
  const request=harness(t),project=createDemo();project.plantEnabled=false;await request('load',{project});await request('run');
  await new Promise(r=>setTimeout(r,150));const paused=await request('pause');
  assert.ok(paused.data.scan>=1);assert.equal(paused.data.timeMs,paused.data.scan*20);
  await new Promise(r=>setTimeout(r,50));const later=await request('snapshot');assert.equal(later.data.scan,paused.data.scan);
  const trace=await request('exportTrace');assert.ok(trace.csv.startsWith('scan,time_ms,'));
});
