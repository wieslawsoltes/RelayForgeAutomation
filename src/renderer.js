/** One GPU triangle batch per surface; text stays on an accessible high-DPI 2D overlay.
 * No external rendering library. GPU device and pipeline are shared across surfaces.
 */
const COLORS=new Map();
export function rgba(hex){
  if(Array.isArray(hex))return hex;if(COLORS.has(hex))return COLORS.get(hex);
  let h=(hex||'#000000').replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');
  const c=[parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255,h.length===8?parseInt(h.slice(6,8),16)/255:1];COLORS.set(hex,c);return c;
}
const WGSL=`
struct Camera { viewport: vec4f, view: vec4f };
@group(0) @binding(0) var<uniform> camera: Camera;
struct VOut { @builtin(position) position: vec4f, @location(0) color: vec4f };
@vertex fn vs(@location(0) point: vec2f, @location(1) color: vec4f) -> VOut {
  var out: VOut;
  let p = (point * camera.viewport.z + camera.view.xy) / camera.viewport.xy;
  out.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  out.color = color; return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return in.color; }
`;
let sharedGPU;
async function gpu(){
  if(!sharedGPU)sharedGPU=(async()=>{
    if(!navigator.gpu)throw new Error('WebGPU is unavailable in this browser or context.');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter.');
    const device=await adapter.requestDevice();const format=navigator.gpu.getPreferredCanvasFormat();
    const shader=device.createShaderModule({label:'RelayForge vector batch',code:WGSL});
    const pipeline=await device.createRenderPipelineAsync({label:'RelayForge vector pipeline',layout:'auto',vertex:{module:shader,entryPoint:'vs',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x4'}]}]},fragment:{module:shader,entryPoint:'fs',targets:[{format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},primitive:{topology:'triangle-list'}});
    return {device,format,pipeline};
  })();
  return sharedGPU;
}
export class Scene {
  constructor(capacity=16384){this.data=new Float32Array(capacity);this.count=0;this.labels=[];this.background='#ffffff';}
  reset(background='#ffffff'){this.count=0;this.labels.length=0;this.background=background;}
  reserve(n){if(this.count+n>this.data.length){const next=new Float32Array(Math.max(this.data.length*2,this.count+n));next.set(this.data.subarray(0,this.count));this.data=next;}}
  vertex(x,y,c){this.data[this.count++]=x;this.data[this.count++]=y;for(let i=0;i<4;i++)this.data[this.count++]=c[i];}
  triangle(x1,y1,x2,y2,x3,y3,color){this.reserve(18);const c=rgba(color);this.vertex(x1,y1,c);this.vertex(x2,y2,c);this.vertex(x3,y3,c);}
  rect(x,y,w,h,color){this.reserve(36);const c=rgba(color);this.vertex(x,y,c);this.vertex(x+w,y,c);this.vertex(x+w,y+h,c);this.vertex(x,y,c);this.vertex(x+w,y+h,c);this.vertex(x,y+h,c);}
  line(x1,y1,x2,y2,color,width=1){const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);if(!len)return;const nx=-dy/len*width/2,ny=dx/len*width/2;this.triangle(x1+nx,y1+ny,x2+nx,y2+ny,x2-nx,y2-ny,color);this.triangle(x1+nx,y1+ny,x2-nx,y2-ny,x1-nx,y1-ny,color);}
  outline(x,y,w,h,color,width=1){this.line(x,y,x+w,y,color,width);this.line(x+w,y,x+w,y+h,color,width);this.line(x+w,y+h,x,y+h,color,width);this.line(x,y+h,x,y,color,width);}
  polyline(points,color,width=1){for(let i=1;i<points.length;i++)this.line(...points[i-1],...points[i],color,width);}
  circle(cx,cy,r,color,segments=24){for(let i=0;i<segments;i++){const a=i/segments*Math.PI*2,b=(i+1)/segments*Math.PI*2;this.triangle(cx,cy,cx+Math.cos(a)*r,cy+Math.sin(a)*r,cx+Math.cos(b)*r,cy+Math.sin(b)*r,color);}}
  arc(cx,cy,r,start,end,color,width=1,segments=20){let prev=[cx+Math.cos(start)*r,cy+Math.sin(start)*r];for(let i=1;i<=segments;i++){const a=start+(end-start)*i/segments,next=[cx+Math.cos(a)*r,cy+Math.sin(a)*r];this.line(...prev,...next,color,width);prev=next;}}
  text(x,y,text,options={}){this.labels.push({x,y,text:String(text??''),size:12,color:'#30465b',font:'Segoe UI, system-ui, sans-serif',...options});}
}
export class VectorSurface {
  constructor(host,{draw,onBackend=()=>{},camera={x:0,y:0,zoom:1}}={}){
    this.host=host;this.draw=draw;this.onBackend=onBackend;this.camera=camera;this.scene=new Scene();this.backend='initializing';this.dead=false;this.frame=0;this.width=1;this.height=1;
    this.canvas=document.createElement('canvas');this.fallback=document.createElement('canvas');this.overlay=document.createElement('canvas');
    for(const c of [this.canvas,this.fallback,this.overlay]){c.className='vector-layer';c.setAttribute('aria-hidden','true');host.append(c);}
    this.fallback.style.display='none';this.text=this.overlay.getContext('2d');this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.initialize();this.resize();
  }
  async initialize(){
    try{
      const shared=await gpu();if(this.dead)return;Object.assign(this,shared);
      this.context=this.canvas.getContext('webgpu');this.context.configure({device:this.device,format:this.format,alphaMode:'opaque'});
      this.uniform=this.device.createBuffer({label:'View uniforms',size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.bind=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
      this.backend='WebGPU';this.device.lost.then(info=>{if(!this.dead)this.useFallback(`GPU device lost: ${info.message}`);});
      this.device.addEventListener('uncapturederror',event=>{if(!this.dead)this.useFallback(event.error.message);},{once:true});
      this.onBackend(this.backend);this.invalidate();
    }catch(e){this.useFallback(e.message);}
  }
  useFallback(reason){this.backend='Canvas 2D';this.reason=reason;this.canvas.style.display='none';this.fallback.style.display='block';this.fallbackContext=this.fallback.getContext('2d');this.onBackend(this.backend,reason);this.invalidate();}
  resize(){
    const box=this.host.getBoundingClientRect();this.width=Math.max(1,this.host.clientWidth||box.width);this.height=Math.max(1,this.host.clientHeight||box.height);this.dpr=Math.min(window.devicePixelRatio||1,2);
    const limit=this.device?.limits.maxTextureDimension2D||8192;
    this.dpr=Math.min(this.dpr,limit/this.width,limit/this.height);
    for(const c of [this.canvas,this.overlay,this.fallback]){c.width=Math.max(1,Math.round(this.width*this.dpr));c.height=Math.max(1,Math.round(this.height*this.dpr));}
    this.invalidate();
  }
  invalidate(){if(this.dead||this.frame)return;this.frame=requestAnimationFrame(()=>{this.frame=0;this.render();});}
  world(x,y){return {x:(x-this.camera.x)/this.camera.zoom,y:(y-this.camera.y)/this.camera.zoom};}
  point(event){const r=this.host.getBoundingClientRect();return this.world(event.clientX-r.left,event.clientY-r.top);}
  visible(x,y,w,h){const a=this.world(0,0),b=this.world(this.width,this.height);return x+w>=a.x&&x<=b.x&&y+h>=a.y&&y<=b.y;}
  zoomAt(factor,x=this.width/2,y=this.height/2){const before=this.world(x,y);this.camera.zoom=Math.min(2.5,Math.max(0.25,this.camera.zoom*factor));this.camera.x=x-before.x*this.camera.zoom;this.camera.y=y-before.y*this.camera.zoom;this.invalidate();}
  fit(w,h,padding=24){this.camera.zoom=Math.min(1.2,Math.max(0.25,Math.min((this.width-2*padding)/w,(this.height-2*padding)/h)));this.camera.x=(this.width-w*this.camera.zoom)/2;this.camera.y=padding;this.invalidate();}
  render(){
    if(this.dead||!this.width)return;const start=performance.now();this.scene.reset();this.draw?.(this.scene,this);const s=this.scene;
    if(this.backend==='WebGPU'){
      try{
        const bytes=s.count*4;
        if(bytes&&(this.bufferSize||0)<bytes){this.buffer?.destroy();this.bufferSize=2**Math.ceil(Math.log2(Math.max(256,bytes)));this.buffer=this.device.createBuffer({label:'Vector vertices',size:this.bufferSize,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
        if(bytes)this.device.queue.writeBuffer(this.buffer,0,s.data,0,s.count);
        this.device.queue.writeBuffer(this.uniform,0,new Float32Array([this.width,this.height,this.camera.zoom,this.dpr,this.camera.x,this.camera.y,0,0]));
        const encoder=this.device.createCommandEncoder(),color=rgba(s.background);
        const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:color[0],g:color[1],b:color[2],a:1},loadOp:'clear',storeOp:'store'}]});
        if(bytes){pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bind);pass.setVertexBuffer(0,this.buffer);pass.draw(s.count/6);}pass.end();this.device.queue.submit([encoder.finish()]);
      }catch(e){this.useFallback(e.message);}
    }
    if(this.backend==='Canvas 2D'){
      const ctx=this.fallbackContext;ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.fillStyle=s.background;ctx.fillRect(0,0,this.width,this.height);ctx.translate(this.camera.x,this.camera.y);ctx.scale(this.camera.zoom,this.camera.zoom);
      let last='';for(let i=0;i<s.count;i+=18){const d=s.data,color=`rgba(${Math.round(d[i+2]*255)},${Math.round(d[i+3]*255)},${Math.round(d[i+4]*255)},${d[i+5]})`;if(color!==last){if(last)ctx.fill();ctx.fillStyle=color;ctx.beginPath();last=color;}ctx.moveTo(d[i],d[i+1]);ctx.lineTo(d[i+6],d[i+7]);ctx.lineTo(d[i+12],d[i+13]);ctx.closePath();}if(last)ctx.fill();
    }
    const ctx=this.text;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.overlay.width,this.overlay.height);ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.translate(this.camera.x,this.camera.y);ctx.scale(this.camera.zoom,this.camera.zoom);ctx.textBaseline='middle';
    for(const l of s.labels){ctx.font=`${l.bold?'600':'400'} ${l.size}px ${l.font}`;ctx.textAlign=l.align||'left';ctx.fillStyle=l.color;if(l.maxWidth)ctx.fillText(l.text,l.x,l.y,l.maxWidth);else ctx.fillText(l.text,l.x,l.y);}
    this.stats={vertices:s.count/6,drawCalls:s.count?1:0,cpuMs:performance.now()-start};
  }
  destroy(){this.dead=true;if(this.frame)cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.buffer?.destroy();this.uniform?.destroy();this.context?.unconfigure();for(const c of [this.canvas,this.overlay,this.fallback])c.remove();}
}
