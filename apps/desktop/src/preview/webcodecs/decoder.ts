// Phase B1 — WebCodecs decoder substrate.
//
// Single-clip H.264 / HEVC / VP9 / AV1 demux + decode, emitting decoded
// `VideoFrame`s through callbacks. This is the substrate B2's WebGL2
// compositor and B3's IR recipe consumer build on; for B1 itself we
// drive it directly from `RealtimePreview.tsx` to prove the substrate
// works on the user's WebView2.
//
// The decoder produces frames eagerly — every sample it pulls out of
// the MP4 is pushed into `VideoDecoder.decode()`, and the WebCodecs
// runtime invokes our `output` callback as frames are produced.
// Backpressure is handled by the consumer: it MUST close every
// `VideoFrame` it receives, or the decoder's internal frame pool will
// stall after ~32–64 frames.

import MP4Box, {
  type DataStream as DataStreamCtor,
  type MP4ArrayBuffer,
  type MP4BoxBox,
  type MP4File,
  type MP4Info,
  type MP4VideoTrack,
} from "mp4box";

export interface DecodedFrameInfo {
  /// The VideoFrame to display. Caller MUST call `.close()` when done.
  frame: VideoFrame;
  /// Presentation timestamp in microseconds (already converted from
  /// the source's native timescale).
  timestampUs: number;
}

export interface ClipInfo {
  /// Full ISO BMFF codec string from the MP4, e.g. "avc1.640028".
  codec: string;
  width: number;
  height: number;
  durationUs: number;
}

export interface DecoderEvents {
  /// Fires once after the demuxer has parsed the moov box and the
  /// decoder has been configured. Before this, no frames will arrive.
  onReady?: (info: ClipInfo) => void;
  /// Fires per decoded frame. The caller MUST close the VideoFrame
  /// (or the decoder pool stalls).
  onFrame?: (frame: DecodedFrameInfo) => void;
  /// Fires on demuxer / decoder error. `open()` rejects on early errors
  /// (no moov, unsupported codec); runtime decode errors come through
  /// here.
  onError?: (err: string) => void;
}

export class Mp4Decoder {
  private readonly events: DecoderEvents;
  private mp4box: MP4File | null = null;
  private decoder: VideoDecoder | null = null;
  private closed = false;

  constructor(events: DecoderEvents) {
    this.events = events;
  }

  /// Fetch the file at `url`, demux it, configure a VideoDecoder, and
  /// kick off sample extraction. Resolves once the decoder is
  /// configured; frames start arriving via `onFrame` afterwards.
  async open(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const raw = await res.arrayBuffer();

    return new Promise<void>((resolve, reject) => {
      const mp4 = MP4Box.createFile();
      this.mp4box = mp4;

      let settled = false;
      const fail = (msg: string) => {
        if (settled) {
          this.events.onError?.(msg);
          return;
        }
        settled = true;
        reject(new Error(msg));
      };

      mp4.onError = (msg) => fail(`mp4box: ${msg}`);

      mp4.onReady = (info: MP4Info) => {
        const track = info.videoTracks[0];
        if (!track) {
          fail("no video track in file");
          return;
        }
        const codec = track.codec;
        const width = track.video?.width ?? track.track_width;
        const height = track.video?.height ?? track.track_height;
        const durationUs = info.timescale > 0
          ? (info.duration / info.timescale) * 1_000_000
          : 0;

        const description = extractCodecDescription(mp4, track);
        // VideoDecoder requires a `description` for AVC1/HVC1/VP9/AV1
        // tracks that carry params in the sample-description box; if
        // we can't pull it the configure() call will fail with a
        // cryptic message — surface that up front.
        if (!description) {
          fail(`no codec config box found for ${codec}`);
          return;
        }

        const config: VideoDecoderConfig = {
          codec,
          codedWidth: width,
          codedHeight: height,
          description,
        };

        VideoDecoder.isConfigSupported(config)
          .then((sup) => {
            if (this.closed) {
              if (!settled) {
                settled = true;
                reject(new Error("decoder closed during open"));
              }
              return;
            }
            if (!sup.supported) {
              fail(`VideoDecoder.isConfigSupported(${codec}) = false`);
              return;
            }
            const decoder = new VideoDecoder({
              output: (frame) => {
                if (this.closed) {
                  frame.close();
                  return;
                }
                this.events.onFrame?.({
                  frame,
                  timestampUs: frame.timestamp ?? 0,
                });
              },
              error: (e) => this.events.onError?.(String(e)),
            });
            decoder.configure(config);
            this.decoder = decoder;
            this.events.onReady?.({ codec, width, height, durationUs });

            mp4.onSamples = (_trackId, _user, samples) => {
              const dec = this.decoder;
              if (!dec || this.closed) return;
              for (const sample of samples) {
                const tsUs =
                  sample.timescale > 0
                    ? (sample.cts / sample.timescale) * 1_000_000
                    : 0;
                const durUs =
                  sample.timescale > 0
                    ? (sample.duration / sample.timescale) * 1_000_000
                    : 0;
                try {
                  dec.decode(
                    new EncodedVideoChunk({
                      type: sample.is_sync ? "key" : "delta",
                      timestamp: tsUs,
                      duration: durUs,
                      data: sample.data,
                    }),
                  );
                } catch (e) {
                  this.events.onError?.(`decode: ${String(e)}`);
                  return;
                }
              }
            };

            mp4.setExtractionOptions(track.id, null, { nbSamples: 64 });
            mp4.start();

            settled = true;
            resolve();
          })
          .catch((e) => fail(`isConfigSupported: ${String(e)}`));
      };

      // mp4box wants ArrayBuffer-with-fileStart in monotonically
      // increasing order. We fetch the whole file up front so a single
      // append + flush covers everything.
      const buf = raw as MP4ArrayBuffer;
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== "closed") {
      try {
        await dec.flush();
      } catch {
        // flush rejects when the decoder is reset / closed mid-flight;
        // that's expected on rapid teardown.
      }
      try {
        dec.close();
      } catch {
        // close is idempotent at the spec level but the impl will
        // throw on double-close.
      }
    }
    if (this.mp4box) {
      try {
        this.mp4box.stop();
      } catch {
        // stop is best-effort.
      }
      this.mp4box = null;
    }
  }
}

/// Pull the codec config box (avcC / hvcC / vpcC / av1C) out of the
/// MP4's sample description and re-serialize it into the BufferSource
/// the WebCodecs spec requires for `description`. The first 8 bytes
/// of the serialized box are its ISO BMFF box header (size + type) —
/// VideoDecoder wants the box BODY only, not the wrapper, so we slice
/// past the header.
function extractCodecDescription(
  mp4: MP4File,
  track: MP4VideoTrack,
): Uint8Array | undefined {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box: MP4BoxBox | undefined =
      entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      // MP4Box's DataStream defaults to big-endian when given no args
      // beyond the initial buffer (we pass nothing, so it allocates).
      const DataStream = MP4Box.DataStream as unknown as typeof DataStreamCtor;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      // box.write produces [size:4][type:4][body...] — strip the 8-byte
      // header so we hand the decoder the body alone.
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}
