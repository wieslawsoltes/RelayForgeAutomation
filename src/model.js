export const SCHEMA_VERSION = 1;
export const TYPES = Object.freeze(['BOOL','INT','DINT','REAL','TIME']);
export const FB_TYPES = Object.freeze(['TON','TOF','TP','CTU','CTD','CTUD','R_TRIG','F_TRIG']);
export const FB_SPECS = Object.freeze({
  TON:{inputs:{IN:'BOOL',PT:'TIME'},outputs:{Q:'BOOL',ET:'TIME'}},
  TOF:{inputs:{IN:'BOOL',PT:'TIME'},outputs:{Q:'BOOL',ET:'TIME'}},
  TP:{inputs:{IN:'BOOL',PT:'TIME'},outputs:{Q:'BOOL',ET:'TIME'}},
  CTU:{inputs:{CU:'BOOL',R:'BOOL',PV:'DINT'},outputs:{Q:'BOOL',CV:'DINT'}},
  CTD:{inputs:{CD:'BOOL',LD:'BOOL',PV:'DINT'},outputs:{Q:'BOOL',CV:'DINT'}},
  CTUD:{inputs:{CU:'BOOL',CD:'BOOL',R:'BOOL',LD:'BOOL',PV:'DINT'},outputs:{QU:'BOOL',QD:'BOOL',CV:'DINT'}},
  R_TRIG:{inputs:{CLK:'BOOL'},outputs:{Q:'BOOL'}},
  F_TRIG:{inputs:{CLK:'BOOL'},outputs:{Q:'BOOL'}}
});
export const FBD_SPECS = Object.freeze({
  READ:{inputs:[],outputs:['OUT']}, CONST:{inputs:[],outputs:['OUT']}, WRITE:{inputs:['IN'],outputs:[]},
  AND:{inputs:['A','B'],outputs:['OUT']},OR:{inputs:['A','B'],outputs:['OUT']},XOR:{inputs:['A','B'],outputs:['OUT']},NOT:{inputs:['IN'],outputs:['OUT']},
  ADD:{inputs:['A','B'],outputs:['OUT']},SUB:{inputs:['A','B'],outputs:['OUT']},MUL:{inputs:['A','B'],outputs:['OUT']},DIV:{inputs:['A','B'],outputs:['OUT']},
  GT:{inputs:['A','B'],outputs:['OUT']},GE:{inputs:['A','B'],outputs:['OUT']},LT:{inputs:['A','B'],outputs:['OUT']},LE:{inputs:['A','B'],outputs:['OUT']},EQ:{inputs:['A','B'],outputs:['OUT']},
  ...Object.fromEntries(Object.entries(FB_SPECS).map(([k,s])=>[k,{inputs:Object.keys(s.inputs),outputs:Object.keys(s.outputs)}]))
});
export function uid(prefix='id'){return `${prefix}-${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;}
export function defaultValue(type){return type==='BOOL'?false:0;}
export function coerce(value,type) {
  if(type==='BOOL'){if(typeof value!=='boolean')throw new Error(`Expected BOOL, received ${String(value)}.`);return value;}
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`Expected finite ${type}, received ${String(value)}.`);
  if(type==='REAL'){const result=Math.fround(value);if(!Number.isFinite(result))throw new Error('REAL overflow.');return result;}
  if(!Number.isInteger(value))throw new Error(`Fractional value ${value} cannot be assigned to ${type}; use TO_INT.`);
  const [min,max]=type==='INT'?[-32768,32767]:type==='DINT'?[-2147483648,2147483647]:type==='TIME'?[0,2147483647]:[NaN,NaN];
  if(!Number.isFinite(min)||value<min||value>max)throw new Error(`${type} value ${value} is outside ${min}..${max}.`);
  return value;
}
export function parseInput(value,type){
  if(type==='BOOL'){
    if(value===true||value==='true'||value==='TRUE'||value==='1'||value===1)return true;
    if(value===false||value==='false'||value==='FALSE'||value==='0'||value===0)return false;
    throw new Error('BOOL expects TRUE or FALSE.');
  }
  if(typeof value==='string'&&!value.trim())throw new Error(`${type} value is required.`);
  return coerce(Number(value),type);
}
export function validateProject(p){
  if(!p||typeof p!=='object'||p.schemaVersion!==SCHEMA_VERSION)throw new Error('Unsupported project schema. Expected RelayForge schemaVersion 1.');
  if(typeof p.name!=='string'||p.name.length>200)throw new Error('Invalid project name.');
  if(!Number.isInteger(p.cycleMs)||p.cycleMs<1||p.cycleMs>1000)throw new Error('Cycle time must be 1..1000 ms.');
  if(!Array.isArray(p.tags)||p.tags.length>10000||!Array.isArray(p.blocks)||p.blocks.length>500)throw new Error('Invalid project or project exceeds limits.');
  if(!Array.isArray(p.hmi)||p.hmi.length>1000)throw new Error('Invalid HMI object list.');
  for(const key of ['watch','trace'])if(!Array.isArray(p[key])||p[key].length>(key==='trace'?16:10000)||p[key].some(v=>typeof v!=='string'||v.length>160))throw new Error(`Invalid ${key} tag list.`);
  const ids=new Set();
  const optionalText=(o,keys,max=2000)=>{for(const key of keys)if(o[key]!==undefined&&(typeof o[key]!=='string'||o[key].length>max))throw new Error(`Invalid text field '${key}'.`);};
  function checkId(o){if(!o||typeof o!=='object'||typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(o.id)||ids.has(o.id))throw new Error(`Missing or duplicate object identity '${o.id}'.`);ids.add(o.id);}
  for(const t of p.tags){checkId(t);optionalText(t,['name','address','comment']);if(typeof t.name!=='string'||!TYPES.includes(t.type)||!['input','output','memory'].includes(t.io))throw new Error('Invalid tag definition.');coerce(t.initial,t.type);}
  for(const b of p.blocks){
    checkId(b);optionalText(b,['name','comment']);if(typeof b.name!=='string'||!['LAD','FBD','ST'].includes(b.language)||!['OB','FB','FC'].includes(b.kind))throw new Error('Invalid program block.');
    if(b.language==='ST'&&(typeof b.source!=='string'||b.source.length>500000))throw new Error('Invalid ST source.');
    if(b.language==='LAD'){
      if(!Array.isArray(b.networks)||b.networks.length>2000)throw new Error('Invalid ladder networks.');
      for(const n of b.networks){checkId(n);optionalText(n,['title','comment']);if(!Array.isArray(n.series)||!Array.isArray(n.branches)||n.branches.some(v=>!Array.isArray(v))||!n.action)throw new Error('Invalid ladder network.');if(n.series.length>200||n.branches.length>100||n.branches.some(a=>a.length>200))throw new Error('Ladder network exceeds contact limits.');
        for(const c of [...n.series,...n.branches.flat()]){checkId(c);optionalText(c,['tag','expression']);}
        if(!['COIL','SET','RESET','MOVE','CALL',...FB_TYPES].includes(n.action.type))throw new Error('Invalid ladder action.');
        optionalText(n.action,['tag','PT','Q','ET','R','PV','CV','LD','QU','QD','CD','value','target','block']);}
    }
    if(b.language==='FBD'){
      if(!Array.isArray(b.nodes)||b.nodes.length>3000)throw new Error('Invalid FBD nodes.');
      for(const n of b.nodes){checkId(n);if(!FBD_SPECS[n.op]||!Number.isFinite(n.x)||!Number.isFinite(n.y)||!n.inputs||typeof n.inputs!=='object'||Array.isArray(n.inputs))throw new Error('Invalid FBD node.');optionalText(n,['tag','value','label']);for(const v of Object.values(n.inputs)){if(!v||typeof v!=='object')throw new Error('Invalid FBD input binding.');optionalText(v,['expr','node','port']);}}
    }
  }
  if(!p.blocks.some(b=>b.id===p.entry))throw new Error('Entry block is missing.');
  for(const w of p.hmi){checkId(w);optionalText(w,['label','tag','unit','color','behavior']);for(const key of ['min','max','step','fontSize'])if(w[key]!==undefined&&!Number.isFinite(w[key]))throw new Error('Invalid HMI numeric property.');if(!['button','lamp','gauge','value','slider','label','tank','panel'].includes(w.type))throw new Error('Invalid HMI widget type.');for(const k of ['x','y','w','h'])if(!Number.isFinite(w[k])||Math.abs(w[k])>10000)throw new Error('Invalid HMI widget coordinates.');if(w.w<20||w.h<20)throw new Error('HMI objects must be at least 20 × 20.');}
  return p;
}
export class History {
  constructor(project,limit=80){this.project=structuredClone(project);this.undoStack=[];this.redoStack=[];this.limit=limit;this.version=0;}
  transact(label,change){
    const next=structuredClone(this.project);change(next);validateProject(next);
    this.undoStack.push({label,project:this.project});if(this.undoStack.length>this.limit)this.undoStack.shift();
    this.project=next;this.redoStack=[];this.version++;return this.project;
  }
  undo(){const item=this.undoStack.pop();if(!item)return false;this.redoStack.push({label:item.label,project:this.project});this.project=item.project;this.version++;return true;}
  redo(){const item=this.redoStack.pop();if(!item)return false;this.undoStack.push({label:item.label,project:this.project});this.project=item.project;this.version++;return true;}
}
