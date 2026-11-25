/**
 * FFT 海面的振幅场构建与逐帧求值（CPU 参考实现，GPU 端按同一公式写 shader）。
 *
 * 精度策略（对应验收：FFT 海面统计 Hs 与输入误差 <3%）：
 * 1. 每个 k 网格单元的能量由方向谱 S(ω,θ) 极坐标积分得到，
 *    雅可比 dk/dω 由色散方程隐式求导，浅水含 tanh 修正项。
 * 2. 谱样本能量按双线性权重分摊到最近的 4 个 k 网格节点（splat），
 *    避免硬落桶在粗网格上丢能量；分摊总和守恒。
 * 3. 离散 Parseval：η=IFFT(C)（含 1/N² 归一化）且 C 含 Hermitian 对称时，
 *    空间方差 = Σ|C|²/N⁴。每个物理模式能量 E_k=S_kΔk² 由共轭对
 *    (k,-k) 各承载一半，单节点系数幅值 N²√(E_k/2)，自共轭节点 N²√E_k，
 *    求和严格还原 m0=Hs²/16，与随机相位的具体实现无关。
 * 4. 域长 L 按 Tp 自动选取（约 5 倍峰波长），N 决定高频截断。
 */
import type { ComplexArray, DirectionalSpectrumData, SeaStateInput, WaveAmplitudeField } from './types.ts';
import { mulberry32 } from './math.ts';
import { kFromOmega, omegaFromK } from './dispersion.ts';
import { buildDirectionalSpectrum } from './spectrum.ts';
import { fft2d } from './fft.ts';

export interface OceanFieldConfig {
  size: number;            // FFT 分辨率 N（2 的幂）
  domainLength: number;    // 物理域边长 L，米
  nOmega?: number;         // 谱积分频率采样数
  nTheta?: number;
}

/** 按谱峰周期和水深估算合适域长：取最长分量峰波长的 5 倍并向上取整到 10 m */
export function recommendDomainLength(input: SeaStateInput): number {
  let lambdaMax = 0;
  for (const c of input.components) {
    const wp = (2 * Math.PI) / c.peakPeriod;
    const kp = kFromOmega(wp, input.depth);
    lambdaMax = Math.max(lambdaMax, (2 * Math.PI) / kp);
  }
  return Math.ceil((lambdaMax * 5) / 10) * 10;
}

/** 网格坐标：idx=(iy,ix) → (kx,ky)，N/2 以上为负频率侧 */
export function kxFor(ix: number, n: number, dk: number): number {
  return ix <= n / 2 ? ix * dk : (ix - n) * dk;
}
export function kyFor(iy: number, n: number, dk: number): number {
  return kxFor(iy, n, dk);
}

/**
 * 将 S(ω,θ) 积分到 k 网格节点上，返回每个节点代表的谱能量 E_k=S_kΔk²（单位 m²）。
 * 谱网格很密（默认 160×96），中点矩形积分 + 四邻域 splat，总能量守恒。
 */
export function integrateSpectrumToKGrid(
  spec: DirectionalSpectrumData,
  cfg: OceanFieldConfig,
): Float64Array {
  const n = cfg.size;
  const dk = (2 * Math.PI) / cfg.domainLength;
  const depth = spec.depth;
  const energy = new Float64Array(n * n);

  const nO = spec.omegas.length;
  const nT = spec.thetas.length;
  const dTheta = (2 * Math.PI) / nT;

  for (let j = 0; j < nT; j++) {
    const theta = spec.thetas[j];
    for (let i = 0; i < nO - 1; i++) {
      const w0 = spec.omegas[i];
      const w1 = spec.omegas[i + 1];
      const dw = w1 - w0;
      const wMid = 0.5 * (w0 + w1);
      if (wMid <= 0) continue;
      const kMid = kFromOmega(wMid, depth);
      const sVal = 0.5 * (spec.values[j * nO + i] + spec.values[j * nO + i + 1]);
      // 极坐标能量元：S dω dθ（方向谱已归一化，∫D dθ=1）
      const e = sVal * dw * dTheta;
      if (e <= 0) continue;
      // θ 为「来浪方向」，波数向量沿传播方向 θ+π
      const kx = kMid * Math.cos(theta + Math.PI);
      const ky = kMid * Math.sin(theta + Math.PI);
      // 连续 k 坐标 → 网格浮点下标
      const gx = kx / dk;
      const gy = ky / dk;
      if (gx < -n / 2 || gx > n / 2 || gy < -n / 2 || gy > n / 2) continue; // 高频截断外
      const fx = gx >= 0 ? gx : gx + n;
      const fy = gy >= 0 ? gy : gy + n;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const tx = fx - i0;
      const ty = fy - j0;
      const i1 = (i0 + 1) % n;
      const j1 = (j0 + 1) % n;
      // 双线性 splat，权重和为 1
      energy[j0 * n + i0] += e * (1 - tx) * (1 - ty);
      energy[j0 * n + i1] += e * tx * (1 - ty);
      energy[j1 * n + i0] += e * (1 - tx) * ty;
      energy[j1 * n + i1] += e * tx * ty;
    }
  }
  return energy;
}

/**
 * 构建完整振幅场（随机相位 + Hermitian 共轭）。
 *
 * IFFT 约定（见 fft.ts）：η = (1/N²)Σ C(k)e^{ik·x}。
 * 实信号的一个物理模式由 Hermitian 对 (k,-k) 两个系数共同产生，
 * 两点在物理场叠加。用单模式 δ 测试校准（见 test/debug4）：
 * - 共轭对承载总能量 E 时，每节点系数幅值 N²·√(E/2)，
 *   物理振幅 = √(2E)，空间方差 = E；
 * - 自共轭（原点/Nyquist）节点无叠加，系数 = N²·√E。
 */
export function buildWaveField(input: SeaStateInput, cfg: OceanFieldConfig): WaveAmplitudeField {
  const n = cfg.size;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 尺寸必须是 2 的幂');
  const dk = (2 * Math.PI) / cfg.domainLength;
  const spec = buildDirectionalSpectrum(input, {
    nOmega: cfg.nOmega ?? 160,
    nTheta: cfg.nTheta ?? 96,
  });
  const nodeEnergy = integrateSpectrumToKGrid(spec, cfg);

  const rng = mulberry32(input.seed >>> 0);
  const h0: ComplexArray = { re: new Float64Array(n * n), im: new Float64Array(n * n) };
  const omega = new Float64Array(n * n);
  const kMag = new Float64Array(n * n);

  const conjugateIndex = (ix: number, iy: number): number => {
    const cx = ix === 0 ? 0 : n - ix;
    const cy = iy === 0 ? 0 : n - iy;
    return cy * n + cx;
  };

  const norm = n * n;
  // 先把所有节点的色散表填满（几何/渲染按节点查询）
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iy * n + ix;
      const kx0 = kxFor(ix, n, dk);
      const ky0 = kyFor(iy, n, dk);
      const km0 = Math.hypot(kx0, ky0);
      kMag[idx] = km0;
      omega[idx] = km0 > 0 ? omegaFromK(km0, input.depth) : 0;
    }
  }

  // 每对共轭节点只构建一次：物理上 k 与 -k 两侧都被方向谱 splat 了能量，
  // 对能量求和后由「主节点」生成一对共轭系数，避免二次遍历覆盖。
  const done = new Uint8Array(n * n);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iy * n + ix;
      if (done[idx]) continue;
      const conj = conjugateIndex(ix, iy);
      // 该共轭对承载的总能量（两侧 splat 之和）
      const pairEnergy = nodeEnergy[idx] + (conj !== idx ? nodeEnergy[conj] : 0);
      done[idx] = 1;
      done[conj] = 1;
      if (pairEnergy <= 0) continue;

      if (idx === conj) {
        // 自共轭模式（原点、Nyquist 行/列）：系数必须为实数
        h0.re[idx] = norm * Math.sqrt(pairEnergy);
        h0.im[idx] = 0;
      } else {
        const phase = rng() * 2 * Math.PI;
        const amp = norm * Math.sqrt(pairEnergy / 2);
        h0.re[idx] = amp * Math.cos(phase);
        h0.im[idx] = amp * Math.sin(phase);
        h0.re[conj] = h0.re[idx];
        h0.im[conj] = -h0.im[idx];
      }
    }
  }

  return {
    size: n,
    domainLength: cfg.domainLength,
    dk,
    h0,
    omega,
    kMag,
    depth: input.depth,
    seed: input.seed >>> 0,
  };
}

/**
 * 计算 t 时刻的波面 η(x,y,t)，返回行主序 N×N 高度场（米）。
 * 共轭对反向旋转才能保持 Hermitian 对称、输出实场：
 *   C(k,t)=h0(k)e^{+iωt}，C(-k,t)=h0(-k)e^{-iωt}。
 * 二维网格的频率符号按物理分量 kx、ky 判定（不能只看单一维下标，
 * 混合象限节点 (kx<0,ky>0) 需逐轴定号）。
 */
export function evaluateHeight(field: WaveAmplitudeField, time: number): Float64Array {
  const n = field.size;
  const dk = field.dk;
  const work: ComplexArray = {
    re: new Float64Array(field.h0.re),
    im: new Float64Array(field.h0.im),
  };
  for (let iy = 0; iy < n; iy++) {
    const ky = kyFor(iy, n, dk);
    for (let ix = 0; ix < n; ix++) {
      const idx = iy * n + ix;
      const w = field.omega[idx];
      if (w === 0) continue;
      const kx = kxFor(ix, n, dk);
      // 主半空间约定：ky>0，或 ky==0 且 kx>=0 的节点正向旋转，其余反向
      const positiveHalf = ky > 0 || (ky === 0 && kx >= 0);
      const phase = (positiveHalf ? 1 : -1) * w * time;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const re = work.re[idx];
      const im = work.im[idx];
      work.re[idx] = re * c - im * s;
      work.im[idx] = re * s + im * c;
    }
  }
  fft2d(work, true);
  return work.re;
}

/** 单点波面（全量求值后双线性取样） */
export function heightAt(field: WaveAmplitudeField, time: number, x: number, y: number): number {
  const grid = evaluateHeight(field, time);
  const n = field.size;
  const fx = ((((x / field.domainLength) % 1) + 1) % 1) * n;
  const fy = ((((y / field.domainLength) % 1) + 1) % 1) * n;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const i1 = (ix + 1) % n;
  const j1 = (iy + 1) % n;
  const v00 = grid[iy * n + ix];
  const v10 = grid[iy * n + i1];
  const v01 = grid[j1 * n + ix];
  const v11 = grid[j1 * n + i1];
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

/**
 * 由振幅场直接核算理论空间方差 m0（Parseval，不经 FFT）。
 * 由单模式 δ 测试（test/debug4）实测校准：
 * IFFT 含 1/N² 归一化时，空间方差 = Σ_k|C(k)|²/N⁴，
 * Hermitian 对两个节点的贡献在求和中天然给出物理模式的真实方差。
 */
export function fieldVariance(field: WaveAmplitudeField): number {
  let sum = 0;
  for (let idx = 0; idx < field.h0.re.length; idx++) {
    sum += field.h0.re[idx] ** 2 + field.h0.im[idx] ** 2;
  }
  const n4 = (field.size * field.size) ** 2;
  return sum / n4;
}

/** 由场核算理论 Hs=4√m0 */
export function fieldTheoreticalHs(field: WaveAmplitudeField): number {
  return 4 * Math.sqrt(fieldVariance(field));
}

/** 对多帧高度场做空间+时间统计，返回实测 Hs（4σ，逐帧先去均值） */
export function measuredHs(frames: Float64Array[]): number {
  let sumSq = 0;
  let count = 0;
  for (const frame of frames) {
    let m = 0;
    for (let i = 0; i < frame.length; i++) m += frame[i];
    m /= frame.length;
    for (let i = 0; i < frame.length; i++) {
      const d = frame[i] - m;
      sumSq += d * d;
    }
    count += frame.length;
  }
  return 4 * Math.sqrt(sumSq / count);
}
