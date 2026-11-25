/**
 * 船舶运动 RAO。
 * - 支持导入的幅值/相位表，按浪向 μ（船首与来浪夹角，0=迎浪）与频率双线性插值；
 * - 无表时按船宽 B 与初稳性高 GM 粗估横摇固有周期 Tφ≈2π√(k·B²/(g·GM))，
 *   并用单自由度平滑曲线生成全套解析 RAO，供仿真与测试使用。
 * 单位约定：heave 幅值 m/m（波高输入），pitch/roll 幅值 rad/m。
 */
import type { RaoTable, Vessel } from './types.ts';
import { GRAVITY, interp1 } from './math.ts';

/** 横摇固有周期粗估（k 为横摇惯性半径系数，典型 0.35~0.45） */
export function estimateRollPeriod(v: Pick<Vessel, 'beam' | 'gm'>, k = 0.4): number {
  if (!(v.gm > 0)) return NaN;
  return 2 * Math.PI * Math.sqrt((k * v.beam) ** 2 / (GRAVITY * v.gm));
}

/** 横摇固有角频率 */
export function estimateRollOmega(v: Pick<Vessel, 'beam' | 'gm'>, k = 0.4): number {
  const t = estimateRollPeriod(v, k);
  return Number.isFinite(t) ? (2 * Math.PI) / t : 0;
}

/** RAO 表标准浪向列（rad，0=迎浪 … π=随浪） */
export const RAO_HEADINGS = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, (2 * Math.PI) / 3, (5 * Math.PI) / 6, Math.PI];

/** RAO 表标准频率列（rad/s，覆盖 0.2~2.0） */
export const RAO_OMEGAS = (() => {
  const arr: number[] = [];
  for (let i = 0; i <= 24; i++) arr.push(0.2 + (1.8 * i) / 24);
  return arr;
})();

function sdofCurve(omega: number, wn: number, zeta: number): number {
  const r = omega / wn;
  const denom = Math.sqrt((1 - r * r) ** 2 + (2 * zeta * r) ** 2);
  return 1 / denom;
}

/**
 * 生成解析 RAO 表（种子数据与无表船舶使用）。
 * 横摇：以固有频率为峰的单自由度曲线，横浪最大、迎随浪趋零；
 * 纵摇：以较低固有频率为峰，迎/随浪大、横浪趋零；
 * 垂荡：低频跟随波面（→1），高频衰减。
 */
export function generateAnalyticRao(v: Vessel): RaoTable {
  const wRoll = estimateRollOmega(v, 0.4);
  // 纵摇固有频率：经验上约为横摇的 1.6~2 倍（船长方向刚度大）
  const wPitch = Math.max(0.55, wRoll * 1.8);
  const zetaRoll = 0.12;
  const zetaPitch = 0.18;

  const headings = RAO_HEADINGS;
  const omegas = RAO_OMEGAS;
  const blank = (): number[][] => headings.map(() => new Array<number>(omegas.length).fill(0));
  const rollAmp = blank();
  const rollPhase = blank();
  const pitchAmp = blank();
  const pitchPhase = blank();
  const heaveAmp = blank();
  const heavePhase = blank();

  headings.forEach((mu, ih) => {
    // 浪向加权：横摇 sin μ，纵摇 |cos μ|
    const rollDir = Math.sin(mu);
    const pitchDir = Math.abs(Math.cos(mu));
    // 横摇物理标定：激励为波面斜率 kζ（rad/m 波幅），有效波陡系数取 0.5，
    // 经单自由度共振放大（1/(2ζ)≈4），峰值约 0.15~0.25 rad/m，符合实船量级。
    const rollSlopeFactor = 0.5;
    // 纵摇：同样由波面斜率激励，船长越长静态系数越小
    const pitchSlopeFactor = 0.6 * Math.min(1, 180 / Math.max(120, v.loa));
    omegas.forEach((w, iw) => {
      // 波数（深水近似，用于把斜率激励折算到每米波幅）
      const k = (w * w) / GRAVITY;
      // 横摇
      const rr = sdofCurve(w, wRoll, zetaRoll);
      rollAmp[ih][iw] = rollSlopeFactor * k * rollDir * rr;
      rollPhase[ih][iw] = sdofPhase(w, wRoll, zetaRoll);
      // 纵摇
      const rp = sdofCurve(w, wPitch, zetaPitch);
      pitchAmp[ih][iw] = pitchSlopeFactor * k * pitchDir * rp;
      pitchPhase[ih][iw] = sdofPhase(w, wPitch, zetaPitch);
      // 垂荡：二阶低通，截止频率取 √(g/T) 经验量；低频随浪→1
      const wc = Math.sqrt(GRAVITY / Math.max(8, v.draft * 2));
      const heaveResp = 1 / Math.sqrt((1 - (w / wc) ** 2) ** 2 + (2 * 0.25 * (w / wc)) ** 2);
      heaveAmp[ih][iw] = Math.min(1.1, heaveResp);
      heavePhase[ih][iw] = sdofPhase(w, wc, 0.25);
    });
  });

  return { headings, omegas, rollAmp, rollPhase, pitchAmp, pitchPhase, heaveAmp, heavePhase };
}

/** 单自由度位移传递相位（滞后，取负） */
function sdofPhase(w: number, wn: number, zeta: number): number {
  const r = w / wn;
  return -Math.atan2(2 * zeta * r, 1 - r * r);
}

/**
 * RAO 查表（浪向折叠到 [0,π]，频率夹边）。
 * 返回三个自由度的复传递函数 H(ω,μ)。
 */
export function lookupRao(
  table: RaoTable,
  omega: number,
  mu: number,
): { roll: { re: number; im: number }; pitch: { re: number; im: number }; heave: { re: number; im: number } } {
  // μ 折叠：左右舷对称
  let m = ((mu % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (m > Math.PI) m = 2 * Math.PI - m;

  const pick = (amp: number[][], phase: number[][]) => {
    // 沿浪向插值
    const hAmp = interp1(table.headings, amp.map((row) => interp1(table.omegas, row, omega)), m);
    const hPhase = interp1(table.headings, phase.map((row) => interp1(table.omegas, row, omega)), m);
    return { re: hAmp * Math.cos(hPhase), im: hAmp * Math.sin(hPhase) };
  };

  return {
    roll: pick(table.rollAmp, table.rollPhase),
    pitch: pick(table.pitchAmp, table.pitchPhase),
    heave: pick(table.heaveAmp, table.heavePhase),
  };
}

/** 确保船舶有 RAO（无表则现场生成解析表并挂回） */
export function ensureRao(v: Vessel): RaoTable {
  if (v.rao) return v.rao;
  v.rao = generateAnalyticRao(v);
  return v.rao;
}
