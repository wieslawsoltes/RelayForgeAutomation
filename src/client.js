/** Versioned request/reply protocol. Every pending request settles or times out. */
export class SimulatorClient {
  constructor(onEvent){
    this.worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module',name:'RelayForge PLC'});this.pending=new Map();this.serial=0;this.onEvent=onEvent;
    this.worker.onmessage=({data})=>{if(data.id&&this.pending.has(data.id)){const pending=this.pending.get(data.id);this.pending.delete(data.id);clearTimeout(pending.timeout);data.ok===false?pending.reject(Object.assign(new Error(data.error||data.diagnostics?.map(d=>d.message).join('\n')||'Simulation command failed.'),{response:data})):pending.resolve(data);}else this.onEvent(data);};
    this.worker.onerror=event=>{for(const p of this.pending.values()){clearTimeout(p.timeout);p.reject(new Error(event.message||'Simulation worker failed.'));}this.pending.clear();this.onEvent({type:'fault',message:event.message||'Simulation worker failed. Check browser module-worker support.'});};
  }
  request(type,payload={}){return new Promise((resolve,reject)=>{const id=++this.serial,timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Simulation request '${type}' timed out.`));},15000);this.pending.set(id,{resolve,reject,timeout});this.worker.postMessage({id,type,...payload});});}
  dispose(){this.worker.terminate();for(const p of this.pending.values()){clearTimeout(p.timeout);p.reject(new Error('Simulator disposed.'));}this.pending.clear();}
}
