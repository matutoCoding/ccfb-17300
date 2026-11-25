/**
 * 大船挡浪形成的下风舷遮蔽区（工程几何模型）。
 *
 * 物理机理：来浪被船身阻挡/绕射，船的下风（被浪）一侧形成波高衰减区。
 * 本模型按几何绕射思想构造衰减系数场 A(x,y)∈[0,1]（乘到波幅上）：
 * - 取船宽为遮挡宽度，从舷侧向外以衍射扩散角（默认 35°）展开遮蔽锥；
 * - 锥内按相对横向距离 d/B 指数恢复，衰减长度取 1.2 倍船宽；
 * - 纵向超出船长两端 ±0.5L 后遮蔽线性消失（端部绕射）；
 * - 遮蔽强度随风向入射角变化：横浪（来浪垂直舷侧）最强，迎/随浪趋零。
 * 该模型用于可视化与航向优选，属半经验模型，文档与界面均明确标注。
 */
export interface ShelterInput {
  shipHeading: number;   // 船首向 rad
  waveDir: number;       // 来浪方向 rad
  length: number;        // 船长 m
  beam: number;          // 船宽 m
  draft: number;         // 吃水 m（深水处吃水越大挡浪越强，浅水中封顶）
  waterDepth: number;
}

export interface ShelterOptions {
  diffractionAngle?: number; // 扩散角 rad
  recoveryFactor?: number;   // 恢复长度系数（×船宽）
}

/** 入射角因子：横浪=1，迎随浪=0（|sin μ| 的平滑形式） */
export function incidenceFactor(shipHeading: number, waveDir: number): number {
  const mu = Math.abs(Math.atan2(Math.sin(shipHeading - waveDir), Math.cos(shipHeading - waveDir)));
  return Math.sin(mu);
}

/**
 * 计算世界坐标点 (x,y) 的波幅衰减系数（1=无遮蔽，越小越平静）。
 * 船位假定在原点，x 沿船首，y 沿右舷。
 */
export function shelterFactorAt(
  inp: ShelterInput,
  x: number,
  y: number,
  opts: ShelterOptions = {},
): number {
  const spread = opts.diffractionAngle ?? (35 * Math.PI) / 180;
  const recovery = opts.recoveryFactor ?? 1.2;

  const inc = incidenceFactor(inp.shipHeading, inp.waveDir);
  if (inc < 0.02) return 1;

  // 转到船坐标系（x 船首向，y 右舷）
  const ch = Math.cos(-inp.shipHeading);
  const sh = Math.sin(-inp.shipHeading);
  const bx = x * ch - y * sh;
  const by = x * sh + y * ch;

  // 下风舷判定：波能传播方向 = waveDir+π；
  // 船系下波传播的横向分量符号决定被浪舷侧
  const propagateWorld = inp.waveDir + Math.PI - inp.shipHeading;
  const leeSide = Math.sin(propagateWorld); // >0 → 右舷一侧为下风
  const sideY = Math.sign(leeSide);
  if (sideY === 0) return 1;
  const offHull = by * sideY; // 距下风舷外缘的横向距离
  if (offHull < inp.beam / 2) return 1; // 船体内侧不适用
  const d = offHull - inp.beam / 2;

  // 纵向端部绕射：船长两端外线性失效
  const endMargin = 0.15 * inp.length;
  const longEffect =
    Math.abs(bx) <= inp.length / 2
      ? 1
      : Math.max(0, 1 - (Math.abs(bx) - inp.length / 2) / endMargin);
  if (longEffect <= 0) return 1;

  // 遮蔽锥：允许的最大横向偏移随纵向距离展开
  const coneHalf = inp.beam / 2 + Math.abs(bx) * Math.tan(spread);
  if (Math.abs(by) > coneHalf + d) {
    // 锥外仍给弱衰减（绕射尾迹）
  }
  const inCone = Math.abs(by) <= coneHalf + d ? 1 : 0.35;

  // 吃水/水深效应：船身挡住的水深比例
  const blockage = Number.isFinite(inp.waterDepth)
    ? Math.min(1, inp.draft / Math.max(1, inp.waterDepth * 0.6))
    : 0.85;

  const strength = inc * blockage * longEffect * inCone;
  const attenuation = Math.exp(-d / (recovery * inp.beam));
  return 1 - strength * attenuation;
}

/**
 * 全航向扫描：对每个候选航向计算下风舷登轮作业点的平均波能比，
 * 返回遮蔽最优（波能比最低）的若干航向。
 */
export interface HeadingScore {
  heading: number;
  /** 作业点平均波能比（=衰减系数平方的均值），越小越好 */
  energyRatio: number;
  /** 0~1 的遮蔽评分，1 为最佳 */
  score: number;
}

export function scanBestHeadings(
  base: Omit<ShelterInput, 'shipHeading'>,
  /** 登轮作业点在船坐标系的位置（下风舷外若干米，沿船长取若干点） */
  boardingStations: Array<{ x: number; y: number }>,
  stepDeg = 5,
  topK = 5,
): HeadingScore[] {
  const results: HeadingScore[] = [];
  const step = (stepDeg * Math.PI) / 180;
  for (let h = 0; h < 2 * Math.PI; h += step) {
    let sum = 0;
    for (const p of boardingStations) {
      const f = shelterFactorAt({ ...base, shipHeading: h }, p.x, p.y);
      sum += f * f;
    }
    const ratio = sum / boardingStations.length;
    results.push({ heading: h, energyRatio: ratio, score: 1 - ratio });
  }
  results.sort((a, b) => a.energyRatio - b.energyRatio);
  // 去重：相邻 15° 内只保留最优
  const picked: HeadingScore[] = [];
  for (const r of results) {
    if (picked.every((p) => angularDist(p.heading, r.heading) > (15 * Math.PI) / 180)) {
      picked.push(r);
      if (picked.length >= topK) break;
    }
  }
  return picked.sort((a, b) => a.heading - b.heading);
}

function angularDist(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
