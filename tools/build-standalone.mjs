/** Zero-dependency packager for this repository's controlled ESM source graph.
 * Not a general-purpose JavaScript bundler; user PLC source is never evaluated as JS.
 * The canonical HTTP application uses a module worker. The standalone distribution
 * wraps those same modules into a classic Blob worker to support local-file launch.
 */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),sources={};
for(const name of await readdir(new URL('src/',root)))if(name.endsWith('.js'))sources[name]=await readFile(new URL('src/'+name,root),'utf8');
const seen=new Set();
function bundle(name){
  if(seen.has(name))return '';seen.add(name);
  if(!Object.hasOwn(sources,name))throw new Error(`Missing source module ${name}`);
  const exports=[...sources[name].matchAll(/export\s+(?:const|class|function)\s+(\w+)/g)].map(m=>m[1]);let dependencies='';
  const source=sources[name].replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"];?/g,(_,names,dependency)=>{
    dependencies+=bundle(dependency);
    return `const {${names.replace(/\s+as\s+/g,':')}}=modules[${JSON.stringify(dependency)}];`;
  }).replace(/\bexport\s+/g,'');
  return dependencies+`modules[${JSON.stringify(name)}]=(()=>{${source}\nreturn {${exports.join(',')}};})();\n`;
}
const workerSource='const modules=Object.create(null);\n'+bundle('worker.js');
const payload=JSON.stringify({sources,workerSource}).replace(/</g,'\\u003c');
const bootstrap=`
const {sources,workerSource}=JSON.parse(document.getElementById('relayforge-sources').textContent);
const workerURL=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
sources['client.js']=sources['client.js'].replace("new URL('./worker.js',import.meta.url)",JSON.stringify(workerURL)).replace("type:'module'","type:'classic'");
const urls=Object.create(null);
function moduleURL(name){
  if(urls[name])return urls[name];
  const text=sources[name].replace(/from\\s*['"]\\.\\/([^'"]+)['"]/g,(_,dependency)=>'from '+JSON.stringify(moduleURL(dependency)));
  return urls[name]=URL.createObjectURL(new Blob([text],{type:'text/javascript'}));
}
try{await import(moduleURL('app.js'));}catch(error){console.error(error);const warning=document.createElement('pre');warning.textContent='RelayForge could not start: '+error.message+'\\nServe the modular source over localhost using npm start.';document.body.append(warning);}
`;
let html=await readFile(new URL('index.html',root),'utf8');
const css=await readFile(new URL('styles.css',root),'utf8');
html=html.replace('<link rel="stylesheet" href="./styles.css">',()=>'<style>'+css+'</style>');
html=html.replace(/<script\s+type="module"\s+src="\.\/src\/app.js"><\/script>/,()=>`<script type="application/json" id="relayforge-sources">${payload}</script>\n<script type="module">${bootstrap}</script>`);
if(html.includes('src="./src/app.js"'))throw new Error('Application entry was not replaced.');
const target=new URL('RelayForge.html',root);await writeFile(target,html);console.log(fileURLToPath(target));
