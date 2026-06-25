import { describe, it, expect } from 'vitest'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'
import { serializeProjectToJson } from '../persistence'

// Regression: the read-mirror round-trips serializeProjectToJson(snapshot) through
// Rust `set_project_mirror` → `serde_json::from_str::<Project>`, where created_at /
// modified_at are `DateTime<Utc>`. A '<TS>' sentinel (used only for canonical
// differential comparison) makes Rust deserialization fail with "invalid project
// json", which aborts boot under WEFTCUT_TS_ACTOR. blankProject must emit real
// RFC3339 timestamps, like Rust Project::new_blank's Utc::now().
describe('blankProject timestamps are Rust-DateTime parseable', () => {
  it('created_at / modified_at are real RFC3339, not the <TS> sentinel', () => {
    const p = blankProject(uuidV7Gen(), 'untitled')
    for (const ts of [p.metadata.created_at, p.metadata.modified_at]) {
      expect(ts).not.toBe('<TS>')
      expect(Number.isNaN(Date.parse(ts)), `${ts} must be a parseable date`).toBe(false)
      // RFC3339 / ISO-8601 with a timezone — what chrono DateTime<Utc> accepts.
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
    }
  })

  it('the serialized mirror JSON carries no <TS> in metadata timestamps', () => {
    const json = serializeProjectToJson(blankProject(uuidV7Gen(), 'untitled'))
    const meta = (JSON.parse(json) as { metadata: { created_at: string; modified_at: string } }).metadata
    expect(meta.created_at).not.toBe('<TS>')
    expect(meta.modified_at).not.toBe('<TS>')
  })
})
