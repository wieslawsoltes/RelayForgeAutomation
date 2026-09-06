// Test-only adapter: execute the unchanged browser ES-module worker under Node.
import {parentPort} from 'node:worker_threads';
globalThis.self=globalThis;
globalThis.postMessage=value=>parentPort.postMessage(value);
await import('../src/worker.js');
parentPort.on('message',data=>globalThis.onmessage({data}));
