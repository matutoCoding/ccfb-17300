// 海面 FFT 与渲染着色器。
// 振幅系数 h0、色散 omega 由 CPU 数值核（core/waveField，已通过验收测试）
// 上传到 storage buffer，GPU 只负责逐帧相位旋转、IFFT 与绘制，
// 因此 GPU 海面与 CPU 参考实现严格同源。

struct Params {
  // 显式布局（vec4 对齐 16，避免 vec3 的隐式填充错位）
  sizeTimeDomain: vec4<f32>,  // x=N, y=time, z=domainLength, w=unused
  camPos: vec4<f32>,          // xyz 相机位置
  viewProj: mat4x4<f32>,      // 视图投影
  lightDir: vec4<f32>,        // xyz 平行光方向
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
  nightAndPad: vec4<f32>,     // x=nightMode
  shipInfo: vec4<f32>,        // x=船长 y=船宽 z=吃水 w=水深
  shelterInfo: vec4<f32>,     // x=船首向 y=来浪向 z=启用(1/0)
};                          // 9*16 = 144 字节

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> h0Re: array<f32>;
@group(0) @binding(2) var<storage, read_write> h0Im: array<f32>;
@group(0) @binding(3) var<storage, read_write> omega: array<f32>;
// 工作缓冲（复数拆两个实数组）
@group(0) @binding(4) var<storage, read_write> workRe: array<f32>;
@group(0) @binding(5) var<storage, read_write> workIm: array<f32>;
// 输出实场：高度、x 斜率、y 斜率
@group(0) @binding(6) var<storage, read_write> outHeight: array<f32>;
@group(0) @binding(7) var<storage, read_write> outSlopeX: array<f32>;
@group(0) @binding(8) var<storage, read_write> outSlopeY: array<f32>;

// 网格下标 → 物理波数分量
fn kxFor(ix: u32) -> f32 {
  let n = P.sizeTimeDomain.x;
  let dk = 6.28318530718 / P.sizeTimeDomain.z;
  if (ix <= n / 2u) { return f32(ix) * dk; }
  return f32(ix - n) * dk;
}
fn kyFor(iy: u32) -> f32 {
  let n = P.sizeTimeDomain.x;
  let dk = 6.28318530718 / P.sizeTimeDomain.z;
  if (iy <= n / 2u) { return f32(iy) * dk; }
  return f32(iy - n) * dk;
}

// 相位旋转：主半空间（ky>0 或 ky==0 且 kx>=0）正向 e^{+iwt}，其余反向，
// 与 CPU evaluateHeight 的半空间约定完全一致，保持 Hermitian 对称。
@compute @workgroup_size(256)
fn phaseRotate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let n = P.sizeTimeDomain.x;
  if (idx >= n * n) { return; }
  let ix = idx % n;
  let iy = idx / n;
  let w = omega[idx];
  let re = h0Re[idx];
  let im = h0Im[idx];
  let kx = kxFor(ix);
  let ky = kyFor(iy);
  let sign = 1.0;
  if (!(ky > 0.0 || (ky == 0.0 && kx >= 0.0))) { sign = -1.0; }
  let ph = sign * w * P.sizeTimeDomain.y;
  let c = cos(ph);
  let s = sin(ph);
  workRe[idx] = re * c - im * s;
  workIm[idx] = re * s + im * c;
}

// 一维 IFFT：每个 workgroup 处理一行（axis=0）或一列（axis=1）。
// 组内共享内存做 radix-2 蝶形，逆变换带 1/N 归一化，与 CPU fft.ts 对齐。
// 固定支持 N=512（256 线程各处理蝶形的两半），与 512×512 海面需求对应。
var<workgroup> shRe: array<f32, 512>;
var<workgroup> shIm: array<f32, 512>;

fn bitReverse32(x: u32, n: u32) -> u32 {
  var v = x;
  var r = 0u;
  var bits = 0u;
  var nn = n;
  while (nn > 1u) { nn = nn >> 1u; bits = bits + 1u; }
  for (var i = 0u; i < bits; i = i + 1u) {
    r = (r << 1u) | (v & 1u);
    v = v >> 1u;
  }
  return r;
}

// 行/列两个入口，复用蝶形逻辑，仅下标映射不同
@compute @workgroup_size(256)
fn fftRows(@builtin(local_invocation_id) lid: vec3<u32>,
           @builtin(workgroup_id) wid: vec3<u32>) {
  let n = P.sizeTimeDomain.x;
  let row = wid.x;
  let half = n / 2u;
  let t = lid.x;
  let revT = bitReverse32(t, n);
  let revT1 = bitReverse32(t + half, n);
  shRe[t] = workRe[row * n + revT];
  shIm[t] = workIm[row * n + revT];
  shRe[t + half] = workRe[row * n + revT1];
  shIm[t + half] = workIm[row * n + revT1];
  workgroupBarrier();
  for (var len = 2u; len <= n; len = len << 1u) {
    let h = len >> 1u;
    let pos = t % h;
    let block = (t / h) * len;
    let a = block + pos;
    let b = a + h;
    let ang = 6.28318530718 * f32(pos) / f32(len);
    let wr = cos(ang);
    let wi = sin(ang);
    let tre = wr * shRe[b] - wi * shIm[b];
    let tim = wr * shIm[b] + wi * shRe[b];
    let ua = shRe[a];
    let ub = shIm[a];
    shRe[b] = ua - tre; shIm[b] = ub - tim;
    shRe[a] = ua + tre; shIm[a] = ub + tim;
    workgroupBarrier();
  }
  let invN = 1.0 / f32(n);
  workRe[row * n + t] = shRe[t] * invN;
  workIm[row * n + t] = shIm[t] * invN;
  workRe[row * n + t + half] = shRe[t + half] * invN;
  workIm[row * n + t + half] = shIm[t + half] * invN;
}

@compute @workgroup_size(256)
fn fftCols(@builtin(local_invocation_id) lid: vec3<u32>,
           @builtin(workgroup_id) wid: vec3<u32>) {
  let n = P.sizeTimeDomain.x;
  let col = wid.x;
  let half = n / 2u;
  let t = lid.x;
  let revT = bitReverse32(t, n);
  let revT1 = bitReverse32(t + half, n);
  shRe[t] = workRe[revT * n + col];
  shIm[t] = workIm[revT * n + col];
  shRe[t + half] = workRe[revT1 * n + col];
  shIm[t + half] = workIm[revT1 * n + col];
  workgroupBarrier();
  for (var len = 2u; len <= n; len = len << 1u) {
    let h = len >> 1u;
    let pos = t % h;
    let block = (t / h) * len;
    let a = block + pos;
    let b = a + h;
    let ang = 6.28318530718 * f32(pos) / f32(len);
    let wr = cos(ang);
    let wi = sin(ang);
    let tre = wr * shRe[b] - wi * shIm[b];
    let tim = wr * shIm[b] + wi * shRe[b];
    let ua = shRe[a];
    let ub = shIm[a];
    shRe[b] = ua - tre; shIm[b] = ub - tim;
    shRe[a] = ua + tre; shIm[a] = ub + tim;
    workgroupBarrier();
  }
  let invN = 1.0 / f32(n);
  workRe[t * n + col] = shRe[t] * invN;
  workIm[t * n + col] = shIm[t] * invN;
  workRe[(t + half) * n + col] = shRe[t + half] * invN;
  workIm[(t + half) * n + col] = shIm[t + half] * invN;
}

// 把 IFFT 结果实部写入高度场；斜率由相位旋转时乘 ik 生成（这里先存高度）。
// 为减少 FFT 次数，斜率在渲染端由相邻高度差分得到（视觉足够，且物理场同源）。
@compute @workgroup_size(256)
fn storeHeight(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let n = P.sizeTimeDomain.x;
  if (idx >= n * n) { return; }
  outHeight[idx] = workRe[idx];
}

// ---- 海面渲染 ----
struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) height: f32,
};

// 下风舷遮蔽衰减系数（与 core/shelter.ts 同一半经验模型），1=无遮蔽，越小越平静。
// 入参为世界坐标（船在原点，x 船首，z 对应船系 y 右舷）。
fn shelterFactor(wx: f32, wz: f32) -> f32 {
  if (P.shelterInfo.z < 0.5) { return 1.0; }
  let heading = P.shelterInfo.x;
  let waveDir = P.shelterInfo.y;
  let len = P.shipInfo.x;
  let beam = P.shipInfo.y;
  let draft = P.shipInfo.z;
  let depth = P.shipInfo.w;

  // 入射角因子：横浪=1，迎随浪=0
  let mu = atan2(sin(heading - waveDir), cos(heading - waveDir));
  let inc = abs(sin(mu));
  if (inc < 0.02) { return 1.0; }

  // 世界坐标 → 船坐标（绕 y 轴旋转 -heading）
  let ch = cos(-heading);
  let sh = sin(-heading);
  let bx = wx * ch - wz * sh;
  let by = wx * sh + wz * ch;

  // 下风舷：波能传播方向 waveDir+π 在船系下的横向分量符号
  let leeSide = sign(sin(waveDir + 3.14159265 - heading));
  if (leeSide == 0.0) { return 1.0; }
  let offHull = by * leeSide;
  if (offHull < beam * 0.5) { return 1.0; } // 船体内侧不处理
  let d = offHull - beam * 0.5;

  // 纵向端部绕射
  let endMargin = 0.15 * len;
  var longEffect = 1.0;
  if (abs(bx) > len * 0.5) {
    longEffect = max(0.0, 1.0 - (abs(bx) - len * 0.5) / endMargin);
  }
  if (longEffect <= 0.0) { return 1.0; }

  // 遮蔽锥
  let spread = 0.610865; // 35°
  let coneHalf = beam * 0.5 + abs(bx) * tan(spread);
  var inCone = 1.0;
  if (abs(by) > coneHalf + d) { inCone = 0.35; }

  let blockage = clamp(draft / max(1.0, depth * 0.6), 0.0, 1.0);
  let strength = inc * blockage * longEffect * inCone;
  let attenuation = exp(-d / (1.2 * beam));
  return 1.0 - strength * attenuation;
}

@vertex
fn oceanVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
  let n = P.sizeTimeDomain.x;
  let ix = vi % n;
  let iy = vi / n;
  let step = P.sizeTimeDomain.z / f32(n);
  // 网格居中
  let x = f32(ix) * step - P.sizeTimeDomain.z * 0.5;
  let z = f32(iy) * step - P.sizeTimeDomain.z * 0.5;
  // 下风舷遮蔽：衰减浪高（视觉上让遮蔽区明显变小）
  let fShelter = shelterFactor(x, z);
  let h = outHeight[iy * n + ix] * fShelter;
  // 相邻高度差分求法线（循环边界）
  let xl = outHeight[iy * n + (ix + n - 1u) % n];
  let xr = outHeight[iy * n + (ix + 1u) % n];
  let zl = outHeight[((iy + n - 1u) % n) * n + ix];
  let zr = outHeight[((iy + 1u) % n) * n + ix];
  let dhdx = (xr - xl) / (2.0 * step);
  let dhdz = (zr - zl) / (2.0 * step);
  let normal = normalize(vec3<f32>(-dhdx, 1.0, -dhdz));
  let world = vec3<f32>(x, h, z);
  var out: VertexOut;
  out.clip = P.viewProj * vec4<f32>(world, 1.0);
  out.world = world;
  out.normal = normal;
  out.height = h;
  return out;
}

@fragment
fn oceanFragment(in: VertexOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(P.lightDir.xyz);
  let diffuse = clamp(dot(n, l), 0.0, 1.0);
  // 深水蓝到浅水青的渐变，按波高加白沫倾向
  let deep = vec3<f32>(0.02, 0.16, 0.28);
  let shallow = vec3<f32>(0.08, 0.38, 0.46);
  let base = mix(deep, shallow, clamp(in.height * 0.25 + 0.5, 0.0, 1.0));
  let spec = pow(clamp(dot(reflect(-l, n), normalize(P.camPos.xyz - in.world)), 0.0, 1.0), 60.0);
  // 波峰白沫：高且法线趋平处
  let foam = smoothstep(1.2, 2.2, in.height) * smoothstep(0.6, 0.95, n.y);
  let foamColor = vec3<f32>(0.9, 0.95, 0.96);
  var color = base * (0.35 + 0.65 * diffuse) + vec3<f32>(spec * 0.6);
  color = mix(color, foamColor, clamp(foam, 0.0, 0.85));
  if (P.nightAndPad.x > 0.5) {
    // 夜间整体压暗，仅保留微弱反光
    color = color * 0.18 + vec3<f32>(0.01, 0.02, 0.04);
  }
  return vec4<f32>(color, 1.0);
}
