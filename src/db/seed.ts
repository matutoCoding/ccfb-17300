/**
 * 出厂种子数据：三个引航登轮点、三艘船（含 RAO）、浮标样例、默认站务设置。
 * 首次启动时写入 IndexedDB；所有随机/谱参数固定，保证演示可复现。
 */
import type { BoardingPoint, SeaStateInput, StationSettings, Vessel } from '../core/types.ts';
import { generateAnalyticRao } from '../core/rao.ts';
import { DEG } from '../core/math.ts';

export const SEED_POINTS: BoardingPoint[] = [
  {
    id: 'bp-1',
    name: '一号锚地外登轮区（深水）',
    lon: 122.185,
    lat: 30.045,
    depth: 42,
    dominantWaveDir: 90 * DEG,
    currentDir: 130 * DEG,
    currentSpeed: 0.8,
    notes: '常年东向涌，水深充足，大船首选登轮区',
  },
  {
    id: 'bp-2',
    name: '二号登轮区（过渡水深）',
    lon: 122.095,
    lat: 30.012,
    depth: 20,
    dominantWaveDir: 75 * DEG,
    currentDir: 115 * DEG,
    currentSpeed: 1.1,
    notes: '水深 20m，长涌在此开始浅水变形，注意色散修正',
  },
  {
    id: 'bp-3',
    name: '近岸避风登轮区（浅水）',
    lon: 121.982,
    lat: 29.968,
    depth: 14,
    dominantWaveDir: 60 * DEG,
    currentDir: 100 * DEG,
    currentSpeed: 1.4,
    notes: '浅水 14m，潮流较强，仅中小船与气象窗口短时使用',
  },
];

function makeVessels(): Vessel[] {
  const tanker: Vessel = {
    id: 'v-vloc',
    name: '远洋 30 万吨油轮（压载）',
    type: 'oil_tanker_ballast',
    loa: 333,
    beam: 60,
    depth: 30,
    draft: 8.5,          // 压载吃水浅，干舷高
    freeboard: 21.5,     // 远超 9m → 必须组合梯
    gm: 2.4,
    displacement: 112000,
    ladderX: -45,
    ladderY: 30,
    ladderTopHeight: 21.5,
    notes: '压载状态干舷 21.5m，按规定必须配组合梯',
  };
  const container: Vessel = {
    id: 'v-cont',
    name: '中海 14000TEU 集装箱船',
    type: 'container',
    loa: 366,
    beam: 51,
    depth: 30,
    draft: 14,
    freeboard: 16,
    gm: 1.3,
    displacement: 165000,
    ladderX: -40,
    ladderY: 25.5,
    ladderTopHeight: 16,
    notes: '干舷 16m，需组合梯；甲板堆箱影响横摇惯性',
  };
  const bulk: Vessel = {
    id: 'v-bulk',
    name: '金航 3 万吨散货船',
    type: 'small_bulk',
    loa: 180,
    beam: 30,
    depth: 15,
    draft: 9.8,
    freeboard: 5.2,      // 低于 9m，可单软梯
    gm: 0.9,
    displacement: 38500,
    ladderX: -22,
    ladderY: 15,
    ladderTopHeight: 5.2,
    notes: '干舷 5.2m，可使用单软梯；GM 偏小横摇偏软',
  };
  for (const v of [tanker, container, bulk]) v.rao = generateAnalyticRao(v);
  return [tanker, container, bulk];
}

export const SEED_VESSELS: Vessel[] = makeVessels();

export const SEED_SEA_STATES: SeaStateInput[] = [
  {
    id: 'sea-moderate',
    name: '常规作业海况（风浪 1.8m）',
    depth: 42,
    seed: 20240115,
    components: [
      { kind: 'wind', significantHeight: 1.8, peakPeriod: 7.5, peakDirection: 90 * DEG, gamma: 3.3, spreadingIndex: 2 },
    ],
    note: '一号登轮区典型冬季风浪',
  },
  {
    id: 'sea-swell',
    name: '风浪+涌浪混合',
    depth: 20,
    seed: 20240116,
    components: [
      { kind: 'wind', significantHeight: 1.2, peakPeriod: 6.5, peakDirection: 75 * DEG, gamma: 3.3, spreadingIndex: 2 },
      { kind: 'swell', significantHeight: 1.4, peakPeriod: 13, peakDirection: 105 * DEG, gamma: 18, spreadingIndex: 9 },
    ],
    note: '二号区东向长涌叠加本地风浪',
  },
  {
    id: 'sea-rough',
    name: '偏大停止临界海况',
    depth: 14,
    seed: 20240117,
    components: [
      { kind: 'wind', significantHeight: 2.6, peakPeriod: 8.5, peakDirection: 60 * DEG, gamma: 2.8, spreadingIndex: 3 },
    ],
    note: '接近停航阈值，用于验证可行性判定',
  },
];

export const DEFAULT_SETTINGS: StationSettings = {
  id: 'station-default',
  stationName: '舟山引航站',
  defaults: {
    maxSignificantHeight: 2.5,
    maxRelativeDisplacement: 1.2,
    maxRelativeVelocity: 2.5,
    combinationLadderFreeboard: 9,
    minWindowDuration: 2,
    minWindowsPerMinute: 1,
  },
  pointOverrides: {
    // 浅水近岸点更保守
    'bp-3': { maxSignificantHeight: 1.8, maxRelativeDisplacement: 1.0 },
  },
};

/**
 * 生成浮标方向谱样例文件文本（dense 格式），其中混入坏行与缺频段。
 * 主浪向 90°、Tp≈8s 的 JONSWAP 型能量分布。
 */
export function makeSampleBuoyFiles(): Array<{ name: string; text: string; description: string }> {
  return [
    {
      name: 'buoy-normal.csv',
      description: '正常浮标文件（无坏数据）',
      text: encodeBuoy(false, false),
    },
    {
      name: 'buoy-bad-rows.csv',
      description: '含 3 条坏行（字段缺失/非数值/负能量）',
      text: encodeBuoy(true, false),
    },
    {
      name: 'buoy-missing-band.csv',
      description: '含缺频段（0.12~0.16Hz 被整段删除）',
      text: encodeBuoy(false, true),
    },
  ];
}

function encodeBuoy(injectBadRows: boolean, injectGap: boolean): string {
  const freqs: number[] = [];
  for (let i = 0; i < 30; i++) freqs.push(0.03 + i * 0.01); // 0.03~0.32 Hz
  const nTheta = 24;
  const thetas: number[] = [];
  for (let j = 0; j < nTheta; j++) thetas.push((360 * j) / nTheta);
  const fp = 1 / 8;
  const dirMean = 90 * DEG;
  const lines = ['f_hz,theta_deg,energy'];
  let badInjected = 0;
  freqs.forEach((f, iF) => {
    if (injectGap && f >= 0.12 && f <= 0.16) return; // 缺频段
    // 一维 JONSWAP 形（频率域），Hs≈1.8
    const x = f / fp;
    const e1d =
      (5 / 16) * (1.8 * 1.8) / fp *
      Math.pow(x, -5) *
      Math.exp(-1.25 * Math.pow(x, -4)) *
      Math.pow(3.3, Math.exp(-((x - 1) ** 2) / (2 * 0.08 * 0.08)));
    thetas.forEach((td) => {
      const th = (td * Math.PI) / 180;
      let d = th - dirMean;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const dir = Math.pow(Math.max(0, Math.cos(d / 2)), 2 * 4);
      const energy = e1d * dir * (nTheta / (2 * Math.PI));
      lines.push(`${f.toFixed(3)},${td.toFixed(1)},${energy.toExponential(5)}`);
    });
    // 在固定频率处注入坏行
    if (injectBadRows && (iF === 5 || iF === 12 || iF === 20) && badInjected < 3) {
      if (badInjected === 0) lines.push(`${f.toFixed(3)},90.0`); // 字段缺失
      if (badInjected === 1) lines.push(`${f.toFixed(3)},abc,1.2e-3`); // 非数值
      if (badInjected === 2) lines.push(`${f.toFixed(3)},180.0,-9.9e-4`); // 负能量
      badInjected++;
    }
  });
  return lines.join('\n');
}
