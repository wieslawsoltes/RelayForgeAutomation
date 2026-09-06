import {compileProject} from './compiler.js';
import {PLC} from './runtime.js';
let plc=null,mode='STOP',revision=-1,speed=1,last=performance.now(),accumulator=0,lastPublish=0,timer=null;
const respond=(id,payload)=>postMessage({id,...payload,mode,revision});
function snapshot(){return plc?.snapshot()||null;}
function publish(){postMessage({type:'snapshot',mode,revision,data:snapshot(),backlogMs:Math.max(0,accumulator)});lastPublish=performance.now();}
function schedule(){if(timer===null)timer=setTimeout(pump,4);}
function pump(){
  timer=null;const now=performance.now();
  if(mode==='RUN'&&plc){
    accumulator+=(now-last)*speed;let count=0;
    try{while(accumulator>=plc.program.cycleMs&&count++<100){plc.step();accumulator-=plc.program.cycleMs;}}
    catch(e){mode='FAULT';accumulator=0;postMessage({type:'fault',message:e.message,location:e.location,revision});}
    if(now-lastPublish>=50||mode==='FAULT')publish();
  }
  last=now;if(mode==='RUN')schedule();
}
self.onmessage=event=>{
  const {id,type,...message}=event.data||{};
  try{
    if(type==='load'){
      const compiled=compileProject(message.project);
      if(!compiled.ok){respond(id,{ok:false,diagnostics:compiled.diagnostics});return;}
      mode='STOP';plc?.safeStop();revision=message.revision;accumulator=0;
      plc=new PLC(compiled.program,{traceTags:message.project.trace,plant:message.project.plantEnabled});
      respond(id,{ok:true,type:'loaded',diagnostics:compiled.diagnostics,data:snapshot()});publish();return;
    }
    if(!plc)throw new Error('Compile and download a project before starting the CPU.');
    if(message.revision!==undefined&&message.revision!==revision)throw new Error('Command belongs to an obsolete project revision. Compile and download again.');
    switch(type){
      case 'run':if(plc.fault)throw new Error('Reset the CPU after a runtime fault.');mode='RUN';last=performance.now();accumulator=0;schedule();break;
      case 'pause':mode='PAUSED';accumulator=0;break;
      case 'stop':mode='STOP';plc.safeStop();accumulator=0;break;
      case 'step':if(mode==='RUN')throw new Error('Pause before single-scanning.');mode='PAUSED';plc.step();break;
      case 'reset':mode='STOP';message.warm?plc.warmReset():plc.coldReset();accumulator=0;break;
      case 'io':plc.enqueue(message.kind,message.tag,message.value,plc.scan+(message.afterScans||0));if(mode!=='RUN')plc.applyPending();break;
      case 'releaseAll':for(const name of plc.force.keys())plc.enqueue('release',name);if(mode!=='RUN')plc.applyPending();break;
      case 'speed':if(![1,2,4,8,16].includes(message.value))throw new Error('Unsupported simulation speed.');speed=message.value;last=performance.now();break;
      case 'plant':plc.plantEnabled=!!message.value;break;
      case 'traceTags':throw new Error('Edit the project trace list and download to configure channels.');
      case 'exportTrace':respond(id,{ok:true,csv:plc.trace.csv(),events:plc.events,eventOverflow:plc.eventOverflow});return;
      case 'clearTrace':plc.trace.clear();break;
      case 'snapshot':break;
      default:throw new Error(`Unknown worker command '${type}'.`);
    }
    respond(id,{ok:true,data:snapshot()});publish();
  }catch(e){if(plc?.fault)mode='FAULT';respond(id,{ok:false,error:e.message,location:e.location,data:snapshot()});}
};
