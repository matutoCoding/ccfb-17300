/**
 * 船舶频域响应：在方向谱 S(ω,θ) 上积分船上指定点的运动谱。
 *
 * 船上点 (x,y)（x 纵向船中前为正，y 横向右舷为正）的垂向位移传递函数：
 *   H_z(ω,μ) = H_heave(ω,μ) + y·H_roll(ω,μ) - x·H_pitch(ω,μ)
 * 其中波面本身在该点的贡献为 1（单位波幅 → 单位波面升高），
 * 总垂向绝对位移传递函数 = 1 + H_z。
 *
 * 响应谱 S_r(ω,θ) = |H(ω,μ(θ))|² · S(ω,θ)，
 * m0 = ∫∫ S_r dθ dω；速度谱乘 ω²。有义值统一取 4√m0（与 Hs 同定义）。
 */
import type { DirectionalSpectrumData, RaoTable, Vessel } from './types.ts';
import { lookupRao } from './rao.ts';
import { angleDiff } from './math.ts';

export interface PointMotionResult {
  /** 位移谱零阶矩 m² */
  m0Displacement: number;
  /** 速度谱零阶矩 (m/s)² */
  m0Velocity: number;
  /** 位移有义值 4σ，m */
  significantDisplacement: number;
  /** 速度有义值 4σ，m/s */
  significantVelocity: number;
  /** 平均跨零周期 s（由谱矩比估算） */
  meanZeroCrossingPeriod: number;
}

export interface MotionPoint {
  x: number;
  y: number;
}

/** 复数值四则小工具 */
interface C {
  re: number;
  im: number;
}
function cadd(a: C, b: C, s = 1): C {
  return { re: a.re + s * b.re, im: a.im + s * b.im };
}
function cscale(a: C, s: number): C {
  return { re: a.re * s, im: a.im * s };
}
function cabs2(a: C): number {
  return a.re * a.re + a.im * a.im;
}

/**
 * 船上点垂向绝对位移传递函数（相对静水面），输入单位波幅。
 * μ=船首向-浪向（来向），内部折叠到 RAO 表域。
 */
export function verticalTransferAtPoint(
  rao: RaoTable,
  omega: number,
  mu: number,
  point: MotionPoint,
): C {
  const h = lookupRao(rao, omega, mu);
  // 1 = 波面随动项
  let hz: C = { re: 1, im: 0 };
  hz = cadd(hz, h.heave);
  hz = cadd(hz, cscale(h.roll, point.y));
  hz = cadd(hz, cscale(h.pitch, -point.x));
  return hz;
}

/** 引航艇简化传递函数：小艇在低频几乎完全随浪，高频略有放大后衰减 */
export function pilotBoatVerticalTransfer(omega: number): C {
  // 等效单自由度，wn≈1.1 rad/s（约 5.7 s 周期），阻尼 0.35；
  // 返回绝对垂向位移传递函数（含波面随动项 1）。
  const wn = 1.1;
  const zeta = 0.35;
  const r = omega / wn;
  const amp = 1 / Math.sqrt((1 - r * r) ** 2 + (2 * zeta * r) ** 2);
  const phase = -Math.atan2(2 * zeta * r, 1 - r * r);
  return { re: amp * Math.cos(phase), im: amp * Math.sin(phase) };
}

/**
 * 方向谱上的点运动积分。
 * @param shipHeading 船首向 rad（与浪向同一坐标系）
 */
export function integratePointMotion(
  spec: DirectionalSpectrumData,
  rao: RaoTable,
  point: MotionPoint,
  shipHeading: number,
  boat = false,
): PointMotionResult {
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;

  let m0d = 0;
  let m0v = 0;
  let m2 = 0;
  for (let j = 0; j < nT; j++) {
    for (let i = 1; i < nO; i++) {
      const w = 0.5 * (omegas[i] + omegas[i - 1]);
      const dw = omegas[i] - omegas[i - 1];
      const sMid = 0.5 * (values[j * nO + i] + values[j * nO + i - 1]);
      const mu = angleDiff(shipHeading, thetas[j]);
      const h = boat
        ? pilotBoatVerticalTransfer(w)
        : verticalTransferAtPoint(rao, w, mu, point);
      const mag2 = cabs2(h);
      m0d += mag2 * sMid * dw * dTheta;
      m0v += w * w * mag2 * sMid * dw * dTheta;
      m2 += w * w * sMid * dw * dTheta;
    }
  }
  const m0Wave = specM0(spec);
  const tz = m0Wave > 0 && m2 > 0 ? 2 * Math.PI * Math.sqrt(m0Wave / m2) : 0;
  return {
    m0Displacement: m0d,
    m0Velocity: m0v,
    significantDisplacement: 4 * Math.sqrt(m0d),
    significantVelocity: 4 * Math.sqrt(m0v),
    meanZeroCrossingPeriod: tz,
  };
}

/** 谱 m0（与 spectrum.ts 中 spectralM0 同结果，局部复制避免循环依赖） */
function specM0(spec: DirectionalSpectrumData): number {
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;
  let m0 = 0;
  for (let j = 0; j < nT; j++) {
    const base = j * nO;
    for (let i = 1; i < nO; i++) {
      m0 +=
        0.5 * (values[base + i] + values[base + i - 1]) *
        (omegas[i] - omegas[i - 1]) *
        dTheta;
    }
  }
  return m0;
}

/**
 * 软梯底端 vs 引航艇登梯点的相对垂向运动谱积分。
 * 两点运动来自同一片海面，按同一组方向分量相干叠加：
 *   H_rel = H_ladder - H_boat，S_rel = |H_rel|²·S
 */
export function integrateRelativeMotion(
  spec: DirectionalSpectrumData,
  vessel: Vessel,
  shipHeading: number,
  ladderPoint: MotionPoint,
): PointMotionResult {
  const rao = vessel.rao!;
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;

  let m0d = 0;
  let m0v = 0;
  let m2 = 0;
  for (let j = 0; j < nT; j++) {
    for (let i = 1; i < nO; i++) {
      const w = 0.5 * (omegas[i] + omegas[i - 1]);
      const dw = omegas[i] - omegas[i - 1];
      const sMid = 0.5 * (values[j * nO + i] + values[j * nO + i - 1]);
      const mu = angleDiff(shipHeading, thetas[j]);
      const hL = verticalTransferAtPoint(rao, w, mu, ladderPoint);
      const hB = pilotBoatVerticalTransfer(w);
      const hRel: C = { re: hL.re - hB.re, im: hL.im - hB.im };
      const mag2 = cabs2(hRel);
      m0d += mag2 * sMid * dw * dTheta;
      m0v += w * w * mag2 * sMid * dw * dTheta;
      m2 += w * w * sMid * dw * dTheta;
    }
  }
  const m0Wave = specM0(spec);
  const tz = m0Wave > 0 && m2 > 0 ? 2 * Math.PI * Math.sqrt(m0Wave / m2) : 0;
  return {
    m0Displacement: m0d,
    m0Velocity: m0v,
    significantDisplacement: 4 * Math.sqrt(m0d),
    significantVelocity: 4 * Math.sqrt(m0v),
    meanZeroCrossingPeriod: tz,
  };
}
