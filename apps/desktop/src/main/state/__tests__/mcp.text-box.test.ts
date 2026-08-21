// apps/desktop/src/main/state/__tests__/mcp.text-box.test.ts
//
// The text box across the MCP WIRE, not just the mutation (that half lives in
// mutations/params.test.ts). Two things only a JSON round trip can prove:
//
//   * `box_w: null` survives as null and is not flattened to absent, because the
//     three resize modes ARE the box nullability (ADR 0049) and null is the only
//     way to say "back to auto";
//   * the (null, set) refusal reaches the agent as `invalid_params` with the
//     field NAMED IN THE MESSAGE — MCP clients surface `code: message` and drop
//     `error.data`, so a refusal that only carries the field structurally is a
//     dead end for the caller.
//
// Asserted through mcpCall per the emit-smoke-tests house rule: invoke the real
// tool, don't string-match the schema.
import { describe, it, expect } from 'vitest'
import { freshActor, bRollId } from './pbt/harness'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import type { TextParams } from '../model'

function addTextLayer(actor: ReturnType<typeof freshActor>): string {
  const r = actor.dispatch('add_layer', { track: bRollId(actor), kind: 'text', t_start_us: 0, t_end_us: 2_000_000 })
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: string }).value
}

function textParams(actor: ReturnType<typeof freshActor>, id: string): TextParams {
  for (const t of actor.snapshot().tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return l.params as TextParams
  }
  throw new Error('layer not found')
}

const patch = (actor: ReturnType<typeof freshActor>, id: string, fields: Record<string, unknown>) =>
  actor.mcpCall('update_layer_params', JSON.stringify({ layer_id: id, patch: { kind: 'Text', ...fields } }))

describe('update_layer_params — the Text box over the wire', () => {
  it('a width alone lands in auto height, and an explicit null comes back to auto width', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([null, null])

    expect(patch(a, id, { box_w: 800 }).ok).toBe(true)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([800, null])

    expect(patch(a, id, { box_w: null }).ok).toBe(true)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([null, null])
  })

  it('an omitted box field leaves the axis alone — absent is not null', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect(patch(a, id, { box_w: 800, box_h: 200 }).ok).toBe(true)
    expect(patch(a, id, { content: 'unrelated' }).ok).toBe(true)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([800, 200])
  })

  it('both axes in one patch land in fixed', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect(patch(a, id, { box_w: 800, box_h: 200 }).ok).toBe(true)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([800, 200])
  })

  it('a height with no width refuses, names box_h in the message, and commits nothing', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    const before = JSON.stringify(a.snapshot())

    const r = patch(a, id, { box_h: 200, content: 'never lands' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('box_h')
    // Byte-identical, not merely "box_h unset": the refusal fires before the
    // first field write, so the co-riding `content` must not have landed either.
    expect(JSON.stringify(a.snapshot())).toBe(before)
  })

  it('a height on a layer that already carries a width succeeds', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect(patch(a, id, { box_w: 800 }).ok).toBe(true)
    expect(patch(a, id, { box_h: 200 }).ok).toBe(true)
    expect([textParams(a, id).box_w, textParams(a, id).box_h]).toEqual([800, 200])
  })

  it('align takes effect on a boxed layer — the field an agent could not reach at all before', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect(patch(a, id, { box_w: 800, align: 'Left', valign: 'Top', line_height: 1.4, letter_spacing: 2 }).ok).toBe(true)
    const t = textParams(a, id)
    expect([t.align, t.valign, t.line_height, t.letter_spacing]).toEqual(['Left', 'Top', 1.4, 2])
  })
})

describe('the advertised schema can express what the model needs', () => {
  const props = (() => {
    const def = MCP_TOOL_DEFS.find((d) => d.name === 'update_layer_params')!
    const schema = def.inputSchema as { properties: { patch: { properties: Record<string, { type: unknown; enum?: unknown }> } } }
    return schema.properties.patch.properties
  })()

  it("the box pair advertises number-OR-null, or 'back to auto' is unsendable", () => {
    expect(props.box_w.type).toEqual(['number', 'null'])
    expect(props.box_h.type).toEqual(['number', 'null'])
  })

  it('align and valign are advertised with the enums the model defines', () => {
    expect(props.align.enum).toEqual(['Left', 'Center', 'Right'])
    expect(props.valign.enum).toEqual(['Top', 'Middle', 'Bottom'])
  })

  it('Text still advertises no scale fields of its own — a bigger title is a bigger box', () => {
    // scale_x/scale_y ARE in this shared property bag for the other kinds, so the
    // guard that keeps ADR 0049 true is the description telling an agent Text has
    // none, plus the patch type in mutations/params.ts having no such field.
    const def = MCP_TOOL_DEFS.find((d) => d.name === 'update_layer_params')!
    expect(def.description).toContain('no scale fields')
  })
})
