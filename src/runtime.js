import {coerce,defaultValue,FB_SPECS} from './model.js';
/** Function-block state transitions. 'now' is integer virtual milliseconds, never wall time. */
export function evaluateFunctionBlock(kind,state,input,now){
  const s=state;let out;
  if(['TON','TOF','TP'].includes(kind)){
    const IN=input.IN,PT=coerce(input.PT,'TIME');
    if(kind==='TON'){
      if(!IN){s.start=null;out={Q:false,ET:0};}
      else{if(s.start==null)s.start=now;const ET=Math.min(PT,Math.max(0,now-s.start));out={Q:ET>=PT,ET};}
    }else if(kind==='TOF'){
      if(IN){s.start=null;out={Q:true,ET:0};}
      else{if(s.prev===true)s.start=now;const ET=s.start==null?0:Math.min(PT,Math.max(0,now-s.start));out={Q:s.start!=null&&ET<PT,ET};}
    }else{
      if(s.active&&now-s.start>=s.preset)s.active=false;
      if(IN&&!s.prev&&!s.active){s.start=now;s.preset=PT;s.active=PT>0;}
      let ET=s.start==null?0:Math.min(s.preset,Math.max(0,now-s.start));
      if(!s.active&&!IN){s.start=null;ET=0;}
      out={Q:!!s.active,ET};
    }
    s.prev=IN;
  }else if(['CTU','CTD','CTUD'].includes(kind)){
    const PV=coerce(input.PV,'DINT');if(PV<0)throw new Error('Counter PV must be nonnegative.');
    let CV=s.CV??0;const up=!!input.CU&&!s.prevCU,down=!!input.CD&&!s.prevCD;
    if(input.R)CV=0;
    else if(input.LD)CV=PV;
    else if(kind==='CTU'&&up)CV=Math.min(2147483647,CV+1);
    else if(kind==='CTD'&&down)CV=Math.max(0,CV-1);
    else if(kind==='CTUD'&&up!==down)CV=up?Math.min(2147483647,CV+1):Math.max(0,CV-1);
    s.CV=CV;s.prevCU=!!input.CU;s.prevCD=!!input.CD;
    out=kind==='CTUD'?{CV,QU:CV>=PV,QD:CV<=0}:{CV,Q:kind==='CTD'?CV<=0:CV>=PV};
  }else if(kind==='R_TRIG'||kind==='F_TRIG'){
    out={Q:kind==='R_TRIG'?input.CLK&&!s.prev:!input.CLK&&s.prev===true};s.prev=input.CLK;
  }else throw new Error(`Unknown runtime function block '${kind}'.`);
  s.outputs=out;return out;
}
export class TraceRing {
  constructor(keys,capacity=4096){this.keys=[...keys];this.capacity=capacity;this.length=0;this.head=0;this.times=new Float64Array(capacity);this.scans=new Float64Array(capacity);this.columns=Object.fromEntries(keys.map(k=>[k,new Float64Array(capacity)]));}
  push(time,scan,values){const i=this.head;this.times[i]=time;this.scans[i]=scan;for(const k of this.keys)this.columns[k][i]=Number(values[k]??0);this.head=(i+1)%this.capacity;this.length=Math.min(this.length+1,this.capacity);}
  samples(limit=this.capacity){const count=Math.min(limit,this.length),start=(this.head-count+this.capacity)%this.capacity,result=[];for(let k=0;k<count;k++){const i=(start+k)%this.capacity;result.push({timeMs:this.times[i],scan:this.scans[i],values:Object.fromEntries(this.keys.map(name=>[name,this.columns[name][i]]))});}return result;}
  clear(){this.head=0;this.length=0;}
  csv(){const escape=s=>'"'+String(s).replaceAll('"','""')+'"';return ['scan,time_ms,'+this.keys.map(escape).join(','),...this.samples().map(s=>[s.scan,s.timeMs,...this.keys.map(k=>s.values[k])].join(','))].join('\r\n');}
}
export class RuntimeFault extends Error {constructor(message,location){super(message);this.name='RuntimeFault';this.location=location;}}
export class PLC {
  constructor(program,options={}){
    this.program=program;this.operationLimit=options.operationLimit||100000;
    this.tags=new Map(program.tags.map(t=>[t.name,t]));this.force=new Map();this.pending=[];this.events=[];this.eventOverflow=0;
    this.trace=new TraceRing(options.traceTags?.filter(n=>this.tags.has(n))||program.tags.slice(0,12).map(t=>t.name));
    this.plantEnabled=!!options.plant;this.plant={level:28};this.coldReset();
  }
  coldReset(){
    this.memory=Object.fromEntries([...this.tags].map(([n,t])=>[n,coerce(t.initial,t.type)]));
    this.inputs=Object.fromEntries([...this.tags].filter(([,t])=>t.io==='input').map(([n,t])=>[n,coerce(t.initial,t.type)]));
    this.outputs=Object.fromEntries([...this.tags].filter(([,t])=>t.io==='output').map(([n,t])=>[n,defaultValue(t.type)]));
    this.frames=new Map();this.instances=new Map();this.scan=0;this.timeMs=0;this.operations=0;this.signals={};this.executed=[];this.fault=null;this.pending=[];this.force.clear();this.events=[];this.eventOverflow=0;this.trace.clear();this.plant={level:28};this.lastCPUms=0;this.maxCPUms=0;
  }
  warmReset(){const retained=Object.fromEntries([...this.tags].filter(([,t])=>t.retain&&t.io==='memory').map(([n])=>[n,this.memory[n]]));this.coldReset();Object.assign(this.memory,retained);}
  safeStop(){for(const [name,t]of this.tags)if(t.io==='output'){this.outputs[name]=defaultValue(t.type);this.memory[name]=defaultValue(t.type);}}
  enqueue(kind,tag,value,atScan=this.scan){
    const t=this.tags.get(tag);if(!t)throw new Error(`Unknown tag '${tag}'.`);
    if(kind==='input'&&t.io!=='input')throw new Error(`${tag} is not an input.`);
    if(kind==='force'&&t.io==='memory')throw new Error('Force is restricted to simulated I/O; use Modify for memory.');
    if(!['input','write','force','release'].includes(kind))throw new Error('Unknown I/O event.');
    if(kind!=='release')value=coerce(value,t.type);
    if(this.pending.length>=10000)throw new Error('Pending event queue is full.');
    if(!Number.isInteger(atScan)||atScan<this.scan||atScan>this.scan+10000)throw new Error('Invalid event scan index.');
    this.pending.push({kind,tag,value,atScan});
  }
  applyPending(){
    const future=[];
    for(const e of this.pending){
      if(e.atScan>this.scan){future.push(e);continue;}
      if(e.kind==='force')this.force.set(e.tag,e.value);
      else if(e.kind==='release')this.force.delete(e.tag);
      else if(this.tags.get(e.tag).io==='input')this.inputs[e.tag]=e.value;
      else this.memory[e.tag]=e.value;
      if(this.events.length<20000)this.events.push({...e,atScan:this.scan});else this.eventOverflow++;
    }
    this.pending=future;
  }
  readTag(name){return this.force.has(name)?this.force.get(name):this.memory[name];}
  values(physical=false){const result=Object.create(null);for(const [name,t]of this.tags)result[name]=physical&&t.io==='output'?this.outputs[name]:t.io==='input'?(this.force.has(name)?this.force.get(name):this.inputs[name]):this.readTag(name);return result;}
  consume(){if(++this.operations>this.operationLimit)throw new Error(`Instruction budget ${this.operationLimit} exceeded; scan stopped.`);}
  read(ref,frame){
    if(ref.kind==='tag')return this.readTag(ref.name);
    if(ref.kind==='temp')return frame.temps[ref.name];
    if(ref.kind==='local')return frame.locals[ref.name];
    if(ref.kind==='field')return this.instances.get(`${frame.scope}/${ref.name}`)?.outputs?.[ref.field]??defaultValue(ref.type);
    throw new Error(`Invalid load '${ref.kind}'.`);
  }
  write(ref,value,frame){
    const v=coerce(value,ref.type);
    if(ref.kind==='tag')this.memory[ref.name]=v;
    else if(ref.kind==='temp'){frame.temps[ref.name]=v;this.signals[`${frame.block}:${ref.name}`]=v;}
    else if(ref.kind==='local')frame.locals[ref.name]=v;
    else throw new Error('Invalid assignment destination.');
  }
  expression(e,frame){
    this.consume();let result;
    if(e.kind==='literal')result=e.value;
    else if(e.kind==='load')result=this.read(e.ref,frame);
    else if(e.kind==='unary'){const a=this.expression(e.arg,frame);result=e.operator==='NOT'?!a:e.operator==='-'?-a:a;}
    else if(e.kind==='binary'){
      // Deliberately evaluate both sides: deterministic contact monitoring, no hidden side effects.
      const a=this.expression(e.left,frame),b=this.expression(e.right,frame);
      switch(e.operator){
        case 'AND':result=a&&b;break;case 'OR':result=a||b;break;case 'XOR':result=a!==b;break;
        case '=':result=a===b;break;case '<>':result=a!==b;break;case '<':result=a<b;break;case '>':result=a>b;break;case '<=':result=a<=b;break;case '>=':result=a>=b;break;
        case '+':result=a+b;break;case '-':result=a-b;break;case '*':result=a*b;break;
        case '/':if(b===0)throw new Error('Division by zero.');result=e.type==='REAL'?a/b:Math.trunc(a/b);break;
        case 'MOD':if(b===0)throw new Error('Modulo by zero.');result=a%b;break;
        default:throw new Error(`Unknown operator '${e.operator}'.`);
      }
    }else if(e.kind==='function'){
      const a=e.args.map(v=>this.expression(v,frame));
      switch(e.name){
        case 'ABS':result=Math.abs(a[0]);break;
        case 'SQRT':if(a[0]<0)throw new Error('SQRT domain error.');result=Math.sqrt(a[0]);break;
        case 'MIN':result=Math.min(...a);break;case 'MAX':result=Math.max(...a);break;
        case 'LIMIT':if(a[0]>a[2])throw new Error('LIMIT lower bound exceeds upper bound.');result=Math.min(a[2],Math.max(a[0],a[1]));break;
        case 'TO_REAL':case 'INT_TO_REAL':result=a[0];break;
        case 'TO_INT':case 'REAL_TO_INT':result=Math.trunc(a[0]);break;
      }
    }else throw new Error(`Invalid IR expression '${e.kind}'.`);
    result=coerce(result,e.type);if(e.monitorId)this.signals[`${frame.block}:${e.monitorId}`]=result;return result;
  }
  runInstructions(body,frame,depth){
    for(const ins of body){
      this.consume();this.location={block:frame.block,...ins.source};
      if(this.executed.length<4096)this.executed.push(`${frame.block}:${ins.source?.id||''}`);
      if(ins.op==='noop')continue;
      if(ins.op==='assign'){
        const value=this.expression(ins.value,frame);this.write(ins.target,value,frame);this.signals[`${frame.block}:${ins.source?.id}`]=value;
      }else if(ins.op==='if'){
        let matched=false;
        for(const arm of ins.arms)if(this.expression(arm.condition,frame)){this.runInstructions(arm.body,frame,depth);matched=true;break;}
        if(!matched)this.runInstructions(ins.otherwise,frame,depth);
      }else if(ins.op==='for'){
        const from=this.expression(ins.from,frame),to=this.expression(ins.to,frame),by=this.expression(ins.by,frame);
        if(by===0)throw new Error('FOR step cannot be zero.');let n=0;
        this.write(ins.target,from,frame);
        for(let i=from;by>0?i<=to:i>=to;i+=by){if(++n>10000)throw new Error('FOR iteration limit 10000 exceeded.');this.write(ins.target,i,frame);this.runInstructions(ins.body,frame,depth);this.write(ins.target,i+by,frame);}
      }else if(ins.op==='invoke'){
        const key=`${frame.scope}/${ins.instance}`;let state=this.instances.get(key);if(!state){state={};this.instances.set(key,state);}
        const input=Object.fromEntries(Object.entries(ins.inputs).map(([pin,e])=>[pin,this.expression(e,frame)]));
        const output=evaluateFunctionBlock(ins.kind,state,input,this.timeMs);
        for(const [pin,ref]of Object.entries(ins.outputs))this.write(ref,output[pin],frame);
        this.signals[`${frame.block}:${ins.source?.id}`]=output.Q??output.QU??false;
        for(const [pin,v]of Object.entries(output))this.signals[`${frame.block}:${ins.source?.id}.${pin}`]=v;
      }else if(ins.op==='call')this.runBlock(ins.block,`${frame.scope}/${ins.source.id}:${ins.block}`,depth+1);
      else throw new Error(`Invalid IR instruction '${ins.op}'.`);
    }
  }
  runBlock(id,scope,depth=0){
    if(depth>32)throw new Error('Maximum call depth 32 exceeded.');
    const block=this.program.blocks[id];if(!block)throw new Error(`Compiled block '${id}' is missing.`);
    let frame=this.frames.get(scope);if(!frame){if(this.frames.size>=4096)throw new Error('Maximum instance-frame count exceeded.');frame={scope,block:id,locals:{...block.initials},temps:{}};this.frames.set(scope,frame);}
    frame.temps={};this.runInstructions(block.body,frame,depth);
  }
  advancePlant(){
    if(!this.plantEnabled)return;
    const dt=this.program.cycleMs/1000;
    const valve=!!this.outputs.FillValve,motor=!!this.outputs.Motor;
    this.plant.level=Math.max(0,Math.min(100,this.plant.level+dt*((valve?13:0)-(motor?5:0))));
    if(this.tags.get('LevelRaw')?.io==='input')this.inputs.LevelRaw=Math.round(this.plant.level/100*27648);
    if(this.tags.get('PartSensor')?.io==='input')this.inputs.PartSensor=motor&&(this.timeMs%1500)<120;
  }
  step(){
    if(this.fault)throw new RuntimeFault('Reset the CPU after a runtime fault.',this.fault.location);
    const start=performance.now();this.operations=0;this.signals={};this.executed=[];
    try{
      this.advancePlant();this.applyPending();
      // Scan boundary: sample digital/analog inputs once, execute OB, then atomically publish outputs.
      for(const [name,t]of this.tags)if(t.io==='input')this.memory[name]=this.force.has(name)?this.force.get(name):this.inputs[name];
      this.runBlock(this.program.entry,this.program.entry);
      const nextOutputs={};for(const [name,t]of this.tags)if(t.io==='output')nextOutputs[name]=coerce(this.readTag(name),t.type);
      this.outputs=nextOutputs;this.trace.push(this.timeMs,this.scan,this.values(true));this.scan++;this.timeMs+=this.program.cycleMs;
      this.lastCPUms=performance.now()-start;this.maxCPUms=Math.max(this.maxCPUms,this.lastCPUms);return {scan:this.scan,timeMs:this.timeMs};
    }catch(e){this.safeStop();this.fault={message:e.message,location:{...this.location},scan:this.scan,timeMs:this.timeMs};throw new RuntimeFault(e.message,this.location);}
  }
  snapshot(){return {scan:this.scan,timeMs:this.timeMs,cycleMs:this.program.cycleMs,values:this.values(true),programValues:{...this.memory},inputs:{...this.inputs},outputs:{...this.outputs},forces:Object.fromEntries(this.force),signals:{...this.signals},executed:this.executed,instances:Object.fromEntries([...this.instances].map(([k,v])=>[k,{...v.outputs}])),operations:this.operations,lastCPUms:this.lastCPUms,maxCPUms:this.maxCPUms,fault:this.fault,plantEnabled:this.plantEnabled,trace:this.trace.samples(240),eventOverflow:this.eventOverflow};}
}
