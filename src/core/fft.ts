/**
 * 复数 FFT（CPU 参考实现，用于与 WebGPU compute shader 逐元素对拍）。
 * 迭代式 radix-2 Cooley–Tukey，1/N 归一化放在逆变换。
 */
import type { ComplexArray } from './types.ts';

export function makeComplex(n: number): ComplexArray {
  return { re: new Float64Array(n), im: new Float64Array(n) };
}

export function cloneComplex(c: ComplexArray): ComplexArray {
  return { re: new Float64Array(c.re), im: new Float64Array(c.im) };
}

/** 位反转置换 */
function bitReverse(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
}

/**
 * 一维 FFT（原地）。
 * @param inverse true=逆变换（带 1/N 归一化）
 */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
  bitReverse(re, im);
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 二维 FFT：先逐行后逐列（原地，要求方阵 N×N） */
export function fft2d(c: ComplexArray, inverse: boolean): void {
  const n = Math.round(Math.sqrt(c.re.length));
  if (n * n !== c.re.length) throw new Error('fft2d 要求 N×N 方阵');
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  // 行
  for (let j = 0; j < n; j++) {
    const base = j * n;
    for (let i = 0; i < n; i++) {
      rowRe[i] = c.re[base + i];
      rowIm[i] = c.im[base + i];
    }
    fft1d(rowRe, rowIm, inverse);
    for (let i = 0; i < n; i++) {
      c.re[base + i] = rowRe[i];
      c.im[base + i] = rowIm[i];
    }
  }
  // 列
  const colRe = new Float64Array(n);
  const colIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      colRe[j] = c.re[j * n + i];
      colIm[j] = c.im[j * n + i];
    }
    fft1d(colRe, colIm, inverse);
    for (let j = 0; j < n; j++) {
      c.re[j * n + i] = colRe[j];
      c.im[j * n + i] = colIm[j];
    }
  }
}

/** 由频域系数计算某一时刻的物理场（逆变换，返回新数组） */
export function inverseFft2dAt(source: ComplexArray, timeEvolve: (idx: number) => { re: number; im: number }): Float64Array {
  const n = Math.round(Math.sqrt(source.re.length));
  const work = cloneComplex(source);
  for (let idx = 0; idx < n * n; idx++) {
    const e = timeEvolve(idx);
    const re = work.re[idx];
    const im = work.im[idx];
    // (re+i·im)·(e.re+i·e.im)
    work.re[idx] = re * e.re - im * e.im;
    work.im[idx] = re * e.im + im * e.re;
  }
  fft2d(work, true);
  return work.re;
}
