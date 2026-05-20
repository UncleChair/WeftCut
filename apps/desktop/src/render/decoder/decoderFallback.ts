// Decision logic for `VideoDecoder` error recovery. Pure-function core
// extracted so it can be tested without a real `VideoDecoder` instance.
//
// Two failure shapes are handled:
//
//   1. Hardware decode fails before any frame has been emitted. We
//      downgrade once to `prefer-software` per source handle; the
//      caller resets + reconfigures with the software preference.
//
//   2. Chrome reclaims the codec slot after a long idle period. The
//      error message is exact and well-known. We surface it as a
//      LogBus warning and signal the caller to null + lazy-rebuild
//      the decoder.
//
// Anything else is informational — log only.

export type DecodeErrorAction =
  | { kind: "downgrade-to-software" }
  | { kind: "inactivity-rebuild" }
  | { kind: "log-only" };

export interface HandleDecodeErrorArgs {
  err: Error;
  outputFrameCount: number;
  alreadyDowngraded: boolean;
  mediaId: string;
  log: (msg: string) => void;
}

const INACTIVITY_PHRASE = "Codec reclaimed due to inactivity";

export function handleDecodeError(args: HandleDecodeErrorArgs): DecodeErrorAction {
  if (args.err.message.includes(INACTIVITY_PHRASE)) {
    args.log(
      `video decoder recovered from inactivity (source ${args.mediaId})`,
    );
    return { kind: "inactivity-rebuild" };
  }

  if (!args.alreadyDowngraded && args.outputFrameCount === 0) {
    return { kind: "downgrade-to-software" };
  }

  return { kind: "log-only" };
}
