/**
 * 色散关系（含浅水修正）。
 * 有限水深：ω² = g·k·tanh(k·h)
 * 深水极限：ω² = g·k
 *
 * 引航登轮区水深可能只有十几米，长涌在此处明显浅水变形，
 * 因此正解/反解全部按有限水深处理，Infinity 水深时退化为深水公式。
 */
import { GRAVITY } from './math.ts';

export const DEEP_WATER = Number.POSITIVE_INFINITY;

/** 由波数 k 求角频率 ω */
export function omegaFromK(k: number, depth: number): number {
  if (!Number.isFinite(depth)) return Math.sqrt(GRAVITY * k);
  return Math.sqrt(GRAVITY * k * Math.tanh(k * depth));
}

/**
 * 由角频率 ω 反求波数 k（色散方程反解）。
 * Newton 迭代，初值采用 Eckart 近似 k≈ω²/g / √tanh(ω²h/g)，
 * 该初值在全水深范围误差都很小，通常 3~4 次迭代即收敛到 1e-12。
 */
export function kFromOmega(omega: number, depth: number): number {
  if (omega <= 0) return 0;
  if (!Number.isFinite(depth)) return (omega * omega) / GRAVITY;

  const w2g = (omega * omega) / GRAVITY;
  // Eckart (1952) 近似作为初值
  let k = w2g / Math.sqrt(Math.tanh(w2g * depth));
  for (let iter = 0; iter < 30; iter++) {
    const kh = k * depth;
    const t = Math.tanh(kh);
    const f = GRAVITY * k * t - omega * omega;
    // df/dk = g (tanh(kh) + kh·sech²(kh))
    const sech2 = 1 - t * t;
    const df = GRAVITY * (t + kh * sech2);
    const step = f / df;
    k -= step;
    if (k <= 0) k = w2g * 0.5;
    if (Math.abs(step) < 1e-12 * k) break;
  }
  return k;
}

/** 相速度 c=ω/k */
export function phaseSpeed(omega: number, depth: number): number {
  const k = kFromOmega(omega, depth);
  return k > 0 ? omega / k : 0;
}

/** 群速度 cg = (1/2)c·(1 + 2kh/sinh(2kh))；深水为 c/2，浅水为 c */
export function groupSpeed(omega: number, depth: number): number {
  if (!Number.isFinite(depth)) {
    return 0.5 * (GRAVITY / omega);
  }
  const k = kFromOmega(omega, depth);
  if (k === 0) return 0;
  const kh = k * depth;
  const n = 0.5 * (1 + (2 * kh) / Math.sinh(2 * kh));
  return n * (omega / k);
}

/** 由 k 网格向量 (kx,ky) 求色散频率，供 FFT 海面每个傅里叶系数使用 */
export function omegaFromKxKy(kx: number, ky: number, depth: number): number {
  return omegaFromK(Math.hypot(kx, ky), depth);
}

/**
 * 遭遇频率（带符号）：船舶以航速 U、航向 χ 与来浪（方向 θ）相遇。
 *
 * 约定：waveDir 为浪的「来向」（气象惯例），波能朝 waveDir+π 传播；
 * μ = shipHeading - waveDir，迎浪 μ=0、横浪 μ=±π/2、随浪 μ=π。
 * 由相位沿船迹求导得 ωe = ω + kU·cos μ。
 * 随浪且 kU·cosμ 足够大时 ωe 可为负（屏障条件），此处保留符号，
 * 需要幅值的调用方自行取绝对值。
 */
export function encounterOmega(
  omega: number,
  waveDir: number,
  shipHeading: number,
  shipSpeed: number,
  depth: number,
): number {
  const k = kFromOmega(omega, depth);
  const mu = shipHeading - waveDir;
  return omega + k * shipSpeed * Math.cos(mu);
}
