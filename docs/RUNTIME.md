# RelayForge execution contract

## Scan cycle and clocks

At virtual scan index `N`, the program evaluates with `now = N * cycleMs`. A successful scan performs the following ordered stages:

1. Integrate the optional example plant over one fixed `cycleMs` interval using previously committed outputs.
2. Apply due queued events in their original enqueue order. Future events remain queued.
3. Sample every simulated input into the program's input image, with active forces taking precedence.
4. Execute the entry OB. Networks/statements and user-block calls execute in program order. FBD dependencies execute in topological order.
5. Build and atomically publish the output image. Output forces take precedence over the raw program assignments.
6. Append a trace sample labelled with `N` and `N * cycleMs`; increment the scan index and virtual time.

Consequently, a snapshot after scan `N` reports completed scan count `N+1` and next evaluation time `(N+1) * cycleMs`, whereas the trace record for that scan uses the evaluation time. The supplied 20 ms / 800 ms TON example becomes true on evaluation index 40, after 41 executed scans starting at index zero.

A runtime exception aborts output commit, enters FAULT and de-energizes all physical simulated outputs. Previous memory assignments remain inspectable. STOP also de-energizes outputs; PAUSE preserves them. A reset is required to execute again after FAULT. Output forcing never overrides STOP/FAULT safe-output behavior.

The worker accumulates elapsed wall time scaled by 1×, 2×, 4×, 8× or 16× and executes fixed-duration scans, at most 100 per scheduling batch. Backlogged virtual ticks are not discarded. Publishing live snapshots at up to 20 Hz and browser rendering are separate activities. Suspension/throttling may produce delayed delivery or backlog: this is not hard real-time execution. Determinism is conditional on the same *scan-indexed* event stream; a human clicking at a wall-clock time does not provide a deterministic input schedule.

## Tags, values and forces

Global tags are case-insensitive symbols resolved to their declared canonical spelling. They carry an ID, type, input/output/memory direction, initial value, optional retention and a symbolic address. Addresses do not alias a shared byte buffer.

- BOOL is strictly Boolean; no implicit numeric truthiness is allowed in compiled expressions.
- INT and DINT are checked signed 16-bit and 32-bit integers.
- REAL is rounded to IEEE-754 binary32 at each expression result and write. Arithmetic uses JavaScript numbers internally and then applies `Math.fround`; NaN and infinities fault.
- TIME is an integer duration from 0 to 2147483647 milliseconds. Duration literals support `T#1m2s50ms` and related units.

Integer division truncates toward zero. `TO_INT`/`REAL_TO_INT` explicitly truncate to this implementation's DINT result; subsequent assignment to INT is range checked. Integer-to-REAL conversion is supported. Overflow does not silently wrap.

Input changes, memory writes, force and release events are validated before queueing. Running CPUs apply them at a scan boundary. A stopped/paused CPU applies currently due changes immediately for inspection; a future-indexed event still waits for its scan index. Momentary HMI release uses at least one future scan boundary so a very short click is not silently lost.

Forces are permitted only for simulated inputs/outputs, not memory tags. Forced values override program reads and the effective output image; `programValues` retains the raw assignments separately. Releasing an input restores the latest underlying input. A program output becomes program-controlled on the next commit. Warm reset clears forces and retains only memory tags marked retain; cold reset restores all initial values and clears local/instance state.

## Timers and edge state

Timer state belongs to its block call-site frame, never to a graph pixel or render frame. Invoke an instance at most once per intended program point per scan unless deliberately exercising repeated-call semantics. Skipping a call leaves its outputs unchanged; the next invocation uses elapsed virtual time. Merely reading `timer.Q` or `timer.ET` has no update side effect.

| Instruction | Contract |
|---|---|
| TON | FALSE clears start, Q and ET. The first TRUE call captures `now`, with ET=0. Later TRUE calls use `ET=min(PT,now-start)`; Q is true when ET reaches PT. PT=0 completes immediately. PT changes are evaluated against the existing start time. |
| TOF | TRUE sets Q, clears ET and cancels any pending off-delay. A TRUE→FALSE edge starts the delay at ET=0; Q stays true while elapsed time is less than PT. Initial FALSE does not create an artificial delay. |
| TP | A rising edge starts a non-retriggerable pulse and captures PT. Falling input does not terminate an active pulse. While active, further rising edges and PT changes do not extend it. On expiration, Q becomes false. After input returns low, inactive elapsed state clears. PT=0 yields no true scan. |
| R_TRIG | Q is true only on a false-to-true transition. Initial previous state is low, so an initial true input produces an edge. |
| F_TRIG | Q is true only after an observed true-to-false transition. An initial false input produces no synthetic edge. |

## Counters

All counters store CV in the range 0…2147483647. Inputs are sampled per invocation and counting is rising-edge driven. Negative PV is a runtime error; saturation is explicit rather than overflow wrapping.

CTU resets on R, otherwise increments on a CU edge. Q is `CV >= PV`. CTD loads PV on LD, otherwise decrements on a CD edge. Q is `CV <= 0`. CTUD prioritizes R, then LD, then edges; simultaneous CU/CD rising edges cancel. Its outputs are QU=`CV >= PV` and QD=`CV <= 0`. Reset/load calls still update previous-edge state, so a held-high input does not create a new edge after reset clears.

## Structured-text example

Create a ST OB or replace the source in a ST block called by Main. The names below are declared by the bundled project:

```iecst
VAR
    startup : TON;
    edge : R_TRIG;
    i : DINT;
    localCount : DINT := 0;
END_VAR

startup(
    IN := RunRequest AND EStopOK,
    PT := T#800ms,
    Q => StartReady,
    ET => StartDelay
);

edge(CLK := PartSensor);
IF edge.Q THEN
    localCount := localCount + 1;
END_IF;

IF startup.Q THEN
    Motor := TRUE;
    SpeedCommand := LIMIT(0.0, SpeedSetpoint, 100.0);
ELSIF Stop THEN
    Motor := FALSE;
    SpeedCommand := 0.0;
ELSE
    Motor := FALSE;
END_IF;

FOR i := 1 TO 3 DO
    localCount := localCount + 1;
END_FOR;
PartsCount := localCount;
```

`VAR` scalar locals and FB instances persist between scans at a call site. Separate syntactic call sites own separate local/instance frames. This is not a Siemens instance-DB allocation model. User-defined blocks currently communicate through global tags rather than formal parameter interfaces. A called block's kind FB/FC identifies it in the project but does not implement all vendor-specific storage distinctions.

No user ST code is passed to `eval`, `Function` or browser script execution. The parser builds expression/statement syntax nodes; the compiler resolves references and types; the interpreter executes the resulting instruction objects. A 100000-operation scan budget, 10000-iteration loop limit, depth limit of 32 and frame limit of 4096 bound runtime work. Static recursion and FBD combinational cycles are diagnosed before loading.

## FBD and LAD ordering

FBD requires an acyclic explicit wire graph. Node array order does not substitute for dependency ordering. Unconnected required pins, missing outputs and incompatible types are compile errors. Use explicit state instructions or global memory/scan boundaries rather than implicit combinational feedback. Independent writes are deterministic in the graph's stable traversal order; avoid multiple writers to the same tag unless the order is intentional. Cross-block multiple writers produce a warning; last executed assignment wins.

LAD implements ordered networks, each with a common series chain and zero or more parallel series legs feeding one action. An empty contact chain conducts TRUE. Normally closed contacts invert their operand. Both operands of Boolean expressions are evaluated, rather than short-circuiting, to keep monitoring behavior explicit. Graphical arbitrary nested branch trees and graphical network-to-network wires are outside the current schema.

## Persistence and reproducibility

Project files preserve document identity, program source, tag definitions, watch/trace channel selection and HMI layout. They do not serialize a running CPU checkpoint. Loading/downloading performs a cold restart. Undo/redo restores editable documents, not previous PLC time or state. Trace samples are in a 4096-record ring; live snapshots carry only the latest 240 samples. CSV export returns the retained full ring in chronological order.

The bounded I/O event export records actual applied scan indices and overflow count. It does not record Run/Pause/Stop/Reset, download, speed or plant-mode changes; its `completeReplay` field is false. The automated deterministic replay test instead constructs the same complete initial conditions and scan-indexed event schedule twice and compares computed memory, trace and instance state.
