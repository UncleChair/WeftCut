# Frozen schema fixtures

One `v{n}.json` per **on-disk schema generation** — the input a migration step
reads. `migrate.completeness.test.ts` walks each one through the chain
(`state/migrate.ts`), then through `parseProject` + `validate`, and fails if a
registered step has no fixture at its `from` version.

## These files are frozen. Do not regenerate them.

A fixture's whole job is to be a *shape from the past*. Regenerating one from the
current model re-anchors it to today's shape, at which point the step it guards
is being tested against its own output and the test proves nothing. There is
deliberately **no generator script** in the repo for these — if a fixture looks
wrong, that is either a real migration bug or a deliberate follow-up step, never
a reason to rewrite the file.

Hand-editing one is allowed for exactly one reason: the version it declares must
match its filename.

## Provenance

`v1.json` was produced once by driving the real actor (`state/actor.ts`) with a
seeded id generator, then frozen:

- a `Video` media item with audio, workspace paths, and a `Proxied` decode route
  carrying a landed full proxy, waveform and thumbnails
- A-roll: an auto-paired `VideoClip` + `Audio` layer, and the `Group` that pairing
  creates
- B-roll: two adjacent `Color` layers with a `Crossfade` transition across the
  join (so the authorized-overlap invariant is represented, not just the field)
- a spawned overlay lane (`label: null` — the derived-name case) holding a `Text`
  layer whose `x` track is keyframed across `Bezier`, `Elastic` and `Hold`
  segments
- a `blur` effect on that layer with a keyframed `strength` (`Linear`, `Bounce`)
- a point marker and a region marker
- `audio_roles.dialogue` off unity, `prefer_proxies` on, and one
  `proxy_overrides` entry

Two fields could not come from the actor and were pinned by hand at generation
time, because `blankProject` stamps wall-clock time: `metadata.created_at` and
`metadata.modified_at`.

The coverage above is the point — a step that forgets a field is only caught if
the fixture *has* that field. When adding a fixture for a later version, aim at
the same breadth.
