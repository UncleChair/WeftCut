// VideoEncoder + mp4box.js mux of the encoded chunks into a temp
// video.mp4 buffer.
//
// Plan: docs/pixi-renderer-plan.md (P8)
//
// P0 stub.

export interface EncoderInit {
  config: VideoEncoderConfig;
  width: number;
  height: number;
  fps: number;
}

export class EncoderSink {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_init: EncoderInit) {
    // P8: new VideoEncoder({ output: (chunk, meta) => mp4mux.addSample(...), error })
    // P8: mp4box.Muxer init with width/height/fps.
  }

  async encodeFrame(_frame: VideoFrame, _ptsUs: number, _keyFrame: boolean): Promise<void> {
    // P8: backpressure on encodeQueueSize; encode(frame, { keyFrame })
  }

  async finalize(): Promise<ArrayBuffer> {
    // P8: encoder.flush(); mp4mux.finalize()
    throw new Error("EncoderSink.finalize: not yet implemented (P8)");
  }

  dispose(): void {
    // P8: encoder.close()
  }
}
