// Vitest global setup (registered in vitest.config.ts `setupFiles`): load the
// shared weftcut-eval wasm once per test file. Any code path that routes through
// it — snapFrameRound, resolveAnimated, dbToLinear, roleAudible, and the
// components/hooks that call them — then works without each test wiring up its
// own init. `initEval()` is idempotent, so suites that also await it themselves
// are fine. New tests need NOTHING; this covers them.
import { beforeAll } from "vitest";
import { initEval } from "./eval";

beforeAll(async () => {
  await initEval();
});
