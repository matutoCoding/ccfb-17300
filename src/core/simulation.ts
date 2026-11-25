/**
 * 时域推演引擎（CPU 参考实现，页面实时曲线与 5% 验收测试共用）。
 *
 * 对方向谱每个 (ω,θ) 离散元取一个谐波，波面在任意点的序列为
 *   ζ(t)=Σ_i Σ_j √(2·S_ij·Δω·Δθ)·cos(kx·x+ky·y-ωt+φ_ij)，
 * 船上点运动经 RAO 复传递函数调制相位/幅值，小艇经小艇传递函数；
 * 两者用同一组随机相位 → 相对运动的相干性被完整保留。
 * 同一 seed 产生同一组相位，配合海况快照即可逐位回放。
 */
import type { DirectionalSpectrumData, Vessel, SafetyThresholds } from './types.ts';
import { angleDiff, mulberry32 } from './math.ts';
import { kFromOmega } from './dispersion.ts';
import { lookupRao } from './rao.ts';
import { pilotBoatVerticalTransfer } from './shipResponse.ts';
import { shelterFactorAt, type ShelterInput } from './shelter.ts';
import { buildLadderGeometry, evaluateLadder, stepLadderSwing } from './ladder.ts';

export interface SimulationConfig {
  duration: number;          // 仿真时长 s
  sampleRate: number;        // 采样率 Hz
  shipHeading: number;       // 船首向 rad
  shipSpeed: number;         // 航速 m/s
  seed: number;
  /** 小艇在船坐标系的位置（下风舷外） */
  boatOffsetX: number;
  boatOffsetY: number;
  thresholds: SafetyThresholds;
  shelter?: Omit<ShelterInput, 'shipHeading'>;
  /**
   * 是否计入谐波空间相位 e^{ik·r}。
   * 频域 RAO 积分以船位为参考点（无空间相位），对拍验收时设 false
   * 使两条路径物理模型严格一致；三维可视化取 true 保留空间结构。
   */
  includeSpatialPhase?: boolean;
}

export interface MotionSample {
  t: number;
  /** 软梯底端垂向位置（绝对，相对静水面） */
  ladderZ: number;
  /** 小艇登梯点甲板垂向位置 */
  boatZ: number;
  /** 相对垂向位移 */
  relDisp: number;
  /** 相对垂向速度（中心差分） */
  relVel: number;
  /** 当地波面（梯位） */
  waveAtLadder: number;
  roll: number;
  pitch: number;
  ladderSwing: number;
  ladderClearance: number;
  ladderHullGap: number;
  /** 该采样点是否超限 */
  exceed: boolean;
}

export interface SafetyWindow {
  start: number;
  end: number;
  duration: number;
}

export interface SimulationResult {
  samples: MotionSample[];
  dt: number;
  /** 相对位移有义值（时域 4σ） */
  sigDisplacement: number;
  sigVelocity: number;
  /** 超限时间段 */
  exceedWindows: SafetyWindow[];
  /** 安全跨梯窗口（位移与速度同时低于上限的连续段） */
  safeWindows: SafetyWindow[];
  /** 每分钟安全窗口数（按整段均值） */
  safeWindowsPerMinute: number;
  /** 软梯距水面最小/最大高度 */
  minClearance: number;
  maxClearance: number;
  /** 贴壳时间占比 */
  hullContactRatio: number;
}

interface Harmonic {
  omega: number;
  kx: number;
  ky: number;
  amp: number;
  phase: number;
  theta: number;
  shelterF: number;
}

/** 预构建谐波表（谱离散 + 相位 + 遮蔽衰减） */
function buildHarmonics(spec: DirectionalSpectrumData, cfg: SimulationConfig): Harmonic[] {
  const rng = mulberry32(cfg.seed >>> 0);
  const { omegas, thetas, values } = spec;
  const nO = omegas.length;
  const nT = thetas.length;
  const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;
  const list: Harmonic[] = [];
  for (let j = 0; j < nT; j++) {
    const theta = thetas[j];
    for (let i = 1; i < nO; i++) {
      const dw = omegas[i] - omegas[i - 1];
      const w = 0.5 * (omegas[i] + omegas[i - 1]);
      const s = 0.5 * (values[j * nO + i] + values[j * nO + i - 1]);
      const energy = s * dw * dTheta;
      if (energy <= 1e-12) continue;
      const k = kFromOmega(w, spec.depth);
      // 波数向量沿传播方向 θ+π
      const kx = k * Math.cos(theta + Math.PI);
      const ky = k * Math.sin(theta + Math.PI);
      // 遮蔽：对小艇作业点的该方向分量施加衰减
      let f = 1;
      if (cfg.shelter) {
        f = shelterFactorAt(
          { ...cfg.shelter, shipHeading: cfg.shipHeading },
          cfg.boatOffsetX,
          cfg.boatOffsetY,
        );
      }
      list.push({
        omega: w,
        kx,
        ky,
        amp: Math.sqrt(2 * energy),
        phase: rng() * 2 * Math.PI,
        theta,
        shelterF: f,
      });
    }
  }
  return list;
}

/** 运行时域仿真 */
export function runSimulation(
  spec: DirectionalSpectrumData,
  vessel: Vessel,
  cfg: SimulationConfig,
): SimulationResult {
  const rao = vessel.rao!;
  const harmonics = buildHarmonics(spec, cfg);
  const ladderGeo = buildLadderGeometry(vessel);
  const dt = 1 / cfg.sampleRate;
  const nSample = Math.round(cfg.duration * cfg.sampleRate);

  // 预计算每个谐波在两个点上的复响应系数
  const ladderPoint = { x: vessel.ladderX, y: vessel.ladderY };
  const ladderCoef = harmonics.map((h) => {
    const mu = angleDiff(cfg.shipHeading, h.theta);
    const r = lookupRao(rao, h.omega, mu);
    // 船上点垂向绝对位移 H = 1 + Hheave + y·Hroll - x·Hpitch
    const re =
      1 + r.heave.re + ladderPoint.y * r.roll.re - ladderPoint.x * r.pitch.re;
    const im =
      r.heave.im + ladderPoint.y * r.roll.im - ladderPoint.x * r.pitch.im;
    return { re, im };
  });
  const boatCoef = harmonics.map((h) => pilotBoatVerticalTransfer(h.omega));
  // 横摇/纵摇时序系数（用于软梯几何）
  const rollCoef = harmonics.map((h) => {
    const mu = angleDiff(cfg.shipHeading, h.theta);
    return lookupRao(rao, h.omega, mu).roll;
  });
  const pitchCoef = harmonics.map((h) => {
    const mu = angleDiff(cfg.shipHeading, h.theta);
    return lookupRao(rao, h.omega, mu).pitch;
  });

  const rawLadder = new Float64Array(nSample);
  const rawBoat = new Float64Array(nSample);
  const rawWave = new Float64Array(nSample);
  const rawVelL = new Float64Array(nSample);
  const rawVelB = new Float64Array(nSample);
  const rollArr = new Float64Array(nSample);
  const pitchArr = new Float64Array(nSample);
  const times = new Float64Array(nSample);

  for (let n = 0; n < nSample; n++) {
    const t = n * dt;
    times[n] = t;
    let zL = 0;
    let zB = 0;
    let zW = 0;
    let vL = 0;
    let vB = 0;
    let roll = 0;
    let pitch = 0;
    for (let q = 0; q < harmonics.length; q++) {
      const h = harmonics[q];
      // 空间相位：对拍频域基准以船位为参考点，可关闭
      const useSpatial = cfg.includeSpatialPhase ?? true;
      const spatialL = useSpatial ? h.kx * ladderPoint.x + h.ky * ladderPoint.y : 0;
      const spatialB = useSpatial ? h.kx * cfg.boatOffsetX + h.ky * cfg.boatOffsetY : 0;
      // 标准 +ωt 相位约定，与 RAO 复传递 H=re+i·im 的相位定义一致：
      // 输入 cos(arg)，输出 re·cos(arg) + im·sin(arg)（Re[H·e^{i·arg}]）
      const argL = h.omega * t - spatialL - h.phase;
      const cosL = Math.cos(argL);
      const sinL = Math.sin(argL);
      // 波面（梯位，无遮蔽）
      zW += h.amp * cosL;
      // 梯底复传递
      const cL = ladderCoef[q];
      zL += h.amp * (cL.re * cosL + cL.im * sinL);
      // 解析速度：d/dt Re[H·e^{i·arg}] = ω·(-re·sin + im·cos)
      vL += h.amp * h.omega * (-cL.re * sinL + cL.im * cosL);
      // 小艇（裸传递函数，与频域对拍基准一致；遮蔽仅用于可视化/作业评估）
      const argB = h.omega * t - spatialB - h.phase;
      const cosB = Math.cos(argB);
      const sinB = Math.sin(argB);
      const cB = boatCoef[q];
      zB += h.amp * (cB.re * cosB + cB.im * sinB);
      vB += h.amp * h.omega * (-cB.re * sinB + cB.im * cosB);
      // 姿态
      roll += h.amp * (rollCoef[q].re * cosL + rollCoef[q].im * sinL);
      pitch += h.amp * (pitchCoef[q].re * cosL + pitchCoef[q].im * sinL);
    }
    rawLadder[n] = zL;
    rawBoat[n] = zB;
    rawWave[n] = zW;
    rawVelL[n] = vL;
    rawVelB[n] = vB;
    rollArr[n] = roll;
    pitchArr[n] = pitch;
  }

  // 相对位移与相对速度（解析求导，与频域 ω²S 积分严格同构）
  const samples: MotionSample[] = new Array(nSample);
  const rel = new Float64Array(nSample);
  const vel = new Float64Array(nSample);
  let swing = 0;
  let minClearance = Infinity;
  let maxClearance = -Infinity;
  let contactCount = 0;

  for (let n = 0; n < nSample; n++) {
    rel[n] = rawLadder[n] - rawBoat[n];
    vel[n] = rawVelL[n] - rawVelB[n];

    swing = stepLadderSwing(swing, rollArr[n], ladderGeo.length, dt);
    const ladderState = evaluateLadder(ladderGeo, swing, rollArr[n], pitchArr[n], rawWave[n]);
    minClearance = Math.min(minClearance, ladderState.clearanceAboveWater);
    maxClearance = Math.max(maxClearance, ladderState.clearanceAboveWater);
    if (ladderState.touchesHull) contactCount++;

    const exceed =
      Math.abs(rel[n]) > cfg.thresholds.maxRelativeDisplacement ||
      Math.abs(vel[n]) > cfg.thresholds.maxRelativeVelocity;
    samples[n] = {
      t: times[n],
      ladderZ: rawLadder[n],
      boatZ: rawBoat[n],
      relDisp: rel[n],
      relVel: vel[n],
      waveAtLadder: rawWave[n],
      roll: rollArr[n],
      pitch: pitchArr[n],
      ladderSwing: swing,
      ladderClearance: ladderState.clearanceAboveWater,
      ladderHullGap: ladderState.hullGap,
      exceed,
    };
  }

  // 有义值（零均值 4σ），采用分段 RMS 平均（Welch 思想）抑制单实现涨落：
  // 将序列切成若干等长段，各段独立求 RMS 后平均，等效增加独立样本数。
  const sigDisplacement = 4 * segmentedRms(rel);
  const sigVelocity = 4 * segmentedRms(vel);

  const safeWindows = extractWindows(samples, (s) => !s.exceed, dt, cfg.thresholds.minWindowDuration);
  const exceedWindows = extractWindows(samples, (s) => s.exceed, dt, 0.5);
  const minutes = cfg.duration / 60;

  return {
    samples,
    dt,
    sigDisplacement,
    sigVelocity,
    exceedWindows,
    safeWindows,
    safeWindowsPerMinute: safeWindows.length / minutes,
    minClearance,
    maxClearance,
    hullContactRatio: contactCount / nSample,
  };
}

function rms(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/**
 * 多次独立相位实现的集合平均（ensemble）。
 * 单次随机相位实现的方差估计存在固有涨落，对 K 个独立种子的
 * 位移/速度「方差」（RMS²）取算术平均，统计误差按 1/√K 下降。
 * 返回的代表结果取第一次实现（保留确定性时序用于展示），
 * 但 sigDisplacement/sigVelocity 用集合平均后的方差重算。
 */
export function runSimulationEnsemble(
  spec: DirectionalSpectrumData,
  vessel: Vessel,
  cfg: SimulationConfig,
  runs: number,
): SimulationResult {
  const base = runSimulation(spec, vessel, cfg);
  if (runs <= 1) return base;
  let sumVarD = (base.sigDisplacement / 4) ** 2;
  let sumVarV = (base.sigVelocity / 4) ** 2;
  for (let k = 1; k < runs; k++) {
    const r = runSimulation(spec, vessel, { ...cfg, seed: (cfg.seed >>> 0) + k * 7919 });
    sumVarD += (r.sigDisplacement / 4) ** 2;
    sumVarV += (r.sigVelocity / 4) ** 2;
  }
  return {
    ...base,
    sigDisplacement: 4 * Math.sqrt(sumVarD / runs),
    sigVelocity: 4 * Math.sqrt(sumVarV / runs),
  };
}

/**
 * 分段 RMS 平均（Welch 式）：把序列切成 nSeg 段，
 * 每段去均值后求 RMS，再对各段 RMS 取平均。
 * 段数取 min(16, floor(√N))，保证每段仍含足够多个波周期，
 * 同时把单实现的方差估计涨落降低约 √nSeg 倍。
 */
function segmentedRms(x: Float64Array): number {
  const n = x.length;
  const nSeg = Math.max(1, Math.min(16, Math.floor(Math.sqrt(n))));
  const segLen = Math.floor(n / nSeg);
  if (segLen < 8 || nSeg === 1) return rms(x);
  let acc = 0;
  for (let s = 0; s < nSeg; s++) {
    const start = s * segLen;
    let m = 0;
    for (let i = start; i < start + segLen; i++) m += x[i];
    m /= segLen;
    let ss = 0;
    for (let i = start; i < start + segLen; i++) {
      const d = x[i] - m;
      ss += d * d;
    }
    acc += Math.sqrt(ss / segLen);
  }
  return acc / nSeg;
}

function extractWindows(
  samples: MotionSample[],
  predicate: (s: MotionSample) => boolean,
  dt: number,
  minDuration: number,
): SafetyWindow[] {
  const out: SafetyWindow[] = [];
  let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    const inside = i < samples.length && predicate(samples[i]);
    if (inside && start < 0) start = samples[i].t;
    if (!inside && start >= 0) {
      const end = samples[i - 1].t + dt;
      if (end - start >= minDuration) out.push({ start, end, duration: end - start });
      start = -1;
    }
  }
  return out;
}

/** 基于结果做可行性结论（供可行性单） */
export function assessFeasibility(
  result: SimulationResult,
  thresholds: SafetyThresholds,
  hs: number,
): { feasible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let feasible = true;
  if (hs > thresholds.maxSignificantHeight) {
    feasible = false;
    reasons.push(`有效波高 ${hs.toFixed(2)} m 超过停航阈值 ${thresholds.maxSignificantHeight} m`);
  }
  if (result.sigDisplacement > thresholds.maxRelativeDisplacement) {
    feasible = false;
    reasons.push(
      `相对垂向位移有义值 ${result.sigDisplacement.toFixed(2)} m 超过上限 ${thresholds.maxRelativeDisplacement} m`,
    );
  }
  if (result.sigVelocity > thresholds.maxRelativeVelocity) {
    feasible = false;
    reasons.push(
      `相对垂向速度有义值 ${result.sigVelocity.toFixed(2)} m/s 超过上限 ${thresholds.maxRelativeVelocity} m/s`,
    );
  }
  if (result.safeWindowsPerMinute < thresholds.minWindowsPerMinute) {
    feasible = false;
    reasons.push(
      `每分钟安全窗口 ${result.safeWindowsPerMinute.toFixed(1)} 个，少于要求 ${thresholds.minWindowsPerMinute} 个`,
    );
  }
  if (feasible) reasons.push('各项指标均在站定阈值内，具备登轮条件');
  return { feasible, reasons };
}
