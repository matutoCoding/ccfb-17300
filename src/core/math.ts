/**
 * 数学工具：确定性随机数、高斯抽样、插值、角度归一化。
 * 所有随机过程都走可播种的 mulberry32 + Box-Muller，保证同一种子逐位回放。
 */

export const GRAVITY = 9.80665;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** 归一化到 [0, 2π) */
export function normalizeAngle(a: number): number {
  const TWO_PI = 2 * Math.PI;
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
}

/** 归一化到 (-π, π] */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** mulberry32 伪随机数发生器，返回 [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯随机数（Box-Muller），由给定均匀随机源派生 */
export class GaussianRng {
  private spare: number | null = null;
  private uniform: () => number;
  constructor(uniform: () => number) {
    this.uniform = uniform;
  }

  next(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.uniform() * 2 - 1;
      v = this.uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }
}

/** 一维线性插值（xs 升序），越界取端点值 */
export function interp1(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  // 二分查找
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** 双线性插值（二维规则网格），越界夹边 */
export function interp2(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  grid: ArrayLike<number>,
  x: number,
  y: number,
): number {
  const nx = xs.length;
  const ny = ys.length;
  const cx = clamp(x, xs[0], xs[nx - 1]);
  const cy = clamp(y, ys[0], ys[ny - 1]);
  let i = 0;
  while (i < nx - 2 && xs[i + 1] < cx) i++;
  let j = 0;
  while (j < ny - 2 && ys[j + 1] < cy) j++;
  const tx = (cx - xs[i]) / (xs[i + 1] - xs[i] || 1);
  const ty = (cy - ys[j]) / (ys[j + 1] - ys[j] || 1);
  const v00 = grid[j * nx + i];
  const v10 = grid[j * nx + i + 1];
  const v01 = grid[(j + 1) * nx + i];
  const v11 = grid[(j + 1) * nx + i + 1];
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/** 循环角度线性插值（用于方向列上的谱插值），w 为各角度权重 */
export function circularMean(angles: number[], weights: number[]): number {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = 0; i < angles.length; i++) {
    sx += weights[i] * Math.cos(angles[i]);
    sy += weights[i] * Math.sin(angles[i]);
    sw += weights[i];
  }
  if (sw <= 0) return 0;
  return Math.atan2(sy / sw, sx / sw);
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : 0;
}

export function std(xs: ArrayLike<number>): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (xs.length - 1));
}

/** 零均值序列的均方根 */
export function rms(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] * xs[i];
  return Math.sqrt(s / xs.length);
}

/** 有义值 = 4σ（零均值窄/宽带过程通用定义，与 Hs=4√m0 一致） */
export function significantValue(xs: ArrayLike<number>): number {
  return 4 * rms(xs);
}

/** 梯形积分 */
export function trapz(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < xs.length; i++) {
    s += 0.5 * (ys[i] + ys[i - 1]) * (xs[i] - xs[i - 1]);
  }
  return s;
}

/** 等间距数组梯形积分 */
export function trapzUniform(ys: ArrayLike<number>, dx: number): number {
  let s = 0;
  for (let i = 1; i < ys.length; i++) s += ys[i] + ys[i - 1];
  return 0.5 * dx * s;
}
