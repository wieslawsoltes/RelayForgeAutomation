import test from 'node:test';
import assert from 'node:assert/strict';
import {compileProject} from '../src/compiler.js';
import {PLC,evaluateFunctionBlock,TraceRing} from '../src/runtime.js';
import {createDemo} from '../src/demo.js';
import {History,coerce,validateProject} from '../src/model.js';
import {parseDuration,parseST} from '../src/language.js';
function simple(source,tags=[]){const p=createDemo();p.blocks=[{id:'main',name:'Main',number:1,kind:'OB',language:'ST',source}];p.tags=[...p.tags,...tags];p.plantEnabled=false;return p;}
function runtime(p){const result=compileProject(p);assert.equal(result.ok,true,JSON.stringify(result.diagnostics));return new PLC(result.program,{traceTags:p.trace,plant:p.plantEnabled});}
function tick(r,n=1){for(let i=0;i<n;i++)r.step();}
const fb=(kind,s,i,t)=>evaluateFunctionBlock(kind,s,i,t);
test('demonstration compiles all three languages to executable typed IR',()=>{const c=compileProject(createDemo());assert.equal(c.ok,true,JSON.stringify(c.diagnostics));assert.equal(Object.keys(c.program.blocks).length,3);assert.ok(c.program.references.length>20);});
test('seal-in circuit, TON delay, output commit, and immediate stop',()=>{const p=createDemo();p.plantEnabled=false;const r=runtime(p);r.enqueue('input','Start',true);tick(r);assert.equal(r.memory.RunRequest,true);assert.equal(r.outputs.Motor,false);r.enqueue('input','Start',false);tick(r,39);assert.equal(r.outputs.Motor,false);tick(r);assert.equal(r.outputs.Motor,true);assert.equal(r.memory.StartDelay,800);r.enqueue('input','Stop',true);tick(r);assert.equal(r.outputs.Motor,false);assert.equal(r.memory.RunRequest,false);});
test('TON exact start, completion and reset semantics',()=>{const s={};assert.deepEqual(fb('TON',s,{IN:true,PT:100},20),{Q:false,ET:0});assert.deepEqual(fb('TON',s,{IN:true,PT:100},119),{Q:false,ET:99});assert.deepEqual(fb('TON',s,{IN:true,PT:100},120),{Q:true,ET:100});assert.deepEqual(fb('TON',s,{IN:false,PT:100},140),{Q:false,ET:0});});
test('TON uses elapsed virtual time when an instance is skipped',()=>{const s={};fb('TON',s,{IN:true,PT:100},0);assert.deepEqual(fb('TON',s,{IN:true,PT:100},500),{Q:true,ET:100});});
test('TON zero preset completes on the first active invocation',()=>assert.deepEqual(fb('TON',{}, {IN:true,PT:0},0),{Q:true,ET:0}));
test('TOF starts on a falling edge and cancels on a rising input',()=>{const s={};assert.equal(fb('TOF',s,{IN:false,PT:50},0).Q,false);assert.equal(fb('TOF',s,{IN:true,PT:50},10).Q,true);assert.deepEqual(fb('TOF',s,{IN:false,PT:50},20),{Q:true,ET:0});assert.equal(fb('TOF',s,{IN:false,PT:50},70).Q,false);assert.deepEqual(fb('TOF',s,{IN:true,PT:50},80),{Q:true,ET:0});});
test('TP is non-retriggerable, latches its width and survives falling input',()=>{const s={};assert.equal(fb('TP',s,{IN:true,PT:100},0).Q,true);assert.equal(fb('TP',s,{IN:false,PT:1},20).Q,true);assert.equal(fb('TP',s,{IN:true,PT:200},40).Q,true);assert.equal(fb('TP',s,{IN:true,PT:200},100).Q,false);assert.equal(fb('TP',s,{IN:true,PT:200},110).Q,false);});
test('CTU counts only rising edges, reset wins',()=>{const s={};const call=(CU,R=false)=>fb('CTU',s,{CU,R,PV:2},0);assert.equal(call(true).CV,1);assert.equal(call(true).CV,1);call(false);assert.deepEqual(call(true),{CV:2,Q:true});assert.deepEqual(call(true,true),{CV:0,Q:false});assert.equal(call(true).CV,0);});
test('CTD load and zero detection',()=>{const s={};assert.equal(fb('CTD',s,{CD:false,LD:true,PV:1},0).CV,1);assert.deepEqual(fb('CTD',s,{CD:true,LD:false,PV:1},0),{CV:0,Q:true});});
test('CTUD simultaneous rising edges cancel, reset precedes load',()=>{const s={};assert.equal(fb('CTUD',s,{CU:true,CD:true,LD:false,R:false,PV:5},0).CV,0);assert.equal(fb('CTUD',s,{CU:false,CD:false,LD:true,R:true,PV:5},1).CV,0);});
test('edge detectors have deterministic initial states',()=>{assert.equal(fb('R_TRIG',{}, {CLK:true},0).Q,true);assert.equal(fb('F_TRIG',{}, {CLK:false},0).Q,false);const s={};fb('F_TRIG',s,{CLK:true},0);assert.equal(fb('F_TRIG',s,{CLK:false},1).Q,true);});
test('ST local state, nested expressions, ELSIF and FOR execute',()=>{const r=runtime(simple(`VAR i : DINT; total : DINT := 0; END_VAR
FOR i := 1 TO 5 DO total := total + i; END_FOR;
IF total < 10 THEN PartsCount := 1; ELSIF total = 15 THEN PartsCount := total; ELSE PartsCount := 99; END_IF;`));tick(r);assert.equal(r.memory.PartsCount,15);tick(r);assert.equal(r.memory.PartsCount,99);});
test('ST timer instance output mapping and member reads',()=>{const r=runtime(simple(`VAR d : TON; END_VAR d(IN := TRUE, PT := T#40ms, Q => Motor, ET => StartDelay); StartReady := d.Q;`));tick(r,2);assert.equal(r.outputs.Motor,false);tick(r);assert.equal(r.outputs.Motor,true);assert.equal(r.memory.StartReady,true);});
test('timer instances in separate user-block call sites have separate state',()=>{const p=simple('Analog_Scaling(); Analog_Scaling();');p.blocks.push({id:'f',name:'Analog_Scaling',number:1,kind:'FC',language:'ST',source:'VAR n : DINT := 0; END_VAR n := n + 1; PartsCount := n;'});const r=runtime(p);tick(r);assert.equal(r.memory.PartsCount,1);assert.equal(r.frames.size,3);});
test('FBD dependencies execute independently of document node order',()=>{const p=createDemo();p.blocks[1].nodes.reverse();const r=runtime(p);r.enqueue('input','Start',true);tick(r,41);assert.equal(r.outputs.FillValve,true);});
test('FBD combinational cycles are rejected',()=>{const p=createDemo();p.blocks[1].nodes[2].inputs.A={node:'f-enable',port:'OUT'};const c=compileProject(p);assert.equal(c.ok,false);assert.ok(c.diagnostics.some(d=>/cycle/.test(d.message)));});
test('unknown FBD source pins are rejected',()=>{const p=createDemo();p.blocks[1].nodes[2].inputs.A.port='MISSING';assert.equal(compileProject(p).ok,false);});
test('undefined symbols, writes to inputs and BOOL arithmetic are compile errors',()=>{for(const source of ['Missing := TRUE;','Start := TRUE;','Motor := Start + Stop;','PartsCount := 1.5;'])assert.equal(compileProject(simple(source)).ok,false,source);});
test('recursive block invocation is rejected',()=>{const p=simple('Child();');p.blocks.push({id:'child',name:'Child',kind:'FC',number:2,language:'ST',source:'Child();'});assert.equal(compileProject(p).ok,false);});
test('REAL rounds to binary32, integers and TIME are range checked',()=>{assert.equal(coerce(0.1,'REAL'),Math.fround(0.1));assert.throws(()=>coerce(32768,'INT'));assert.throws(()=>coerce(-1,'TIME'));assert.throws(()=>coerce(1.1,'DINT'));assert.throws(()=>coerce(Infinity,'REAL'));});
test('integer division truncates and conversion is explicit',()=>{const r=runtime(simple('PartsCount := 7 / 2; SpeedCommand := TO_REAL(PartsCount);'));tick(r);assert.equal(r.memory.PartsCount,3);assert.equal(r.outputs.SpeedCommand,3);});
test('divide-by-zero faults prevent partial physical output commit',()=>{const r=runtime(simple('Motor := TRUE; PartsCount := 1 / 0;'));assert.throws(()=>r.step(),/Division by zero/);assert.equal(r.outputs.Motor,false);assert.equal(r.scan,0);assert.ok(r.fault);});
test('operation budget and loop limits stop a runaway program',()=>{const r=runtime(simple('VAR i : DINT; END_VAR FOR i := 1 TO 20000 DO PartsCount := PartsCount + 1; END_FOR;'));assert.throws(()=>r.step(),/budget|iteration limit/);assert.equal(r.outputs.Motor,false);});
test('forcing inputs overrides sampled I/O and release restores physical value',()=>{const r=runtime(simple('Motor := Start;'));r.enqueue('force','Start',true);tick(r);assert.equal(r.outputs.Motor,true);r.enqueue('release','Start');tick(r);assert.equal(r.outputs.Motor,false);});
test('forcing outputs overrides program command and STOP deenergizes them',()=>{const r=runtime(simple('Motor := FALSE;'));r.enqueue('force','Motor',true);tick(r);assert.equal(r.outputs.Motor,true);assert.equal(r.memory.Motor,false);r.safeStop();assert.equal(r.snapshot().values.Motor,false);});
test('input events are applied atomically at the next scan boundary',()=>{const r=runtime(simple('Motor := Start;'));r.enqueue('input','Start',true);assert.equal(r.inputs.Start,false);tick(r);assert.equal(r.outputs.Motor,true);assert.equal(r.events[0].atScan,0);});
test('repeated runs with the same scan-indexed inputs are deterministic',()=>{function run(){const p=createDemo();p.plantEnabled=false;const r=runtime(p);r.enqueue('input','Start',true);for(let i=0;i<200;i++){if(i===1)r.enqueue('input','Start',false);if(i%30===0)r.enqueue('input','PartSensor',true);if(i%30===1)r.enqueue('input','PartSensor',false);r.step();}return {m:r.memory,trace:r.trace.samples(),instances:[...r.instances]};}assert.deepEqual(run(),run());});
test('history uses atomic immutable project transactions',()=>{const h=new History(createDemo());h.transact('Rename',p=>p.name='Changed');assert.equal(h.project.name,'Changed');h.undo();assert.equal(h.project.name,'Bottling_Cell');h.redo();assert.equal(h.project.name,'Changed');assert.throws(()=>h.transact('Bad edit',p=>p.cycleMs=0));assert.equal(h.project.cycleMs,20);});
test('bounded trace buffer preserves chronological samples',()=>{const t=new TraceRing(['a'],3);for(let i=0;i<5;i++)t.push(i*20,i,{a:i});assert.deepEqual(t.samples().map(s=>s.values.a),[2,3,4]);assert.ok(t.csv().includes('scan,time_ms,"a"'));});
test('TIME parser supports compound durations, rejects malformed values',()=>{assert.equal(parseDuration('T#1m2s50ms'),62050);assert.throws(()=>parseDuration('T#3cats'));assert.throws(()=>parseDuration('T#0.1ms'));});
test('nested comments and signed numeric literals parse safely',()=>{assert.equal(parseST('(* outer (* inner *) *) PartsCount := -12;').body.length,1);const r=runtime(simple('PartsCount := -2147483648;'));tick(r);assert.equal(r.memory.PartsCount,-2147483648);});
test('project import rejects unsupported schema and duplicate identities',()=>{const p=createDemo();p.schemaVersion=2;assert.throws(()=>validateProject(p));p.schemaVersion=1;p.tags[1].id=p.tags[0].id;assert.throws(()=>validateProject(p));});
test('warm restart retains only selected memory tags',()=>{const r=runtime(simple('PartsCount := PartsCount + 1;'));r.enqueue('write','BatchTarget',30);tick(r);r.warmReset();assert.equal(r.memory.BatchTarget,30);assert.equal(r.memory.PartsCount,0);r.coldReset();assert.equal(r.memory.BatchTarget,12);});
test('future input events are ordered by scan and preserve sub-scan button pulses',()=>{
  const r=runtime(simple('Motor := Start;'));r.enqueue('input','Start',true,2);r.enqueue('input','Start',false,3);
  tick(r,2);assert.equal(r.outputs.Motor,false);tick(r);assert.equal(r.outputs.Motor,true);tick(r);assert.equal(r.outputs.Motor,false);
  assert.deepEqual(r.events.map(e=>e.atScan),[2,3]);
  assert.throws(()=>r.enqueue('input','Start',true,0));
});
test('disconnected recursive blocks are rejected',()=>{
  const p=simple('Motor := FALSE;');p.blocks.push({id:'child',name:'Child',kind:'FC',number:2,language:'ST',source:'Child();'});
  assert.equal(compileProject(p).ok,false);
});
