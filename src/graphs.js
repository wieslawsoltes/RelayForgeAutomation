import {FB_SPECS,FBD_SPECS} from './model.js';
export const SIGNAL_COLORS=['#1588cd','#14a37d','#aa6ad5','#dc8b20','#dd5978','#4585b8','#59a527','#934b43'];
const activeColor='#16935d',wireColor='#6b879c',textColor='#30495e';
export function formatValue(value,type){if(value===undefined)return '—';if(type==='BOOL'||typeof value==='boolean')return value?'TRUE':'FALSE';if(type==='TIME')return `${value} ms`;if(!Number.isFinite(value))return String(value);return Number.isInteger(value)?String(value):value.toFixed(2);}
export function ladderLayout(block){
  const width=Math.max(1120,...block.networks.map(n=>360+n.series.length*130+Math.max(0,...n.branches.map(b=>b.length))*126));
  let y=18;const networks=block.networks.map((n,index)=>{const branches=Math.max(1,n.branches.length),height=Math.max(164,123+branches*66);const layout={network:n,index,x:18,y,width:width-36,height,center:y+105,branchSpacing:66};y+=height+16;return layout;});
  return {width,height:y,networks};
}
export function drawLadder(scene,surface,block,{snapshot,monitor,selection,project}){
  scene.background='#f7f9fb';const hits=[],layout=ladderLayout(block),signals=snapshot?.signals||{},values=snapshot?.values||{};
  const enabled=monitor&&!!snapshot?.scan;
  const known=id=>enabled&&Object.hasOwn(signals,`${block.id}:${id}`);
  const truth=id=>known(id)&&!!signals[`${block.id}:${id}`];
  const color=id=>truth(id)?activeColor:wireColor;
  const hit=(kind,id,x,y,w,h,extra={})=>hits.push({kind,id,x,y,w,h,...extra});
  const drawContact=(c,x,y,net,branch,powered)=>{
    const selected=selection?.id===c.id;
    if(selected){scene.rect(x-52,y-31,104,64,'#e3f0fc');scene.outline(x-52,y-31,104,64,'#2687cb',1.5);}
    const pass=truth(c.id),col=known(c.id)?(pass?activeColor:wireColor):'#425f77';
    scene.line(x-36,y,x-10,y,powered?activeColor:wireColor,2);scene.line(x+10,y,x+36,y,powered&&pass?activeColor:wireColor,2);
    scene.line(x-10,y-12,x-10,y+12,col,2.2);scene.line(x+10,y-12,x+10,y+12,col,2.2);
    if(c.negated)scene.line(x-14,y+14,x+14,y-14,col,1.8);
    scene.text(x,y-24,c.expression||c.tag,{align:'center',size:11,bold:true,color:textColor,maxWidth:115});
    const tag=project.tags.find(t=>t.name===c.tag);
    scene.text(x,y+26,tag?.address||'BOOL expression',{align:'center',size:9,color:'#8397a8'});
    if(known(c.id))scene.circle(x+33,y-23,3,pass?'#18a86e':'#b4c2cd',12);
    hit('contact',c.id,x-58,y-37,116,74,{network:net.id,branch});return powered&&pass;
  };
  for(const item of layout.networks){
    const {network:n,x,y,width:w,height:h,center:cy}=item;if(!surface.visible(x,y,w,h))continue;
    const selected=selection?.id===n.id;
    scene.rect(x,y,w,h,'#ffffff');scene.outline(x,y,w,h,selected?'#79a7c8':'#d3dee6');
    scene.rect(x,y,w,32,selected?'#dcecf8':'#e9f0f6');scene.rect(x,y,4,32,truth(n.id)?activeColor:'#7695ad');
    scene.text(x+17,y+16,`Network ${item.index+1}`,{size:11,bold:true,color:'#55738a'});
    scene.text(x+110,y+16,n.title,{size:12,bold:true,maxWidth:w-250});
    if(known(n.id)){scene.circle(x+w-69,y+16,3.5,truth(n.id)?activeColor:'#b2c0cc');scene.text(x+w-56,y+16,truth(n.id)?'TRUE':'FALSE',{size:9,color:color(n.id),bold:true});}
    scene.text(x+17,y+49,n.comment||'Click an instruction to edit its properties.',{size:10,color:'#879aa9',maxWidth:w-35});
    hit('network',n.id,x,y,w,60);
    const railX=x+30,end=x+w-30,actionX=end-108,branchX=x+101+n.series.length*132;
    scene.line(railX,y+70,railX,y+h-16,enabled?activeColor:wireColor,2.5);scene.line(end,y+70,end,y+h-16,wireColor,2.5);
    let px=railX,powered=enabled;
    for(const [i,c]of n.series.entries()){
      const cx=x+110+i*132;scene.line(px,cy,cx-36,cy,powered?activeColor:wireColor,2);powered=drawContact(c,cx,cy,n,-1,powered);px=cx+36;
    }
    let exit=px;
    if(n.branches.length){
      const begin=Math.max(px+30,branchX-40),maxContacts=Math.max(1,...n.branches.map(b=>b.length)),join=Math.min(actionX-126,begin+maxContacts*122+20);
      scene.line(px,cy,begin,cy,powered?activeColor:wireColor,2);
      const bottom=cy+(n.branches.length-1)*item.branchSpacing;scene.line(begin,cy,begin,bottom,powered?activeColor:wireColor,2);
      let branchAny=false;
      for(const [bi,contacts]of n.branches.entries()){
        let bpower=powered,last=begin;const by=cy+bi*item.branchSpacing;
        for(const [ci,c]of contacts.entries()){
          const cx=begin+66+ci*122;scene.line(last,by,cx-36,by,bpower?activeColor:wireColor,2);bpower=drawContact(c,cx,by,n,bi,bpower);last=cx+36;
        }
        scene.line(last,by,join,by,bpower?activeColor:wireColor,2);branchAny ||= bpower;
      }
      scene.line(join,cy,join,bottom,branchAny?activeColor:wireColor,2);exit=join;powered=branchAny;
    }
    const action=n.action,isCoil=['COIL','SET','RESET'].includes(action.type),ax=actionX;
    if(isCoil){
      scene.line(exit,cy,ax-22,cy,powered?activeColor:wireColor,2);scene.line(ax+22,cy,end,cy,color(n.id),2);
      const col=known(n.id)?color(n.id):'#425f77';scene.arc(ax-4,cy,15,Math.PI*0.58,Math.PI*1.42,col,2);scene.arc(ax+4,cy,15,-Math.PI*0.42,Math.PI*0.42,col,2);
      if(action.type!=='COIL')scene.text(ax,cy,action.type==='SET'?'S':'R',{align:'center',size:11,bold:true,color:col});
      scene.text(ax,cy-26,action.target,{align:'center',size:11,bold:true,maxWidth:160});
      const t=project.tags.find(t=>t.name===action.target);scene.text(ax,cy+27,t?.address||'BOOL',{align:'center',size:9,color:'#8397a8'});
      if(selection?.kind==='action'&&selection.id===n.id)scene.outline(ax-70,cy-40,140,78,'#2687cb',1.5);
      hit('action',n.id,ax-75,cy-42,150,84,{network:n.id});
    }else{
      const left=ax-103,top=cy-31,bh=action.type==='CALL'?65:83;
      scene.line(exit,cy,left,cy,powered?activeColor:wireColor,2);scene.line(left+190,cy,end,cy,color(n.id),2);
      scene.rect(left,top,190,bh,selection?.kind==='action'&&selection.id===n.id?'#f0f8fd':'#f9fcfe');scene.outline(left,top,190,bh,truth(n.id)?activeColor:'#7c9fb9',1.5);
      scene.rect(left,top,190,23,'#e7f1f8');
      scene.text(left+10,top+12,action.type,{size:11,bold:true,color:'#266897'});
      if(action.type==='CALL'){
        const b=project.blocks.find(b=>b.id===action.block);scene.text(left+12,top+42,b?.name||'Missing block',{size:11,bold:true,maxWidth:165});
      }else if(action.type==='MOVE'){
        scene.text(left+10,top+39,`${action.value} → ${action.target}`,{size:10,maxWidth:170});
      }else{
        const spec=FB_SPECS[action.type];const primary=Object.keys(spec?.inputs||{})[0];
        scene.text(left+10,top+37,`${primary}   ${powered?'TRUE':'FALSE'}`,{size:9,color:powered?activeColor:'#8ba0b0'});
        const out=action.outputs?.Q||action.outputs?.QU||'';scene.text(left+181,top+37,`Q   ${out}`,{align:'right',size:9,maxWidth:102});
        const preset=action.inputs?.PT||action.inputs?.PV||'';scene.text(left+10,top+57,`${action.inputs?.PT?'PT':'PV'}  ${preset}`,{size:10,color:'#425c74',maxWidth:112});
        const field=action.outputs?.ET?'ET':action.outputs?.CV?'CV':null;
        if(field)scene.text(left+181,top+72,`${field}  ${formatValue(values[action.outputs[field]])}`,{align:'right',size:9,color:'#2179ae',maxWidth:116});
      }
      hit('action',n.id,left,top,190,bh,{network:n.id});
    }
  }
  return {hits,...layout};
}
export function fbdLayout(block,drag){
  const map=new Map();let width=1000,height=550;
  for(const node of block.nodes){const spec=FBD_SPECS[node.op]||{inputs:[],outputs:[]},x=drag?.id===node.id?drag.x:node.x,y=drag?.id===node.id?drag.y:node.y,w=176,h=Math.max(84,50+Math.max(spec.inputs.length,spec.outputs.length)*23);const inputs=Object.fromEntries(spec.inputs.map((p,i)=>[p,{x,y:y+44+i*23}])),outputs=Object.fromEntries(spec.outputs.map((p,i)=>[p,{x:x+w,y:y+44+i*23}]));map.set(node.id,{node,x,y,w,h,inputs,outputs});width=Math.max(width,x+w+60);height=Math.max(height,y+h+60);}
  return {map,width,height};
}
export function drawFBD(scene,surface,block,{snapshot,monitor,selection,drag,wire}){
  scene.background='#fcfdfe';const layout=fbdLayout(block,drag),hits=[],signals=snapshot?.signals||{},enabled=monitor&&!!snapshot?.scan;
  const a=surface.world(0,0),b=surface.world(surface.width,surface.height);
  for(let x=Math.floor(a.x/20)*20;x<b.x;x+=20)for(let y=Math.floor(a.y/20)*20;y<b.y;y+=20)scene.rect(x,y,1,1,'#dfe8f0');
  for(const target of layout.map.values())for(const [pin,src]of Object.entries(target.node.inputs))if(src?.node){
    const start=layout.map.get(src.node)?.outputs[src.port||'OUT'],end=target.inputs[pin];if(!start||!end)continue;
    const value=signals[`${block.id}:${src.node}.${src.port||'OUT'}`],col=enabled&&value?activeColor:'#8ba4b8';const mid=(start.x+end.x)/2;
    const points=end.x>start.x?[[start.x,start.y],[mid,start.y],[mid,end.y],[end.x,end.y]]:[[start.x,start.y],[start.x+22,start.y],[start.x+22,Math.max(start.y,end.y)+28],[end.x-24,Math.max(start.y,end.y)+28],[end.x-24,end.y],[end.x,end.y]];
    scene.polyline(points,col,enabled&&value?2.5:1.7);
  }
  for(const l of layout.map.values()){
    const {node:n,x,y,w,h}=l;if(!surface.visible(x-90,y,w+190,h+20))continue;const selected=selection?.id===n.id;
    scene.rect(x+2,y+3,w,h,'#dce5ed');scene.rect(x,y,w,h,'#ffffff');scene.outline(x,y,w,h,selected?'#198bcc':'#99b0c1',selected?2:1);
    scene.rect(x,y,w,26,selected?'#d5ebfa':'#eaf2f8');scene.text(x+10,y+13,n.op,{bold:true,size:11,color:'#29688f'});
    const symbol={AND:'&',OR:'≥1',XOR:'=1',NOT:'¬',LT:'<',LE:'≤',GT:'>',GE:'≥',EQ:'=',ADD:'+',SUB:'−',MUL:'×',DIV:'÷'}[n.op];if(symbol)scene.text(x+w-14,y+13,symbol,{align:'right',size:15,bold:true,color:'#5e91b2'});
    if(['READ','WRITE'].includes(n.op))scene.text(x+w/2,y+h-15,n.tag||'Select tag',{align:'center',size:11,bold:true,color:'#2b5675',maxWidth:w-18});
    if(n.op==='CONST')scene.text(x+w/2,y+h-15,n.value,{align:'center',size:12,bold:true});
    hits.push({kind:'node',id:n.id,x,y,w,h});
    for(const [pin,p]of Object.entries(l.inputs)){
      scene.circle(p.x,p.y,4.2,'#4c87af',16);scene.circle(p.x,p.y,2.3,'#ffffff',12);scene.text(p.x+10,p.y,pin,{size:9,color:'#738a9c'});
      const s=n.inputs[pin];if(!s?.node){const expr=typeof s==='object'?s.expr:s;scene.text(x+35,p.y,expr??'connect…',{size:10,color:expr?'#416984':'#c57330',maxWidth:94});}
      hits.push({kind:'pin',direction:'in',id:n.id,pin,x:p.x-9,y:p.y-9,w:18,h:18});
    }
    for(const [pin,p]of Object.entries(l.outputs)){
      const value=signals[`${block.id}:${n.id}.${pin}`];scene.circle(p.x,p.y,4.2,enabled&&value?activeColor:'#4c87af',16);
      scene.text(p.x-10,p.y,pin,{align:'right',size:9,color:'#738a9c'});
      if(enabled&&value!==undefined){scene.rect(p.x+8,p.y-9,Math.max(32,String(formatValue(value)).length*6+8),18,'#e5f5ed');scene.text(p.x+12,p.y,formatValue(value),{size:9,color:'#187e53'});}
      hits.push({kind:'pin',direction:'out',id:n.id,pin,x:p.x-9,y:p.y-9,w:18,h:18});
    }
  }
  if(wire){const start=layout.map.get(wire.node)?.outputs[wire.port];if(start&&wire.end)scene.polyline([[start.x,start.y],[(start.x+wire.end.x)/2,start.y],[(start.x+wire.end.x)/2,wire.end.y],[wire.end.x,wire.end.y]],'#f49b30',2);}
  return {hits,...layout};
}
export function drawTrace(scene,surface,snapshot,project,hover){
  scene.background='#ffffff';surface.camera={x:0,y:0,zoom:1};const samples=snapshot?.trace||[],keys=project.trace||[];const width=surface.width,height=surface.height,left=133,right=30,top=32,bottom=28,row=Math.max(44,(height-top-bottom)/Math.max(1,keys.length));
  scene.text(16,15,'LIVE ACQUISITION',{size:9,bold:true,color:'#7c93a4'});
  if(!samples.length){scene.text(width/2,height/2,'Run or step the CPU to acquire execution traces.',{align:'center',size:13,color:'#8197a8'});return;}
  const begin=samples[0].timeMs,end=samples.at(-1).timeMs,span=Math.max(project.cycleMs,end-begin),plotW=Math.max(10,width-left-right);
  for(let i=0;i<=5;i++){const x=left+plotW*i/5;scene.line(x,top,x,height-bottom,'#e8eef3');scene.text(x,height-12,`${((begin+span*i/5)/1000).toFixed(2)} s`,{align:'center',size:9,color:'#7890a3'});}
  for(const [index,key]of keys.entries()){
    const tag=project.tags.find(t=>t.name===key),y=top+index*row,col=SIGNAL_COLORS[index%SIGNAL_COLORS.length],data=samples.map(s=>s.values[key]||0);let min=Math.min(...data),max=Math.max(...data);
    if(tag?.type==='BOOL'){min=0;max=1;}else if(min===max){min-=1;max+=1;}else{const pad=(max-min)*0.1;min-=pad;max+=pad;}
    scene.rect(0,y,width,row,index%2===0?'#f8fafc':'#ffffff');scene.line(left,y+row-4,width-right,y+row-4,'#e2eaf1');scene.rect(14,y+12,3,19,col);
    scene.text(24,y+17,key,{size:10,bold:true,color:'#466479',maxWidth:102});scene.text(24,y+34,formatValue(snapshot?.values[key],tag?.type),{size:10,color:col});
    const py=v=>y+row-11-(v-min)/(max-min)*(row-23),px=t=>left+(t-begin)/span*plotW;
    let prev;
    for(const sample of samples){const p=[px(sample.timeMs),py(sample.values[key]||0)];if(prev){if(tag?.type==='BOOL'){scene.line(...prev,p[0],prev[1],col,1.8);scene.line(p[0],prev[1],...p,col,1.8);}else scene.line(...prev,...p,col,1.8);}prev=p;}
    scene.text(width-5,y+10,max.toFixed(tag?.type==='BOOL'?0:1),{align:'right',size:8,color:'#93a5b4'});scene.text(width-5,y+row-9,min.toFixed(tag?.type==='BOOL'?0:1),{align:'right',size:8,color:'#93a5b4'});
  }
  if(hover&&hover.x>=left){const t=begin+(hover.x-left)/plotW*span;let sample=samples.reduce((best,s)=>Math.abs(s.timeMs-t)<Math.abs(best.timeMs-t)?s:best,samples[0]);const x=left+(sample.timeMs-begin)/span*plotW;scene.line(x,top,x,height-bottom,'#5f7e95',1);scene.text(Math.min(width-110,x+5),16,`scan ${sample.scan} · ${(sample.timeMs/1000).toFixed(3)} s`,{size:10,bold:true,color:'#226a9b'});}
}
