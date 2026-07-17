# 02 — Extract five semantic tool Panel boundaries

**What to build:** Turn Attribute, Effect, Caption, Role Mixer, and Nearby into independent renderable Panel components while preserving all existing tool behaviour inside the current editor layout, making the later Dock Workspace a composition change rather than a business-UI rewrite.

**Blocked by:** 01 — Promote complete Layer selection to a global model.

**Status:** ready-for-agent

- [ ] Attribute owns existing kind-specific Layer fields without rendering the effect chain.
- [ ] Effect renders the selected visual Layer's existing effect chain as a standalone surface.
- [ ] Caption, Role Mixer, and Nearby can render independently of the legacy right-side tab container.
- [ ] A temporary compatibility composition preserves the current fixed-layout experience until the Dock Tree lands.
- [ ] Component tests prove the extraction does not change existing edits, selection, visibility, or mounted-state behaviour.
