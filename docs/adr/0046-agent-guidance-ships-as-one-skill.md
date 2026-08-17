---
status: accepted
---

# Agent guidance ships as one app-bundled skill, single-sourced from the docs

## Context

WeftCut's MCP surface already teaches connected agents everything a single
tool can carry: tool descriptions written as API docs, structured errors with
options, three canned prompts. What it structurally cannot carry is
**cross-tool process knowledge** — how a session should go (checkpoint first,
ask before taking over the UI), which tools compose into which flows, and the
Motif authoring loop with its verification gate. That knowledge lived only in
repo docs, and an end user's agent has no repo: whatever it should know has to
travel to its machine.

The obvious hazard of any client-side artifact is drift. The skill describes
the app; the app updates; a stale skill teaches every connected agent to call
tools that no longer exist — silently, on machines we don't control.

## Decision

### One skill, not a series

A single model-invoked skill named `weftcut` (repo-root `skills/weftcut/`),
description-anchored on "use BEFORE calling any weftcut MCP tool" so the MCP
catalog itself is the trigger signal. Editing etiquette and orchestration
patterns sit inline in `SKILL.md`; the Motif authoring spec is a disclosed
sibling file reached by a pointer. Splitting waits for observed trigger
failures, not anticipation.

### The content boundary is a rule, not a judgment call

The skill carries only what no single tool description can: etiquette,
composition, the authoring loop. If writing the skill ever requires restating
a tool's contract, the tool description is too weak — fix it at the source,
where every MCP client benefits, and leave a name-drop in the skill. The same
rule sends single-resource contracts into resource descriptions: the
`project://history` window semantics (`window_start`, `evicted`) moved into
its advertised description as part of this work, pinned by a Rust test.

### The authoring contract is single-sourced and build-copied

`docs/motif-authoring.md` is the one normative authoring spec — deliberately
self-contained (it links to no other doc), because a verbatim copy of it is
what ships inside the skill bundle. `docs/motifs.md` shrank to system
narrative and points at it. The spec embeds **zero example HTML**: the living
exemplar is always a built-in read via `get_motif_source`, which cannot drift
from the running app by construction.

### Verification is the user's, not the agent's

Not every MCP agent is multimodal, so the install gate cannot be "look at the
preview PNG". The mandated loop places the draft on the timeline and has the
user approve in the app's own preview before `install_motif`; image-capable
agents may pre-filter with `preview_motif_draft`, but the user's confirmation
is the gate either way. The same ask-first posture governs
`begin_agent_session`: small edits take a `checkpoint` and nothing more;
batch jobs ask before flipping the user's UI.

### Delivery rides the shim's rails

`scripts/build-skills.mjs` stages `skills/` plus the contract copy into
`out/skills`; electron-builder ships it as an extraResource; startup refreshes
it to `<userData>/skills/` (the only path stable across upgrades on all three
OSes); the Connect-agent panel shows a copyable install prompt pointing at
that copy. Skill version therefore equals app version — drift between the two
is structurally impossible. A marketplace mirror is deferred until the content
is validated with real users.

### Names are pinned by a gate

`mcp.skill-conformance.test.ts` extracts every backticked tool / resource /
prompt reference from the shipped sources and asserts membership in the
advertised catalog (the same fixture-plus-TS-tables union the bijection gate
uses). A rename goes red in CI until the prose is updated; semantic honesty
stays a docs-conformance-pass duty.

## Alternatives considered and rejected

- **MCP-native only (prompts / resources).** Reaches every client, but nothing
  in MCP loads proactively before the first tool call — prompts are
  user-invoked and resources are read on demand, so process knowledge would
  arrive only after the mistakes it exists to prevent. The boundary rule keeps
  the MCP surface as strong as it can be; the skill covers only the remainder.
- **A skill series.** Two-plus descriptions of permanent context load for
  content that shares its etiquette core; the Motif branch is reachable
  through one pointer at no standing cost.
- **Marketplace-first distribution.** Decouples skill version from app version
  on day one — the drift hazard adopted before any user has validated the
  content.
- **Embedded example Motifs.** Every embedded source is a future lie once the
  contract moves; built-ins read at run time are always current.
- **Agent self-review as the install gate.** Assumes multimodality; a
  text-only agent would install blind or not at all.

## Where this lives

- `skills/weftcut/SKILL.md` — the skill; `docs/motif-authoring.md` — the
  contract (copied verbatim into the bundle).
- `apps/desktop/scripts/build-skills.mjs` — staging;
  `apps/desktop/electron-builder.yml` `extraResources` — shipping;
  `apps/desktop/src/main/mcp/skillsInstall.ts` — the startup refresh;
  `AgentSection.tsx` — the Connect-panel install block.
- `apps/desktop/src/main/state/__tests__/mcp.skill-conformance.test.ts` — the
  anti-drift gate; `native/src/mcp/resources.rs` — the history-description
  pin.
