// Phase B2 — WebGL2 multi-layer compositor.
//
// Replaces B1's `drawImage(VideoFrame)` with a textured-quad pipeline
// that can stack arbitrary `TexImageSource` layers (decoded VideoFrames
// from B1's decoder + rasterized template PNGs that the IR emitter
// will hand us in B3). Each layer carries its own transform, opacity,
// and blend mode.
//
// Coordinate space:
//   - Canvas-normalized [0, 1]: x=0 is left, y=0 is top.
//   - `transform.{x,y}` is the top-left corner of the layer.
//   - `transform.{width,height}` is the layer's size as a fraction of
//     the canvas (so width=1 fills horizontally).
// This matches WeftCut's IR convention for raster placement.

export type BlendMode = "normal" | "add";

export interface LayerTransform {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositorLayer {
  /// Texture source. Caller retains ownership; the compositor uploads
  /// to a GL texture for the draw, then drops the texture. For
  /// VideoFrame, the caller MUST `.close()` after rendering (or after
  /// the source is replaced); for ImageBitmap, dispose with `.close()`
  /// when no longer needed.
  source: TexImageSource;
  transform: LayerTransform;
  /// [0..1]; values outside the range are clamped.
  opacity: number;
  blendMode: BlendMode;
}

const VS_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
uniform mat3 u_mvp;
out vec2 v_texCoord;
void main() {
  vec3 pos = u_mvp * vec3(a_position, 1.0);
  // [0,1] canvas-normalized -> [-1,1] clip-space, Y-flipped so y=0 is
  // at the top of the canvas (matches the IR / DOM convention).
  gl_Position = vec4(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

// Fragment shader outputs PRE-MULTIPLIED alpha; the GL blend func
// below pairs with that (`ONE, ONE_MINUS_SRC_ALPHA` for normal). This
// is the right convention for compositing over a black backdrop and
// matches WebGL's standard "Porter-Duff over" model.
const FS_SOURCE = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_texture, v_texCoord);
  float a = c.a * u_opacity;
  fragColor = vec4(c.rgb * a, a);
}
`;

export class WebGL2Compositor {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uMVP: WebGLUniformLocation;
  private readonly uOpacity: WebGLUniformLocation;
  private readonly uTexture: WebGLUniformLocation;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error("WebGL2 not supported in this WebView");
    }
    this.gl = gl;

    const program = linkProgram(gl, VS_SOURCE, FS_SOURCE);
    this.program = program;

    const uMVP = gl.getUniformLocation(program, "u_mvp");
    const uOpacity = gl.getUniformLocation(program, "u_opacity");
    const uTexture = gl.getUniformLocation(program, "u_texture");
    if (!uMVP || !uOpacity || !uTexture) {
      throw new Error("compositor: missing uniform locations");
    }
    this.uMVP = uMVP;
    this.uOpacity = uOpacity;
    this.uTexture = uTexture;

    // Unit quad as a 4-vertex triangle strip in [0,1]^2.
    const positions = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const texCoords = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("compositor: createVertexArray failed");
    this.vao = vao;
    gl.bindVertexArray(vao);

    const aPos = gl.getAttribLocation(program, "a_position");
    const aTC = gl.getAttribLocation(program, "a_texCoord");
    if (aPos < 0 || aTC < 0) {
      throw new Error("compositor: missing attribute locations");
    }

    const posBuf = gl.createBuffer();
    if (!posBuf) throw new Error("compositor: createBuffer failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tcBuf = gl.createBuffer();
    if (!tcBuf) throw new Error("compositor: createBuffer failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, tcBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aTC);
    gl.vertexAttribPointer(aTC, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // ImageBitmap and HTMLCanvas have origin at top-left in their
    // own space, but WebGL textures sample y from the bottom by
    // default. Setting UNPACK_FLIP_Y_WEBGL flips uploads so the
    // shader's v_texCoord = (0,0) is the top-left of the source.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  }

  /// Resize the backing canvas + GL viewport. Called by `render()`
  /// based on the first layer's intended canvas size; callers can
  /// also drive this directly.
  setSize(width: number, height: number): void {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  /// Render the given layers in order (layer[0] = back, last = front).
  /// Uploads each layer's source as a fresh GL texture, draws, then
  /// drops the texture. No texture caching in B2; B3 / B4 can add a
  /// Map<source, WebGLTexture> when the recipe makes reuse common.
  render(layers: ReadonlyArray<CompositorLayer>): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);

    for (const layer of layers) {
      const tex = gl.createTexture();
      if (!tex) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          layer.source,
        );
      } catch {
        // Source can be invalid (closed VideoFrame, broken ImageBitmap);
        // skip that layer rather than tearing the whole frame.
        gl.deleteTexture(tex);
        continue;
      }

      gl.uniform1i(this.uTexture, 0);
      gl.uniform1f(this.uOpacity, clamp01(layer.opacity));
      gl.uniformMatrix3fv(this.uMVP, false, makeMVP(layer.transform));

      switch (layer.blendMode) {
        case "add":
          // Additive: ignores destination alpha. Source is already
          // pre-multiplied in the shader.
          gl.blendFunc(gl.ONE, gl.ONE);
          break;
        case "normal":
        default:
          // Porter-Duff "over" with pre-multiplied source.
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          break;
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.deleteTexture(tex);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("compositor: createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  const ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
  if (!ok) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`compositor: program link failed: ${log ?? "(no log)"}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("compositor: createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
  if (!ok) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`compositor: shader compile failed: ${log ?? "(no log)"}`);
  }
  return shader;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/// Column-major 3x3 matrix:
///   [ w  0  x ]
///   [ 0  h  y ]
///   [ 0  0  1 ]
/// Stored in WebGL column-major order. Multiplies the unit quad
/// position to land at (x, y) with size (w, h) in canvas-normalized
/// [0, 1] space.
function makeMVP(t: LayerTransform): Float32Array {
  return new Float32Array([
    t.width, 0, 0,
    0, t.height, 0,
    t.x, t.y, 1,
  ]);
}
