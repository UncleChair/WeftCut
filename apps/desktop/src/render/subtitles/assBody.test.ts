import { describe, expect, test } from "vitest";
import { srtToAss, subtitlesViewToAssBody } from "./assBody";
import type { SubtitlesView } from "../../ipc";

describe("srtToAss", () => {
  test("emits a header + one Dialogue line for a single cue", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,500
Hello world
`;
    const ass = srtToAss(srt);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello world");
  });

  test("emits one Dialogue per cue and preserves order", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
A

2
00:00:03,000 --> 00:00:04,000
B
`;
    const ass = srtToAss(srt);
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain("A");
    expect(dialogues[1]).toContain("B");
  });

  test("merges multi-line cue text with \\N", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
Line 1
Line 2
`;
    const ass = srtToAss(srt);
    expect(ass).toContain("Line 1\\NLine 2");
  });

  test("accepts CRLF line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nText\r\n\r\n";
    const ass = srtToAss(srt);
    expect(ass).toContain("Dialogue:");
    expect(ass).toContain("Text");
  });

  test("accepts dot-as-decimal in timestamps (some SRT writers emit this)", () => {
    const srt = `1
00:00:01.500 --> 00:00:02.750
Hello
`;
    const ass = srtToAss(srt);
    expect(ass).toContain("0:00:01.50,0:00:02.75");
  });

  test("returns header only when there are no cues", () => {
    const ass = srtToAss("");
    expect(ass).toContain("[Events]");
    expect(ass).not.toContain("Dialogue:");
  });
});

describe("subtitlesViewToAssBody", () => {
  test("InlineAss source returns the body verbatim", () => {
    const view: SubtitlesView = {
      source_kind: "InlineAss",
      source_value: "[Script Info]\nfake ass body",
    };
    expect(subtitlesViewToAssBody(view)).toBe("[Script Info]\nfake ass body");
  });

  test("InlineSrt source converts via srtToAss", () => {
    const view: SubtitlesView = {
      source_kind: "InlineSrt",
      source_value: "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    };
    const out = subtitlesViewToAssBody(view);
    expect(out).not.toBeNull();
    expect(out).toContain("[Events]");
    expect(out).toContain("Hi");
  });

  test("Media source returns null (file-backed subtitles deferred)", () => {
    const view: SubtitlesView = {
      source_kind: "Media",
      source_value: "media-id-123",
    };
    expect(subtitlesViewToAssBody(view)).toBeNull();
  });
});
