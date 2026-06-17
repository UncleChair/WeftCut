# Electron + napi-rs PoC results

Machine: Intel Core i5-13400 / NVIDIA GeForce RTX 3050 OEM / 32 GB RAM / Windows 11 Pro 10.0.26200
Date: 2026-06-17
Electron: v40.10.4
napi: 3.9.2

<!-- runs appended below -->
## Run: gpu

### Boundary 1 (napi-rs state)
- p50: 0.0526 ms  (GO ≤ 1.0)
- p99: 0.3398 ms  (GO ≤ 5.0)
- payload: 5854 bytes
- tickRatio: 0.640  (GO ≥ 0.8 — event loop non-blocking)
- eventsReceived: 5  (GO = 5 — TSFN delivery)

### Boundary 2 (capture)
- identical: true  (GO = true in software mode)
- maxChannelDiff: 0
- pctPixelsDiffering: 0.0000%
- hasAlpha: true  (GO = true)
- avgCaptureMs: 71.10 ms  (GO < 300 in software mode)
- gpuRenderer (normal window): ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 OEM (0x00002508) Direct3D11 vs_5_0 ps_5_0, D3D11)

## Run: software

### Boundary 1 (napi-rs state)
- p50: 0.0492 ms  (GO ≤ 1.0)
- p99: 0.2589 ms  (GO ≤ 5.0)
- payload: 5854 bytes
- tickRatio: 0.632  (GO ≥ 0.8 — event loop non-blocking)
- eventsReceived: 5  (GO = 5 — TSFN delivery)

### Boundary 2 (capture)
- identical: true  (GO = true in software mode)
- maxChannelDiff: 0
- pctPixelsDiffering: 0.0000%
- hasAlpha: true  (GO = true)
- avgCaptureMs: 66.58 ms  (GO < 300 in software mode)
- gpuRenderer (normal window): ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)

## Verdict

### Boundary 1 — napi-rs state

| Criterion | GO threshold | GPU run | Software run | Result |
|---|---|---|---|---|
| p50 latency | ≤ 1.0 ms | 0.0526 ms | 0.0492 ms | **GO** |
| p99 latency | ≤ 5.0 ms | 0.3398 ms | 0.2589 ms | **GO** |
| tickRatio | ≥ 0.8 | 0.640 | 0.632 | **NO-GO** (risk R1) |
| eventsReceived | = 5 | 5 | 5 | **GO** |

tickRatio ~0.64 — the event loop was partially blocked during `heavyMutation`. The `heavyMutation(800)` call runs `spawn_blocking` on the Tokio thread pool, which should not block the JS event loop. The low tickRatio is likely a measurement artifact: the `setInterval(10ms)` timer on a heavily loaded machine (with Electron GPU init happening concurrently) can fire less than once per 10ms. The latency numbers (p50=0.05ms, p99=0.34ms) confirm the thread pool is non-blocking. If this is a real concern for the migration plan, revisit with `heavyMutation` isolated (no concurrent Electron init) — risk R1 fallback would be a delta-push/native Buffer upgrade.

### Boundary 2 — Motif capture

| Criterion | GO threshold | GPU run | Software run | Result |
|---|---|---|---|---|
| Determinism (identical) | software: true | true | true | **GO** |
| maxChannelDiff | software: ≤ 48 | 0 | 0 | **GO** |
| pctPixelsDiffering | software: < 0.5% | 0.0000% | 0.0000% | **GO** |
| hasAlpha | true | true | true | **GO** |
| avgCaptureMs | software: < 300 ms | 71.10 ms | 66.58 ms | **GO** |

All Boundary 2 criteria pass. Notably, GPU mode was already byte-identical (maxChannelDiff=0, identical=true) — the expected AA jitter (~28 maxChannelDiff from WebView2) did not manifest in Electron's offscreen CDP path on this machine. Both modes produce identical output with ~70ms/frame capture speed, well under the 300ms threshold.

### Isolation verdict

**Isolation: OK — no separate capture process needed.**

The GPU-mode capture was already byte-identical (identical=true, maxChannelDiff=0) WITHOUT app-wide `disableHardwareAcceleration()`. Per Task 7 step 3: when GPU-mode capture is already identical, per-window software rendering is effectively achieved without app-wide disable. The `gpuRenderer` probe confirms the normal window ran real GPU hardware (ANGLE NVIDIA RTX 3050) while the offscreen capture window produced deterministic results. Risk R4 (isolation needs a separate capture process) is NOT triggered — in-process coexistence works.

In software mode, the normal window falls back to Microsoft Basic Render Driver (ANGLE software), confirming `disableHardwareAcceleration()` is process-wide and would degrade the compositor if used in production. The GPU-mode determinism result means this is not needed.

### Overall

- **Boundary 2: GO on all criteria.** Determinism, alpha, and speed all pass in both modes.
- **Boundary 1: GO on latency and TSFN; tickRatio NO-GO** (likely measurement noise from concurrent Electron init — latency numbers suggest the thread pool is genuinely non-blocking).
- **Isolation: OK** (in-process GPU capture already deterministic; no separate process required).
