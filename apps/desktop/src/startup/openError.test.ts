import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import {
  NOT_PROJECT_FOLDER_SENTINEL,
  PROJECT_FOLDER_MISSING_SENTINEL,
  describeOpenError,
  isDeadRecentError,
} from "./openError";

// Records which i18n key was chosen — the component only cares about key
// selection; actual copy lives in the locale files.
const t = ((key: string) => key) as unknown as TFunction;

describe("describeOpenError", () => {
  it("maps the missing-folder sentinel to the folder-missing message", () => {
    expect(
      describeOpenError(PROJECT_FOLDER_MISSING_SENTINEL, "C:\\proj\\a", t),
    ).toBe("startup.project_folder_missing");
  });

  it("maps the not-a-project sentinel to the not-a-project message", () => {
    expect(
      describeOpenError(NOT_PROJECT_FOLDER_SENTINEL, "C:\\proj\\a", t),
    ).toBe("startup.not_project_folder");
  });

  it("falls back to the generic open-failed message for other errors", () => {
    expect(describeOpenError("io: disk on fire", "C:\\proj\\a", t)).toBe(
      "startup.recent_open_failed",
    );
  });
});

describe("isDeadRecentError", () => {
  it("is true for both dead-entry sentinels", () => {
    expect(isDeadRecentError(PROJECT_FOLDER_MISSING_SENTINEL)).toBe(true);
    expect(isDeadRecentError(NOT_PROJECT_FOLDER_SENTINEL)).toBe(true);
  });

  it("is false for transient/unknown errors", () => {
    expect(isDeadRecentError("io: disk on fire")).toBe(false);
    expect(isDeadRecentError(new Error("EBUSY"))).toBe(false);
  });
});
