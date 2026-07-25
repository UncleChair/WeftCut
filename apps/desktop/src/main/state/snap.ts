// The frame-grid snapping the TS actor uses MUST be the shared wasm leaf
// (weftcut-eval `snap_round`) — never a reimplementation — so TS and Rust
// snapping stay byte-identical (feedback_snap_math_drift). Re-exported here so
// main-process code has a stable import that does not reach across into the
// renderer tree at every call site. In tests the wasm is initialized by
// src/renderer/testSetup.ts (initEval in beforeAll); in production the main
// process must await initEval() once at boot before the actor handles a command.
export { snapFrameRound, snapFrameFloor, snapFrameCeil, frameIndexRound, timeUsAtFrame, initEval } from '../../renderer/eval'
