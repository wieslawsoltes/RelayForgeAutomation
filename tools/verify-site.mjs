/** Verify the live deployment against the bytes just built, including module workers. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

const address = process.argv[2];
if (!address) throw new Error('Usage: node tools/verify-site.mjs <site-url>');
const base = new URL(address.endsWith('/') ? address : address + '/');
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Expected an HTTP(S) site URL.');
const expected = JSON.parse(await readFile(new URL('../_site/build-info.json', import.meta.url), 'utf8'));
const deadline = Date.now() + 300_000;
async function fetchBytes(path, fresh = false) {
  const url = new URL(path, base);
  if (fresh) url.searchParams.set('revision', expected.revision);
  const response = await fetch(url, {signal: AbortSignal.timeout(20_000), cache: 'no-store'});
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  return {bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') || ''};
}
let lastError;
while (Date.now() < deadline) {
  try {
    const {bytes} = await fetchBytes('build-info.json', true);
    const current = JSON.parse(bytes.toString('utf8'));
    assert.equal(current.revision, expected.revision, 'Deployment revision is not published yet.');
    for (const [path, hash] of Object.entries(expected.files)) {
      // Pages may omit dotfiles; .nojekyll is a build marker, not a public resource.
      if (path.startsWith('.')) continue;
      const result = await fetchBytes(path, true);
      assert.equal(createHash('sha256').update(result.bytes).digest('hex'), hash, `Published content mismatch: ${path}`);
      if (path.endsWith('.js')) assert.match(result.type, /(?:javascript|ecmascript)/i, `Invalid module MIME type: ${path}`);
      console.log(`HTTP 200 + SHA-256 verified: ${path}`);
    }
    const home = await fetchBytes('');
    assert.match(home.type, /text\/html/i);
    assert.equal(createHash('sha256').update(home.bytes).digest('hex'), expected.files['index.html']);
    console.log(`VERIFIED LIVE: ${base.href} (revision ${expected.revision})`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.log(`Awaiting published files: ${error.message}`);
    await delay(10_000);
  }
}
throw new Error(`Live deployment verification failed: ${lastError?.message}`);
