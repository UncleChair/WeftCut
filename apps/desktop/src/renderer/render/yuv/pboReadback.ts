// Double-buffered async GPU readback for the pack passes: readPixels lands in
// a PIXEL_PACK_BUFFER (GPU-side DMA, non-blocking) behind a fence; retrieve()
// waits for the fence — normally already signaled a frame later — then copies
// the PBO into a frame-owned buffer via getBufferSubData. A sync readPixels
// here would stall the worker on GPU completion every frame. Shared by
// PackYuvPlanar and PackYuv420p10 so both packers' readback behavior stays
// aligned.

export interface PboPlane {
  /// readPixels dimensions in texels (RGBA8 → w*4 bytes per GPU row).
  w: number;
  h: number;
  /// VALID bytes per output row. When < w*4 the GPU row is padded and the
  /// copy-out trims each row (PackYuvPlanar's W % samplesPerTexel != 0 case).
  dstRowBytes: number;
  /// Copy rows bottom-up into the output (PackYuv420p10's PACK_ROW_FLIP).
  flipRows?: boolean;
}

interface Slot {
  pbo: WebGLBuffer;
  /// Set while a readback is in flight; null = slot free.
  fence: WebGLSync | null;
}

/// At most this many frames may be submitted without a retrieve. Two is
/// exactly the worker's pipeline depth (frame i submitted, frame i-1
/// retrieved); a deeper ring would just hold more GPU memory hostage.
const SLOTS = 2;

export class PboFrameReader {
  private slots: Slot[] = [];
  /// Slot indices with an in-flight readback, oldest first.
  private queue: number[] = [];
  private scratch: Uint8Array | null = null;
  private readonly pboBytes: number;
  private readonly frameBytes: number;
  /// Byte offsets accumulated in plane order: where readPixels writes in the
  /// PBO (padded rows) vs. where the plane lands in the output (valid rows).
  private readonly pboOffsets: number[] = [];
  private readonly dstOffsets: number[] = [];

  constructor(
    private gl: WebGL2RenderingContext,
    private planes: PboPlane[],
  ) {
    let pbo = 0;
    let dst = 0;
    for (const p of planes) {
      this.pboOffsets.push(pbo);
      this.dstOffsets.push(dst);
      pbo += p.w * 4 * p.h;
      dst += p.dstRowBytes * p.h;
    }
    this.pboBytes = pbo;
    this.frameBytes = dst;
  }

  get pending(): number {
    return this.queue.length;
  }

  /// Queue one frame's readback: for each plane, `bindPlane(i)` must bind that
  /// plane's framebuffer (the pack pass RT), then readPixels streams it into
  /// the slot's PBO. Ends with fenceSync + flush — WITHOUT the flush the fence
  /// may never signal (the driver has no reason to submit the commands).
  submit(bindPlane: (index: number) => void): void {
    const gl = this.gl;
    if (this.queue.length >= SLOTS) {
      throw new Error("PboFrameReader: all readback slots in flight — retrieve() first");
    }
    let idx = this.slots.findIndex((s) => s.fence === null);
    if (idx === -1) {
      const pbo = gl.createBuffer();
      if (!pbo) throw new Error("PboFrameReader: createBuffer failed");
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pboBytes, gl.STREAM_READ);
      idx = this.slots.push({ pbo, fence: null }) - 1;
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.slots[idx]!.pbo);
    }
    const slot = this.slots[idx]!;
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i]!;
      bindPlane(i);
      gl.readPixels(0, 0, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, this.pboOffsets[i]!);
    }
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (!fence) throw new Error("PboFrameReader: fenceSync failed");
    gl.flush();
    slot.fence = fence;
    this.queue.push(idx);
  }

  /// Resolve the OLDEST submitted frame into a fresh, exactly-sized buffer —
  /// frame-owned, so the caller can transfer it (postChunk) without a copy.
  async retrieve(): Promise<Uint8Array> {
    const gl = this.gl;
    const idx = this.queue.shift();
    if (idx === undefined) throw new Error("PboFrameReader: retrieve() with nothing submitted");
    const slot = this.slots[idx]!;
    await this.awaitFence(slot.fence!);
    gl.deleteSync(slot.fence!);
    slot.fence = null;

    const out = new Uint8Array(this.frameBytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i]!;
      const gpuRow = p.w * 4;
      const dstOff = this.dstOffsets[i]!;
      if (!p.flipRows && p.dstRowBytes === gpuRow) {
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, this.pboOffsets[i]!, out, dstOff, gpuRow * p.h);
        continue;
      }
      // Padded or flipped plane: land the GPU rows in scratch, then place each
      // row's valid bytes individually.
      const need = gpuRow * p.h;
      if (!this.scratch || this.scratch.length < need) this.scratch = new Uint8Array(need);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, this.pboOffsets[i]!, this.scratch, 0, need);
      for (let r = 0; r < p.h; r++) {
        const dstRow = p.flipRows ? p.h - 1 - r : r;
        out.set(
          this.scratch.subarray(r * gpuRow, r * gpuRow + p.dstRowBytes),
          dstOff + dstRow * p.dstRowBytes,
        );
      }
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return out;
  }

  /// Poll clientWaitSync (WebGL2 caps the blocking timeout at 0) yielding to
  /// the event loop between polls. By the time the worker retrieves a frame
  /// the fence has had a full frame of composite+pack behind it, so the fast
  /// path is zero iterations.
  private async awaitFence(fence: WebGLSync): Promise<void> {
    const gl = this.gl;
    for (;;) {
      const res = gl.clientWaitSync(fence, 0, 0);
      if (res === gl.ALREADY_SIGNALED || res === gl.CONDITION_SATISFIED) return;
      if (res === gl.WAIT_FAILED || gl.isContextLost()) {
        throw new Error("PboFrameReader: GPU fence wait failed (context lost?)");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.fence) gl.deleteSync(s.fence);
      gl.deleteBuffer(s.pbo);
    }
    this.slots = [];
    this.queue = [];
    this.scratch = null;
  }
}
