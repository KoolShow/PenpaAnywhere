import { mat3ToColumnMajorFloat32, type Mat3 } from './homography';

export type BlendRenderMode =
  | 'multiply'
  | 'multiply-inv'
  | 'alpha-luma'
  | 'alpha-luma-inv'
  | 'alpha-minrgb'
  | 'alpha-minrgb-inv';

const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform mat3 u_invH;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform int u_mode;
uniform float u_opacity;
uniform float u_whiteThreshold;
uniform vec4 u_clipRect;
uniform float u_outsideOpacity;

out vec4 outColor;

// Bi-cone HSL lightness inversion: preserves Hue (H) and HSL Saturation (S), maps L -> 1 - L.
// Because chroma C = (1 - |2L - 1|) * S is symmetric around L = 0.5, C is invariant and
// every RGB channel shifts equally by (1 - 2L) = 1 - (maxRGB + minRGB).
vec3 invertLightnessBiconeHSL(vec3 rgb) {
  float cMax = max(rgb.r, max(rgb.g, rgb.b));
  float cMin = min(rgb.r, min(rgb.g, rgb.b));
  float L = 0.5 * (cMax + cMin);
  return clamp(rgb + vec3(1.0 - 2.0 * L), 0.0, 1.0);
}

void main() {
  vec2 screenCss = vec2(
    gl_FragCoord.x / u_dpr,
    (u_resolution.y - gl_FragCoord.y) / u_dpr
  );

  vec3 proj = u_invH * vec3(screenCss, 1.0);
  if (abs(proj.z) < 1e-6) {
    discard;
  }

  vec2 uv = proj.xy / proj.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    discard;
  }
  bool outsideClip = uv.x < u_clipRect.x || uv.x > u_clipRect.z || uv.y < u_clipRect.y || uv.y > u_clipRect.w;
  if (outsideClip && u_outsideOpacity <= 0.001) {
    discard;
  }
  float effOpacity = outsideClip ? u_opacity * u_outsideOpacity : u_opacity;

  vec4 tex = texture(u_tex, uv);
  vec3 rgb = tex.rgb;

  // Mode 0: Multiply (CSS mix-blend-mode: multiply, white -> transparent)
  if (u_mode == 0) {
    vec3 mixed = mix(vec3(1.0), rgb, effOpacity);
    outColor = vec4(mixed, 1.0);
    return;
  }

  // Mode 1: Multiply Inverted (Bi-cone HSL lightness inversion + CSS mix-blend-mode: screen, black -> transparent)
  if (u_mode == 1) {
    vec3 invRgb = invertLightnessBiconeHSL(rgb);
    vec3 mixed = mix(vec3(0.0), invRgb, effOpacity);
    outColor = vec4(mixed, 1.0);
    return;
  }

  // Mode 2: Alpha = 1 - luminance (white background becomes fully transparent)
  if (u_mode == 2) {
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    float rawAlpha = clamp((u_whiteThreshold - luma) / max(u_whiteThreshold, 0.01), 0.0, 1.0);
    float a = rawAlpha * effOpacity;
    if (a < 0.004) discard;
    vec3 fg = clamp((rgb - vec3(1.0 - rawAlpha)) / max(rawAlpha, 0.001), 0.0, 1.0);
    outColor = vec4(fg * a, a);
    return;
  }

  // Mode 3: Alpha = 1 - luminance (Inverted via Bi-cone HSL: white->black transparent, dark marks->bright)
  if (u_mode == 3) {
    vec3 invRgb = invertLightnessBiconeHSL(rgb);
    float lumaInv = dot(invRgb, vec3(0.299, 0.587, 0.114));
    float blackFloor = 1.0 - u_whiteThreshold;
    float rawAlpha = clamp((lumaInv - blackFloor) / max(1.0 - blackFloor, 0.01), 0.0, 1.0);
    float a = rawAlpha * effOpacity;
    if (a < 0.004) discard;
    vec3 fg = clamp(invRgb / max(rawAlpha, 0.001), 0.0, 1.0);
    outColor = vec4(fg * a, a);
    return;
  }

  // Mode 4: Color-to-Alpha (alpha = 1 - min(r,g,b), white transparent, full color saturation)
  if (u_mode == 4) {
    float minC = min(rgb.r, min(rgb.g, rgb.b));
    float rawAlpha = clamp((u_whiteThreshold - minC) / max(u_whiteThreshold, 0.01), 0.0, 1.0);
    float a = rawAlpha * effOpacity;
    if (a < 0.004) discard;
    vec3 fg = clamp(1.0 - (1.0 - rgb) / max(rawAlpha, 0.001), 0.0, 1.0);
    outColor = vec4(fg * a, a);
    return;
  }

  // Mode 5: Color-to-Alpha Inverted (Bi-cone HSL inversion + alpha = max(invRgb), black transparent, full color saturation)
  vec3 invRgb = invertLightnessBiconeHSL(rgb);
  float maxC = max(invRgb.r, max(invRgb.g, invRgb.b));
  float blackFloor = 1.0 - u_whiteThreshold;
  float rawAlpha = clamp((maxC - blackFloor) / max(1.0 - blackFloor, 0.01), 0.0, 1.0);
  float a = rawAlpha * effOpacity;
  if (a < 0.004) discard;
  vec3 fg = clamp(invRgb / max(rawAlpha, 0.001), 0.0, 1.0);
  outColor = vec4(fg * a, a);
}
`;

const MODE_TO_INT: Record<BlendRenderMode, number> = {
  multiply: 0,
  'multiply-inv': 1,
  'alpha-luma': 2,
  'alpha-luma-inv': 3,
  'alpha-minrgb': 4,
  'alpha-minrgb-inv': 5,
};

export class WebGLPerspectiveRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject | null;
  private texture: WebGLTexture;
  private uTex: WebGLUniformLocation | null;
  private uInvH: WebGLUniformLocation | null;
  private uResolution: WebGLUniformLocation | null;
  private uDpr: WebGLUniformLocation | null;
  private uMode: WebGLUniformLocation | null;
  private uOpacity: WebGLUniformLocation | null;
  private uWhiteThreshold: WebGLUniformLocation | null;
  private uClipRect: WebGLUniformLocation | null;
  private uOutsideOpacity: WebGLUniformLocation | null;
  private lastUploadedVersion = -1;
  private hasTexture = false;
  private viewportW = 0;
  private viewportH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('WebGL2 is not supported in this browser/WebView.');
    }
    this.gl = gl;
    this.program = this.createProgram(VERT_SRC, FRAG_SRC);
    this.vao = gl.createVertexArray();
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create WebGL texture');
    this.texture = tex;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.uTex = gl.getUniformLocation(this.program, 'u_tex');
    this.uInvH = gl.getUniformLocation(this.program, 'u_invH');
    this.uResolution = gl.getUniformLocation(this.program, 'u_resolution');
    this.uDpr = gl.getUniformLocation(this.program, 'u_dpr');
    this.uMode = gl.getUniformLocation(this.program, 'u_mode');
    this.uOpacity = gl.getUniformLocation(this.program, 'u_opacity');
    this.uWhiteThreshold = gl.getUniformLocation(this.program, 'u_whiteThreshold');
    this.uClipRect = gl.getUniformLocation(this.program, 'u_clipRect');
    this.uOutsideOpacity = gl.getUniformLocation(this.program, 'u_outsideOpacity');
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile error: ${info}`);
    }
    return shader;
  }

  private createProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const vShader = this.compileShader(gl.VERTEX_SHADER, vs);
    const fShader = this.compileShader(gl.FRAGMENT_SHADER, fs);
    const prog = gl.createProgram();
    if (!prog) throw new Error('Failed to create WebGL program');
    gl.attachShader(prog, vShader);
    gl.attachShader(prog, fShader);
    gl.linkProgram(prog);
    gl.deleteShader(vShader);
    gl.deleteShader(fShader);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link error: ${info}`);
    }
    return prog;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth < 1 || cssHeight < 1) {
      return false;
    }
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    let changed = false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      changed = true;
    }
    if (changed || this.viewportW !== w || this.viewportH !== h) {
      this.gl.viewport(0, 0, w, h);
      this.viewportW = w;
      this.viewportH = h;
      changed = true;
    }
    return changed;
  }

  uploadSourceIfNeeded(sourceCanvas: HTMLCanvasElement, version: number): boolean {
    if (sourceCanvas.width <= 0 || sourceCanvas.height <= 0) return false;
    if (this.hasTexture && version === this.lastUploadedVersion) return false;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    this.lastUploadedVersion = version;
    this.hasTexture = true;
    return true;
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  render(
    invH: Mat3,
    dpr: number,
    mode: BlendRenderMode,
    opacity: number,
    whiteThreshold = 0.99,
    clipRect: [number, number, number, number] = [0, 0, 1, 1],
    outsideOpacity = 0.0,
  ) {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasTexture) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uTex, 0);
    gl.uniformMatrix3fv(this.uInvH, false, mat3ToColumnMajorFloat32(invH));
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uDpr, dpr);
    gl.uniform1i(this.uMode, MODE_TO_INT[mode]);
    gl.uniform1f(this.uOpacity, opacity);
    gl.uniform1f(this.uWhiteThreshold, whiteThreshold);
    gl.uniform4f(this.uClipRect, clipRect[0], clipRect[1], clipRect[2], clipRect[3]);
    gl.uniform1f(this.uOutsideOpacity, outsideOpacity);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
