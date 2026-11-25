/**
 * 浮标方向谱文件解析。
 *
 * 支持两种自描述文本格式（扩展名 .csv/.txt，首行表头）：
 * 1. 稠密网格：f_hz,theta_deg,energy（单位 m²/Hz/rad，内部换算为 m²·s/rad）
 * 2. 矩参数行：f_hz,a1,b1,a2,b2（ITTC 推荐浮标格式，
 *    方向分布 D(θ,f)=1/π{1+2[a1cosθ+b1sinθ]+2[a2cos2θ+b2sin2θ]}）
 *
 * 坏数据检测：
 * - 行列字段缺失/非数值/能量为负 → 坏行，跳过并计数；
 * - 频率列相对中位频率步长缺一段（>1.5 倍中位步长）→ 缺频段告警，
 *   缺口内部不补值，积分时由梯形积分自然过渡，并在报告中列出区间。
 */
export interface BuoyParseResult {
  ok: boolean;
  /** 频率列 Hz，升序去重 */
  frequenciesHz: number[];
  /** 方向列 rad（矩参数格式时内部展开 36 个方向） */
  thetas: number[];
  /** S(ω,θ) 行主序 [iTheta][iFreq]，单位 m²·s/rad（对 ω 的谱密度） */
  values: number[][];
  warnings: string[];
  errors: string[];
  totalRows: number;
  badRows: number;
  format: 'dense' | 'moment' | 'unknown';
}

interface DenseRow {
  f: number;
  theta: number;
  e: number;
}
interface MomentRow {
  f: number;
  a1: number;
  b1: number;
  a2: number;
  b2: number;
}

export function parseBuoyFile(text: string): BuoyParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const warnings: string[] = [];
  const errors: string[] = [];
  if (lines.length < 2) {
    return emptyResult(warnings, errors, lines.length, 0, 'unknown');
  }
  const header = lines[0].toLowerCase();
  const isMoment = /a1/.test(header) && /b1/.test(header);
  const isDense = /f_hz/.test(header) && /theta/.test(header) && /energy/.test(header);

  if (isMoment) return parseMoment(lines, warnings, errors);
  if (isDense) return parseDense(lines, warnings, errors);
  errors.push('无法识别表头：应以 f_hz,theta_deg,energy 或 f_hz,a1,b1,a2,b2 开头');
  return emptyResult(warnings, errors, lines.length - 1, 0, 'unknown');
}

function emptyResult(
  warnings: string[],
  errors: string[],
  totalRows: number,
  badRows: number,
  format: BuoyParseResult['format'],
): BuoyParseResult {
  return {
    ok: false,
    frequenciesHz: [],
    thetas: [],
    values: [],
    warnings,
    errors,
    totalRows,
    badRows,
    format,
  };
}

function parseDense(
  lines: string[],
  warnings: string[],
  errors: string[],
): BuoyParseResult {
  const rows: DenseRow[] = [];
  let bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/[,\t]+/).map((s) => s.trim());
    if (parts.length < 3) {
      bad++;
      warnings.push(`第 ${i + 1} 行字段不足，已跳过：${lines[i]}`);
      continue;
    }
    const f = Number(parts[0]);
    const thetaDeg = Number(parts[1]);
    const e = Number(parts[2]);
    if ([f, thetaDeg, e].some((v) => !Number.isFinite(v))) {
      bad++;
      warnings.push(`第 ${i + 1} 行含非数值/空字段，已跳过：${lines[i]}`);
      continue;
    }
    if (e < 0) {
      bad++;
      warnings.push(`第 ${i + 1} 行能量为负（${e}），已跳过`);
      continue;
    }
    rows.push({ f, theta: (thetaDeg * Math.PI) / 180, e });
  }
  if (rows.length === 0) {
    errors.push('没有任何有效数据行');
    return emptyResult(warnings, errors, lines.length - 1, bad, 'dense');
  }
  const freqSet = [...new Set(rows.map((r) => r.f))].sort((a, b) => a - b);
  const thetaSet = [...new Set(rows.map((r) => normalizeTheta(r.theta)))].sort((a, b) => a - b);
  const missing = detectMissingBands(freqSet);
  missing.forEach(([f0, f1]) =>
    warnings.push(`缺频段：${f0.toFixed(4)} ~ ${f1.toFixed(4)} Hz（该区间无浮标采样）`),
  );

  // 单位换算：S(f) [m²/Hz] → S(ω) [m²·s] 需除以 2π；方向密度对 rad 再除一次
  const nTheta = thetaSet.length;
  const dTheta = (2 * Math.PI) / nTheta;
  const values = thetaSet.map(() => new Array<number>(freqSet.length).fill(0));
  for (const r of rows) {
    const iF = freqSet.indexOf(r.f);
    const iT = thetaSet.indexOf(normalizeTheta(r.theta));
    values[iT][iF] = r.e / (2 * Math.PI * dTheta);
  }
  return {
    ok: true,
    frequenciesHz: freqSet,
    thetas: thetaSet,
    values,
    warnings,
    errors,
    totalRows: lines.length - 1,
    badRows: bad,
    format: 'dense',
  };
}

function parseMoment(
  lines: string[],
  warnings: string[],
  errors: string[],
): BuoyParseResult {
  const rows: MomentRow[] = [];
  let bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/[,\t]+/).map((s) => s.trim());
    if (parts.length < 5) {
      bad++;
      warnings.push(`第 ${i + 1} 行字段不足，已跳过：${lines[i]}`);
      continue;
    }
    const nums = parts.slice(0, 5).map(Number);
    if (nums.some((v) => !Number.isFinite(v))) {
      bad++;
      warnings.push(`第 ${i + 1} 行含非数值/空字段，已跳过：${lines[i]}`);
      continue;
    }
    // 总能量在第 6 列时可选；这里只用矩参数重构方向分布
    rows.push({ f: nums[0], a1: nums[1], b1: nums[2], a2: nums[3], b2: nums[4] });
  }
  if (rows.length === 0) {
    errors.push('没有任何有效数据行');
    return emptyResult(warnings, errors, lines.length - 1, bad, 'moment');
  }
  const freqSet = rows.map((r) => r.f).sort((a, b) => a - b);
  detectMissingBands(freqSet).forEach(([f0, f1]) =>
    warnings.push(`缺频段：${f0.toFixed(4)} ~ ${f1.toFixed(4)} Hz（该区间无浮标采样）`),
  );

  const nTheta = 36;
  const thetas = Array.from({ length: nTheta }, (_, j) => (2 * Math.PI * j) / nTheta);
  // 一维能量 E(f)=S(f)：矩参数格式把总能量放在可选第 6 列；
  // 本实现约定第 6 列为 E(f) [m²/Hz]，缺失时按经验由矩幅度反推一个量级并告警。
  const rawLines = lines.slice(1);
  const hasEnergy = rawLines.some((l) => l.split(/[,\t]+/).length >= 6);
  if (!hasEnergy) warnings.push('未提供总能量列，一维谱由方向矩幅度估算，建议核对标定');

  const values = thetas.map(() => new Array<number>(freqSet.length).fill(0));
  freqSet.forEach((_f, iF) => {
    const line = rawLines[iF].split(/[,\t]+/).map((s) => s.trim());
    const eTotal = hasEnergy ? Number(line[5]) : estimateEnergy(rows[iF]);
    rows.forEach(() => undefined);
    const row = rows[iF];
    for (let j = 0; j < nTheta; j++) {
      const th = thetas[j];
      const d =
        (1 / Math.PI) *
        (1 +
          2 * (row.a1 * Math.cos(th) + row.b1 * Math.sin(th)) +
          2 * (row.a2 * Math.cos(2 * th) + row.b2 * Math.sin(2 * th)));
      const dClamped = Math.max(0, d);
      // D 为「对 rad 的方向密度」，S(ω,θ)=S(ω)·D，S(ω)=E(f)/(2π)
      values[j][iF] = (eTotal / (2 * Math.PI)) * dClamped;
    }
  });
  return {
    ok: true,
    frequenciesHz: freqSet,
    thetas,
    values,
    warnings,
    errors,
    totalRows: lines.length - 1,
    badRows: bad,
    format: 'moment',
  };
}

function estimateEnergy(row: MomentRow): number {
  // 无总能量列时的兜底：由一阶矩幅度给一个保守量级（仅用于可用性预览）
  const m1 = Math.hypot(row.a1, row.b1);
  return 0.25 * m1 * m1;
}

function normalizeTheta(t: number): number {
  const TWO_PI = 2 * Math.PI;
  return ((t % TWO_PI) + TWO_PI) % TWO_PI;
}

/** 缺频段检测：相邻频率间隔 >1.5 倍中位步长视为缺口 */
function detectMissingBands(freqs: number[]): Array<[number, number]> {
  if (freqs.length < 3) return [];
  const gaps: number[] = [];
  for (let i = 1; i < freqs.length; i++) gaps.push(freqs[i] - freqs[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const out: Array<[number, number]> = [];
  for (let i = 1; i < freqs.length; i++) {
    if (freqs[i] - freqs[i - 1] > median * 1.5) {
      out.push([freqs[i - 1], freqs[i]]);
    }
  }
  return out;
}

/** 由解析结果生成可下载的示例浮标文件文本（种子数据用） */
export function encodeDenseBuoyFile(
  frequenciesHz: number[],
  thetasRad: number[],
  valuesOmega: number[][],
): string {
  const lines = ['f_hz,theta_deg,energy'];
  const nTheta = thetasRad.length;
  const dTheta = (2 * Math.PI) / nTheta;
  frequenciesHz.forEach((f, iF) => {
    thetasRad.forEach((th, iT) => {
      // 反向换算：S(f,θ)[m²/Hz/rad] = S(ω,θ)·2π·dθ
      const e = valuesOmega[iT][iF] * 2 * Math.PI * dTheta;
      lines.push(`${f.toFixed(5)},${((th * 180) / Math.PI).toFixed(1)},${e.toExponential(5)}`);
    });
  });
  return lines.join('\n');
}
