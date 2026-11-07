// Prism shaders adapted from TankFactory/Mirage_Decode (MIT). See THIRD_PARTY_NOTICES.md.
import { TankOptions } from "./tank-decode";

const vertex = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const scaleFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform vec2 thresholds;
uniform int fillMethod;
uniform int mode;
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 mask;
void main() {
  vec4 source = texture(image, uv);
  mask = vec4(0.0);
  if (mode != 0) {
    color = vec4(source.rgb * source.a + vec3(mode == 2 ? 1.0 : 0.0) * (1.0 - source.a), 1.0);
    return;
  }
  float l = dot(source.rgb, vec3(0.299, 0.587, 0.114));
  if (l >= thresholds.x && l <= thresholds.y) {
    color = vec4(clamp((source.rgb - thresholds.x) / (thresholds.y - thresholds.x), 0.0, 1.0), source.a);
  } else {
    mask = vec4(1.0, 0.0, 0.0, 1.0);
    color = fillMethod == 2 ? vec4(0.0) : vec4(vec3(fillMethod == 1 ? 1.0 : 0.0), 1.0);
  }
}`;
const fillFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform sampler2D holes;
uniform vec2 texel;
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 mask;
void main() {
  color = texture(image, uv);
  mask = texture(holes, uv);
  if (mask.r < 0.5) return;
  vec2 offsets[24] = vec2[](
    vec2(-1,0),vec2(1,0),vec2(0,-1),vec2(0,1),
    vec2(-1,-1),vec2(1,1),vec2(-1,1),vec2(1,-1),
    vec2(-2,0),vec2(2,0),vec2(0,-2),vec2(0,2),
    vec2(-2,-2),vec2(2,2),vec2(-2,2),vec2(2,-2),
    vec2(-1,-2),vec2(1,2),vec2(-2,-1),vec2(2,1),
    vec2(-1,2),vec2(1,-2),vec2(-2,1),vec2(2,-1));
  float weights[24] = float[](
    0.6065,0.6065,0.6065,0.6065,0.3679,0.3679,0.3679,0.3679,
    0.1353,0.1353,0.1353,0.1353,0.0183,0.0183,0.0183,0.0183,
    0.0821,0.0821,0.0821,0.0821,0.0821,0.0821,0.0821,0.0821);
  vec4 sum = vec4(0.0);
  float weight = 0.0;
  for (int i = 0; i < 24; i++) {
    vec2 point = uv + offsets[i] * texel;
    if (texture(holes, point).r < 0.5) {
      sum += texture(image, point) * weights[i];
      weight += weights[i];
    }
  }
  if (weight > 0.0) { color = sum / weight; mask = vec4(0.0); }
}`;
const displayFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform float contrast;
uniform bool flipY;
layout(location = 0) out vec4 color;
void main() {
  vec4 source = texture(image, vec2(uv.x, flipY ? 1.0 - uv.y : uv.y));
  float factor = 259.0 * (contrast + 255.0) / (255.0 * (259.0 - contrast));
  color = vec4(clamp((factor * (source.rgb * 255.0 - 128.0) + 128.0) / 255.0, 0.0, 1.0), source.a);
}`;

export class TankGPU {
  private gl: WebGL2RenderingContext;
  private scale: WebGLProgram;
  private fill: WebGLProgram;
  private display: WebGLProgram;
  private canvas: OffscreenCanvas;
  private textures: WebGLTexture[] = [];
  private framebuffer: WebGLFramebuffer;
  private decoded: WebGLTexture | null = null;
  private decodedKey = "";

  constructor(private width: number, private height: number, pixels: Uint8ClampedArray) {
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl || width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.canvas = canvas;
    this.scale = this.program(scaleFragment);
    this.fill = this.program(fillFragment);
    this.display = this.program(displayFragment);
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, width, height);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let i = 0; i < 5; i++) {
      const texture = gl.createTexture()!;
      this.textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const mask = i >= 3;
      gl.texImage2D(gl.TEXTURE_2D, 0, mask ? gl.R8 : gl.RGBA8, width, height, 0, mask ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, i === 0 ? pixels : null);
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error("GPU allocation failed");
  }

  private program(fragment: string) {
    const gl = this.gl;
    const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
      const shader = gl.createShader(type as number)!;
      gl.shaderSource(shader, source as string);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
      return shader;
    });
    const program = gl.createProgram()!;
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Shader linking failed");
    return program;
  }

  private decodeBase(options: TankOptions) {
    const key = JSON.stringify([options.mode, options.lower, options.upper, options.fill, options.iterations]);
    if (key === this.decodedKey && this.decoded) return this.decoded;
    const gl = this.gl;
    const bind = (texture: WebGLTexture, unit: number) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    };
    const target = (color: WebGLTexture, mask: WebGLTexture) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, mask, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("GPU framebuffer unavailable");
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    let [, source, destination, sourceMask, destinationMask] = this.textures;
    target(source, sourceMask);
    bind(this.textures[0], 0);
    gl.useProgram(this.scale);
    gl.uniform1i(gl.getUniformLocation(this.scale, "image"), 0);
    gl.uniform2f(gl.getUniformLocation(this.scale, "thresholds"), options.lower / 255, options.upper / 255);
    gl.uniform1i(gl.getUniformLocation(this.scale, "fillMethod"), options.fill === "black" ? 0 : options.fill === "white" ? 1 : 2);
    gl.uniform1i(gl.getUniformLocation(this.scale, "mode"), options.mode === "prism" ? 0 : options.mode === "black" ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (options.mode === "prism" && options.fill === "ltavg") {
      gl.useProgram(this.fill);
      gl.uniform1i(gl.getUniformLocation(this.fill, "image"), 0);
      gl.uniform1i(gl.getUniformLocation(this.fill, "holes"), 1);
      gl.uniform2f(gl.getUniformLocation(this.fill, "texel"), 1 / this.width, 1 / this.height);
      for (let i = 0; i < options.iterations; i++) {
        target(destination, destinationMask);
        bind(source, 0); bind(sourceMask, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [source, destination] = [destination, source];
        [sourceMask, destinationMask] = [destinationMask, sourceMask];
      }
    }
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("GPU decode failed");
    this.decoded = source;
    this.decodedKey = key;
    return source;
  }

  private draw(options: TankOptions, width: number, height: number, flipY: boolean) {
    const gl = this.gl;
    const source = this.decodeBase(options);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.useProgram(this.display);
    gl.uniform1i(gl.getUniformLocation(this.display, "image"), 0);
    gl.uniform1f(gl.getUniformLocation(this.display, "contrast"), options.contrast);
    gl.uniform1i(gl.getUniformLocation(this.display, "flipY"), flipY ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("GPU display failed");
  }

  preview(options: TankOptions, maxEdge: number) {
    const scale = Math.min(1, maxEdge / Math.max(this.width, this.height));
    // Resize only already-revealed pixels; resizing encoded originals destroys their levels.
    this.draw(options, Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale)), true);
    return this.canvas.transferToImageBitmap();
  }

  decode(options: TankOptions) {
    this.draw(options, this.width, this.height, false);
    const gl = this.gl;
    const output = new Uint8ClampedArray(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, output);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error("GPU export failed");
    return output;
  }
}
