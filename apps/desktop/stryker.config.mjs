// Mutation-testing config. A .mjs file rather than the stryker.config.json it
// replaces: Stryker parses .json with a strict JSON.parse, and `tsconfigFile`
// below is a workaround that must not travel uncommented.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  concurrency: 4,
  timeoutMS: 60000,

  // Names a tsconfig that deliberately does not exist, which switches OFF
  // Stryker's sandbox tsconfig rewriting. That rewriting is a no-op for us
  // anyway — ./tsconfig.json is a `files: []` orchestrator whose four
  // `references` are all relative and all copied into the sandbox, so they
  // resolve there untouched — but merely reaching it costs us the run: the
  // preprocessor opens with `await import('typescript')`, and since the
  // TypeScript 7 upgrade there is no `typescript` for it to find. Two reasons,
  // both structural rather than transient:
  //   1. Nothing hoists to the workspace root any more. @napi-rs/cli pins
  //      typescript ^6 while the app is on ^7, so npm nests BOTH copies under
  //      apps/desktop/node_modules — while @stryker-mutator/core hoists to the
  //      repo root and resolves from there. ERR_MODULE_NOT_FOUND.
  //   2. Hoisting one would not help. TypeScript 7's package exports only
  //      `./lib/version.cjs` as its main entry, so `ts.parseConfigFileTextToJson`
  //      is gone and the preprocessor would fail one line later instead.
  // Stryker has no TypeScript 7 support yet; drop this line once it does.
  tsconfigFile: 'tsconfig.stryker-disabled.json',

  mutate: [
    'src/main/state/validate.ts',
    'src/main/state/mutations/move.ts',
    'src/main/state/mutations/trim.ts',
    '!src/main/state/**/*.test.ts',
    '!src/main/state/**/__tests__/**',
  ],
  thresholds: { high: 90, low: 80, break: 75 },
}
