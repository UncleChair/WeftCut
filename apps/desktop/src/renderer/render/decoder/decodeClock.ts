// Canonical container-PTS ↔ normalized source-time conversion for the
// WebCodecs decode paths. The clock is anchored in the SAME integer-
// microsecond domain that EncodedVideoChunk/VideoFrame use; callers must not
// independently recreate packet PTS from Mediabunny's floating-point seconds.

export interface DecodeClockPacket {
  /// Mediabunny's integer timestamp used by `toEncodedVideoChunk()`.
  readonly microsecondTimestamp: number;
  toEncodedVideoChunk(): EncodedVideoChunk;
}

export interface PreparedDecodePacket {
  readonly chunk: EncodedVideoChunk;
  /// Presentation timestamp normalized so the first visible packet is 0.
  readonly sourcePtsUs: number;
}

export class DecodeClock {
  private constructor(private readonly originUs: number) {}

  static fromOrigin(originUs: number): DecodeClock {
    return new DecodeClock(originUs);
  }

  static fromFirstPacket(
    firstPacket: Pick<DecodeClockPacket, "microsecondTimestamp"> | null,
    fallbackOriginUs = 0,
  ): DecodeClock {
    return new DecodeClock(firstPacket?.microsecondTimestamp ?? fallbackOriginUs);
  }

  /// Container timestamp (µs) → normalized source-content timestamp (µs).
  sourceUs(containerUs: number): number {
    return containerUs - this.originUs;
  }

  /// Normalized source-content timestamp (µs) → container timestamp (µs).
  containerUs(sourceUs: number): number {
    return sourceUs + this.originUs;
  }

  /// Prepare one packet for decode and derive scheduling time from the actual
  /// chunk timestamp, so dispatch and decoder output cannot use different
  /// rounding rules for the same packet.
  prepare(packet: DecodeClockPacket): PreparedDecodePacket {
    const chunk = packet.toEncodedVideoChunk();
    return { chunk, sourcePtsUs: this.sourceUs(chunk.timestamp) };
  }
}
