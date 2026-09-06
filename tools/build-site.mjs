/** Build a dependency-free, project-subpath-safe GitHub Pages distribution. */
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.js';
import {compileProject} from '../src/compiler.js';
import {PLC} from '../src/runtime.js';
import './build-standalone.mjs';

const root = new URL('../', import.meta.url);
const site = new URL('_site/', root);
await rm(site, {recursive: true, force: true});
await mkdir(new URL('examples/', site), {recursive: true});
for (const name of ['index.html', 'styles.css', 'src', 'docs', 'LICENSE', 'RelayForge.html']) {
  await cp(new URL(name, root), new URL(name, site), {recursive: true});
}
await writeFile(new URL('.nojekyll', site), '');
const project = createDemo();
await writeFile(new URL('examples/Bottling_Cell.relayforge', site), JSON.stringify(project, null, 2) + '\n');
const compiled = compileProject(project);
assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
const plc = new PLC(compiled.program, {traceTags: project.trace, plant: false});
plc.enqueue('input', 'Start', true, 0);
plc.enqueue('input', 'Start', false, 1);
for (const scan of [50, 75, 100, 125, 150, 175]) {
  plc.enqueue('input', 'PartSensor', true, scan);
  plc.enqueue('input', 'PartSensor', false, scan + 1);
}
plc.enqueue('input', 'Stop', true, 220);
for (let scan = 0; scan < 250; scan++) plc.step();
assert.equal(plc.memory.PartsCount, 6);
assert.equal(plc.outputs.Motor, false);
assert.equal(plc.outputs.FillValve, false);
await writeFile(new URL('examples/Computed_Cell_Trace.csv', site), plc.trace.csv());

const files = {};
async function inventory(directory, prefix = '') {
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await inventory(url, path + '/');
    else if (entry.isFile()) files[path] = createHash('sha256').update(await readFile(url)).digest('hex');
    else throw new Error(`Unsupported build entry: ${path}`);
  }
}
await inventory(site);
await writeFile(new URL('build-info.json', site), JSON.stringify({
  application: 'RelayForge Automation',
  revision: process.env.GITHUB_SHA || 'local',
  files
}, null, 2) + '\n');
console.log(`Pages distribution: ${Object.keys(files).length} files; deterministic example: ${plc.scan} scans, ${plc.memory.PartsCount} parts.`);
