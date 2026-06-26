// apps/desktop/src/main/mcp/motifToolDefs.ts
// TS-owned MCP tool defs + resource defs for the motif surface (Phase 4 Task 1).
// Descriptions verbatim from native/src/mcp/catalog.rs lines 88–118.
// inputSchemas verbatim from fixtures/mcp/rust-catalog-snapshot.json.
// preview_motif_draft stays on the Rust path (special-cased capture in server.ts)
// and is NOT included here.

export interface MotifToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MotifResourceDef {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export const MOTIF_TOOL_DEFS: ReadonlyArray<MotifToolDef> = [
  {
    name: 'list_motifs',
    description:
      'List every motif available to add via `add_motif` — built-ins PLUS installed and ' +
      'draft user motifs. Returns an array of `{ id, name, version, size: [w,h], ' +
      'default_duration_s, props_schema, status, content_hash, target_id? }` where ' +
      '`status` is `builtin` | `installed` | `draft`. Inspect `props_schema` before ' +
      '`add_motif` to know what keys + types each motif accepts; unknown keys reject. ' +
      'Drafts (status `draft`) are placeable immediately for preview.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      description:
        'Empty arg shape for tools that take no parameters. The dispatch table deserializes `{}` (or any object) into this; `schemars` advertises it as an empty object schema.',
      title: 'EmptyArgs',
      type: 'object',
    },
  },
  {
    name: 'get_motif_source',
    description:
      'Read a Motif\'s source { manifest, html } — any built-in, installed, or draft. ' +
      'Read this before editing so you can base your changes on the current source. ' +
      '`id` comes from `list_motifs`.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      description: 'Shared single-id arg for `get_motif_source` + `delete_motif`.',
      properties: {
        id: {
          description: 'The Motif id (from `list_motifs`).',
          type: 'string',
        },
      },
      required: ['id'],
      title: 'MotifIdArgs',
      type: 'object',
    },
  },
  {
    name: 'write_motif_draft',
    description:
      'Write a Motif draft from { manifest, html }. Returns the draft id. The draft is ' +
      'placeable immediately (via `add_motif`) for preview, and re-writable. `from` ' +
      '(optional) records an existing Motif id as the draft\'s UPDATE target so a later ' +
      '`install_motif {mode:\'update\'}` republishes over it; omit `from` for a brand-new ' +
      'Motif (installs as new). The manifest\'s `id`/`version` are ignored — app-assigned. ' +
      'Expose tweakable controls via `props_schema`.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: {
        from: {
          description:
            'Optional id of an existing Motif this draft will UPDATE on install (records it as the draft\'s target). Omit for a brand-new Motif (installs as new).',
          type: ['string', 'null'],
        },
        html: {
          description:
            'The HTML body. The manifest island is injected by the app; a `<script>motif.define({...})</script>` drives the render.',
          type: 'string',
        },
        manifest: {
          description:
            'The manifest as a JSON object (its `id`/`version` are ignored — app-assigned). Shape: `{ name, size:[w,h], default_duration_s, props_schema, ... }` — inspect a built-in via `get_motif_source` for an exact example. Rejected if malformed.',
        },
      },
      required: ['html', 'manifest'],
      title: 'WriteMotifDraftArgs',
      type: 'object',
    },
  },
  {
    name: 'install_motif',
    description:
      'Install a draft. mode \'new\' publishes under the draft\'s own id; \'update\' ' +
      'republishes over the draft\'s recorded UPDATE target (set via `write_motif_draft`\'s ' +
      '`from`) — bumping its version so every placement re-renders, and rebinding + ' +
      'migrating current-project layers. Returns the published id.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: {
        draft_id: {
          description: 'The draft id (from `write_motif_draft`).',
          type: 'string',
        },
        mode: {
          description:
            '"new" (publish under the draft\'s own id) or "update" (republish over the draft\'s recorded target; fails if the draft has no target).',
          type: 'string',
        },
      },
      required: ['draft_id', 'mode'],
      title: 'InstallMotifArgs',
      type: 'object',
    },
  },
  {
    name: 'delete_motif',
    description:
      'Delete an installed or draft user Motif by id. Built-ins are rejected. Placed ' +
      'layers referencing it degrade to an error placeholder.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      description: 'Shared single-id arg for `get_motif_source` + `delete_motif`.',
      properties: {
        id: {
          description: 'The Motif id (from `list_motifs`).',
          type: 'string',
        },
      },
      required: ['id'],
      title: 'MotifIdArgs',
      type: 'object',
    },
  },
]

export const MOTIF_RESOURCE_DEFS: ReadonlyArray<MotifResourceDef> = [
  {
    uri: 'motifs://current',
    name: 'Motif catalog',
    description: 'Built-in, installed, and draft Motifs (html stripped). Re-fetch after motifs:changed events.',
    mimeType: 'application/json',
  },
]
