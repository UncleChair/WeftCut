import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import { WorkspaceFailure } from "../../shared/workspaceErrors";
import {
  cleanIpcDetail,
  describeCreateError,
  describeOpenError,
  isDeadRecentError,
  parseWorkspaceError,
} from "./openError";

// Records which i18n key was chosen — the component only cares about key
// selection; actual copy lives in the locale files. Interpolation values ride
// along so the version-mismatch line can be checked for carrying both numbers.
const t = ((key: string, values?: Record<string, unknown>) =>
  values && Object.keys(values).length > 0
    ? `${key} ${JSON.stringify(values)}`
    : key) as unknown as TFunction;

/** What the renderer actually receives: Electron prefixes the main-process
 *  Error's message and drops every other property. Captured verbatim from a
 *  live dev build — this framing is the whole reason the payload rides in
 *  `message` as a JSON tail. */
const overIpc = (e: WorkspaceFailure): Error =>
  new Error(
    `Error invoking remote method 'backend:invoke': Error: ${e.message}`,
  );

/** The folder the caller acted on. A real Windows path, since that is what
 *  every one of these call sites passes and what the interpolation has to
 *  survive intact. */
const PICKED = String.raw`C:\proj\a`;

/** What the `t` stub above renders for a key that interpolates the path. */
const withPath = (key: string) => `${key} ${JSON.stringify({ path: PICKED })}`;

describe("parseWorkspaceError", () => {
  it("recovers the payload through Electron's IPC prefix", () => {
    const err = overIpc(
      new WorkspaceFailure({
        error: "ProjectSchemaTooNew",
        found: 2,
        supported: 1,
      }),
    );
    expect(parseWorkspaceError(err)).toEqual({
      error: "ProjectSchemaTooNew",
      found: 2,
      supported: 1,
    });
  });

  it("declines a CommandError, which shares the wire shape", () => {
    // Both unions serialize as `{ error: string, … }`, so only the vocabulary
    // check keeps a mutation refusal from being rendered as a workspace one.
    expect(
      parseWorkspaceError(
        new Error(`Error: ${JSON.stringify({ error: "TrackNotFound", track: "t1" })}`),
      ),
    ).toBeNull();
  });

  it("declines plumbing throws and junk", () => {
    expect(parseWorkspaceError(new Error("EBUSY: resource busy"))).toBeNull();
    expect(parseWorkspaceError("io: disk on fire")).toBeNull();
    expect(parseWorkspaceError(new Error("{not json"))).toBeNull();
    expect(parseWorkspaceError(null)).toBeNull();
  });
});

describe("cleanIpcDetail", () => {
  it("strips the IPC framing and the redundant error-class prefix", () => {
    expect(
      cleanIpcDetail(
        new Error(
          "Error invoking remote method 'backend:invoke': Error: EBUSY: resource busy",
        ),
      ),
    ).toBe("EBUSY: resource busy");
  });

  it("leaves an unwrapped message alone", () => {
    expect(cleanIpcDetail(new Error("commit_workspace failed"))).toBe(
      "commit_workspace failed",
    );
  });

  it("keeps the raw text when stripping would leave nothing", () => {
    expect(cleanIpcDetail(new Error("TypeError:"))).toBe("TypeError:");
  });
});

describe("describeOpenError", () => {
  const open = (e: WorkspaceFailure) =>
    describeOpenError(overIpc(e), PICKED, t);

  it("maps the missing-folder refusal to the folder-missing message", () => {
    expect(open(new WorkspaceFailure({ error: "ProjectFolderMissing" }))).toBe(
      withPath("startup.project_folder_missing"),
    );
  });

  it("maps the not-a-project refusal to the not-a-project message", () => {
    expect(open(new WorkspaceFailure({ error: "NotProjectFolder" }))).toBe(
      withPath("startup.not_project_folder"),
    );
  });

  it("carries both versions into the schema-mismatch message", () => {
    expect(
      open(
        new WorkspaceFailure({
          error: "ProjectSchemaTooNew",
          found: 7,
          supported: 1,
        }),
      ),
    ).toBe('startup.project_schema_too_new {"found":7,"supported":1}');
  });

  it("maps an unversioned project.json to its own message", () => {
    expect(open(new WorkspaceFailure({ error: "ProjectSchemaUnreadable" }))).toBe(
      "startup.project_schema_unreadable",
    );
  });

  it("passes a parse failure's prose through as detail", () => {
    expect(
      open(
        new WorkspaceFailure({
          error: "ProjectFileUnreadable",
          detail: "SyntaxError: Unexpected token }",
        }),
      ),
    ).toBe(
      'startup.project_file_unreadable {"detail":"SyntaxError: Unexpected token }"}',
    );
  });

  it("keeps the validation refusal generic — its uuids have no mirror here", () => {
    expect(
      open(
        new WorkspaceFailure({
          error: "ProjectInvalid",
          detail: '{"error":"ValidationFailed"}',
        }),
      ),
    ).toBe("startup.project_invalid");
  });

  it("falls back to the generic line for an untranslated throw, minus the IPC framing", () => {
    expect(
      describeOpenError(
        new Error(
          "Error invoking remote method 'backend:invoke': Error: io: disk on fire",
        ),
        PICKED,
        t,
      ),
    ).toBe('startup.recent_open_failed {"detail":"io: disk on fire"}');
  });
});

describe("describeCreateError", () => {
  const create = (e: WorkspaceFailure) =>
    describeCreateError(overIpc(e), PICKED, t);

  it("maps an occupied target to the pick-another-name message", () => {
    expect(create(new WorkspaceFailure({ error: "ProjectFolderExists" }))).toBe(
      "new_project.folder_exists",
    );
  });

  it("reuses the field-level copy for an empty name", () => {
    expect(create(new WorkspaceFailure({ error: "ProjectNameRequired" }))).toBe(
      "new_project.validation_empty",
    );
  });

  it("maps a bad canvas preset to its own message", () => {
    expect(create(new WorkspaceFailure({ error: "InvalidCanvasPreset" }))).toBe(
      "new_project.invalid_preset",
    );
  });

  it("falls back to the create-failed line for an untranslated throw", () => {
    expect(
      describeCreateError(new Error("EPERM: operation not permitted"), PICKED, t),
    ).toBe('new_project.create_failed {"detail":"EPERM: operation not permitted"}');
  });
});

describe("isDeadRecentError", () => {
  it("is true for both dead-entry refusals", () => {
    expect(
      isDeadRecentError(overIpc(new WorkspaceFailure({ error: "ProjectFolderMissing" }))),
    ).toBe(true);
    expect(
      isDeadRecentError(overIpc(new WorkspaceFailure({ error: "NotProjectFolder" }))),
    ).toBe(true);
  });

  it("keeps an entry this build is merely too old to read", () => {
    // A newer-format project is exactly what the user wants listed the day they
    // run a build that can open it.
    expect(
      isDeadRecentError(
        overIpc(
          new WorkspaceFailure({
            error: "ProjectSchemaTooNew",
            found: 2,
            supported: 1,
          }),
        ),
      ),
    ).toBe(false);
  });

  it("keeps the entry for transient/unknown errors", () => {
    expect(isDeadRecentError("io: disk on fire")).toBe(false);
    expect(isDeadRecentError(new Error("EBUSY"))).toBe(false);
  });
});
