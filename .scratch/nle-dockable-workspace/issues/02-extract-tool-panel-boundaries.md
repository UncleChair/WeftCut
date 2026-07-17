# 02 — Extract five semantic tool Panel boundaries

**What to build:** Turn Attribute, Effect, Caption, Role Mixer, and Nearby into independent renderable Panel components while preserving all existing tool behaviour inside the current editor layout, making the later Dock Workspace a composition change rather than a business-UI rewrite.

**Blocked by:** 01 — Promote complete Layer selection to a global model.

**Status:** completed

- [x] Attribute owns existing kind-specific Layer fields without rendering the effect chain.
- [x] Effect renders the selected visual Layer's existing effect chain as a standalone surface.
- [x] Caption, Role Mixer, and Nearby can render independently of the legacy right-side tab container.
- [x] A temporary compatibility composition preserves the current fixed-layout experience until the Dock Tree lands.
- [x] Component tests prove the extraction does not change existing edits, selection, visibility, or mounted-state behaviour.

## Verification

- 28 focused component tests pass across all five Panel boundaries, the compatibility RightPanel, and the existing EffectsSection contract; the full renderer suite passes 1,150 tests across 161 files.
- Renderer TypeScript check passes with no errors.
- Full-project TypeScript remains blocked by pre-existing stale native-decode declarations in unmodified main-process export files.
- React Doctor changed-scope was attempted, produced no output, and was stopped after 60 seconds because the environment could not complete its package lookup.
