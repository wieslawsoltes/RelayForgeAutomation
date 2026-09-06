import {CompileError,parseExpression,parseST} from './language.js';
import {TYPES,FB_TYPES,FB_SPECS,FBD_SPECS,validateProject,defaultValue,coerce} from './model.js';
const INTEGER = ['INT','DINT'];
const isNumeric=t=>['INT','DINT','REAL'].includes(t);
const literal=(value,type=typeof value==='boolean'?'BOOL':'DINT')=>({kind:'literal',value,type});
export function assignable(from,to){return from===to||(INTEGER.includes(from)&&INTEGER.includes(to))||(INTEGER.includes(from)&&to==='REAL');}
function requireType(actual,expected,loc){if(!assignable(actual,expected))throw new CompileError(`Type mismatch: expected ${expected}, received ${actual}.`,loc);}
function common(a,b,loc){if(a==='TIME'&&b==='TIME')return 'TIME';if(!isNumeric(a)||!isNumeric(b))throw new CompileError(`Numeric operands required, received ${a} and ${b}.`,loc);return a==='REAL'||b==='REAL'?'REAL':'DINT';}
export class Context {
  constructor(project,block,globals,locals=new Map()){this.project=project;this.block=block;this.globals=globals;this.locals=locals;this.references=[];this.calls=[];}
  resolve(name,loc={},write=false){
    const parts=name.split('.');let symbol;
    if(parts.length===2){
      const instance=this.locals.get(parts[0].toUpperCase()),field=parts[1].toUpperCase();
      if(!instance||!FB_SPECS[instance.type]?.outputs[field])throw new CompileError(`Unknown instance field '${name}'.`,loc);
      if(write)throw new CompileError(`Instance output '${name}' is read-only.`,loc);
      return {kind:'field',name:instance.name,field,type:FB_SPECS[instance.type].outputs[field]};
    }
    symbol=this.locals.get(name.toUpperCase())||this.globals.get(name.toUpperCase());
    if(!symbol)throw new CompileError(`Unknown symbol '${name}'.`,loc);
    if(FB_TYPES.includes(symbol.type))throw new CompileError(`'${name}' is a function-block instance; use a member such as .Q.`,loc);
    if(write&&symbol.io==='input')throw new CompileError(`Input '${name}' cannot be assigned by the program.`,loc);
    if(symbol.kind==='tag')this.references.push({tag:symbol.name,block:this.block.id,access:write?'write':'read',line:loc.line||0});
    return symbol;
  }
}
export function compileExpression(ast,context){
  const e={...ast};
  if(e.kind==='literal'){coerce(e.value,e.type);return e;}
  if(e.kind==='reference'){const ref=context.resolve(e.name,e.loc);return {kind:'load',ref,type:ref.type,loc:e.loc};}
  if(e.kind==='load')return e;
  if(e.kind==='unary'){
    if(e.operator==='-'&&e.arg.kind==='literal'&&e.arg.value===2147483648)return literal(-2147483648);
    e.arg=compileExpression(e.arg,context);
    if(e.operator==='NOT'){requireType(e.arg.type,'BOOL',e.loc);e.type='BOOL';}
    else{if(!isNumeric(e.arg.type))throw new CompileError('Unary + / - requires a numeric value.',e.loc);e.type=e.arg.type;}
    return e;
  }
  if(e.kind==='binary'){
    e.left=compileExpression(e.left,context);e.right=compileExpression(e.right,context);
    const a=e.left.type,b=e.right.type,op=e.operator;
    if(['AND','OR','XOR'].includes(op)){requireType(a,'BOOL',e.loc);requireType(b,'BOOL',e.loc);e.type='BOOL';}
    else if(['=','<>','<','>','<=','>='].includes(op)){
      if(a==='BOOL'&&b==='BOOL'){if(!['=','<>'].includes(op))throw new CompileError('BOOL only supports = and <> comparisons.',e.loc);}
      else common(a,b,e.loc);e.type='BOOL';
    }else{
      e.type=common(a,b,e.loc);
      if(e.type==='TIME'&&!['+','-'].includes(op))throw new CompileError('TIME arithmetic supports only + and -.',e.loc);
      if(op==='MOD'&&(!INTEGER.includes(a)||!INTEGER.includes(b)))throw new CompileError('MOD requires integer operands.',e.loc);
    }
    return e;
  }
  if(e.kind==='function'){
    const arities={ABS:[1,1],SQRT:[1,1],MIN:[2,16],MAX:[2,16],LIMIT:[3,3],TO_REAL:[1,1],TO_INT:[1,1],INT_TO_REAL:[1,1],REAL_TO_INT:[1,1]};
    const range=arities[e.name];if(!range)throw new CompileError(`Unknown pure function '${e.name}'.`,e.loc);
    if(e.args.length<range[0]||e.args.length>range[1])throw new CompileError(`${e.name} expects ${range[0]}${range[0]!==range[1]?'..'+range[1]:''} arguments.`,e.loc);
    e.args=e.args.map(a=>compileExpression(a,context));
    for(const a of e.args)if(!isNumeric(a.type))throw new CompileError(`${e.name} expects numeric arguments.`,e.loc);
    e.type=['TO_REAL','INT_TO_REAL','SQRT'].includes(e.name)?'REAL':['TO_INT','REAL_TO_INT'].includes(e.name)?'DINT':e.args.some(a=>a.type==='REAL')?'REAL':'DINT';return e;
  }
  throw new CompileError(`Unsupported expression '${e.kind}'.`,e.loc);
}
export function compileTextExpression(source,context){return compileExpression(parseExpression(source),context);}
function target(name,from,context,loc){const dest=context.resolve(name,loc,true);requireType(from,dest.type,loc);return dest;}
function invoke(kind,instance,inputs,outputs,context,source){
  const spec=FB_SPECS[kind];if(!spec)throw new CompileError(`Unknown function block '${kind}'.`,source);
  const args={},result={};
  for(const [pin,type]of Object.entries(spec.inputs)){
    if(!Object.hasOwn(inputs,pin))throw new CompileError(`${kind}: required input '${pin}' is missing.`,source);
    args[pin]=compileExpression(inputs[pin],context);requireType(args[pin].type,type,source);
  }
  for(const pin of Object.keys(inputs))if(!spec.inputs[pin])throw new CompileError(`${kind}: unknown input '${pin}'.`,source);
  for(const [pin,name]of Object.entries(outputs)){
    if(!spec.outputs[pin])throw new CompileError(`${kind}: unknown output '${pin}'.`,source);
    result[pin]=typeof name==='object'?name:target(name,spec.outputs[pin],context,source);
  }
  return {op:'invoke',kind,instance,inputs:args,outputs:result,source};
}
function blockCall(name,context,source){
  const block=context.project.blocks.find(b=>b.id===name||b.name.toUpperCase()===name.toUpperCase());
  if(!block)throw new CompileError(`Unknown program block '${name}'.`,source);
  if(block.kind==='OB')throw new CompileError('An OB cannot be called as a subprogram.',source);
  context.calls.push(block.id);return {op:'call',block:block.id,source};
}
function compileStatements(statements,context){return statements.map(s=>{
  const source={id:s.id,line:s.loc?.line,column:s.loc?.column};
  if(s.kind==='noop')return {op:'noop',source};
  if(s.kind==='assign'){const value=compileExpression(s.value,context);return {op:'assign',target:target(s.target,value.type,context,s.loc),value,source};}
  if(s.kind==='if')return {op:'if',arms:s.arms.map(a=>{const condition=compileExpression(a.condition,context);requireType(condition.type,'BOOL',s.loc);return {condition,body:compileStatements(a.body,context)};}),otherwise:compileStatements(s.otherwise,context),source};
  if(s.kind==='for'){
    const from=compileExpression(s.from,context),to=compileExpression(s.to,context),by=compileExpression(s.by,context);
    for(const e of [from,to,by])if(!INTEGER.includes(e.type))throw new CompileError('FOR bounds and step must be integer.',s.loc);
    const dest=target(s.target,from.type,context,s.loc);if(!INTEGER.includes(dest.type))throw new CompileError('FOR iterator must be INT or DINT.',s.loc);
    return {op:'for',target:dest,from,to,by,body:compileStatements(s.body,context),source};
  }
  if(s.kind==='invoke'){
    const instance=context.locals.get(s.name.toUpperCase());
    if(instance&&FB_TYPES.includes(instance.type))return invoke(instance.type,instance.name,s.inputs,s.outputs,context,source);
    if(Object.keys(s.inputs).length||Object.keys(s.outputs).length)throw new CompileError('User block calls use globally declared tags; parameter interfaces are not supported.',s.loc);
    return blockCall(s.name,context,source);
  }
  throw new CompileError(`Unsupported statement '${s.kind}'.`,s.loc);
});}
function compileLAD(block,context){
  const instructions=[];
  for(const n of block.networks){
    const source={id:n.id};
    const contact=c=>{
      let expression=c.expression?parseExpression(c.expression):{kind:'reference',name:c.tag};
      if(c.negated)expression={kind:'unary',operator:'NOT',arg:expression};
      const compiled=compileExpression(expression,context);requireType(compiled.type,'BOOL');
      return {...compiled,monitorId:c.id};
    };
    const fold=(xs,op,identity)=>xs.reduce((l,r)=>({kind:'binary',operator:op,left:l,right:r,type:'BOOL'}),literal(identity));
    const series=fold(n.series.map(contact),'AND',true);
    const branches=n.branches.length?fold(n.branches.map(b=>fold(b.map(contact),'AND',true)),'OR',false):literal(true);
    const condition={kind:'binary',operator:'AND',left:series,right:branches,type:'BOOL',monitorId:n.id};
    const action=n.action;
    if(['COIL','SET','RESET'].includes(action.type)){
      const dest=target(action.target,'BOOL',context);
      if(action.type==='COIL')instructions.push({op:'assign',target:dest,value:condition,source});
      else instructions.push({op:'if',arms:[{condition,body:[{op:'assign',target:dest,value:literal(action.type==='SET'),source}]}],otherwise:[],source});
    } else if(FB_TYPES.includes(action.type)){
      const spec=FB_SPECS[action.type],inputs={};
      for(const [pin,type]of Object.entries(spec.inputs)){
        const primary=['IN','CU','CD','CLK'].includes(pin)&&pin===Object.keys(spec.inputs)[0];
        inputs[pin]=primary?condition:parseExpression(action.inputs?.[pin]??(type==='BOOL'?'FALSE':type==='TIME'?'T#1s':'10'));
      }
      instructions.push(invoke(action.type,`lad_${n.id}`,inputs,action.outputs||{},context,source));
    } else if(action.type==='CALL'){
      const call=blockCall(action.block,context,source);instructions.push({op:'if',arms:[{condition,body:[call]}],otherwise:[],source});
    } else if(action.type==='MOVE'){
      const value=compileTextExpression(action.value??'0',context),dest=target(action.target,value.type,context);
      instructions.push({op:'if',arms:[{condition,body:[{op:'assign',target:dest,value,source}]}],otherwise:[],source});
    } else throw new CompileError(`Network '${n.title}': unknown action '${action.type}'.`);
  }
  return instructions;
}
function compileFBD(block,context){
  const nodes=new Map(block.nodes.map(n=>[n.id,n])),states=new Map(),ordered=[];
  const visit=(id,depth=0)=>{
    if(depth>3000)throw new CompileError('FBD dependency depth exceeded.');
    if(states.get(id)===1)throw new CompileError('FBD contains a combinational cycle. Use a tag as an explicit scan-delay boundary.');
    if(states.get(id)===2)return;
    const n=nodes.get(id);if(!n)throw new CompileError(`Wire source '${id}' no longer exists.`);states.set(id,1);
    for(const s of Object.values(n.inputs||{}))if(s&&typeof s==='object'&&s.node)visit(s.node,depth+1);
    states.set(id,2);ordered.push(n);
  };
  for(const n of block.nodes)visit(n.id);
  const outputs=new Map(),instructions=[];
  for(const n of ordered){
    const source={id:n.id},spec=FBD_SPECS[n.op];if(!spec)throw new CompileError(`Unknown FBD operation '${n.op}'.`);
    const args={};
    for(const pin of spec.inputs){
      const s=n.inputs[pin];if(s===undefined||s===null)throw new CompileError(`${n.op} '${n.id}': input ${pin} is not connected.`);
      if(typeof s==='object'&&s.node){
        const ref=outputs.get(`${s.node}.${s.port||'OUT'}`);if(!ref)throw new CompileError(`${n.op}: source pin '${s.port}' does not exist.`);
        args[pin]={kind:'load',ref,type:ref.type};
      }else args[pin]=compileTextExpression(typeof s==='object'?s.expr:s,context);
    }
    for(const pin of Object.keys(n.inputs))if(!spec.inputs.includes(pin))throw new CompileError(`${n.op}: unknown input '${pin}'.`);
    const register=(pin,type)=>{const ref={kind:'temp',name:`${n.id}.${pin}`,type};outputs.set(ref.name,ref);return ref;};
    if(FB_TYPES.includes(n.op)){
      const result=Object.fromEntries(Object.entries(FB_SPECS[n.op].outputs).map(([pin,type])=>[pin,register(pin,type)]));
      instructions.push(invoke(n.op,`fbd_${n.id}`,args,result,context,source));
    }else if(n.op==='WRITE')instructions.push({op:'assign',target:target(n.tag,args.IN.type,context),value:args.IN,source});
    else{
      let value;
      if(n.op==='READ')value=compileExpression({kind:'reference',name:n.tag},context);
      else if(n.op==='CONST')value=compileTextExpression(n.value??'TRUE',context);
      else if(n.op==='NOT')value=compileExpression({kind:'unary',operator:'NOT',arg:args.IN},context);
      else{
        const op={AND:'AND',OR:'OR',XOR:'XOR',ADD:'+',SUB:'-',MUL:'*',DIV:'/',GT:'>',GE:'>=',LT:'<',LE:'<=',EQ:'='}[n.op];
        value=compileExpression({kind:'binary',operator:op,left:args.A,right:args.B},context);
      }
      instructions.push({op:'assign',target:register('OUT',value.type),value,source});
    }
  }
  return instructions;
}
function constant(e){
  if(e.kind==='literal')return e.value;
  if(e.kind==='unary'&&['+','-'].includes(e.operator))return (e.operator==='-'?-1:1)*constant(e.arg);
  throw new CompileError('A local initializer must be a literal or signed literal.',e.loc);
}
export function compileProject(project){
  const diagnostics=[],blocks=Object.create(null),references=[],globals=new Map();
  const error=(message,block,loc={})=>diagnostics.push({severity:'error',message,block:typeof block==='object'?block?.id:block,line:loc.line||0,column:loc.column||0});
  const warn=(message,block)=>diagnostics.push({severity:'warning',message,block});
  try{validateProject(project);}catch(e){return {ok:false,diagnostics:[{severity:'error',message:e.message}],program:null};}
  const blockNames=new Set(),addresses=new Map();
  for(const t of project.tags){
    if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(t.name)){error(`Invalid tag identifier '${t.name}'.`);continue;}
    if(['TRUE','FALSE','IF','THEN','ELSE','ELSIF','END_IF','VAR','END_VAR','FOR','TO','BY','DO','END_FOR','AND','OR','NOT','XOR','MOD'].includes(t.name.toUpperCase()))error(`Tag '${t.name}' is a reserved keyword.`);
    if(globals.has(t.name.toUpperCase()))error(`Duplicate tag '${t.name}' (case-insensitive).`);
    globals.set(t.name.toUpperCase(),{kind:'tag',name:t.name,type:t.type,io:t.io});
    if(t.address){const a=t.address.toUpperCase();if(addresses.has(a))error(`Duplicate symbolic address '${a}' on ${t.name} and ${addresses.get(a)}.`);addresses.set(a,t.name);}
  }
  for(const b of project.blocks){
    if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(b.name))error(`Invalid block identifier '${b.name}'.`,b);
    if(blockNames.has(b.name.toUpperCase()))error(`Duplicate block '${b.name}'.`,b);blockNames.add(b.name.toUpperCase());
    try{
      const locals=new Map(),context=new Context(project,b,globals,locals);let body,initials=Object.create(null);
      if(b.language==='ST'){
        const parsed=parseST(b.source);
        for(const d of parsed.declarations){
          if(!TYPES.includes(d.type)&&!FB_TYPES.includes(d.type))throw new CompileError(`Unsupported local type '${d.type}'.`,d.loc);
          if(locals.has(d.name.toUpperCase()))throw new CompileError(`Duplicate local '${d.name}'.`,d.loc);
          if(globals.has(d.name.toUpperCase()))warn(`Local '${d.name}' shadows a global tag.`,b.id);
          locals.set(d.name.toUpperCase(),{kind:'local',name:d.name,type:d.type});
          if(TYPES.includes(d.type))initials[d.name]=d.initial?coerce(constant(d.initial),d.type):defaultValue(d.type);
          else if(d.initial)throw new CompileError('Function-block instances cannot have scalar initializers.',d.loc);
        }
        body=compileStatements(parsed.body,context);
      } else if(b.language==='LAD')body=compileLAD(b,context);
      else body=compileFBD(b,context);
      blocks[b.id]={id:b.id,name:b.name,language:b.language,body,initials,locals:Object.fromEntries(locals),calls:context.calls};references.push(...context.references);
    }catch(e){error(e.message,b,e);}
  }
  const entry=project.blocks.find(b=>b.id===project.entry);if(entry?.kind!=='OB')error('Cyclic entry must be an OB.');
  const visiting=new Set(),visited=new Set();
  function walk(id){
    if(visiting.has(id)){error('Recursive block calls are not permitted.',id);return;}
    if(visited.has(id))return;visiting.add(id);
    for(const child of blocks[id]?.calls||[])walk(child);
    visiting.delete(id);visited.add(id);
  }
  walk(project.entry);
  for(const b of project.blocks)if(!visited.has(b.id))warn(`Block '${b.name}' is not reachable from the cyclic entry.`,b.id);
  for(const b of project.blocks)walk(b.id); // Also reject recursion in disconnected blocks.
  const writers=new Map();
  for(const r of references.filter(r=>r.access==='write')){if(!writers.has(r.tag))writers.set(r.tag,new Set());writers.get(r.tag).add(r.block);}
  for(const [tag,set]of writers)if(set.size>1)warn(`'${tag}' is written by multiple blocks; the last executed assignment wins.`);
  for(const w of project.hmi){
    if(w.tag&&!globals.has(w.tag.toUpperCase()))warn(`HMI '${w.label||w.type}' binds unknown tag '${w.tag}'.`);
    const t=globals.get(w.tag?.toUpperCase());
    if(t&&['button','lamp'].includes(w.type)&&t.type!=='BOOL')warn(`HMI ${w.type} '${w.label}' requires a BOOL tag.`);
    if(t&&['slider','gauge','tank'].includes(w.type)&&!isNumeric(t.type))warn(`HMI ${w.type} '${w.label}' requires a numeric tag.`);
    if(t&&['button','slider'].includes(w.type)&&t.io==='output')warn(`HMI '${w.label}' writes a program output; the next scan may overwrite it.`);
  }
  const ok=!diagnostics.some(d=>d.severity==='error');
  const program=ok?{schemaVersion:1,entry:project.entry,cycleMs:project.cycleMs,tags:project.tags,blocks,references}:null;
  return {ok,diagnostics,program};
}
