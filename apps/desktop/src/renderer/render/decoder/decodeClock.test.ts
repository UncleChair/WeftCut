import { describe, expect, it } from "vitest";
import { DecodeClock, type DecodeClockPacket } from "./decodeClock";
import golden from "../../../../fixtures/decode-time-golden.json";

function packet(timestampUs: number): DecodeClockPacket {
  return {
    microsecondTimestamp: timestampUs,
    toEncodedVideoChunk: () => ({ timestamp: timestampUs }) as EncodedVideoChunk,
  };
}

describe("DecodeClock", () => {
  it("normalizes a non-zero origin from the timestamp actually sent to WebCodecs", () => {
    // 2/30 s = 66,666.666… µs. Mediabunny truncates the EncodedVideoChunk
    // timestamp to 66,666; the old independently-rounded origin was 66,667,
    // so the first decoded frame entered the ring at source PTS -1 µs.
    const first = packet(66_666);
    const clock = DecodeClock.fromFirstPacket(first, 999_999);

    const prepared = clock.prepare(first);

    expect(prepared.chunk.timestamp).toBe(66_666);
    expect(prepared.sourcePtsUs).toBe(0);
    expect(clock.sourceUs(prepared.chunk.timestamp)).toBe(0);
    expect(clock.containerUs(0)).toBe(66_666);
  });

  it("matches the shared native/WebCodecs timing vectors", () => {
    for (const vector of golden.vectors) {
      const clock = DecodeClock.fromFirstPacket(packet(vector.originUs));
      for (const sample of vector.samples) {
        const prepared = clock.prepare(packet(sample.containerUs));
        expect(prepared.sourcePtsUs, `${vector.name} ticks=${sample.ticks}`).toBe(sample.sourceUs);
        expect(clock.containerUs(sample.sourceUs), `${vector.name} inverse ticks=${sample.ticks}`).toBe(
          sample.containerUs,
        );
      }
    }
  });
});
