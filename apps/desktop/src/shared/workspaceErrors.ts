// The workspace-lifecycle refusal vocabulary: raised by main's
// workspace-orchestrator (project_open / project_new_workspace) and by the
// schema gate it loads through, serialized as
// `Error(JSON.stringify(WorkspaceError))` across IPC, and parsed back by the
// startup screen (renderer/startup/openError.ts).
//
// Lives in shared/ for the reason commandErrors.ts does: the renderer must
// recognise a refusal main raised, and the project-reference graph forbids the
// direct route (tsconfig.main already references tsconfig.web).
//
// SEPARATE from CommandError deliberately. That union is the state actor's
// MUTATION vocabulary, rendered by formatCommandError into editor status-bar
// lines that resolve uuids against the renderer's project mirror. These fire
// while there is no project — no mirror to resolve against, no status bar to
// write to — so they carry their own copy under `startup.*` / `new_project.*`
// and render inline on the launch surface.
//
// Payload rule: nothing the caller already holds. The renderer passed the path
// in and computed the create target itself, so no variant repeats one; only
// facts that live on the far side (the version the file declares, the prose of
// a parse failure) ride the wire.

export type WorkspaceError =
  // ── project_open ──
  /** The workspace folder is gone — typically a recents entry whose folder was
   *  moved or deleted. Probed before project.json so the user is told "the
   *  folder is gone" rather than "this isn't a WeftCut project". */
  | { error: 'ProjectFolderMissing' }
  /** The folder is there but holds no project.json. */
  | { error: 'NotProjectFolder' }
  /** project.json declares no integer schema_version — not a project file this
   *  build recognises. */
  | { error: 'ProjectSchemaUnreadable' }
  /** project.json is AHEAD of this build: it may carry fields and semantics
   *  that do not exist here, and writing it back would silently drop them.
   *  Both versions ride along because the copy states the mismatch rather than
   *  guessing that an app update fixes it — the file this fires on most often
   *  is one left behind by a different build of this same repo. */
  | { error: 'ProjectSchemaTooNew'; found: number; supported: number }
  /** project.json is unparseable, or its structure failed the cast. `detail` is
   *  the underlying throw, English and unlocalized — it names a byte offset or a
   *  field, which is the only actionable thing left to say. */
  | { error: 'ProjectFileUnreadable'; detail: string }
  /** The project parsed but failed validation on the way into the actor.
   *  `detail` is the serialized CommandError for the log's disclosure; the copy
   *  stays generic, since the startup screen cannot name a layer it has never
   *  mirrored. */
  | { error: 'ProjectInvalid'; detail: string }
  // ── project_new_workspace ──
  /** Something already occupies the create target. Never overwritten: the
   *  occupant may be an unrelated folder full of the user's files. */
  | { error: 'ProjectFolderExists' }
  | { error: 'ProjectNameRequired' }
  | { error: 'InvalidCanvasPreset' }

/** Every code in the union, as a runtime set — the renderer's parser needs one
 *  to tell a WorkspaceError apart from a CommandError, which shares its wire
 *  shape (`{ error: string, … }`) and its "JSON in the message tail" transport.
 *  Typed as a Record over the union so a new variant fails to compile until it
 *  is listed here AND given copy in the startup error map. */
export const WORKSPACE_ERROR_CODES: Readonly<Record<WorkspaceError['error'], true>> = {
  ProjectFolderMissing: true,
  NotProjectFolder: true,
  ProjectSchemaUnreadable: true,
  ProjectSchemaTooNew: true,
  ProjectFileUnreadable: true,
  ProjectInvalid: true,
  ProjectFolderExists: true,
  ProjectNameRequired: true,
  InvalidCanvasPreset: true,
}

/** Thrown by the workspace lifecycle to refuse an open / create.
 *
 *  Unlike CommandFailure — whose `message` is the bare code, re-serialized by
 *  the host's command arm on the way out — this one supers the JSON itself.
 *  The open / newWorkspace routes have no such arm: they let the throw
 *  propagate untouched, and Electron keeps only `message`, so the structure has
 *  to already be in it. */
export class WorkspaceFailure extends Error {
  constructor(public readonly err: WorkspaceError) {
    super(JSON.stringify(err))
    this.name = 'WorkspaceFailure'
  }
}

export function isWorkspaceFailure(e: unknown): e is WorkspaceFailure {
  return e instanceof WorkspaceFailure
}
