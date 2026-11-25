/**
 * WebGPU 渲染器：FFT 海面 + 船舶/引航艇/软梯 + 灯光与水花。
 * 海面振幅来自 CPU 数值核（已通过 Hs<3% 验收），GPU 逐帧 IFFT。
 * 不支持 WebGPU 时由上层捕获异常并切换 CPU 降级渲染。
 */
import type { Vessel } from '../core/types.ts';
import type { WaveAmplitudeField } from '../core/types.ts';
import { buildShipHull, buildPilotBoat, buildLadder, type MeshData } from './geometry.ts';
import oceanWgsl from './ocean.wgsl?raw';
import solidWgsl from './solid.wgsl?raw';
import { buildLadderGeometry } from '../core/ladder.ts';
import type { FrameMotion } from './motionSampler.ts';
import { perspective, identityMat4, mul, translation, rotationX, rotationZ } from './mat4.ts';

const MAX_LIGHTS = 4;

interface GpuLight {
  pos: [number, number, number, number];
  dirCut: [number, number, number, number];
  colorPower: [number, number, number, number];
}

interface SolidObject {
  buffers: { pos: GPUBuffer; nrm: GPUBuffer; idx: GPUBuffer };
  indexCount: number;
  uniform: GPUBuffer;
  color: [number, number, number];
}

export interface CameraState {
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
}

export class OceanRenderer {
  device!: GPUDevice;
  context!: GPUCanvasContext;
  format!: GPUTextureFormat;
  private n = 512;
  private oceanPipeline!: GPURenderPipeline;
  private solidPipeline!: GPURenderPipeline;
  private phasePipeline!: GPUComputePipeline;
  private rowPipeline!: GPUComputePipeline;
  private colPipeline!: GPUComputePipeline;
  private storePipeline!: GPUComputePipeline;
  private bindGroup!: GPUBindGroup;
  private paramsBuffer!: GPUBuffer;
  private lightBuffer!: GPUBuffer;
  private solidBindGroup!: GPUBindGroup;
  private objects = new Map<string, SolidObject>();
  private meshes: Record<string, MeshData> = {};
  camera: CameraState = { yaw: 0.6, pitch: 0.5, distance: 220, target: [0, 6, 0] };
  nightMode = false;
  private drag: { x: number; y: number } | null = null;
  private field: WaveAmplitudeField | null = null;
  private time = 0;
  private lastFrame = 0;
  private frameMs: number[] = [];
  onPerf?: (avgMs: number) => void;
  private running = false;
  private outHeightBuffer: GPUBuffer | null = null;
  private currentLightCount = 0;
  private depthTexture: GPUTexture | null = null;
  private shelter = {
    heading: 0, waveDir: 0, length: 1, beam: 1, draft: 1, depth: 30, enabled: 0,
  };

  static async isSupported(): Promise<boolean> {
    return typeof navigator !== 'undefined' && !!navigator.gpu && (await navigator.gpu.requestAdapter()) != null;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无可用 GPU 适配器');
    this.device = await adapter.requestDevice();
    this.context = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.createPipelines();
    this.attachControls(canvas);
  }

  private createPipelines(): void {
    const mod = this.device.createShaderModule({ code: oceanWgsl });
    const bindLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // h0/omega 只读，work/out 在 compute 阶段读写；统一用默认 storage（read-write）
        // 以兼容同一 bind group 跨 compute 与 vertex 阶段使用。
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((b) => ({
          binding: b, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: 'storage' as GPUBufferBindingType },
        })),
      ],
    });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    this.phasePipeline = this.device.createComputePipeline({
      layout, compute: { module: mod, entryPoint: 'phaseRotate' },
    });
    this.rowPipeline = this.device.createComputePipeline({
      layout, compute: { module: mod, entryPoint: 'fftRows' },
    });
    this.colPipeline = this.device.createComputePipeline({
      layout, compute: { module: mod, entryPoint: 'fftCols' },
    });
    this.storePipeline = this.device.createComputePipeline({
      layout, compute: { module: mod, entryPoint: 'storeHeight' },
    });
    this.oceanPipeline = this.device.createRenderPipeline({
      layout,
      vertex: { module: mod, entryPoint: 'oceanVertex' },
      fragment: { module: mod, entryPoint: 'oceanFragment', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // 实体
    const solidMod = this.device.createShaderModule({ code: solidWgsl });
    const solidObjLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const lightLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    });
    this.solidPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [solidObjLayout, lightLayout] }),
      vertex: {
        module: solidMod, entryPoint: 'solidVertex',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: solidMod, entryPoint: 'solidFragment', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.lightBuffer = this.device.createBuffer({ size: MAX_LIGHTS * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.solidBindGroup = this.device.createBindGroup({ layout: lightLayout, entries: [{ binding: 0, resource: { buffer: this.lightBuffer } }] });
  }

  /** 上传振幅场（海况变化时调用） */
  setWaveField(field: WaveAmplitudeField): void {
    this.field = field;
    this.n = field.size;
    const n2 = this.n * this.n;
    const f32 = n2 * 4;
    const make = (data: Float64Array | Float32Array): GPUBuffer => {
      const buf = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, Float32Array.from(data));
      return buf;
    };
    const h0Re = make(field.h0.re);
    const h0Im = make(field.h0.im);
    const omega = make(field.omega);
    const workRe = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE });
    const workIm = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE });
    const outH = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const outSX = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE });
    const outSY = this.device.createBuffer({ size: f32, usage: GPUBufferUsage.STORAGE });
    // Params: 9 个 vec4 = 144 字节（见 ocean.wgsl Params）
    this.paramsBuffer = this.device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layout = this.oceanPipeline.getBindGroupLayout(0);
    this.outHeightBuffer = outH;
    this.bindGroup = this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        ...[h0Re, h0Im, omega, workRe, workIm, outH, outSX, outSY].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
      ],
    });
  }

  /** 注册/重建船舶与小艇、软梯几何 */
  setVessel(vessel: Vessel): void {
    this.meshes = {
      ship: buildShipHull(vessel.loa, vessel.beam, vessel.draft, vessel.freeboard),
      boat: buildPilotBoat(),
      ladder: buildLadder(buildLadderGeometry(vessel).length),
    };
    for (const [key, mesh] of Object.entries(this.meshes)) {
      this.addObject(key, mesh, key === 'ship' ? [0.62, 0.66, 0.7] : key === 'boat' ? [0.85, 0.2, 0.12] : [0.9, 0.8, 0.4]);
    }
  }

  private addObject(key: string, mesh: MeshData, color: [number, number, number]): void {
    const pos = this.device.createBuffer({ size: mesh.positions.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const nrm = this.device.createBuffer({ size: mesh.normals.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const idx = this.device.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(pos, 0, mesh.positions);
    this.device.queue.writeBuffer(nrm, 0, mesh.normals);
    this.device.queue.writeBuffer(idx, 0, mesh.indices);
    // SolidParams 176 字节（见 solid.wgsl）
    const uniform = this.device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.objects.set(key, { buffers: { pos, nrm, idx }, indexCount: mesh.indices.length, uniform, color });
  }

  private attachControls(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      this.camera.yaw -= dx * 0.005;
      this.camera.pitch = Math.max(0.08, Math.min(1.45, this.camera.pitch + dy * 0.005));
    });
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance = Math.max(40, Math.min(900, this.camera.distance * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }

  private viewProj(): { vp: Float32Array; camPos: [number, number, number] } {
    const { yaw, pitch, distance, target } = this.camera;
    const cp = Math.cos(pitch);
    const camPos: [number, number, number] = [
      target[0] + distance * cp * Math.sin(yaw),
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * cp * Math.cos(yaw),
    ];
    const vp = perspective(camPos, target);
    return { vp, camPos };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (): void => {
      if (!this.running) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.time += dt;
      this.renderFrame();
      const frameMs = performance.now() - now;
      this.frameMs.push(frameMs);
      if (this.frameMs.length > 60) this.frameMs.shift();
      if (this.onPerf && this.frameMs.length === 60) {
        this.onPerf(this.frameMs.reduce((a, b) => a + b, 0) / 60);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void { this.running = false; }

  setNight(on: boolean): void { this.nightMode = on; }

  /** 配置海面遮蔽（船尺度、航向、来浪向），enabled=0 关闭 */
  setShelter(s: { heading: number; waveDir: number; length: number; beam: number; draft: number; waterDepth: number }, enabled: boolean): void {
    this.shelter = {
      heading: s.heading, waveDir: s.waveDir, length: s.length,
      beam: s.beam, draft: s.draft, depth: s.waterDepth, enabled: enabled ? 1 : 0,
    };
  }

  /**
   每帧渲染。motion 由上层 MotionSampler 提供（大船 heave/roll/pitch、小艇 z）。
   */
  renderFrame(motion?: FrameMotion, lights?: GpuLight[], boatModel?: Float32Array, ladderModel?: Float32Array): void {
    if (!this.field) return;
    const { vp, camPos } = this.viewProj();
    this.writeOceanParams(vp, camPos);

    const encoder = this.device.createCommandEncoder();
    // ---- 计算：相位旋转 → 行 IFFT → 列 IFFT → 存高度
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.phasePipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.n * this.n / 256));
      pass.setPipeline(this.rowPipeline);
      pass.dispatchWorkgroups(this.n);
      pass.setPipeline(this.colPipeline);
      pass.dispatchWorkgroups(this.n);
      pass.setPipeline(this.storePipeline);
      pass.dispatchWorkgroups(Math.ceil(this.n * this.n / 256));
      pass.end();
    }

    const colorTex = this.context.getCurrentTexture();
    // 深度纹理按画布尺寸缓存复用，避免每帧分配/释放造成显存抖动
    if (!this.depthTexture || this.depthTexture.width !== colorTex.width || this.depthTexture.height !== colorTex.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [colorTex.width, colorTex.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorTex.createView(), clearValue: { r: 0.05, g: 0.09, b: 0.14, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });

    // 海面
    pass.setPipeline(this.oceanPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(this.n * this.n);

    // 实体
    pass.setPipeline(this.solidPipeline);
    pass.setBindGroup(1, this.solidBindGroup);
    if (lights) {
      this.currentLightCount = Math.min(MAX_LIGHTS, lights.length);
      this.device.queue.writeBuffer(this.lightBuffer, 0, alignLights(lights));
    } else {
      this.currentLightCount = 0;
    }
    for (const [key, obj] of this.objects) {
      let model = identityMat4();
      if (key === 'ship' && motion) {
        model = mul(translation(0, motion.heave, 0), mul(rotationX(motion.roll), rotationZ(-motion.pitch)));
      } else if (key === 'boat' && motion && boatModel) {
        model = boatModel;
      } else if (key === 'ladder' && ladderModel) {
        model = ladderModel;
      }
      this.writeSolidParams(obj, vp, camPos, model);
      const bg = this.device.createBindGroup({
        layout: this.solidPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: obj.uniform } }],
      });
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, obj.buffers.pos);
      pass.setVertexBuffer(1, obj.buffers.nrm);
      pass.setIndexBuffer(obj.buffers.idx, 'uint32');
      pass.drawIndexed(obj.indexCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private writeOceanParams(vp: Float32Array, camPos: [number, number, number]): void {
    // 9 个 vec4，每个 16 字节（共 144 字节）
    const f = new Float32Array(36);
    f[0] = this.n; f[1] = this.time; f[2] = this.field?.domainLength ?? 400; // sizeTimeDomain
    f.set(camPos, 4);                                   // camPos
    f.set(vp, 8);                                       // viewProj (16)
    f.set([0.4, 0.9, 0.3, 0], 24);                      // lightDir
    f.set([1, 0, 0, 0], 28);                            // cameraRight
    f.set([0, 1, 0, 0], 32);                            // cameraUp
    f[36] = this.nightMode ? 1 : 0;                     // nightAndPad.x
    // shipInfo @40..43
    f.set([this.shelter.length, this.shelter.beam, this.shelter.draft, this.shelter.depth], 40);
    // shelterInfo @44..47
    f.set([this.shelter.heading, this.shelter.waveDir, this.shelter.enabled, 0], 44);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, f);
  }

  private writeSolidParams(obj: SolidObject, vp: Float32Array, camPos: [number, number, number], model: Float32Array): void {
    const f = new Float32Array(44); // 176 字节
    f.set(vp, 0);                  // viewProj 0..15
    f.set(model, 16);              // model 16..31
    f.set(camPos, 32);             // camPos 32..34
    f[35] = this.nightMode ? 1 : 0; // nightMode @140
    f.set([0.4, 0.9, 0.3], 36);    // sunDir 36..38 @144
    f[39] = this.currentLightCount; // lightCount @156
    f.set(obj.color, 40);          // baseColor 40..42 @160
    this.device.queue.writeBuffer(obj.uniform, 0, f);
  }

  /** 回读一帧高度场（统计/校验用，非每帧调用） */
  async readbackHeight(): Promise<Float32Array> {
    if (!this.field || !this.outHeightBuffer) return new Float32Array(0);
    const n2 = this.n * this.n;
    const staging = this.device.createBuffer({ size: n2 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.outHeightBuffer, 0, staging, 0, n2 * 4);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    return new Float32Array(staging.getMappedRange().slice(0));
  }

  get waveField(): WaveAmplitudeField | null { return this.field; }
}

// ---- 灯光工具 ----
function alignLights(lights: GpuLight[]): Float32Array {
  const f = new Float32Array(MAX_LIGHTS * 12);
  lights.slice(0, MAX_LIGHTS).forEach((l, i) => {
    f.set(l.pos, i * 12);
    f.set(l.dirCut, i * 12 + 4);
    f.set(l.colorPower, i * 12 + 8);
  });
  return f;
}
