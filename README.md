# RelayForge Automation

[Open the live application](https://wieslawsoltes.github.io/RelayForgeAutomation/) · [Standalone HTML](https://wieslawsoltes.github.io/RelayForgeAutomation/RelayForge.html) · [Build and deployment](https://github.com/wieslawsoltes/RelayForgeAutomation/actions/workflows/pages.yml)

A local-first PLC engineering workstation written in plain HTML, CSS and JavaScript. Editable ladder logic, function-block diagrams and structured text compile into a shared typed representation and execute in a dedicated browser worker. The HMI designer binds directly to the simulated PLC's tags.

**Independent simulation software. Not Siemens firmware, TIA Portal, STEP 7, PLCSIM, an IEC conformance-certified runtime, or a safety-certified controller. No physical PLC or industrial equipment connectivity.** The demonstration's `EStopOK` is an ordinary simulated Boolean, not a safety function.

## Run locally

```sh
git clone https://github.com/wieslawsoltes/RelayForgeAutomation.git
cd RelayForgeAutomation
npm start
```

Open **http://127.0.0.1:4173/**. Node.js 20 or newer is required for the development server and tests. There are no application dependencies to install and no mandatory build step. PLC execution remains entirely inside the browser.

```sh
npm test                         # Compiler, runtime and actual worker tests
npm run build                    # Generate self-contained RelayForge.html
node tools/build-site.mjs         # Generate the complete _site/ distribution
```

The modular application works on a static HTTP(S) host, including a project subpath. All assets and module-worker imports are relative. The single-file build packages the same runtime into a classic Blob worker. WebGPU is used when available; a high-DPI Canvas renderer is the explicit fallback.

## Operate the example

Click **Start cell** in the ladder toolbar. The included **Bottling_Cell** program latches its run request, waits for an **800 ms TON**, enables the conveyor, scales a simulated analog level in structured text, evaluates an FBD fill controller, and counts sensor rising edges. These are actual runtime results, not prerecorded animations.

Open **Overview screen → Runtime** for the HMI. Its Start/Stop buttons write to the simulated input image; its displays read the live tags. **Pause** freezes the CPU, **Step** executes one scan, and **Stop** de-energizes the simulated outputs. Disable **Plant** to drive the digital and analog inputs manually. Use Reset Batch and Start Cycle for another batch.

## Editing and debugging

| Area | Implemented behavior |
| --- | --- |
| LAD | Ordered networks, series/parallel contacts, normally closed contacts, coils, set/reset, timers, counters, edge detectors, MOVE and block calls |
| FBD | Draggable nodes, editable wires, typed expressions, Boolean/arithmetic/comparison operators, timers/counters, topological scheduling and cycle diagnostics |
| ST | Typed declarations, persistent call-site locals, assignments, expressions, IF/ELSIF/ELSE, bounded FOR, timer/counter instances and user-block calls |
| Runtime | Fixed virtual scan time; input sampling; ordered OB execution; atomic output commit; RUN/PAUSED/STOP/FAULT; cold and warm resets |
| Debugging | Typed tags, simulated digital/analog I/O, watch tables, Modify, I/O Force/Release, live power-flow monitoring, instance inspection and trace CSV |
| HMI | Design/runtime modes, drag/resize/snap, tag binding, buttons, lamps, numeric displays, gauges, tank level, sliders, labels and panels |
| Persistence | Browser-local autosave, project JSON import/export, document undo/redo, tag CSV and bounded I/O-event export |

Program changes stop the simulator and require a new download. Run automatically compiles/downloads modified logic. Layout-only changes do not change the compiled program. Addresses are symbolic labels, not aliased byte-buffer locations. User PLC source is parsed and interpreted; it is never passed to JavaScript `eval` or `Function`.

## Runtime contract

Each successful scan applies due events, samples inputs, executes the cyclic OB and called blocks, commits outputs, records a trace sample and advances virtual time by exactly `cycleMs`. The optional demonstration plant advances first using the previous committed outputs. Browser repaint timing does not advance PLC time.

BOOL, signed INT/DINT, binary32 REAL and millisecond TIME are checked explicitly. Timer state is driven by integer virtual time, not wall time. Counter inputs are edge-sensitive. Runtime errors latch FAULT; operation, iteration and call-depth limits bound execution. Warm reset retains only designated memory tags. The default trace ring stores 4,096 records per channel.

See **[docs/RUNTIME.md](docs/RUNTIME.md)** for exact timer, counter, force, input-event, type, output-commit, retention and reproducibility semantics.

The build regenerates [the example project](https://wieslawsoltes.github.io/RelayForgeAutomation/examples/Bottling_Cell.relayforge) and [a deterministic computed trace](https://wieslawsoltes.github.io/RelayForgeAutomation/examples/Computed_Cell_Trace.csv). The trace scenario executes 250 scans at 20 ms, counts six sensor pulses and stops with the motor and fill valve off. Its final state is asserted during the build.

## Architecture

```text
src/model.js       Typed document schema, validation and transaction history
src/language.js    Tokenizer and structured-text parser
src/compiler.js    LAD / FBD / ST to shared typed intermediate representation
src/runtime.js     Interpreter, timers/counters, I/O, forces and trace ring
src/worker.js      Fixed-step worker scheduler and versioned request protocol
src/client.js      Request/reply client with bounded request timeouts
src/renderer.js    Shared WebGPU vector pipeline, geometry batch and fallback
src/graphs.js      LAD/FBD/trace presentation and diagram hit regions
src/hmi.js         Tag-bound HMI designer and runtime controls
src/app.js         Engineering shell, editors and project workflows
```

## Tests and GitHub Pages

The **Test and deploy Pages** workflow runs on pushes to `main` and on manual dispatch. It runs the 40 Node compiler/runtime/worker tests, builds the standalone/static distribution, and exercises the HTTP-served modular application in Chromium with its real module worker. Publication uses the repository's existing Pages configuration: an Actions artifact or `gh-pages` at the root.

After deployment, `tools/verify-site.mjs` checks the published revision, compares every public file against its local SHA-256, verifies JavaScript MIME types and verifies the root HTML. `build-info.json` contains the source revision and file hashes. The workflow never force-pushes the publishing branch.

To run browser integration locally:

```sh
python -m pip install playwright
python -m playwright install chromium
npm start
# In a second terminal:
python tests/browser_smoke.py
```

`APP_URL`, `CHROMIUM_PATH` and `OUTPUT_DIR` are optional test overrides. `tests/fixture_smoke.py` additionally tests the generated standalone build in an isolated document fixture. That fixture is not evidence of hardware WebGPU execution.

## Scope and limits

The implemented PLC languages are useful, documented subsets, not complete IEC/SCL implementations. Siemens project formats/protocols, instance DB/UDT layouts, arrays/strings, interrupts, formal user-block parameter interfaces, physical I/O and certified safety functions are not implemented. HMI editing currently provides one screen. User-block state belongs to syntactic call sites rather than a Siemens instance-DB allocation model.

The worker uses deterministic virtual steps but is not a hard real-time control system. Project files preserve editable documents, not a running CPU checkpoint. The bounded I/O-event export is explicitly **not** a complete replay log of downloads, mode changes and plant changes. No performance benchmark or GPU compatibility claim is implied by a successful Canvas-fallback test.

## License

[MIT](LICENSE). TIA Portal and STEP 7 are Siemens trademarks; this project is independently developed and is not affiliated with or endorsed by Siemens.
