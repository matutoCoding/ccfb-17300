/**
 * 软梯动力学与合规检查。
 *
 * 软梯视为上端铰接在船舷的单摆：
 *   I·θ̈ + c·θ̇ + m·g_eff·sinθ = 船舶横摇/横摇加速度通过铰接点施加的强迫项，
 * 工程上用「随动+滞后」模型：
 *   平衡角 θ_eq = -k_tail·φ（φ 为船体横摇角，梯下端因惯性滞后），
 *   一阶滞后 θ̇ = (θ_eq - θ)/τ，τ≈0.6·√(L/g)。
 * 同时输出：梯底端相对船壳的贴合间隙、底端距瞬时水面高度，
 * 以及干舷 >9 m 必须改用组合梯的合规提示（GB/IMO 引航软梯规则）。
 */
import type { Vessel } from './types.ts';
import { GRAVITY, clamp } from './math.ts';

export interface LadderGeometry {
  vessel: Vessel;
  /** 梯长 m（通常 = 干舷 + 1.5 m 入水余量） */
  length: number;
  /** 梯顶端在船体坐标的位置 m */
  topX: number;
  topY: number;
  topZ: number;
}

export interface LadderState {
  /** 相对垂直方向的摆角 rad（正=向舷外） */
  swingAngle: number;
  /** 梯底端世界/船体坐标（x 纵向, y 横向, z 垂向，相对船中静水面） */
  bottomX: number;
  bottomY: number;
  bottomZ: number;
  /** 梯底端与船壳板的水平间隙 m（<0 表示压在壳上） */
  hullGap: number;
  /** 梯底端距当地瞬时波面的高度 m（负=入水） */
  clearanceAboveWater: number;
  /** 是否贴合船壳（间隙小于阈值） */
  touchesHull: boolean;
}

export function buildLadderGeometry(v: Vessel): LadderGeometry {
  return {
    vessel: v,
    length: v.freeboard + 1.5,
    topX: v.ladderX,
    topY: v.ladderY,
    topZ: v.freeboard,
  };
}

/** 滞后时间常数 τ */
export function ladderTimeConstant(length: number): number {
  return 0.6 * Math.sqrt(length / GRAVITY);
}

/**
 * 推进软梯摆角（半隐式 Euler，dt 建议 ≤0.1 s）。
 * @param swing 当前摆角
 * @param roll 当前船体横摇角 rad
 * @param length 梯长
 * @param dt 步长
 */
export function stepLadderSwing(swing: number, roll: number, length: number, dt: number): number {
  const tau = ladderTimeConstant(length);
  // 横摇强迫：船向舷内摇时梯因惯性向外摆，符号取负
  const thetaEq = -0.85 * roll;
  const d = (thetaEq - swing) / tau;
  return clamp(swing + d * dt, -0.6, 0.6);
}

/**
 * 给定船体姿态计算软梯几何状态。
 * @param roll 横摇角 rad
 * @param pitch 纵摇角 rad
 * @param localWaveHeight 梯位处当地波面高度 m
 */
export function evaluateLadder(
  geo: LadderGeometry,
  swing: number,
  roll: number,
  pitch: number,
  localWaveHeight: number,
): LadderState {
  const { length, topX, topY, topZ, vessel } = geo;
  const side = Math.sign(topY) || 1;
  // 底端相对铰接点：横摇引起的几何偏转 + 动态摆角（向外为正）
  const totalAngle = roll * side + swing * side;
  // 船体系下的底端偏移
  let dy = side * length * Math.sin(totalAngle);
  const dz = -length * Math.cos(totalAngle);
  // 纵摇对纵向位置的小修正
  const dx = -length * Math.sin(pitch) * 0.2;

  const bottomX = topX + dx;
  const bottomY = topY + dy;
  const bottomZ = topZ + dz;

  // 与船壳间隙：舷侧板在 y=±beam/2 附近；梯底端横向超出壳板的距离
  const hullY = side * vessel.beam / 2;
  const hullGap = side * (bottomY - hullY);
  const touchesHull = hullGap < 0.08;

  const clearanceAboveWater = bottomZ - localWaveHeight;
  return {
    swingAngle: swing,
    bottomX,
    bottomY,
    bottomZ,
    hullGap,
    clearanceAboveWater,
    touchesHull,
  };
}

/** 组合梯合规检查：干舷超过阈值（默认 9 m）必须配组合梯 */
export function combinationLadderRequired(v: Vessel, threshold = 9): {
  required: boolean;
  reason: string;
} {
  if (v.freeboard > threshold) {
    return {
      required: true,
      reason: `干舷 ${v.freeboard.toFixed(2)} m 超过 ${threshold} m，按规定必须使用组合梯（引航员升降装置/舷梯组合）`,
    };
  }
  return { required: false, reason: `干舷 ${v.freeboard.toFixed(2)} m，可使用单软梯` };
}

/** 梯底端入水深度预警（负值表示入水，超过 1 m 报警） */
export function ladderWaterWarning(state: LadderState): { level: 'ok' | 'warn' | 'danger'; message: string } {
  if (state.clearanceAboveWater < -1) {
    return { level: 'danger', message: `梯底端入水 ${(-state.clearanceAboveWater).toFixed(2)} m，存在没顶风险` };
  }
  if (state.clearanceAboveWater < 0) {
    return { level: 'warn', message: `梯底端入水 ${(-state.clearanceAboveWater).toFixed(2)} m，注意涌浪抬升` };
  }
  if (state.clearanceAboveWater > 2.5) {
    return { level: 'warn', message: `梯底端距水面 ${state.clearanceAboveWater.toFixed(2)} m，跨距偏大` };
  }
  return { level: 'ok', message: `底端距水面 ${state.clearanceAboveWater.toFixed(2)} m` };
}
