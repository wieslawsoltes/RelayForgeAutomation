import {VectorSurface} from './renderer.js';
import {formatValue} from './graphs.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const create=(tag,className,text)=>{const el=document.createElement(tag);el.className=className||'';if(text!==undefined)el.textContent=text;return el;};
export class HMIDesigner {
  constructor(host,project,{mode='design',selection=null,onSelect=()=>{},onCommit=()=>{},onWrite=()=>{},onBackend=()=>{}}={}){
    this.host=host;this.project=project;this.mode=mode;this.onSelect=onSelect;this.onCommit=onCommit;this.onWrite=onWrite;this.elements=new Map();this.scale=1;this.autoFit=true;
    this.viewport=create('div','hmi-viewport');this.sizing=create('div','hmi-sizing');this.screen=create('div',`hmi-screen ${mode}`);this.viewport.append(this.sizing);this.sizing.append(this.screen);host.append(this.viewport);
    const gpuHost=create('div','hmi-backdrop');Object.assign(gpuHost.style,{position:'absolute',inset:0,zIndex:0,pointerEvents:'none'});this.screen.append(gpuHost);
    this.surface=new VectorSurface(gpuHost,{onBackend,draw:s=>{s.background='#172a3c';s.line(32,105,868,105,'#335068',1);s.line(32,407,868,407,'#2b485e',1);if(this.mode==='design')for(let x=10;x<900;x+=10)for(let y=10;y<520;y+=10)s.rect(x,y,.7,.7,'#456880');}});
    for(const w of project.hmi)this.build(w);
    const note=create('div','hmi-runtime-note',mode==='design'?'DESIGN MODE  ·  900 × 520  ·  SNAP 10 PX':'LOCAL HMI  ·  NO HARDWARE CONNECTION');this.screen.append(note);
    this.screen.addEventListener('pointerdown',e=>{if(e.target===this.screen&&this.mode==='design'){this.select(null);this.onSelect(null);}});
    this.observer=new ResizeObserver(()=>{if(this.autoFit)this.fit();});this.observer.observe(this.viewport);this.select(selection);this.fit();
  }
  fit(){this.autoFit=true;this.scale=Math.max(.25,Math.min(1.5,(this.viewport.clientWidth-44)/900,(this.viewport.clientHeight-44)/520));this.applyScale();}
  applyScale(){this.screen.style.transform=`scale(${this.scale})`;this.sizing.style.width=`${900*this.scale}px`;this.sizing.style.height=`${520*this.scale}px`;}
  zoom(factor){this.autoFit=false;this.scale=clamp(this.scale*factor,.25,2);this.applyScale();}
  select(id){this.selected=id;for(const [key,{el}]of this.elements){el.classList.toggle('selected',key===id&&this.mode==='design');el.querySelector('.resize-handle')?.remove();if(key===id&&this.mode==='design')el.append(create('div','resize-handle'));}}
  build(w){
    const el=create('div',`hmi-widget hmi-${w.type} ${this.mode}`);Object.assign(el.style,{left:`${w.x}px`,top:`${w.y}px`,width:`${w.w}px`,height:`${w.h}px`});el.style.setProperty('--accent',w.color||'#38a3d5');el.dataset.widget=w.id;
    const parts={el,widget:w};
    if(w.type==='label'){el.textContent=w.label;el.style.color=w.color||'#d8eaf8';el.style.fontSize=`${w.fontSize||16}px`;}
    if(w.type==='panel'){el.style.background=w.color||'#20384c';el.textContent=w.label||'';}
    if(w.type==='button'){
      const button=create('button','',w.label||'Button');button.type='button';button.style.background=w.color||'#356184';button.setAttribute('aria-label',`${w.label}: ${w.tag}`);el.append(button);
      if(this.mode==='runtime'){
        if(w.behavior==='toggle')button.addEventListener('click',()=>this.onWrite(w.tag,!this.values?.[w.tag]));
        else{
          let down=false;
          const release=()=>{if(down){down=false;this.onWrite(w.tag,false,{afterScans:1});}};
          button.addEventListener('pointerdown',e=>{if(e.button!==0)return;down=true;button.setPointerCapture(e.pointerId);this.onWrite(w.tag,true);});
          for(const event of ['pointerup','pointercancel','lostpointercapture','blur'])button.addEventListener(event,release);
          button.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();down=true;this.onWrite(w.tag,true);}});
          button.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter')release();});
          this.releaseButtons??=[];this.releaseButtons.push(release);
        }
      }
    }
    if(w.type==='lamp'){parts.bulb=create('div','lamp-bulb');el.append(parts.bulb,create('div','widget-label',w.label));}
    if(w.type==='value'){parts.value=create('span','');const value=create('div','big-value');value.append(parts.value,create('span','unit',w.unit||''));el.append(create('div','widget-label',w.label),value);}
    if(w.type==='tank'){
      const tank=create('div','tank-body');parts.fill=create('div','tank-fill');parts.value=create('span');const v=create('div','tank-value');v.append(parts.value,create('small','',w.unit||'%'));tank.append(parts.fill,create('div','tank-ticks'),v);el.append(tank,create('div','tank-pipe'),create('div','tank-title',w.label));
    }
    if(w.type==='gauge'){
      const face=create('div','gauge-face');parts.progress=create('div','gauge-progress');parts.value=create('div','gauge-number');face.append(create('div','gauge-track'),parts.progress,parts.value);el.append(create('div','widget-label',w.label),face,create('div','gauge-unit',w.unit||'%'));
    }
    if(w.type==='slider'){
      const line=create('div');parts.value=create('output');line.append(create('span','',w.label),parts.value);parts.input=create('input');parts.input.type='range';parts.input.min=w.min??0;parts.input.max=w.max??100;parts.input.step=w.step||1;parts.input.setAttribute('aria-label',w.label||w.tag);el.append(line,parts.input);
      if(this.mode==='runtime')parts.input.addEventListener('input',()=>this.onWrite(w.tag,Number(parts.input.value)));
    }
    if(this.mode==='design')this.enableDrag(el,w);
    this.elements.set(w.id,parts);this.screen.append(el);
  }
  enableDrag(el,w){
    let drag;
    el.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;e.preventDefault();e.stopPropagation();const resize=e.target.classList.contains('resize-handle');this.select(w.id);this.onSelect(w.id);el.setPointerCapture(e.pointerId);
      drag={clientX:e.clientX,clientY:e.clientY,x:w.x,y:w.y,w:w.w,h:w.h,resize};
    });
    el.addEventListener('pointermove',e=>{
      if(!drag)return;const snap=v=>e.altKey?Math.round(v):Math.round(v/10)*10,dx=(e.clientX-drag.clientX)/this.scale,dy=(e.clientY-drag.clientY)/this.scale;
      drag.next=drag.resize?{w:clamp(snap(drag.w+dx),40,900-w.x),h:clamp(snap(drag.h+dy),30,520-w.y)}:{x:clamp(snap(drag.x+dx),0,900-w.w),y:clamp(snap(drag.y+dy),0,520-w.h)};
      for(const [k,v]of Object.entries(drag.next))el.style[{x:'left',y:'top',w:'width',h:'height'}[k]]=`${v}px`;
    });
    const finish=()=>{if(drag?.next)this.onCommit(w.id,drag.next);drag=null;};
    el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',()=>{drag=null;Object.assign(el.style,{left:`${w.x}px`,top:`${w.y}px`,width:`${w.w}px`,height:`${w.h}px`});});
  }
  update(values){
    this.values=values;
    for(const {widget:w,...p}of this.elements.values()){
      const value=values?.[w.tag]??0,type=this.project.tags.find(t=>t.name===w.tag)?.type,ratio=clamp((Number(value)-(w.min??0))/Math.max(.0001,(w.max??100)-(w.min??0)),0,1);
      if(p.value)p.value.textContent=formatValue(value,type==='BOOL'?type:undefined)+(w.type==='slider'?' '+(w.unit||''):'');
      if(p.bulb)p.bulb.classList.toggle('on',!!value);
      if(p.fill)p.fill.style.height=`${ratio*100}%`;
      if(p.progress)p.progress.style.setProperty('--angle',`${ratio*180}deg`);
      if(p.input&&document.activeElement!==p.input)p.input.value=Number(value);
    }
  }
  destroy(){for(const release of this.releaseButtons||[])release();this.observer.disconnect();this.surface.destroy();this.viewport.remove();}
}
