# 04 — Introduce the Dock Tree and built-in Editing layout

**What to build:** Replace the fixed editor grid with a WeftCut-owned Dock Workspace using the accepted Dockview version, eight singleton Panel kinds, recursive splits, tab groups, and the built-in NLE Editing arrangement while preserving every existing editing surface.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** ready-for-agent

- [ ] The built-in layout places Media Pool, Preview, and the contextual tool group above a full-width Timeline at the agreed proportions.
- [ ] Attribute, Effect, and Nearby open in the contextual group; Caption and Role Mixer start closed.
- [ ] Every Panel kind is a singleton and Panel components receive business data through WeftCut contracts rather than Dockview objects.
- [ ] Splitters and Panel constraints enforce the agreed main-window and per-Panel minimum sizes.
- [ ] Single groups use the zero-height native six-dot drag overlay and multi groups use the 28-pixel tab strip without content remounts.
- [ ] Center/edge docking and business/Files drag isolation work with no floating or popout user Panels.
- [ ] Adapter and React StrictMode tests cover registration, default layout, singleton enforcement, DnD arbitration, and lifecycle stability.
