/**
 * 波浪方向谱。
 * - 一维谱：JONSWAP（峰升因子 γ、σ 分段 0.07/0.09），
 *   α 不采用经验公式，而是按目标有效波高 Hs 反标定（m0=Hs²/16），
 *   风浪/涌浪统一用该形式（涌浪取大 γ）。
 * - 方向分布：D(θ)=Γ(s+1)/(√π·Γ(s+1/2))·cos^{2s}((θ-θm)/2)，s 可调。
 * - 海况 = 若干分量 S_i(ω)·D_i(θ) 直接叠加。
 */
import type { DirectionalSpectrumData, SeaComponent, SeaStateInput } from './types.ts';
import { GRAVITY, normalizeAngle, trapz } from './math.ts';

/** JONSWAP 一维谱形状（α=1 的未标定形状） */
function jonswapShape(omega: number, wp: number, gamma: number): number {
  if (omega <= 0) return 0;
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = wp / omega;
  const peakEnhance = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return (
    (GRAVITY * GRAVITY) / Math.pow(omega, 5) *
    Math.exp(-1.25 * Math.pow(r, 4)) *
    Math.pow(gamma, peakEnhance)
  );
}

/**
 * 标定后的 JONSWAP 谱 S(ω)，使 ∫S dω = Hs²/16。
 * omegas 为采样角频率列（升序、等距或非等距均可，梯形积分）。
 */
export function jonswapSpectrum(
  omegas: ArrayLike<number>,
  hs: number,
  peakPeriod: number,
  gamma: number,
): Float64Array {
  const wp = (2 * Math.PI) / peakPeriod;
  const shape = new Float64Array(omegas.length);
  for (let i = 0; i < omegas.length; i++) shape[i] = jonswapShape(omegas[i], wp, gamma);
  const m0Shape = trapz(omegas, shape);
  const m0Target = (hs * hs) / 16;
  const alpha = m0Shape > 0 ? m0Target / m0Shape : 0;
  const out = new Float64Array(omegas.length);
  for (let i = 0; i < omegas.length; i++) out[i] = alpha * shape[i];
  return out;
}

/**
 * cos^{2s} 方向分布函数，归一化保证 ∫_0^{2π} D dθ = 1。
 * 归一化常数采用数值积分自标定（避免 Γ 函数在 cos(x)/cos(x/2)
 * 两种参数约定下的域因子错误），对任意 s≥0 均精确。
 */
export function directionalSpreading(
  thetas: ArrayLike<number>,
  thetaMean: number,
  s: number,
): Float64Array {
  // 数值求归一化常数：∫_{-π}^{π} cos^{2s}(u/2) du
  const nRef = 4096;
  let rawIntegral = 0;
  for (let i = 0; i < nRef; i++) {
    const u = -Math.PI + (2 * Math.PI * (i + 0.5)) / nRef;
    rawIntegral += Math.pow(Math.cos(u / 2), 2 * s);
  }
  rawIntegral *= (2 * Math.PI) / nRef;
  const norm = 1 / rawIntegral;
  const out = new Float64Array(thetas.length);
  for (let i = 0; i < thetas.length; i++) {
    let d = normalizeAngle(thetas[i] - thetaMean);
    if (d > Math.PI) d -= 2 * Math.PI; // (-π,π]
    const c = Math.cos(d / 2);
    out[i] = norm * Math.pow(Math.max(c, 0), 2 * s);
  }
  return out;
}

export interface SpectrumGridOptions {
  /** 最低/最高角频率覆盖倍数（相对各分量 ωp），默认 0.25~3.5 倍 */
  omegaLowFactor?: number;
  omegaHighFactor?: number;
  nOmega?: number;
  nTheta?: number;
}

/**
 * 由海况输入构建 S(ω,θ) 采样网格。
 * 频率范围按所有分量的峰频联合取界，保证风浪与涌浪能量都被包住。
 */
export function buildDirectionalSpectrum(
  input: SeaStateInput,
  opts: SpectrumGridOptions = {},
): DirectionalSpectrumData {
  const nOmega = opts.nOmega ?? 128;
  const nTheta = opts.nTheta ?? 72;
  const lowF = opts.omegaLowFactor ?? 0.25;
  const highF = opts.omegaHighFactor ?? 3.5;

  let wLo = Infinity;
  let wHi = 0;
  for (const c of input.components) {
    const wp = (2 * Math.PI) / c.peakPeriod;
    wLo = Math.min(wLo, wp * lowF);
    wHi = Math.max(wHi, wp * highF);
  }
  if (!Number.isFinite(wLo)) {
    wLo = 0.1;
    wHi = 3;
  }
  const omegas = new Float64Array(nOmega);
  for (let i = 0; i < nOmega; i++) {
    omegas[i] = wLo + ((wHi - wLo) * i) / (nOmega - 1);
  }
  const thetas = new Float64Array(nTheta);
  for (let j = 0; j < nTheta; j++) thetas[j] = (2 * Math.PI * j) / nTheta;

  const values = new Float64Array(nOmega * nTheta);
  for (const comp of input.components) {
    const s1d = jonswapSpectrum(omegas, comp.significantHeight, comp.peakPeriod, comp.gamma);
    const dir = directionalSpreading(thetas, comp.peakDirection, comp.spreadingIndex);
    for (let j = 0; j < nTheta; j++) {
      for (let i = 0; i < nOmega; i++) {
        values[j * nOmega + i] += dir[j] * s1d[i];
      }
    }
  }
  return { omegas, thetas, values, depth: input.depth };
}

/** 谱零阶矩 m0 = ∫∫ S(ω,θ) dθ dω */
export function spectralM0(spec: DirectionalSpectrumData): number {
  const { omegas, thetas, values, } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  let m0 = 0;
  for (let j = 0; j < nT; j++) {
    let row = 0;
    const base = j * nO;
    for (let i = 1; i < nO; i++) {
      row += 0.5 * (values[base + i] + values[base + i - 1]) * (omegas[i] - omegas[i - 1]);
    }
    const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;
    m0 += row * dTheta;
  }
  return m0;
}

/** 由谱网格统计有效波高 Hs=4√m0 */
export function spectralHs(spec: DirectionalSpectrumData): number {
  return 4 * Math.sqrt(spectralM0(spec));
}

/** 谱矩 mn = ∫∫ ω^n S dθdω */
export function spectralMoment(spec: DirectionalSpectrumData, n: number): number {
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;
  let acc = 0;
  for (let j = 0; j < nT; j++) {
    const base = j * nO;
    for (let i = 1; i < nO; i++) {
      const wMid = 0.5 * (omegas[i] + omegas[i - 1]);
      const sMid = 0.5 * (values[base + i] + values[base + i - 1]);
      acc += Math.pow(wMid, n) * sMid * (omegas[i] - omegas[i - 1]) * dTheta;
    }
  }
  return acc;
}

/** 主浪向（能量加权平均方向） */
export function spectralMeanDirection(spec: DirectionalSpectrumData): number {
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  let sx = 0;
  let sy = 0;
  for (let j = 0; j < nT; j++) {
    let rowEnergy = 0;
    const base = j * nO;
    for (let i = 1; i < nO; i++) {
      rowEnergy +=
        0.5 * (values[base + i] + values[base + i - 1]) * (omegas[i] - omegas[i - 1]);
    }
    sx += rowEnergy * Math.cos(thetas[j]);
    sy += rowEnergy * Math.sin(thetas[j]);
  }
  return Math.atan2(sy, sx);
}

/** 各分量参数的默认值工厂（UI 新增分量用） */
export function defaultComponent(kind: SeaComponent['kind']): SeaComponent {
  return kind === 'wind'
    ? {
        kind,
        significantHeight: 1.5,
        peakPeriod: 7,
        peakDirection: 0,
        gamma: 3.3,
        spreadingIndex: 2,
      }
    : {
        kind,
        significantHeight: 1.0,
        peakPeriod: 12,
        peakDirection: Math.PI / 2,
        gamma: 15,
        spreadingIndex: 8,
      };
}
