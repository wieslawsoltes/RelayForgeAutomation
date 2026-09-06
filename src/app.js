import {History,uid,validateProject,parseInput,TYPES,FB_TYPES,FB_SPECS,FBD_SPECS,defaultValue} from './model.js';
import {createDemo} from './demo.js';
import {compileProject} from './compiler.js';
import {SimulatorClient} from './client.js';
import {VectorSurface} from './renderer.js';
import {drawLadder,drawFBD,ladderLayout,fbdLayout,drawTrace,formatValue,SIGNAL_COLORS} from './graphs.js';
import {HMIDesigner} from './hmi.js';
import {icon,escapeHTML as esc} from './icons.js';
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)],STORAGE_KEY='relayforge.project.v1';
let startupWarning='',initialProject;
try{const saved=localStorage.getItem(STORAGE_KEY);initialProject=saved?validateProject(JSON.parse(saved)):createDemo();}catch(e){initialProject=createDemo();startupWarning=`Saved project could not be loaded: ${e.message}`;}
let history=new History(initialProject),codeVersion=0,downloadVersion=-1,compileResult=null,mode='STOP',busy=false,loadingPromise=null;
let snapshot={scan:0,timeMs:0,values:Object.fromEntries(initialProject.tags.map(t=>[t.name,t.initial])),signals:{},forces:{},trace:[],instances:{}},mainSurface=null,bottomSurface=null,hmi=null,graphLayout=null,saveTimer=null,sourceTimer=null,sourceDraft=null,drag=null,wire=null,spaceDown=false,renderScheduled=false,rendererName='Initializing…';
const ui={view:'block',block:initialProject.entry,selection:{kind:'network',id:initialProject.blocks.find(b=>b.id===initialProject.entry)?.networks?.[0]?.id},task:'instructions',bottom:'watch',monitor:true,hmiMode:'design',camera:{x:0,y:0,zoom:.85},filter:'',traceHover:null};
let diagnostics=[],log=[{severity:'info',message:'RelayForge workspace initialized. All I/O is local and simulated.',time:new Date().toLocaleTimeString()}];
const project=()=>history.project,block=()=>project().blocks.find(b=>b.id===ui.block),byTag=name=>project().tags.find(t=>t.name===name);
function toast(message,type='info'){const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('#toastArea').append(el);setTimeout(()=>el.remove(),type==='error'?6500:3600);while($('#toastArea').children.length>4)$('#toastArea').firstChild.remove();}
function logMessage(message,severity='info',location){log.push({message,severity,time:new Date().toLocaleTimeString(),...location});if(log.length>150)log.shift();if(ui.bottom==='diagnostics')renderBottom();}
function handleError(error){toast(error.message||String(error),'error');logMessage(error.message||String(error),'error',error.location);}
const client=new SimulatorClient(event=>{
  if(event.type==='snapshot'){
    if(event.revision!==downloadVersion)return;mode=event.mode;snapshot=event.data||snapshot;updateLive();invalidateSurfaces();
  }else if(event.type==='fault'){mode='FAULT';logMessage(event.message,'error',event.location);toast(event.message,'error');ui.bottom='diagnostics';renderBottom();updateStatus();}
});
function request(type,payload={}){return client.request(type,{revision:downloadVersion,...payload});}
function save(silent=false){
  flushSource();try{localStorage.setItem(STORAGE_KEY,JSON.stringify(project()));$('#saveStatus').textContent='Saved locally';if(!silent)toast('Project saved in this browser.','success');}
  catch(e){$('#saveStatus').textContent='Save failed';if(!silent)handleError(new Error(`Local storage failed: ${e.message}. Export a project file instead.`));}
}
function scheduleSave(){clearTimeout(saveTimer);$('#saveStatus').textContent='Unsaved changes';saveTimer=setTimeout(()=>save(true),600);}
function invalidateCode(){codeVersion++;compileResult=null;if(mode!=='STOP'){mode='STOP';request('stop').catch(handleError);}updateStatus();}
function edit(label,change,{compile=true,render=true}={}){
  try{history.transact(label,change);if(compile)invalidateCode();scheduleSave();if(render)renderAll();else{renderTree();renderTabs();updateStatus();}}
  catch(e){handleError(e);}
}
function flushSource(){
  clearTimeout(sourceTimer);if(!sourceDraft)return;const draft=sourceDraft;sourceDraft=null;
  if(project().blocks.find(b=>b.id===draft.id)?.source===draft.source)return;
  edit('Edit structured text',p=>{p.blocks.find(b=>b.id===draft.id).source=draft.source;},{compile:true,render:false});
}
function invalidateSurfaces(){mainSurface?.invalidate();bottomSurface?.invalidate();hmi?.update(snapshot.values);}
function backend(name,reason){rendererName=name;$('#rendererStatus').textContent=name==='WebGPU'?'WebGPU · batched vectors':'Canvas 2D · fallback';$('#rendererStatus').title=reason||'WGSL vertex/fragment pipeline • one draw call per vector surface';}
async function compile(download=false){
  flushSource();compileResult=compileProject(project());diagnostics=compileResult.diagnostics;
  const errors=diagnostics.filter(d=>d.severity==='error').length,warnings=diagnostics.filter(d=>d.severity==='warning').length;
  logMessage(`Compile ${compileResult.ok?'succeeded':'failed'}: ${errors} error(s), ${warnings} warning(s). ${project().blocks.length} blocks, ${project().tags.length} typed tags.`,compileResult.ok?'info':'error');
  ui.bottom='diagnostics';renderBottom();updateStatus();
  if(!compileResult.ok){toast(`Compilation failed: ${errors} error(s). Open Diagnostics.`,'error');return false;}
  if(download){
    const version=codeVersion;
    // Only mark a download synchronized after the worker acknowledges it.
    const result=await client.request('load',{project:structuredClone(project()),revision:version});
    downloadVersion=version;
    if(version!==codeVersion){await request('stop');return false;}
    mode='STOP';snapshot=result.data;renderTabs();logMessage('Program downloaded to the local virtual CPU. Cold restart complete.');updateLive();invalidateSurfaces();
  }
  return true;
}
async function ensureDownloaded(){
  flushSource();
  if(loadingPromise){await loadingPromise;flushSource();}
  if(downloadVersion===codeVersion&&compileResult?.ok)return true;
  const pending=compile(true);loadingPromise=pending;
  try{return await pending;}finally{if(loadingPromise===pending)loadingPromise=null;}
}
async function run(){if(!await ensureDownloaded())return;const r=await request('run');mode=r.mode;snapshot=r.data;updateLive();}
async function step(){if(!await ensureDownloaded())return;if(mode==='RUN')await request('pause');const r=await request('step');mode=r.mode;snapshot=r.data;updateLive();invalidateSurfaces();}
async function writeTag(name,value,{kind='write',afterScans=0}={}){
  if(!await ensureDownloaded())return;const tag=byTag(name);if(!tag)throw new Error(`Unknown tag '${name}'.`);
  const parsed=kind==='release'?undefined:parseInput(value,tag.type);
  const r=await request('io',{kind:kind==='write'&&tag.io==='input'?'input':kind,tag:name,value:parsed,afterScans});
  snapshot=r.data;updateLive();invalidateSurfaces();
}
async function startDemo(){if(!await ensureDownloaded())return;if(!byTag('Start'))throw new Error('This project has no Start input. Use Run to execute the cyclic OB.');await request('plant',{value:true});$('#plantToggle').checked=true;await writeTag('Start',true);await writeTag('Start',false,{afterScans:1});await run();ui.bottom='watch';renderBottom();toast('Cell started. The worker is executing real program scans.','success');}
function downloadFile(name,content,type='application/json'){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function dialog(title,body,{submit='Apply',onSubmit,close='Cancel',wide=false}={}){
  const d=$('#dialog');if(d.open)d.close();d.style.width=wide?'min(860px,94vw)':'';
  d.innerHTML=`<form id="dialogForm"><div class="dialog-title"><span>${esc(title)}</span><button type="button" data-close-dialog aria-label="Close">×</button></div><div class="dialog-body">${body}</div><div class="dialog-error" role="alert"></div><div class="dialog-footer"><button type="button" data-close-dialog>${esc(close)}</button>${onSubmit?`<button type="submit" class="primary-button">${esc(submit)}</button>`:''}</div></form>`;
  d.querySelectorAll('[data-close-dialog]').forEach(b=>b.onclick=()=>d.close());d.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const result=await onSubmit(new FormData(e.target));if(result!==false)d.close();}catch(error){d.querySelector('.dialog-error').textContent=error.message;}};
  d.showModal();return d;
}
function confirmAction(title,message,action){dialog(title,`<p>${esc(message)}</p>`,{submit:'Continue',onSubmit:action});}
function actionButton(command,label,svg,classes=''){return `<button class="${classes}" data-command="${command}" title="${esc(label)}">${svg?icon(svg):''}<span>${esc(label)}</span></button>`;}
function setupMenus(){
  const menus={File:[['New project…','new','Ctrl+N'],['Open project…','open','Ctrl+O'],['Save workspace','save','Ctrl+S'],['Export project…','export',''],['Load demonstration','demo',''],['Project settings…','project-settings','']],Edit:[['Undo','undo','Ctrl+Z'],['Redo','redo','Ctrl+Y'],['Duplicate selection','duplicate','Ctrl+D'],['Delete selection','delete','Del']],View:[['PLC tags','tags',''],['Watch table','watch',''],['Execution traces','traces',''],['HMI designer','hmi',''],['Online diagnostics','online',''],['Selection properties','properties',''],['Fit diagram','fit','F']],PLC:[['Compile','compile','F7'],['Download to simulator','download',''],['Run','run','F5'],['Pause / resume','pause','F6'],['Single scan','step','F10'],['STOP / safe outputs','stop','Shift+F5'],['Cold reset','reset',''],['Warm restart','warm-reset',''],['Release all forces','release-forces',''],['Run demo cell','start-demo','']],Debug:[['Monitor program','monitor',''],['Trace channels…','trace-config',''],['Export trace CSV','export-trace',''],['Export input event log','export-events',''],['Compiled program IR','show-ir','']],Help:[['Guide & keyboard shortcuts','help','F1'],['Runtime semantics','semantics',''],['About RelayForge','about','']]};
  $('#menus').innerHTML=Object.entries(menus).map(([name,items])=>`<div class="menu"><button aria-haspopup="true">${name}</button><div class="menu-popover">${items.map(([label,cmd,key])=>`<button data-command="${cmd}"><span>${label}</span><kbd>${key}</kbd></button>`).join('')}</div></div>`).join('');
  $$('#menus .menu>button').forEach(button=>button.onclick=()=>{const open=button.parentElement.classList.contains('open');$$('.menu').forEach(m=>m.classList.remove('open'));button.parentElement.classList.toggle('open',!open);});
  $('#fileTools').innerHTML=actionButton('save','Save','save','tool-button')+actionButton('undo','Undo','undo','tool-button small')+actionButton('redo','Redo','redo','tool-button small');
  $('#buildTools').innerHTML=actionButton('compile','Compile','compile','tool-button primary')+actionButton('download','Download','download','tool-button');
  $('#runTools').innerHTML=actionButton('run','Run','run','tool-button run')+actionButton('pause','Pause','pause','tool-button')+actionButton('stop','Stop','stop','tool-button stop')+actionButton('step','Step','step','tool-button');
  $('#viewTools').innerHTML=actionButton('monitor','Monitor','monitor','tool-button active')+actionButton('hmi','HMI','hmi','tool-button');
}
function renderTree(){
  const p=project(),filter=ui.filter.toLowerCase(),rows=[];
  const row=(label,{depth=0,iconName='folder',selected=false,view,blockId,network,command,badge='',lang,chevron=false}={})=>{
    if(filter&&!label.toLowerCase().includes(filter)&&depth>1&&!chevron)return;
    const action=command?`data-command="${command}"`:network?`data-network="${network}" data-block="${blockId}"`:blockId?`data-open-block="${blockId}"`:view?`data-view="${view}"`:'';
    rows.push(`<button class="tree-row level-${depth} ${selected?'selected':''}" ${action}><span class="chevron">${chevron?'⌄':''}</span><span class="tree-icon ${lang?'lang '+(lang==='ST'?'fc':'ob'):''}">${lang||icon(iconName)}</span><span class="tree-label">${esc(label)}</span>${badge?`<span class="tag-count">${badge}</span>`:''}</button>`);
  };
  row(p.name,{iconName:'project',chevron:true,command:'project-settings'});row('Devices & networks',{depth:1,iconName:'cpu',view:'online'});row('PLC_1 [RF-1200]',{depth:1,iconName:'cpu',chevron:true,view:'online',selected:ui.view==='online'});row('Device configuration',{depth:2,iconName:'settings',command:'project-settings'});row('Program blocks',{depth:2,chevron:true,badge:p.blocks.length,command:'add-block'});
  for(const b of p.blocks){row(`${b.name} [${b.kind}${b.number}]`,{depth:3,lang:b.language,blockId:b.id,selected:ui.view==='block'&&ui.block===b.id});if(ui.block===b.id&&ui.view==='block'&&b.language==='LAD')for(const [i,n]of b.networks.entries())row(`Network ${i+1}`,{depth:4,iconName:'block',blockId:b.id,network:n.id,selected:ui.selection?.id===n.id});}
  row('Add new block',{depth:3,iconName:'plus',command:'add-block'});row('PLC tags',{depth:2,iconName:'tags',view:'tags',selected:ui.view==='tags',badge:p.tags.length});row('Watch & force tables',{depth:2,iconName:'watch',view:'watch',selected:ui.view==='watch'});row('Execution traces',{depth:2,iconName:'trace',view:'traces',selected:ui.view==='traces'});
  rows.push('<div class="tree-section">VISUALIZATION</div>');row('HMI_1 [Operator panel]',{depth:1,iconName:'hmi',chevron:true,view:'hmi'});row('Overview screen',{depth:2,iconName:'hmi',view:'hmi',selected:ui.view==='hmi',badge:'900 × 520'});row('HMI runtime',{depth:2,iconName:'play',command:'hmi-runtime'});
  rows.push('<div class="tree-section">TOOLS</div>');row('Online & diagnostics',{depth:1,iconName:'monitor',view:'online'});row('Project documentation',{depth:1,iconName:'info',command:'help'});
  $('#projectTree').innerHTML=rows.join('');$('#projectTitle').textContent=p.name;$('#cycleMini').textContent=`${p.cycleMs} ms`;document.title=`${p.name} — RelayForge Automation`;
}
function renderTabs(){
  $('#documentTabs').innerHTML=project().blocks.map(b=>`<button role="tab" aria-selected="${ui.view==='block'&&ui.block===b.id}" class="document-tab ${ui.view==='block'&&ui.block===b.id?'active':''}" data-open-block="${b.id}">${icon(b.language==='ST'?'code':'block')}${esc(b.name)} [${b.kind}${b.number}]${downloadVersion!==codeVersion&&ui.block===b.id?'<span class="dot"></span>':''}</button>`).join('')+[['tags','PLC tags','tags'],['hmi','Overview screen','hmi'],['traces','Traces','trace']].map(([v,label,svg])=>`<button role="tab" aria-selected="${ui.view===v}" class="document-tab ${ui.view===v?'active':''}" data-view="${v}">${icon(svg)}${label}</button>`).join('');
}
function navigate(view,id){flushSource();ui.view=view;if(id)ui.block=id;ui.selection=null;wire=null;ui.camera={x:0,y:0,zoom:.85};renderAll();}
function select(selection,{properties=true}={}){ui.selection=selection;if(properties)ui.task='properties';renderTask();if(ui.bottom==='properties')renderBottom();mainSurface?.invalidate();if(ui.view==='hmi')hmi?.select(selection?.id);renderTree();}
function renderAll(){if(!block())ui.block=project().entry;renderTree();renderTabs();renderHeader();renderEditor();renderTask();renderIO();renderBottom();updateLive();}
function renderHeader(){
  const b=block(),kind=ui.view==='block'?b?.language:ui.view.toUpperCase();
  const label={tags:'PLC tag table',watch:'Watch and force table',traces:'Execution traces',hmi:'Overview screen',online:'Online & diagnostics'}[ui.view];
  $('#breadcrumb').innerHTML=`${esc(project().name)} <span>›</span> ${ui.view==='hmi'?'HMI_1 <span>›</span> Screens':'PLC_1 [RF-1200] <span>›</span> '+(ui.view==='block'?'Program blocks':esc(label))}`;
  $('#documentTitle').innerHTML=ui.view==='block'?`${esc(b.name)} <span>[${b.kind}${b.number}]</span>`:esc(label);
  $('#documentMeta').innerHTML=`<span>${ui.view==='block'?b.language==='LAD'?`${b.networks.length} networks`:b.language==='FBD'?`${b.nodes.length} operators`:'Typed structured text':ui.view==='hmi'?'900 × 520 px':`${project().cycleMs} ms scan`}</span>${ui.monitor?'<span class="monitor-pill">● Monitor enabled</span>':''}<b class="language-pill">${esc(kind)}</b>`;
}
function updateStatus(){
  const errors=diagnostics.filter(d=>d.severity==='error').length;
  $('#compileStatus').textContent=!compileResult?'Modified · compile required':compileResult.ok?(downloadVersion===codeVersion?'Program synchronized':'Compiled · download pending'):`${errors} compilation error(s)`;
  $('#compileStatus').classList.toggle('red',!!compileResult&&!compileResult.ok);
  const badge=$('#cpuBadge');badge.className=`cpu-badge ${mode==='RUN'?'running':mode==='FAULT'?'fault':'stopped'}`;badge.querySelector('b').textContent=`CPU ${mode}`;
  $('#statusConnection').innerHTML=`<i class="status-dot ${mode==='RUN'?'running':mode==='FAULT'?'fault':''}"></i>Local simulator · ${mode}`;
  $('#runtimeStats').textContent=`Scan ${(snapshot?.scan||0).toLocaleString()} · ${((snapshot?.timeMs||0)/1000).toFixed(3)} s · ${(snapshot?.lastCPUms||0).toFixed(2)} ms CPU`;
  $$('[data-command="monitor"]').forEach(b=>b.classList.toggle('active',ui.monitor));
  $$('.ribbon [data-command="undo"]').forEach(b=>b.disabled=!history.undoStack.length);$$('.ribbon [data-command="redo"]').forEach(b=>b.disabled=!history.redoStack.length);
  $$('.ribbon [data-command="run"]').forEach(b=>b.disabled=mode==='RUN'||busy);$$('.ribbon [data-command="step"]').forEach(b=>b.disabled=busy);
}
function editorButton(command,label,svg){return actionButton(command,label,svg);}
function renderEditor(){
  mainSurface?.destroy();mainSurface=null;hmi?.destroy();hmi=null;graphLayout=null;drag=null;
  const area=$('#editorArea');area.replaceChildren();const toolbar=$('#editorToolbar'),b=block();
  if(ui.view==='block'&&(b.language==='LAD'||b.language==='FBD')){
    toolbar.innerHTML=b.language==='LAD'?editorButton('add-network','Network','plus')+'<span class="tool-separator"></span>'+editorButton('add-contact','—| |—')+editorButton('add-nc','—|/|—')+editorButton('add-branch','Parallel branch','link')+editorButton('lad-action','Output','block'):editorButton('add-node','Add operator','plus')+'<span class="tool-separator"></span>'+editorButton('wire-help','Connect pins','link');
    toolbar.innerHTML+=editorButton('delete','Delete','trash')+editorButton('properties','Properties','settings')+'<span class="toolbar-note">'+(byTag('Start')?'<button data-command="start-demo" class="green">'+icon('play')+' Start cell</button>':'20 ms deterministic scans')+'</span>';
    const stage=document.createElement('div');stage.className='graph-stage';stage.tabIndex=0;stage.setAttribute('aria-label',b.language==='LAD'?'Editable ladder logic diagram':'Editable function block diagram');area.append(stage);
    mainSurface=new VectorSurface(stage,{camera:ui.camera,onBackend:backend,draw:(scene,surface)=>{
      const current=block();if(!current)return;
      graphLayout=current.language==='LAD'?drawLadder(scene,surface,current,{snapshot,monitor:ui.monitor,selection:ui.selection,project:project()}):drawFBD(scene,surface,current,{snapshot,monitor:ui.monitor,selection:ui.selection,drag:drag?.kind==='node'?drag.preview:null,wire});
      if(current.language==='LAD'&&!current.networks.length)scene.text(55,70,'Add a network to begin writing ladder logic.',{size:15,color:'#86a0b4'});
      const zoomLabel=$('#zoomLabel');if(zoomLabel)zoomLabel.textContent=Math.round(surface.camera.zoom*100)+'%';
    }});
    if(!ui.camera.initialized){const layout=b.language==='LAD'?ladderLayout(b):fbdLayout(b);requestAnimationFrame(()=>{if(mainSurface){mainSurface.camera.zoom=Math.min(1,(mainSurface.width-30)/layout.width);mainSurface.camera.x=15;mainSurface.camera.y=8;mainSurface.camera.initialized=true;mainSurface.invalidate();}});}
    stage.insertAdjacentHTML('beforeend','<div class="graph-hint">'+(b.language==='LAD'?'Click to inspect · scroll to pan · Ctrl + scroll to zoom':'Drag blocks · connect output → input · Ctrl + scroll to zoom')+'</div><div class="graph-hud"><button data-command="zoom-out" title="Zoom out">−</button><span id="zoomLabel">85%</span><button data-command="zoom-in" title="Zoom in">+</button><button data-command="fit" title="Fit diagram">'+icon('fit')+'</button></div>');
    bindGraph(stage);
  }else if(ui.view==='block'){
    toolbar.innerHTML=editorButton('compile','Compile ST','compile')+editorButton('block-properties','Block properties','settings')+editorButton('st-example','Insert timer example','code')+'<span class="toolbar-note">No eval · typed AST → shared IR</span>';
    area.innerHTML='<div class="code-view"><div class="code-header"><span>STRUCTURED TEXT</span><span>● UTF-8</span><span>4 spaces</span></div><div class="code-scroll"><div class="line-numbers" aria-hidden="true"></div><pre class="code-pre" aria-hidden="true"></pre><textarea class="code-input" id="stEditor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="Structured text source editor" wrap="off"></textarea></div><div class="code-footer"><span id="codeCursor">Ln 1, Col 1</span><span>IF / ELSIF · FOR · VAR · IEC-style instances</span></div></div>';
    const input=$('#stEditor'),pre=$('.code-pre'),lines=$('.line-numbers');input.value=sourceDraft?.id===b.id?sourceDraft.source:b.source;
    const paint=()=>{pre.innerHTML=highlightST(input.value)+'\n';lines.textContent=Array.from({length:input.value.split('\n').length+1},(_,i)=>i+1).join('\n');};
    const sync=()=>{pre.scrollTop=input.scrollTop;pre.scrollLeft=input.scrollLeft;lines.scrollTop=input.scrollTop;};
    const cursor=()=>{const before=input.value.slice(0,input.selectionStart),rows=before.split('\n');$('#codeCursor').textContent=`Ln ${rows.length}, Col ${rows.at(-1).length+1} · ${input.value.length.toLocaleString()} characters`;};
    input.oninput=()=>{paint();sync();cursor();if(!sourceDraft)invalidateCode();sourceDraft={id:b.id,source:input.value};clearTimeout(sourceTimer);sourceTimer=setTimeout(flushSource,500);};
    input.onscroll=sync;input.onkeyup=cursor;input.onclick=cursor;
    input.onkeydown=e=>{if(e.key==='Tab'){e.preventDefault();input.setRangeText('    ',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));}};paint();
  }else if(ui.view==='tags'){
    toolbar.innerHTML=editorButton('add-tag','Add tag','plus')+editorButton('export-tags','Export CSV','export')+editorButton('watch','Watch table','watch')+'<span class="toolbar-note">Symbolic addresses · no byte aliasing</span>';
    area.innerHTML='<div class="table-wrap">'+tagTable()+'</div>';
  }else if(ui.view==='watch'){
    toolbar.innerHTML=editorButton('add-watch','Add watch','plus')+editorButton('release-forces','Release all forces','force')+editorButton('traces','Traces','trace')+'<span class="toolbar-note">I/O forces override program values</span>';
    area.innerHTML='<div class="table-wrap">'+watchTable(true)+'</div>';
  }else if(ui.view==='traces'){
    toolbar.innerHTML=editorButton('trace-config','Channels','settings')+editorButton('export-trace','Export CSV','export')+editorButton('clear-trace','Clear acquisition','reset')+'<span class="toolbar-note">4096 samples / channel · scan-indexed</span>';
    const stage=document.createElement('div');stage.className='trace-stage';area.append(stage);mainSurface=new VectorSurface(stage,{onBackend:backend,draw:(s,v)=>drawTrace(s,v,snapshot,project(),ui.traceHover)});stage.addEventListener('pointermove',e=>{const r=stage.getBoundingClientRect();ui.traceHover={x:e.clientX-r.left,y:e.clientY-r.top};mainSurface?.invalidate();});stage.addEventListener('pointerleave',()=>{ui.traceHover=null;mainSurface?.invalidate();});
  }else if(ui.view==='hmi'){
    toolbar.innerHTML=editorButton('hmi-design','Design','settings')+editorButton('hmi-runtime','Runtime','play')+'<span class="tool-separator"></span>'+editorButton('add-widget','Add object','plus')+editorButton('properties','Properties','settings')+editorButton('duplicate','Duplicate','copy')+editorButton('delete','Delete','trash')+'<span class="tool-separator"></span>'+editorButton('zoom-out','−')+editorButton('zoom-in','+')+editorButton('fit','Fit','fit');
    toolbar.querySelector(`[data-command="hmi-${ui.hmiMode}"]`)?.classList.add('active');
    hmi=new HMIDesigner(area,project(),{mode:ui.hmiMode,selection:ui.selection?.id,onBackend:backend,onSelect:id=>select(id?{kind:'widget',id}:null),onCommit:(id,changes)=>edit('Move / resize HMI object',p=>Object.assign(p.hmi.find(w=>w.id===id),changes),{compile:false}),onWrite:(name,value,options)=>writeTag(name,value,options).catch(handleError)});hmi.update(snapshot.values);
  }else{
    toolbar.innerHTML=editorButton('project-settings','CPU configuration','settings')+editorButton('reset','Cold reset','reset')+editorButton('warm-reset','Warm restart','reset')+'<span class="toolbar-note">Local virtual CPU · no network transport</span>';
    area.innerHTML=`<div class="online-dashboard"><div class="dashboard-card"><h2>RF-1200 Virtual CPU <span class="language-pill">SIMULATION ONLY</span></h2><div class="dashboard-grid"><div class="stat-tile"><span>CPU operating mode</span><strong data-stat="mode">${mode}</strong></div><div class="stat-tile"><span>Completed scans</span><strong data-stat="scan">0</strong></div><div class="stat-tile"><span>Virtual elapsed time</span><strong data-stat="time">0 s</strong></div><div class="stat-tile"><span>Last scan CPU execution</span><strong data-stat="cpu">0 ms</strong></div><div class="stat-tile"><span>Scan instruction count</span><strong data-stat="operations">0</strong></div><div class="stat-tile"><span>Active I/O forces</span><strong data-stat="forces">0</strong></div></div><div class="callout">Input sampling → cyclic OB and block calls → atomic output commit → trace sample. Browser repaint timing never changes the virtual scan step.</div><p class="property-help">Configured cycle: ${project().cycleMs} ms. STOP and FAULT de-energize physical simulated outputs. Pause preserves the last committed output state. A warm restart retains only memory tags explicitly marked Retain.</p></div><div class="dashboard-card"><h2>Execution speed</h2><select id="speedSelect" aria-label="Simulation speed"><option value="1">1× real-time target</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="16">16×</option></select><p class="property-help">Fixed-step scheduling, bounded worker batches, and no dropped virtual scan steps. Wall-clock speed is best effort; this is not a real-time control system.</p></div></div>`;
  }
}
function hitAt(point){return [...(graphLayout?.hits||[])].reverse().find(h=>point.x>=h.x&&point.x<=h.x+h.w&&point.y>=h.y&&point.y<=h.y+h.h);}
function connectPin(input){
  if(!wire||input?.kind!=='pin'||input.direction!=='in')return false;const source={node:wire.node,port:wire.port};wire=null;
  edit('Connect FBD pins',p=>{p.blocks.find(b=>b.id===ui.block).nodes.find(n=>n.id===input.id).inputs[input.pin]=source;});return true;
}
function bindGraph(stage){
  stage.addEventListener('contextmenu',e=>e.preventDefault());
  stage.addEventListener('pointerdown',e=>{
    if(e.target.closest('button'))return;stage.focus({preventScroll:true});const point=mainSurface.point(e),hit=hitAt(point);stage.setPointerCapture(e.pointerId);
    if(e.button===1||spaceDown||(!hit&&!wire)){e.preventDefault();drag={kind:'pan',x:e.clientX,y:e.clientY,cx:mainSurface.camera.x,cy:mainSurface.camera.y};return;}
    if(e.button!==0)return;
    if(hit?.kind==='pin'){
      if(connectPin(hit))return;
      if(hit.direction==='out'){wire={node:hit.id,port:hit.pin,end:point};mainSurface.invalidate();toast('Connect to an input pin. Escape cancels.');}
      else select({kind:'node',id:hit.id});return;
    }
    if(hit?.kind==='node'){
      const n=block().nodes.find(n=>n.id===hit.id);select({kind:'node',id:n.id});drag={kind:'node',id:n.id,start:point,x:n.x,y:n.y,preview:{id:n.id,x:n.x,y:n.y}};
    }else if(hit)select({kind:hit.kind,id:hit.id,network:hit.network,branch:hit.branch});
  });
  stage.addEventListener('pointermove',e=>{
    if(!mainSurface)return;const point=mainSurface.point(e);
    if(wire){wire.end=point;mainSurface.invalidate();}
    if(drag?.kind==='pan'){mainSurface.camera.x=drag.cx+e.clientX-drag.x;mainSurface.camera.y=drag.cy+e.clientY-drag.y;mainSurface.invalidate();}
    else if(drag?.kind==='node'){const snap=v=>e.altKey?Math.round(v):Math.round(v/20)*20;drag.preview={id:drag.id,x:Math.max(0,snap(drag.x+point.x-drag.start.x)),y:Math.max(0,snap(drag.y+point.y-drag.start.y))};mainSurface.invalidate();}
    else{const hit=hitAt(point);stage.style.cursor=hit?.kind==='pin'?'crosshair':hit?.kind==='node'?'move':hit?'pointer':'default';}
  });
  stage.addEventListener('pointerup',e=>{
    if(!mainSurface)return;const hit=hitAt(mainSurface.point(e));if(wire&&connectPin(hit)){drag=null;return;}
    const d=drag;drag=null;
    if(d?.kind==='node'&&(d.preview.x!==d.x||d.preview.y!==d.y))edit('Move FBD operator',p=>Object.assign(p.blocks.find(b=>b.id===ui.block).nodes.find(n=>n.id===d.id),{x:d.preview.x,y:d.preview.y}),{compile:false});
  });
  stage.addEventListener('pointercancel',()=>{drag=null;wire=null;mainSurface?.invalidate();});
  stage.addEventListener('dblclick',e=>{const hit=hitAt(mainSurface.point(e));if(hit?.kind==='action'){const n=block().networks.find(n=>n.id===hit.id);if(n.action.type==='CALL'){navigate('block',n.action.block);return;}}if(hit){select({kind:hit.kind,id:hit.id,network:hit.network});$('#taskContent input, #taskContent select')?.focus();}});
  stage.addEventListener('wheel',e=>{
    e.preventDefault();const r=stage.getBoundingClientRect();if(e.ctrlKey||e.metaKey)mainSurface.zoomAt(Math.exp(-e.deltaY*.002),e.clientX-r.left,e.clientY-r.top);
    else{if(e.shiftKey)mainSurface.camera.x-=e.deltaY;else{mainSurface.camera.y-=e.deltaY;mainSurface.camera.x-=e.deltaX;}mainSurface.camera.y=Math.min(120,Math.max(-Math.max(100,graphLayout?.height||100)*mainSurface.camera.zoom+35,mainSurface.camera.y));mainSurface.invalidate();}
  },{passive:false});
}
function highlightST(source){
  const pattern=/\(\*[\s\S]*?\*\)|\/\/[^\n]*|\b(?:TIME|T)#[\da-z.]+|\b(?:\d+(?:\.\d*)?)(?:[eE][+-]?\d+)?\b|\b[A-Za-z_][A-Za-z_0-9]*\b/gi;let out='',index=0;
  const keywords=new Set(['VAR','END_VAR','IF','THEN','ELSIF','ELSE','END_IF','FOR','TO','BY','DO','END_FOR','TRUE','FALSE','AND','OR','XOR','NOT','MOD',...TYPES,...FB_TYPES]);
  const functions=new Set(['TO_REAL','TO_INT','ABS','MIN','MAX','LIMIT','SQRT','INT_TO_REAL','REAL_TO_INT']);
  for(const match of source.matchAll(pattern)){out+=esc(source.slice(index,match.index));const t=match[0],upper=t.toUpperCase(),cl=t.startsWith('(*')||t.startsWith('//')?'st-comment':/^(T|TIME)#/i.test(t)?'st-time':/^\d/.test(t)?'st-number':keywords.has(upper)?'st-keyword':functions.has(upper)?'st-function':'';out+=cl?`<span class="${cl}">${esc(t)}</span>`:esc(t);index=match.index+t.length;}
  return out+esc(source.slice(index));
}
function tagOptions(value,{bool=false,numeric=false,writable=false,io=false,empty=false}={}){return (empty?'<option value="">— none —</option>':'')+project().tags.filter(t=>(!bool||t.type==='BOOL')&&(!numeric||['INT','DINT','REAL'].includes(t.type))&&(!writable||t.io!=='input')&&(!io||t.io!=='memory')).map(t=>`<option value="${esc(t.name)}" ${t.name===value?'selected':''}>${esc(t.name)} · ${t.type}</option>`).join('');}
function tagTable(){return `<table><thead><tr><th>#</th><th>Name</th><th>Data type</th><th>I/O area</th><th>Symbolic address</th><th>Initial value</th><th>Monitor value</th><th>Retain</th><th>Watch</th><th>Comment</th><th></th></tr></thead><tbody>${project().tags.map((t,i)=>`<tr><td class="row-number">${i+1}</td><td><input class="table-input name" data-tag-field="name" data-id="${t.id}" value="${esc(t.name)}" aria-label="Tag name"></td><td><select class="table-input" data-tag-field="type" data-id="${t.id}" aria-label="Data type">${TYPES.map(v=>`<option ${v===t.type?'selected':''}>${v}</option>`).join('')}</select></td><td><select class="table-input" data-tag-field="io" data-id="${t.id}" aria-label="I/O area">${['input','output','memory'].map(v=>`<option ${v===t.io?'selected':''}>${v}</option>`).join('')}</select></td><td><input class="table-input address-cell" data-tag-field="address" data-id="${t.id}" value="${esc(t.address)}" aria-label="Symbolic address"></td><td><input class="table-input" data-tag-field="initial" data-id="${t.id}" value="${esc(formatValue(t.initial,t.type==='TIME'?undefined:t.type))}" aria-label="Initial value"></td><td class="live-value" data-live="${esc(t.name)}"></td><td><input type="checkbox" data-tag-field="retain" data-id="${t.id}" ${t.retain?'checked':''} ${t.io!=='memory'?'disabled':''} aria-label="Retain ${esc(t.name)}"></td><td><input type="checkbox" data-watch-toggle="${esc(t.name)}" ${(project().watch||[]).includes(t.name)?'checked':''} aria-label="Watch ${esc(t.name)}"></td><td><input class="table-input comment" data-tag-field="comment" data-id="${t.id}" value="${esc(t.comment)}" aria-label="Comment"></td><td><button class="chip-remove" data-delete-tag="${t.id}" title="Delete tag">×</button></td></tr>`).join('')}</tbody></table>${project().tags.length?'':'<div class="empty-state">No tags declared. Add typed tags before using them in a program.</div>'}`;}
function watchTable(full=false){
  const tags=(project().watch||[]).map(byTag).filter(Boolean);
  return `<table class="watch-table"><thead><tr><th>#</th><th>Tag name</th><th>Address</th><th>Type</th><th>Monitor value</th><th>Modify value</th><th>Write</th><th>Force</th>${full?'<th>Program value</th><th></th>':''}</tr></thead><tbody>${tags.map((t,i)=>`<tr><td class="row-number">${i+1}</td><td>${icon(t.io==='input'?'download':t.io==='output'?'export':'tags')} <span>${esc(t.name)}</span></td><td class="address-cell">${esc(t.address)}</td><td class="type-cell">${t.type}</td><td class="live-value" data-live="${esc(t.name)}"></td><td><input class="value-input" data-modify="${esc(t.name)}" aria-label="Modify ${esc(t.name)}" placeholder="${t.type==='BOOL'?'TRUE/FALSE':'value'}"></td><td><button class="tiny-button" data-write-tag="${esc(t.name)}">Write</button></td><td>${t.io!=='memory'?`<button class="tiny-button" data-force-tag="${esc(t.name)}">Force</button>`:'<span class="address-cell">—</span>'}</td>${full?`<td data-program-value="${esc(t.name)}" class="live-value"></td><td><button class="chip-remove" data-remove-watch="${esc(t.name)}">×</button></td>`:''}</tr>`).join('')}</tbody></table>${tags.length?'':'<div class="empty-state">No watch tags. Add tags using the watch configuration or the PLC tag table.</div>'}`;
}
function renderBottom(){
  bottomSurface?.destroy();bottomSurface=null;
  const list=[['watch','Watch table','watch'],['diagnostics','Diagnostics','info'],['instances','Instances','block'],['trace','Trace','trace'],['properties','Inspect','settings']];
  $('#bottomTabs').innerHTML=list.map(([tab,label,svg])=>`<button class="${ui.bottom===tab?'active':''}" data-bottom="${tab}">${icon(svg)}${label}${tab==='diagnostics'&&diagnostics.some(d=>d.severity==='error')?`<span class="badge-count">${diagnostics.filter(d=>d.severity==='error').length}</span>`:''}</button>`).join('')+'<span class="bottom-note">RF-1200 · virtual process image</span>';
  const content=$('#bottomContent');
  if(ui.bottom==='watch')content.innerHTML=watchTable();
  else if(ui.bottom==='diagnostics'){
    const combined=[...diagnostics,...log.slice().reverse()];content.innerHTML=combined.map(d=>`<div class="diagnostic-row ${d.severity}"><span class="diagnostic-icon">${d.severity==='error'?'●':d.severity==='warning'?'▲':'✓'}</span><span class="severity">${d.severity==='info'?'Information':d.severity}</span><span>${esc(d.message)}</span>${d.block?`<button data-goto-block="${d.block}" data-line="${d.line||0}">${esc(project().blocks.find(b=>b.id===d.block)?.name||d.block)}${d.line?' : '+d.line:''}</button>`:`<span class="address-cell">${d.time||'Project'}</span>`}</div>`).join('');
  }else if(ui.bottom==='instances')renderInstances();
  else if(ui.bottom==='properties'){content.innerHTML=`<div style="padding:14px;max-width:600px">${propertyHTML()}</div>`;bindProperties(content);}
  else{content.innerHTML='<div class="trace-stage"></div>';bottomSurface=new VectorSurface(content.firstElementChild,{onBackend:backend,draw:(s,v)=>drawTrace(s,v,snapshot,project())});}
  updateLive();
}
function renderInstances(){
  const entries=Object.entries(snapshot?.instances||{});$('#bottomContent').innerHTML=entries.length?`<table><thead><tr><th>Instance path / call site</th><th>Outputs</th></tr></thead><tbody>${entries.map(([k,v])=>`<tr><td class="address-cell">${esc(k)}</td><td class="live-value">${Object.entries(v).map(([pin,value])=>`${pin} = ${formatValue(value)}`).join(' &nbsp;·&nbsp; ')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">Function-block instances are allocated when the program first executes them.</div>';
}
function renderIO(){
  const inputs=project().tags.filter(t=>t.io==='input'),outputCount=project().tags.filter(t=>t.io==='output').length;
  $('#ioContent').innerHTML=inputs.filter(t=>t.type==='BOOL').map(t=>`<div class="io-row"><i class="io-led" data-led="${esc(t.name)}"></i><span class="address">${esc(t.address)}</span><span class="io-label">${esc(t.name)}</span><button class="toggle" data-toggle-input="${esc(t.name)}" role="switch" aria-checked="false" aria-label="Toggle ${esc(t.name)}"></button></div>`).join('')+inputs.filter(t=>t.type!=='BOOL').map(t=>`<div class="io-analog"><div><span>${esc(t.name)} <small class="address-cell">${esc(t.address)}</small></span><b data-live="${esc(t.name)}"></b></div><input type="range" min="0" max="${t.name==='LevelRaw'?27648:t.type==='INT'?32767:100}" step="${t.type==='REAL'?'.1':'1'}" data-analog-input="${esc(t.name)}" aria-label="${esc(t.name)} analog input"></div>`).join('')+(inputs.length?'':`<div class="empty-state">Declare input tags to simulate I/O.</div>`);
  $('#plantToggle').checked=snapshot?.plantEnabled??project().plantEnabled;$('#plantToggle').title=byTag('LevelRaw')?'Feeds LevelRaw and PartSensor using a deterministic tank / conveyor model.':'Demonstration plant requires LevelRaw and PartSensor tags.';
}
function updateLive(){
  const values=snapshot?.values||{},forces=snapshot?.forces||{};
  $$('[data-live]').forEach(el=>{const name=el.dataset.live,t=byTag(name);el.textContent=formatValue(values[name]??t?.initial,t?.type);el.classList.toggle('true',values[name]===true);el.classList.toggle('forced',Object.hasOwn(forces,name));});
  $$('[data-program-value]').forEach(el=>{const t=byTag(el.dataset.programValue);el.textContent=formatValue(snapshot?.programValues?.[t?.name],t?.type);});
  $$('[data-led]').forEach(el=>{el.classList.toggle('on',!!values[el.dataset.led]);el.classList.toggle('forced',Object.hasOwn(forces,el.dataset.led));});
  $$('[data-toggle-input]').forEach(el=>{const on=!!values[el.dataset.toggleInput];el.classList.toggle('on',on);el.setAttribute('aria-checked',String(on));});
  $$('[data-analog-input]').forEach(el=>{if(document.activeElement!==el)el.value=values[el.dataset.analogInput]??0;el.disabled=!!snapshot?.plantEnabled&&['LevelRaw','PartSensor'].includes(el.dataset.analogInput);});
  $$('[data-toggle-input="PartSensor"]').forEach(el=>{el.disabled=!!snapshot?.plantEnabled;el.title=el.disabled?'Disable Plant to control this sensor manually.':'Toggle physical simulated input';});
  $$('[data-force-tag]').forEach(el=>{const on=Object.hasOwn(forces,el.dataset.forceTag);el.textContent=on?'Release':'Force';el.classList.toggle('force-active',on);});
  $$('[data-stat]').forEach(el=>{el.textContent={mode,scan:(snapshot?.scan||0).toLocaleString(),time:((snapshot?.timeMs||0)/1000).toFixed(3)+' s',cpu:(snapshot?.lastCPUms||0).toFixed(3)+' ms',operations:(snapshot?.operations||0).toLocaleString(),forces:Object.keys(forces).length}[el.dataset.stat];});
  if(ui.bottom==='instances')renderInstances();hmi?.update(values);updateStatus();
}
function currentNetwork(){const b=block();if(b?.language!=='LAD')return null;return b.networks.find(n=>n.id===(ui.selection?.network||ui.selection?.id)||[...n.series,...n.branches.flat()].some(c=>c.id===ui.selection?.id))||b.networks[0];}
function currentContact(){const n=currentNetwork();return n&&[...n.series,...n.branches.flat()].find(c=>c.id===ui.selection?.id);}
function field(key,label,value,{options,type='text',placeholder='',help=''}={}){return `<div class="field"><label>${esc(label)}</label>${options!==undefined?`<select data-prop="${key}" aria-label="${esc(label)}">${options}</select>`:type==='textarea'?`<textarea data-prop="${key}" aria-label="${esc(label)}">${esc(value)}</textarea>`:`<input type="${type}" data-prop="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}">`}${help?`<span class="property-help">${esc(help)}</span>`:''}</div>`;}
const options=(items,selected)=>items.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(x)}</option>`).join('');
function propertyHTML(){
  const b=block(),s=ui.selection,n=currentNetwork();
  if(ui.view==='hmi'){
    const w=project().hmi.find(w=>w.id===s?.id);
    if(!w)return '<div class="property-heading">Overview screen</div><div class="property-kind">HMI_1 · 900 × 520</div><p class="property-help">Select an object to edit its layout, binding, appearance, and interaction. Drag an object to move it; drag its lower-right handle to resize.</p><div class="button-row"><button data-command="add-widget">Add object</button><button data-command="hmi-runtime">Run HMI</button></div><div class="property-section"><h3>Objects</h3>'+project().hmi.map(w=>`<div class="chip-row"><button class="contact-chip" data-select-widget="${w.id}">${esc(w.label||w.type)} <small>· ${esc(w.type)}</small></button></div>`).join('')+'</div>';
    let html=`<div class="property-heading">${icon('hmi')}${esc(w.label||w.type)}</div><div class="property-kind">HMI ${esc(w.type)} · ${esc(w.id)}</div>`+field('widget.label','Label',w.label);
    if(!['label','panel'].includes(w.type))html+=field('widget.tag','PLC tag binding',w.tag,{options:tagOptions(w.tag,{bool:['button','lamp'].includes(w.type),numeric:['slider','tank','gauge'].includes(w.type),empty:true})});
    html+='<div class="field-row">'+field('widget.x','X (px)',w.x,{type:'number'})+field('widget.y','Y (px)',w.y,{type:'number'})+field('widget.w','Width',w.w,{type:'number'})+field('widget.h','Height',w.h,{type:'number'})+'</div>'+field('widget.color','Color',w.color||'#328ec2',{type:'color'});
    if(['slider','tank','gauge','value'].includes(w.type))html+='<div class="field-row">'+field('widget.min','Minimum',w.min??0,{type:'number'})+field('widget.max','Maximum',w.max??100,{type:'number'})+'</div>'+field('widget.unit','Unit label',w.unit||'');
    if(w.type==='slider')html+=field('widget.step','Step',w.step||1,{type:'number'});
    if(w.type==='label')html+=field('widget.fontSize','Font size',w.fontSize||16,{type:'number'});
    if(w.type==='button')html+=field('widget.behavior','Button action',w.behavior||'momentary',{options:options(['momentary','toggle'],w.behavior||'momentary')});
    return html+'<div class="button-row"><button data-command="duplicate">Duplicate</button><button data-command="delete">Delete object</button></div><p class="property-help">Design-mode actions never write tags. Runtime-mode controls send typed writes to the local PLC worker.</p>';
  }
  if(ui.view==='block'&&b.language==='LAD'&&s?.kind==='contact'){
    const c=currentContact();if(c)return `<div class="property-heading">${c.negated?'—|/|—':'—| |—'} Contact</div><div class="property-kind">${esc(n.title)}</div>`+field('contact.tag','BOOL operand',c.tag,{options:tagOptions(c.tag,{bool:true})})+`<label class="field-inline"><input type="checkbox" data-prop="contact.negated" ${c.negated?'checked':''}>Normally closed / invert</label>`+field('contact.expression','Optional BOOL expression',c.expression||'',{placeholder:'Leave empty to use the tag',help:'Expressions support AND, OR, NOT and typed comparisons.'})+`<div class="property-section"><h3>Monitor</h3><div class="property-help">Operand value: <b data-live="${esc(c.tag)}"></b></div></div><button class="subtle-button" data-select-network="${n.id}">← Network properties</button><button class="danger-button" data-command="delete">Remove contact</button>`;
  }
  if(ui.view==='block'&&b.language==='LAD'&&n&&s?.kind!=='block'){
    let html=`<div class="property-heading">Network ${b.networks.indexOf(n)+1}</div><div class="property-kind">${esc(n.id)} · LAD</div>`+field('network.title','Title',n.title)+field('network.comment','Comment',n.comment||'',{type:'textarea'});
    html+='<div class="property-section"><h3>Output instruction</h3>'+actionProperties(n)+'</div>';
    html+='<div class="property-section"><h3>Series contacts</h3>'+n.series.map(c=>`<div class="chip-row"><button class="contact-chip" data-select-contact="${c.id}" data-network="${n.id}">${c.negated?'|/|':'| |'} ${esc(c.expression||c.tag)}</button><button class="chip-remove" data-remove-contact="${c.id}">×</button></div>`).join('')+'<button class="subtle-button" data-command="add-contact">+ Add series contact</button></div>';
    html+='<div class="property-section"><h3>Parallel branches</h3>'+n.branches.map((branch,i)=>`<div class="branch-box"><div class="branch-header"><span>Branch ${i+1}</span><button data-remove-branch="${i}">×</button></div>${branch.map(c=>`<div class="chip-row"><button class="contact-chip" data-select-contact="${c.id}" data-network="${n.id}">${c.negated?'|/|':'| |'} ${esc(c.tag)}</button><button class="chip-remove" data-remove-contact="${c.id}">×</button></div>`).join('')}<button class="subtle-button" data-add-branch-contact="${i}">+ Contact</button></div>`).join('')+'<button class="subtle-button" data-command="add-branch">+ Add parallel branch</button></div>';
    html+='<div class="button-row"><button data-command="network-up">↑ Move up</button><button data-command="network-down">↓ Move down</button><button data-command="duplicate">Duplicate</button></div><button class="danger-button" data-command="delete-network">Delete network</button>';return html;
  }
  if(ui.view==='block'&&b.language==='FBD'&&s?.kind==='node'){
    const node=b.nodes.find(n=>n.id===s.id);if(node){let html='<div class="property-heading">Function-block operator</div><div class="property-kind">'+esc(node.id)+'</div>'+field('node.op','Instruction',node.op,{options:options(Object.keys(FBD_SPECS),node.op)});
      if(['READ','WRITE'].includes(node.op))html+=field('node.tag','PLC tag',node.tag,{options:tagOptions(node.tag,{writable:node.op==='WRITE'})});
      if(node.op==='CONST')html+=field('node.value','Typed literal / expression',node.value||'TRUE');
      html+='<div class="field-row">'+field('node.x','X',node.x,{type:'number'})+field('node.y','Y',node.y,{type:'number'})+'</div><div class="property-section"><h3>Input pins</h3>';
      for(const pin of FBD_SPECS[node.op].inputs){const src=node.inputs[pin],linked=src?.node;const wireOptions='<option value="">Inline expression</option>'+b.nodes.filter(n=>n.id!==node.id).flatMap(n=>FBD_SPECS[n.op].outputs.map(p=>`<option value="${n.id}|${p}" ${linked&&src.node===n.id&&(src.port||'OUT')===p?'selected':''}>${esc(n.tag||n.op)} · ${esc(n.id.slice(-6))}.${p}</option>`)).join('');html+=`<div class="field"><label>${pin} · source</label><select data-pin-wire="${pin}" aria-label="${pin} source">${wireOptions}</select>${linked?`<button class="subtle-button" data-disconnect-pin="${pin}">Disconnect wire</button>`:`<input data-pin-expr="${pin}" aria-label="${pin} expression" value="${esc(typeof src==='object'?src.expr:src||'')}" placeholder="Tag or expression">`}</div>`;}
      html+='</div><div class="property-help">Output pins: '+FBD_SPECS[node.op].outputs.join(', ')+'<br>Graph cycles are rejected at compile time. A tag read can be used as an explicit state boundary.</div><div class="button-row"><button data-command="duplicate">Duplicate</button><button data-command="delete">Delete operator</button></div>';return html;}
  }
  if(ui.view==='block'&&b)return '<div class="property-heading">'+icon('block')+esc(b.name)+'</div><div class="property-kind">'+b.kind+b.number+' · '+b.language+'</div>'+field('block.name','Block name',b.name)+field('block.number','Block number',b.number,{type:'number'})+field('block.comment','Comment',b.comment||'',{type:'textarea'})+'<div class="property-section"><h3>Execution</h3><p class="property-help">'+(b.id===project().entry?'This organization block is the cyclic entry point.':'This block executes only when called from the cyclic OB or another block. Each call site owns separate local state.')+'</p><button class="subtle-button" data-command="add-block">+ Add program block</button>'+(b.id!==project().entry?'<button class="danger-button" data-command="delete-block">Delete block</button>':'')+'</div>';
  return '<div class="property-heading">'+esc(project().name)+'</div><div class="property-kind">RelayForge project</div><p class="property-help">'+project().tags.length+' typed tags<br>'+project().blocks.length+' program blocks<br>'+project().hmi.length+' HMI objects<br>Scan interval: '+project().cycleMs+' ms</p><button class="subtle-button" data-command="project-settings">Project & CPU settings</button><button class="subtle-button" data-command="help">Open guide</button>';
}
function actionProperties(n){
  const a=n.action;let html=field('action.type','Instruction',a.type,{options:options(['COIL','SET','RESET',...FB_TYPES,'MOVE','CALL'],a.type)});
  if(['COIL','SET','RESET'].includes(a.type))html+=field('action.target','BOOL destination',a.target,{options:tagOptions(a.target,{bool:true,writable:true})});
  else if(a.type==='CALL')html+=field('action.block','Called program block',a.block,{options:project().blocks.filter(b=>b.kind!=='OB').map(b=>`<option value="${b.id}" ${b.id===a.block?'selected':''}>${esc(b.name)} [${b.kind}${b.number}]</option>`).join('')});
  else if(a.type==='MOVE')html+=field('action.value','Source expression',a.value||'0')+field('action.target','Destination',a.target,{options:tagOptions(a.target,{writable:true})});
  else if(FB_SPECS[a.type]){
    const spec=FB_SPECS[a.type],inputPins=Object.keys(spec.inputs);html+='<p class="property-help">'+inputPins[0]+' receives the rung logic result.</p>';
    for(const pin of inputPins.slice(1))html+=field(`action-input.${pin}`,`${pin} (${spec.inputs[pin]})`,a.inputs?.[pin]??'');
    for(const [pin,type]of Object.entries(spec.outputs))html+=field(`action-output.${pin}`,`${pin} → ${type}`,a.outputs?.[pin]||'',{options:'<option value="">Not mapped</option>'+project().tags.filter(t=>t.io!=='input'&&(t.type===type||['INT','DINT'].includes(t.type)&&['INT','DINT'].includes(type))).map(t=>`<option value="${esc(t.name)}" ${t.name===a.outputs?.[pin]?'selected':''}>${esc(t.name)}</option>`).join('')});
  }
  return html;
}
function bindProperties(root){
  root.querySelectorAll('[data-prop]').forEach(el=>el.onchange=()=>{
    const [scope,key]=el.dataset.prop.split('.');let value=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;
    const s=ui.selection,n=currentNetwork(),c=currentContact();
    edit('Edit '+el.dataset.prop,p=>{
      const b=p.blocks.find(b=>b.id===ui.block),network=b?.networks?.find(v=>v.id===n?.id);
      if(scope==='widget'){const w=p.hmi.find(v=>v.id===s?.id);if(w)w[key]=value;}
      else if(scope==='block'){if(key==='number'&&(!Number.isInteger(value)||value<1||value>65535))throw new Error('Block number must be 1..65535.');b[key]=value;}
      else if(scope==='network')network[key]=value;
      else if(scope==='contact'){const contact=[...network.series,...network.branches.flat()].find(v=>v.id===c?.id);if(key==='expression'&&!value)delete contact.expression;else contact[key]=value;}
      else if(scope==='action'){if(key==='type')network.action=defaultAction(value);else network.action[key]=value;}
      else if(scope==='action-input'){network.action.inputs??={};network.action.inputs[key]=value;}
      else if(scope==='action-output'){network.action.outputs??={};if(value)network.action.outputs[key]=value;else delete network.action.outputs[key];}
      else if(scope==='node'){const node=b.nodes.find(v=>v.id===s?.id);if(key==='op'){const defaults=defaultNode(value);node.op=value;node.inputs=Object.fromEntries(FBD_SPECS[value].inputs.map(pin=>[pin,node.inputs[pin]??defaults.inputs[pin]]));node.tag ||= defaults.tag;node.value ||= defaults.value;}else node[key]=value;}
    },{compile:!['widget'].includes(scope)&&!(scope==='node'&&['x','y'].includes(key))});
  });
  root.querySelectorAll('[data-pin-expr]').forEach(el=>el.onchange=()=>edit('Edit FBD expression',p=>{p.blocks.find(b=>b.id===ui.block).nodes.find(n=>n.id===ui.selection.id).inputs[el.dataset.pinExpr]={expr:el.value};}));
  root.querySelectorAll('[data-pin-wire]').forEach(el=>el.onchange=()=>edit('Edit FBD connection',p=>{const node=p.blocks.find(b=>b.id===ui.block).nodes.find(n=>n.id===ui.selection.id);const [id,port]=el.value.split('|');node.inputs[el.dataset.pinWire]=id?{node:id,port}:{expr:defaultNode(node.op).inputs[el.dataset.pinWire]?.expr||'FALSE'};}));
}
function renderTask(){
  $('#instructionsTab').classList.toggle('active',ui.task==='instructions');$('#propertiesTab').classList.toggle('active',ui.task==='properties');
  const root=$('#taskContent');if(ui.task==='properties'){root.innerHTML=propertyHTML();bindProperties(root);updateLive();return;}
  const b=block();let groups=[];
  if(ui.view==='hmi')groups=[['HMI objects',[['button','▭','Button'],['lamp','●','Indicator lamp'],['value','123','Numeric display'],['gauge','◔','Gauge'],['tank','▥','Tank level'],['slider','↔','Slider'],['label','Aa','Text label'],['panel','▣','Panel']]]];
  else if(ui.view==='block'&&b.language==='FBD')groups=[['Data & logic',[['READ','↗','Read tag'],['WRITE','↘','Write tag'],['CONST','1.0','Constant'],['AND','&','AND'],['OR','≥1','OR'],['NOT','¬','NOT'],['XOR','=1','XOR']]],['Math & comparison',[['ADD','+','Add'],['SUB','−','Subtract'],['MUL','×','Multiply'],['DIV','÷','Divide'],['GT','>','Greater'],['LT','<','Less'],['GE','≥','Greater/equal'],['EQ','=','Equal']]],['Timers & counters',FB_TYPES.map(t=>[t,t,t])]];
  else if(ui.view==='block'&&b.language==='ST')groups=[['Structured text',[['IF','IF','Conditional'],['FOR','FOR','Bounded loop'],['TON','TON','Timer example']]]];
  else groups=[['Bit logic',[['contact','—| |—','NO contact'],['nc','—|/|—','NC contact'],['COIL','—( )—','Output coil'],['branch','┬─┬','Parallel branch'],['SET','—(S)—','Set output'],['RESET','—(R)—','Reset output']]],['Timer operations',[['TON','TON','On-delay'],['TOF','TOF','Off-delay'],['TP','TP','Pulse timer']]],['Counter & edge operations',[['CTU','CTU','Count up'],['CTD','CTD','Count down'],['CTUD','CTUD','Up / down'],['R_TRIG','R_TRIG','Rising edge'],['F_TRIG','F_TRIG','Falling edge']]],['Program control',[['CALL','CALL','Call block'],['MOVE','MOVE','Move value']]]];
  root.innerHTML='<div class="task-search"><input id="instructionSearch" placeholder="Find instruction…" aria-label="Find instruction"></div>'+groups.map(([name,items])=>`<div class="instruction-group"><div class="instruction-heading"><span>⌄</span>${name}</div><div class="instruction-grid">${items.map(([kind,symbol,label])=>`<button class="instruction" data-instruction="${kind}" title="Insert ${label}"><span class="symbol">${symbol}</span><small>${label}</small></button>`).join('')}</div></div>`).join('')+'<p class="instruction-note">'+(ui.view==='hmi'?'Select an object, then edit its PLC tag binding in Properties.':b?.language==='FBD'?'Click to insert an operator. Connect output pins to input pins; inline expressions are editable in Properties.':'Click an instruction to insert it into the selected network. Select any element to edit its properties.')+'</p>';
  $('#instructionSearch').oninput=e=>root.querySelectorAll('[data-instruction]').forEach(el=>el.style.display=el.textContent.toLowerCase().includes(e.target.value.toLowerCase())?'':'none');
}
function defaultAction(type){
  const bool=project().tags.find(t=>t.io!=='input'&&t.type==='BOOL')?.name||'';
  if(['COIL','SET','RESET'].includes(type))return {type,target:bool};
  if(type==='CALL')return {type,block:project().blocks.find(b=>b.kind!=='OB')?.id||''};
  if(type==='MOVE')return {type,value:'0',target:project().tags.find(t=>t.io!=='input'&&t.type==='DINT')?.name||''};
  const spec=FB_SPECS[type],inputs={},outputs={};
  for(const [pin,t]of Object.entries(spec.inputs).slice(1))inputs[pin]=t==='BOOL'?(pin==='R'&&byTag('ResetBatch')?'ResetBatch':'FALSE'):t==='TIME'?'T#1s':byTag('BatchTarget')?'BatchTarget':'10';
  for(const [pin,t]of Object.entries(spec.outputs)){const preferred=pin==='Q'?(type.startsWith('CT')?'BatchDone':'StartReady'):pin==='CV'?'PartsCount':pin==='ET'?'StartDelay':null;const name=preferred&&byTag(preferred)?preferred:project().tags.find(v=>v.io!=='input'&&v.type===t)?.name;if(name)outputs[pin]=name;}
  return {type,inputs,outputs};
}
function defaultNode(op){
  const inputs={},spec=FBD_SPECS[op];for(const pin of spec.inputs){const t=FB_SPECS[op]?.inputs[pin];inputs[pin]={expr:t==='TIME'?'T#1s':t==='DINT'?'10':t==='BOOL'||['AND','OR','XOR','NOT','WRITE'].includes(op)?'FALSE':'0.0'};}
  return {id:uid('node'),op,inputs,x:100,y:100,...(op==='READ'?{tag:project().tags[0]?.name||''}:op==='WRITE'?{tag:project().tags.find(t=>t.io!=='input'&&t.type==='BOOL')?.name||''}:op==='CONST'?{value:'TRUE'}:{})};
}
function addNetwork(type='COIL'){
  if(ui.view!=='block'||block().language!=='LAD'){toast('Open a LAD program block first.');return;}
  const n=currentNetwork(),id=uid('net'),tag=project().tags.find(t=>t.type==='BOOL')?.name;
  const next={id,title:`${type==='COIL'?'New logic network':type+' instruction'}`,comment:'',series:tag?[{id:uid('contact'),tag,negated:false}]:[],branches:[],action:defaultAction(type)};
  ui.selection={kind:'network',id};ui.task='properties';
  edit('Add ladder network',p=>{const nets=p.blocks.find(b=>b.id===ui.block).networks;const index=n?nets.findIndex(v=>v.id===n.id)+1:nets.length;nets.splice(index,0,next);});
  requestAnimationFrame(()=>scrollToNetwork(id));
}
function addContact(negated=false,branch=-1){
  const n=currentNetwork();if(!n){addNetwork();return;}
  const tag=project().tags.find(t=>t.type==='BOOL');if(!tag){toast('Declare a BOOL tag in the PLC tag table first.');navigate('tags');return;}
  const c={id:uid('contact'),tag:tag.name,negated};ui.selection={kind:'contact',id:c.id,network:n.id,branch};ui.task='properties';
  edit('Add contact',p=>{const target=p.blocks.find(b=>b.id===ui.block).networks.find(v=>v.id===n.id);(branch<0?target.series:target.branches[branch]).push(c);});
}
function addBranch(){const n=currentNetwork();if(!n){addNetwork();return;}const t=project().tags.find(t=>t.type==='BOOL');ui.selection={kind:'network',id:n.id};ui.task='properties';edit('Add parallel branch',p=>p.blocks.find(b=>b.id===ui.block).networks.find(v=>v.id===n.id).branches.push(t?[{id:uid('contact'),tag:t.name,negated:false}]:[]));}
function addNode(op='AND'){
  if(ui.view!=='block'||block().language!=='FBD'){toast('Open a FBD program block first.');return;}
  const node=defaultNode(op),point=mainSurface?.world(mainSurface.width/2-70,mainSurface.height/2-50)||{x:100,y:100};node.x=Math.max(20,Math.round(point.x/20)*20);node.y=Math.max(20,Math.round(point.y/20)*20);ui.selection={kind:'node',id:node.id};ui.task='properties';edit('Add FBD operator',p=>p.blocks.find(b=>b.id===ui.block).nodes.push(node));
}
function addWidget(type='button'){
  if(ui.view!=='hmi'){navigate('hmi');}ui.hmiMode='design';
  const t=project().tags.find(t=>['lamp','button'].includes(type)?t.type==='BOOL':t.type==='REAL')||project().tags[0];
  const w={id:uid('hmi'),type,label:{button:'BUTTON',lamp:'STATUS',tank:'TANK',gauge:'GAUGE',value:'VALUE',slider:'SETPOINT',label:'New text',panel:'PANEL'}[type],tag:['label','panel'].includes(type)?'':t?.name||'',x:100,y:120,w:type==='tank'?150:type==='lamp'?100:180,h:type==='tank'?230:type==='gauge'?170:type==='lamp'?80:type==='value'?95:type==='label'?35:55,color:type==='button'?'#316c8c':'#339ed0',min:0,max:100,unit:'',behavior:'momentary'};
  ui.selection={kind:'widget',id:w.id};ui.task='properties';edit('Add HMI object',p=>p.hmi.push(w),{compile:false});
}
function scrollToNetwork(id){if(!mainSurface||block()?.language!=='LAD')return;const n=ladderLayout(block()).networks.find(v=>v.network.id===id);if(n){mainSurface.camera.y=-n.y*mainSurface.camera.zoom+12;mainSurface.invalidate();}}
function renameTag(p,oldName,newName){
  const safe=oldName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),re=new RegExp(`\\b${safe}\\b`,'gi'),replace=s=>typeof s==='string'?s.replace(re,()=>newName):s;
  for(const b of p.blocks){
    if(b.language==='ST')b.source=replace(b.source);
    if(b.language==='LAD')for(const n of b.networks){for(const c of [...n.series,...n.branches.flat()]){c.tag=replace(c.tag);if(c.expression)c.expression=replace(c.expression);}const a=n.action;if(a.target)a.target=replace(a.target);if(a.value)a.value=replace(a.value);for(const k of Object.keys(a.inputs||{}))a.inputs[k]=replace(a.inputs[k]);for(const k of Object.keys(a.outputs||{}))a.outputs[k]=replace(a.outputs[k]);}
    if(b.language==='FBD')for(const n of b.nodes){if(n.tag)n.tag=replace(n.tag);if(n.value)n.value=replace(n.value);for(const k of Object.keys(n.inputs)){const v=n.inputs[k];if(typeof v==='string')n.inputs[k]=replace(v);else if(v?.expr)v.expr=replace(v.expr);}}
  }
  for(const w of p.hmi)if(w.tag?.toUpperCase()===oldName.toUpperCase())w.tag=newName;
  p.watch=(p.watch||[]).map(replace);p.trace=(p.trace||[]).map(replace);
}
function editTag(el){
  const key=el.dataset.tagField,id=el.dataset.id;edit('Edit PLC tag',p=>{
    const t=p.tags.find(t=>t.id===id);let value=el.type==='checkbox'?el.checked:el.value;
    if(key==='name'){
      if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value))throw new Error('Tag names must be identifiers: letters, digits and underscores; no leading digit.');
      if(p.tags.some(other=>other.id!==id&&other.name.toUpperCase()===value.toUpperCase()))throw new Error('A tag with this name already exists.');renameTag(p,t.name,value);
    }else if(key==='initial')value=parseInput(value,t.type);
    else if(key==='type'){try{t.initial=parseInput(t.initial,value);}catch{t.initial=defaultValue(value);}}
    else if(key==='io'&&value!=='memory')t.retain=false;
    t[key]=value;
  });
}
function showTagDialog(){dialog('Add PLC tag',`<div class="field"><label>Symbol name</label><input name="name" required pattern="[A-Za-z_][A-Za-z_0-9]*" value="Tag_${project().tags.length+1}"></div><div class="field-row"><div class="field"><label>Data type</label><select name="type">${options(TYPES,'BOOL')}</select></div><div class="field"><label>I/O area</label><select name="io">${options(['input','output','memory'],'memory')}</select></div></div><div class="field"><label>Initial value</label><input name="initial" value="0" required></div><div class="field"><label>Symbolic address (optional)</label><input name="address" placeholder="%M1.0"></div><div class="field"><label>Comment</label><input name="comment"></div>`,{submit:'Create tag',onSubmit:data=>{
  const name=data.get('name').trim(),type=data.get('type');if(project().tags.some(t=>t.name.toUpperCase()===name.toUpperCase()))throw new Error('Duplicate symbol name.');const initial=parseInput(data.get('initial'),type);
  edit('Add PLC tag',p=>p.tags.push({id:uid('tag'),name,type,io:data.get('io'),initial,address:data.get('address').trim(),comment:data.get('comment'),retain:false}));
}});}
function showBlockDialog(){dialog('Add program block',`<div class="field"><label>Block name</label><input name="name" value="Block_${project().blocks.length+1}" required pattern="[A-Za-z_][A-Za-z_0-9]*"></div><div class="field-row"><div class="field"><label>Block kind</label><select name="kind">${options(['FC','FB','OB'],'FC')}</select></div><div class="field"><label>Language</label><select name="language">${options(['LAD','FBD','ST'],'ST')}</select></div></div><p class="property-help">User blocks share the global tag table. ST VAR declarations create private state per call site. Add a CALL instruction to execute the new block.</p>`,{submit:'Create block',onSubmit:data=>{
  const name=data.get('name').trim(),language=data.get('language'),kind=data.get('kind');if(project().blocks.some(b=>b.name.toUpperCase()===name.toUpperCase()))throw new Error('Duplicate block name.');
  const newBlock={id:uid('block'),name,language,kind,number:Math.max(0,...project().blocks.filter(b=>b.kind===kind).map(b=>b.number))+1,comment:'',...(language==='LAD'?{networks:[]}:language==='FBD'?{nodes:[]}:{source:`// ${name}\n// Declare global symbols in the PLC tag table.\n`})};
  ui.view='block';ui.block=newBlock.id;ui.selection={kind:'block',id:newBlock.id};ui.task='properties';ui.camera={x:0,y:0,zoom:1};edit('Add program block',p=>p.blocks.push(newBlock));
}});}
function showProjectSettings(){dialog('Project & CPU configuration',`<div class="field"><label>Project name</label><input name="name" required maxlength="200" value="${esc(project().name)}"></div><div class="field-row"><div class="field"><label>Fixed scan step (milliseconds)</label><input type="number" name="cycleMs" value="${project().cycleMs}" min="1" max="1000" required></div><div class="field"><label>Cyclic entry OB</label><select name="entry">${project().blocks.filter(b=>b.kind==='OB').map(b=>`<option value="${b.id}" ${project().entry===b.id?'selected':''}>${esc(b.name)} [OB${b.number}]</option>`).join('')}</select></div></div><p class="callout">Changing CPU configuration stops the simulator and requires a fresh download. There is no connection to Siemens hardware or any physical I/O.</p><p class="property-help">Addresses are symbolic engineering labels, not byte-overlaid memory. BOOL, INT, DINT, REAL and TIME are checked at every assignment.</p>`,{onSubmit:data=>edit('Project settings',p=>{p.name=data.get('name');p.cycleMs=Number(data.get('cycleMs'));p.entry=data.get('entry');})});}
function showWatchDialog(){dialog('Watch table configuration',`<p>Select tags to monitor and modify.</p>${project().tags.map(t=>`<label class="field-inline"><input type="checkbox" name="tag" value="${esc(t.name)}" ${(project().watch||[]).includes(t.name)?'checked':''}>${esc(t.name)} <span class="type-cell">${t.type}</span></label>`).join('')}`,{onSubmit:data=>edit('Configure watch table',p=>{p.watch=data.getAll('tag');},{compile:false})});}
function showTraceDialog(){dialog('Execution trace channels',`<p>The worker stores a bounded, scan-indexed ring buffer. Select up to 16 channels. Changing channels requires a fresh program download and clears acquisition.</p>${project().tags.map((t,i)=>`<label class="field-inline"><input type="checkbox" name="tag" value="${esc(t.name)}" ${(project().trace||[]).includes(t.name)?'checked':''}><span style="color:${SIGNAL_COLORS[i%SIGNAL_COLORS.length]}">●</span> ${esc(t.name)} <span class="type-cell">${t.type}</span></label>`).join('')}`,{onSubmit:data=>{const tags=data.getAll('tag');if(tags.length>16)throw new Error('Maximum 16 trace channels.');edit('Configure trace channels',p=>{p.trace=tags;});}});}
function deleteSelection(){
  const s=ui.selection;if(!s){toast('Select a diagram element or HMI object first.');return;}
  if(s.kind==='widget'){ui.selection=null;edit('Delete HMI object',p=>{p.hmi=p.hmi.filter(w=>w.id!==s.id);},{compile:false});}
  else if(s.kind==='node'){ui.selection=null;edit('Delete FBD operator',p=>{const b=p.blocks.find(b=>b.id===ui.block);b.nodes=b.nodes.filter(n=>n.id!==s.id);for(const n of b.nodes)for(const [pin,v]of Object.entries(n.inputs))if(v?.node===s.id)delete n.inputs[pin];});}
  else if(s.kind==='contact'){const n=currentNetwork();ui.selection={kind:'network',id:n.id};edit('Delete contact',p=>{const net=p.blocks.find(b=>b.id===ui.block).networks.find(v=>v.id===n.id);net.series=net.series.filter(c=>c.id!==s.id);net.branches=net.branches.map(branch=>branch.filter(c=>c.id!==s.id));});}
  else if(s.kind==='network'||s.kind==='action')deleteNetwork();
}
function deleteNetwork(){const n=currentNetwork();if(!n)return;ui.selection=null;edit('Delete ladder network',p=>{const b=p.blocks.find(b=>b.id===ui.block);b.networks=b.networks.filter(v=>v.id!==n.id);});}
function duplicateSelection(){
  const s=ui.selection;if(!s){toast('Select a network, contact, FBD operator, or HMI object.');return;}
  if(s.kind==='widget'){const w=structuredClone(project().hmi.find(w=>w.id===s.id));w.id=uid('hmi');w.x=Math.min(900-w.w,w.x+20);w.y=Math.min(520-w.h,w.y+20);w.label+=' copy';ui.selection={kind:'widget',id:w.id};edit('Duplicate HMI object',p=>p.hmi.push(w),{compile:false});}
  else if(s.kind==='node'){const n=structuredClone(block().nodes.find(n=>n.id===s.id));n.id=uid('node');n.x+=40;n.y+=40;ui.selection={kind:'node',id:n.id};edit('Duplicate FBD operator',p=>p.blocks.find(b=>b.id===ui.block).nodes.push(n));}
  else if(s.kind==='contact'){
    const net=currentNetwork(),c=structuredClone(currentContact());c.id=uid('contact');ui.selection={kind:'contact',id:c.id,network:net.id};edit('Duplicate contact',p=>{const n=p.blocks.find(b=>b.id===ui.block).networks.find(n=>n.id===net.id);const branch=[n.series,...n.branches].find(v=>v.some(c=>c.id===s.id));branch.splice(branch.findIndex(c=>c.id===s.id)+1,0,c);});
  }else if(s.kind==='network'||s.kind==='action'){
    const old=currentNetwork(),n=structuredClone(old);n.id=uid('net');n.title+=' (copy)';for(const c of [...n.series,...n.branches.flat()])c.id=uid('contact');ui.selection={kind:'network',id:n.id};edit('Duplicate network',p=>{const nets=p.blocks.find(b=>b.id===ui.block).networks;nets.splice(nets.findIndex(v=>v.id===old.id)+1,0,n);});
  }
}
function moveNetwork(delta){const n=currentNetwork();if(!n)return;edit('Reorder ladder network',p=>{const a=p.blocks.find(b=>b.id===ui.block).networks,i=a.findIndex(v=>v.id===n.id),j=Math.max(0,Math.min(a.length-1,i+delta));a.splice(i,1);a.splice(j,0,n);});scrollToNetwork(n.id);}
function insertST(text){if(ui.view!=='block'||block().language!=='ST'){toast('Open a structured-text block first.');return;}const input=$('#stEditor');input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));input.focus();}
function timerExample(){dialog('Structured-text timer example',`<p>Add the declaration to the existing VAR section, then insert the invocation into the program body. Change tag names to match your project.</p><pre>VAR
    StartTimer : TON;
END_VAR

StartTimer(
    IN := RunRequest,
    PT := T#800ms,
    Q => StartReady,
    ET => StartDelay
);

Motor := StartTimer.Q;</pre><p class="property-help">A timer starts with ET = 0 on its first active call. TIME values are integer milliseconds. Instance outputs remain at their last evaluated values when the call is skipped.</p>`,{submit:'Insert invocation',onSubmit:()=>insertST('\nStartTimer(IN := RunRequest, PT := T#800ms, Q => StartReady, ET => StartDelay);\n')});}
function help(semantics=false){
  const overview=`<h3>Run the included bottling cell</h3><p>Press <b>Start cell</b> in the LAD toolbar, or use <b>PLC → Run demo cell</b>. The worker executes Main, starts the conveyor after an 800 ms TON delay, scales an analog level, controls the fill valve through the FBD block, and counts bottle-sensor rising edges.</p><p>Open <b>Overview screen</b> and select <b>Runtime</b> to operate the HMI. The cell stops at the batch target. Press RESET BATCH, then START CYCLE to run another batch. Disable <b>Plant</b> to drive LevelRaw and PartSensor manually.</p><h3>Edit a real program</h3><p>LAD: add networks, series contacts, parallel branches, coils, timers, counters, MOVE and block CALL instructions. Select a symbol to edit Properties. FBD: drag operators and connect output → input pins, or configure pin expressions in Properties. ST: edit typed source and compile with F7.</p><p>Editing program logic stops the CPU. Compile reports errors; Download performs a cold restart. Run automatically compiles and downloads changed logic. HMI layout and FBD node-position edits do not change the downloaded program.</p><h3>Watch, force and trace</h3><p>Write applies a one-time typed value; a program assignment may overwrite it. Force holds simulated I/O at a value until released. Memory tags support Modify, not Force. The raw program output is visible beside the forced value in the full watch table. Traces hold up to 4096 scan samples per channel and export to CSV.</p><h3>Keyboard shortcuts</h3><div class="help-keys"><span>Save <kbd>Ctrl / ⌘ S</kbd></span><span>Compile <kbd>F7</kbd></span><span>Run <kbd>F5</kbd></span><span>Pause / resume <kbd>F6</kbd></span><span>Single scan <kbd>F10</kbd></span><span>STOP <kbd>Shift F5</kbd></span><span>Undo / redo <kbd>Ctrl Z / Y</kbd></span><span>Duplicate <kbd>Ctrl / ⌘ D</kbd></span><span>Fit diagram <kbd>F</kbd></span><span>Pan <kbd>Space + drag</kbd></span><span>Zoom <kbd>Ctrl + wheel</kbd></span><span>Cancel wire <kbd>Escape</kbd></span></div>`;
  const execution=`<h3>Deterministic scan contract</h3><p>Scan N evaluates at virtual time N × cycleMs. At each scan: advance the optional plant using the last committed outputs; apply queued events; sample inputs once; execute the cyclic OB and its calls in order; atomically commit outputs; append the trace; advance virtual time by exactly one step.</p><p>Every call site owns a separate local frame. ST VAR scalar values and function-block instances persist between scans at that call site. User-block parameter interfaces, arrays, strings, UDTs, interrupts and Siemens binary/project formats are not implemented.</p><h3>Timers and counters</h3><p>TON resets on FALSE and becomes TRUE after PT virtual milliseconds. TOF delays a falling input and cancels its delay on TRUE. TP is non-retriggerable while active and latches PT at its trigger. Skipped calls do not refresh outputs; the next invocation uses elapsed virtual time. Reading an instance member does not update it.</p><p>CTU counts rising CU edges; R has priority. CTD loads PV on LD and decrements on rising CD. CTUD uses R → LD → edges priority; simultaneous up/down edges cancel. Counters saturate at 0 and 2147483647. Initial R_TRIG has a low previous state; initial F_TRIG does not synthesize a falling edge.</p><h3>Types and fault behavior</h3><p>BOOL is not numeric. INT and DINT are checked signed 16/32-bit integers. REAL rounds to IEEE-754 binary32 after each operation. TIME is checked 0…2147483647 ms. Integer division and TO_INT truncate toward zero. Overflow, nonfinite values, division by zero, recursion and exceeded operation budgets are diagnosed rather than hidden.</p><p>STOP and FAULT de-energize simulated physical outputs even with forces present. Pause preserves outputs. A fault prevents partial physical output commit; memory written before the fault remains available for inspection. Reset is required before execution resumes.</p><h3>Renderer and simulation are independent</h3><p>The module worker owns runtime state and fixed-step scheduling. UI snapshots are published at up to 20 Hz. WebGPU batches vector geometry in a shared WGSL pipeline; a high-DPI Canvas text overlay labels it. Browsers without a usable GPU receive a Canvas 2D vector fallback. Wall-clock scheduling is best effort, never a hard real-time guarantee.</p>`;
  dialog(semantics?'Runtime semantics':'RelayForge guide',semantics?execution:overview+'<div class="callout">Independent engineering simulator. Not Siemens software, not a certified IEC runtime, not a PLC hardware emulator, and never suitable for safety-related or real equipment control.</div>',{close:'Close',wide:true});
}
async function replaceProject(p){
  if(downloadVersion>=0)await request('stop');history=new History(validateProject(p));codeVersion++;compileResult=null;diagnostics=[];ui.view='block';ui.block=p.entry;ui.selection=null;ui.camera={x:0,y:0,zoom:1};sourceDraft=null;snapshot={scan:0,timeMs:0,values:Object.fromEntries(p.tags.map(t=>[t.name,t.initial])),forces:{},signals:{},trace:[],instances:{}};renderAll();scheduleSave();await compile(true);ui.bottom='watch';renderBottom();
}
async function command(name){
  const guarded=['run','step','compile','download','start-demo','reset','warm-reset'];if(busy&&guarded.includes(name))return;if(guarded.includes(name)){busy=true;updateStatus();}
  try{
    switch(name){
      case 'save':save();break;
      case 'open':$('#projectFile').click();break;
      case 'export':flushSource();downloadFile(project().name+'.relayforge',JSON.stringify(project(),null,2));toast('Project file exported.');break;
      case 'new':dialog('New project','<div class="field"><label>Project name</label><input name="name" value="New_Project" required></div><p>The current workspace will be replaced. Export it first to keep a separate copy.</p>',{submit:'Create project',onSubmit:async data=>{const p=createDemo();p.id=uid('project');p.name=data.get('name');p.tags=[];p.blocks=[{id:'main',name:'Main',kind:'OB',number:1,language:'LAD',networks:[],comment:''}];p.hmi=[];p.watch=[];p.trace=[];p.plantEnabled=false;await replaceProject(p);}});break;
      case 'demo':confirmAction('Load demonstration','Replace this workspace with the bottling-cell demonstration? Export your current project first to keep a separate copy.',()=>replaceProject(createDemo()));break;
      case 'undo':flushSource();if(history.undo()){invalidateCode();scheduleSave();renderAll();}break;
      case 'redo':flushSource();if(history.redo()){invalidateCode();scheduleSave();renderAll();}break;
      case 'compile':await compile();break;
      case 'download':await compile(true);break;
      case 'run':await run();break;
      case 'start-demo':await startDemo();break;
      case 'pause':if(mode==='RUN'){const r=await request('pause');mode=r.mode;snapshot=r.data;}else if(mode==='PAUSED')await run();else toast('Run the CPU before pausing.');break;
      case 'stop':if(downloadVersion>=0){const r=await request('stop');mode=r.mode;snapshot=r.data;logMessage('CPU stopped. Simulated physical outputs de-energized.');}break;
      case 'step':await step();break;
      case 'reset':case 'warm-reset':if(await ensureDownloaded()){const r=await request('reset',{warm:name==='warm-reset'});mode=r.mode;snapshot=r.data;logMessage(name==='reset'?'Cold reset complete; values and forces cleared.':'Warm restart complete; retained memory tags preserved.');}break;
      case 'monitor':ui.monitor=!ui.monitor;renderHeader();invalidateSurfaces();break;
      case 'tags':case 'watch':case 'traces':case 'online':navigate(name);break;
      case 'hmi':navigate('hmi');break;
      case 'hmi-runtime':ui.hmiMode='runtime';navigate('hmi');break;
      case 'hmi-design':ui.hmiMode='design';navigate('hmi');break;
      case 'properties':ui.task='properties';if(innerWidth<=950){ui.bottom='properties';renderBottom();}renderTask();break;
      case 'block-properties':ui.selection={kind:'block',id:ui.block};ui.task='properties';renderTask();break;
      case 'project-settings':showProjectSettings();break;
      case 'add-tag':showTagDialog();break;
      case 'add-block':showBlockDialog();break;
      case 'delete-block':{const id=ui.block;if(id===project().entry)throw new Error('The entry OB cannot be deleted.');confirmAction('Delete block','Calls to this block will become compile errors. Delete it?',()=>{ui.block=project().entry;ui.selection=null;edit('Delete program block',p=>{p.blocks=p.blocks.filter(b=>b.id!==id);});});break;}
      case 'add-network':addNetwork();break;
      case 'add-contact':addContact();break;
      case 'add-nc':addContact(true);break;
      case 'add-branch':addBranch();break;
      case 'lad-action':{const n=currentNetwork();if(n)select({kind:'action',id:n.id});break;}
      case 'add-node':dialog('Add function-block operator','<div class="field"><label>Operation</label><select name="op">'+options(Object.keys(FBD_SPECS),'AND')+'</select></div>',{submit:'Insert',onSubmit:data=>addNode(data.get('op'))});break;
      case 'add-widget':dialog('Add HMI object','<div class="field"><label>Object type</label><select name="type">'+options(['button','lamp','value','tank','gauge','slider','label','panel'],'button')+'</select></div>',{submit:'Insert',onSubmit:data=>addWidget(data.get('type'))});break;
      case 'wire-help':toast('Click or drag an output pin onto an input pin. Configure expressions and disconnect wires in Properties.');break;
      case 'duplicate':duplicateSelection();break;
      case 'delete':deleteSelection();break;
      case 'delete-network':deleteNetwork();break;
      case 'network-up':moveNetwork(-1);break;
      case 'network-down':moveNetwork(1);break;
      case 'add-watch':showWatchDialog();break;
      case 'trace-config':showTraceDialog();break;
      case 'release-forces':if(downloadVersion>=0){const r=await request('releaseAll');snapshot=r.data;logMessage('All simulated I/O forces released.');}break;
      case 'export-trace':{const r=await request('exportTrace');downloadFile(project().name+'-trace.csv',r.csv,'text/csv;charset=utf-8');break;}
      case 'export-events':{const r=await request('exportTrace');downloadFile(project().name+'-io-events.json',JSON.stringify({format:'relayforge-io-events-v1',cycleMs:snapshot.cycleMs,scan:snapshot.scan,events:r.events,overflow:r.eventOverflow,completeReplay:false,note:'I/O writes and force events only. CPU mode transitions and plant toggles are not included.'},null,2));break;}
      case 'clear-trace':{const r=await request('clearTrace');snapshot=r.data;invalidateSurfaces();break;}
      case 'export-tags':{const cell=s=>'"'+String(s??'').replaceAll('"','""')+'"';downloadFile(project().name+'-tags.csv',['Name,Type,IO,Address,Initial,Retain,Comment',...project().tags.map(t=>[t.name,t.type,t.io,t.address,t.initial,t.retain,t.comment].map(cell).join(','))].join('\r\n'),'text/csv;charset=utf-8');break;}
      case 'show-ir':flushSource();compileResult=compileProject(project());dialog('Compiled typed program IR',`<pre>${esc(JSON.stringify(compileResult.program||compileResult.diagnostics,null,2))}</pre>`,{close:'Close',wide:true});break;
      case 'st-example':timerExample();break;
      case 'zoom-in':hmi?hmi.zoom(1.15):mainSurface?.zoomAt(1.15);break;
      case 'zoom-out':hmi?hmi.zoom(1/1.15):mainSurface?.zoomAt(1/1.15);break;
      case 'fit':if(hmi){hmi.autoFit=true;hmi.fit();}else if(mainSurface&&graphLayout)mainSurface.fit(graphLayout.width,graphLayout.height);break;
      case 'help':help();break;
      case 'semantics':help(true);break;
      case 'about':dialog('RelayForge Automation','<h3>Independent, local-first engineering</h3><p>Version 1.0.0 · Vanilla HTML, CSS and JavaScript · WebGPU vector renderer · Worker-based virtual PLC</p><p>Source includes the typed compiler, deterministic runtime, language editors, HMI designer and automated tests. No telemetry, accounts, remote runtime, or external JavaScript dependencies.</p><p>Inspired by the project-tree, editor, task-card and diagnostics workflows used in industrial engineering environments. Not affiliated with or endorsed by Siemens. TIA Portal and STEP 7 are Siemens trademarks.</p><div class="callout">Educational and prototyping simulation only. No hardware connectivity or certified safety functionality.</div>',{close:'Close'});break;
      case 'toggle-project':$('.workspace').classList.toggle('show-project');break;
      default:throw new Error(`Unknown command '${name}'.`);
    }
  }catch(e){handleError(e);}finally{if(guarded.includes(name))busy=false;updateLive();invalidateSurfaces();}
}
function bindGlobal(){
  document.addEventListener('click',async event=>{
    const el=event.target.closest('button,[data-command]');
    if(!event.target.closest('.menu>button'))$$('.menu').forEach(m=>m.classList.remove('open'));
    if(!el||el.disabled)return;
    try{
      if(el.dataset.command){await command(el.dataset.command);return;}
      if(el.dataset.bottom){ui.bottom=el.dataset.bottom;renderBottom();return;}
      if(el.dataset.selectContact){select({kind:'contact',id:el.dataset.selectContact,network:el.dataset.network});return;}
      if(el.dataset.selectNetwork){select({kind:'network',id:el.dataset.selectNetwork});return;}
      if(el.dataset.selectWidget){select({kind:'widget',id:el.dataset.selectWidget});return;}
      if(el.dataset.removeContact){select({kind:'contact',id:el.dataset.removeContact,network:currentNetwork()?.id},{properties:false});deleteSelection();return;}
      if(el.dataset.addBranchContact!==undefined){addContact(false,Number(el.dataset.addBranchContact));return;}
      if(el.dataset.removeBranch!==undefined){const id=currentNetwork()?.id,index=Number(el.dataset.removeBranch);edit('Remove parallel branch',p=>p.blocks.find(b=>b.id===ui.block).networks.find(n=>n.id===id).branches.splice(index,1));return;}
      if(el.dataset.disconnectPin){edit('Disconnect FBD input',p=>{const n=p.blocks.find(b=>b.id===ui.block).nodes.find(n=>n.id===ui.selection.id);delete n.inputs[el.dataset.disconnectPin];});return;}
      if(el.dataset.openBlock){navigate('block',el.dataset.openBlock);return;}
      if(el.dataset.view){navigate(el.dataset.view);return;}
      if(el.dataset.network&&el.dataset.block){if(ui.block!==el.dataset.block||ui.view!=='block')navigate('block',el.dataset.block);select({kind:'network',id:el.dataset.network},{properties:false});scrollToNetwork(el.dataset.network);return;}
      if(el.dataset.gotoBlock){navigate('block',el.dataset.gotoBlock);const line=Number(el.dataset.line);if(line&&$('#stEditor')){const input=$('#stEditor'),pos=input.value.split('\n').slice(0,line-1).join('\n').length+(line>1?1:0);input.focus();input.setSelectionRange(pos,pos+(input.value.split('\n')[line-1]||'').length);input.scrollTop=Math.max(0,(line-4)*22);input.dispatchEvent(new Event('scroll'));}return;}
      if(el.dataset.instruction){
        const kind=el.dataset.instruction;if(ui.view==='hmi')addWidget(kind);
        else if(ui.view==='block'&&block().language==='FBD')addNode(kind);
        else if(ui.view==='block'&&block().language==='ST'){
          if(kind==='IF')insertST('\nIF Motor THEN\n    SpeedCommand := SpeedSetpoint;\nELSE\n    SpeedCommand := 0.0;\nEND_IF;\n');
          else if(kind==='FOR')insertST('\n// Declare i : DINT in VAR first.\nFOR i := 1 TO 10 DO\n    PartsCount := PartsCount + 1;\nEND_FOR;\n');else timerExample();
        }else if(kind==='contact')addContact();else if(kind==='nc')addContact(true);else if(kind==='branch')addBranch();else addNetwork(kind);return;
      }
      if(el.dataset.toggleInput){const name=el.dataset.toggleInput;await writeTag(name,!snapshot.values[name]);return;}
      if(el.dataset.writeTag){const name=el.dataset.writeTag,input=el.closest('tr').querySelector('[data-modify]');if(!input.value.trim())throw new Error('Enter a value in the Modify value field.');await writeTag(name,input.value);toast(`${name} modified.`);return;}
      if(el.dataset.forceTag){const name=el.dataset.forceTag;if(Object.hasOwn(snapshot.forces||{},name))await writeTag(name,undefined,{kind:'release'});else{const input=el.closest('tr').querySelector('[data-modify]'),value=input.value.trim()?input.value:snapshot.values[name];await writeTag(name,value,{kind:'force'});}logMessage(`I/O force updated for ${name}.`);return;}
      if(el.dataset.removeWatch){edit('Remove watch tag',p=>{p.watch=p.watch.filter(n=>n!==el.dataset.removeWatch);},{compile:false});return;}
      if(el.dataset.deleteTag){const id=el.dataset.deleteTag,t=project().tags.find(t=>t.id===id);confirmAction('Delete PLC tag',`Delete '${t.name}'? Program references are deliberately preserved and will be reported as compile errors.`,()=>edit('Delete PLC tag',p=>{p.tags=p.tags.filter(t=>t.id!==id);p.watch=p.watch.filter(n=>n!==t.name);p.trace=p.trace.filter(n=>n!==t.name);}));return;}
    }catch(e){handleError(e);}
  });
  document.addEventListener('change',async event=>{
    const el=event.target;
    try{
      if(el.dataset.tagField)editTag(el);
      else if(el.dataset.watchToggle){const name=el.dataset.watchToggle;edit('Toggle watch tag',p=>{p.watch=el.checked?[...new Set([...(p.watch||[]),name])]:(p.watch||[]).filter(n=>n!==name);},{compile:false});}
      else if(el.id==='plantToggle'){
        const value=el.checked;edit('Toggle demonstration plant',p=>{p.plantEnabled=value;},{compile:false,render:false});if(await ensureDownloaded()){const r=await request('plant',{value});snapshot=r.data;renderIO();updateLive();}
      }else if(el.id==='speedSelect')await request('speed',{value:Number(el.value)});
    }catch(e){handleError(e);}
  });
  document.addEventListener('input',event=>{const el=event.target;if(el.dataset.analogInput)writeTag(el.dataset.analogInput,Number(el.value)).catch(handleError);});
  $('#treeSearch').oninput=e=>{ui.filter=e.target.value;renderTree();};
  $('#instructionsTab').onclick=()=>{ui.task='instructions';renderTask();};$('#propertiesTab').onclick=()=>{ui.task='properties';renderTask();};
  $('#projectFile').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw new Error('Project file exceeds 5 MiB.');const p=validateProject(JSON.parse(await file.text()));await replaceProject(p);toast('Project loaded.','success');}catch(e){handleError(e);}};
  document.addEventListener('keydown',event=>{
    const input=event.target.closest('input,textarea,select,[contenteditable]'),mod=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
    if(event.key==='Escape'){wire=null;drag=null;mainSurface?.invalidate();$$('.menu').forEach(m=>m.classList.remove('open'));}
    if(event.key===' '&&!input){spaceDown=true;event.preventDefault();}
    let cmd;
    if(mod&&key==='s')cmd='save';else if(mod&&key==='o')cmd='open';else if(mod&&key==='n')cmd='new';else if(mod&&key==='k'){event.preventDefault();$('#treeSearch').focus();return;}
    else if(!input&&mod&&key==='z')cmd=event.shiftKey?'redo':'undo';else if(!input&&mod&&key==='y')cmd='redo';else if(!input&&mod&&key==='d')cmd='duplicate';
    else if(event.key==='F7')cmd='compile';else if(event.key==='F5')cmd=event.shiftKey?'stop':'run';else if(event.key==='F6')cmd='pause';else if(event.key==='F10')cmd='step';else if(event.key==='F1')cmd='help';
    else if(!input&&event.key==='Delete')cmd='delete';else if(!input&&!mod&&key==='f')cmd='fit';
    if(cmd){event.preventDefault();command(cmd);}
  });
  document.addEventListener('keyup',event=>{if(event.key===' ')spaceDown=false;});
  window.addEventListener('blur',()=>{spaceDown=false;drag=null;});
  for(const handle of $$('[data-resize]')){
    let resizing;
    handle.addEventListener('pointerdown',e=>{e.preventDefault();handle.setPointerCapture(e.pointerId);resizing={x:e.clientX,y:e.clientY,left:$('.project-pane').offsetWidth,right:$('.task-pane').offsetWidth,bottom:$('#bottomPanel').offsetHeight};});
    handle.addEventListener('pointermove',e=>{if(!resizing)return;const style=document.documentElement.style;if(handle.dataset.resize==='left')style.setProperty('--left',Math.max(150,Math.min(380,resizing.left+e.clientX-resizing.x))+'px');else if(handle.dataset.resize==='right')style.setProperty('--right',Math.max(210,Math.min(420,resizing.right-e.clientX+resizing.x))+'px');else style.setProperty('--bottom',Math.max(70,Math.min(innerHeight*.55,resizing.bottom-e.clientY+resizing.y))+'px');});
    handle.addEventListener('pointerup',()=>resizing=null);handle.addEventListener('pointercancel',()=>resizing=null);
  }
  window.addEventListener('beforeunload',()=>{try{flushSource();localStorage.setItem(STORAGE_KEY,JSON.stringify(project()));}catch{}});
}
setupMenus();bindGlobal();renderAll();
window.relayforge={get project(){return project();},get snapshot(){return snapshot;},get mode(){return mode;},get compilation(){return compileResult;},get history(){return history;},get renderer(){return mainSurface?.backend||hmi?.surface.backend||rendererName;},get renderStats(){return mainSurface?.stats;},command,compile,step,run,writeTag,navigate,client};
if(startupWarning){logMessage(startupWarning,'warning');toast(startupWarning,'error');}
try{await compile(true);ui.bottom='watch';renderBottom();}catch(e){handleError(e);}
