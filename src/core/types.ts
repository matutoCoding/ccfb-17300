/**
 * 领域核心类型定义（纯数据，无 DOM / GPU 依赖，可在 Node 下测试）。
 * 角度单位：全系统内部统一使用「弧度」，UI 层负责与度互相转换。
 */

/** 方向谱的一套风浪/涌浪分量参数 */
export interface SeaComponent {
  /** 分量类型：wind=风浪，swell=涌浪 */
  kind: 'wind' | 'swell';
  /** 有效波高 Hs，米 */
  significantHeight: number;
  /** 谱峰周期 Tp，秒 */
  peakPeriod: number;
  /** 主浪向（来浪方向，弧度，0=北，顺时针为正） */
  peakDirection: number;
  /** JONSWAP 峰升因子 γ（涌浪可给大值，如 10~30） */
  gamma: number;
  /** 方向分布指数 s（cos^{2s} 分布的指数的一半） */
  spreadingIndex: number;
}

/** 一次海况输入：风浪 + 涌浪叠加 */
export interface SeaStateInput {
  id?: string;
  name: string;
  /** 水深（米），Infinity 表示深水 */
  depth: number;
  components: SeaComponent[];
  /** 随机种子（回放一致性的根） */
  seed: number;
  /** 备注 */
  note?: string;
}

/** 方向谱采样网格 S(ω,θ)，单位 m²·s/rad */
export interface DirectionalSpectrumData {
  /** 角频率列（rad/s），升序 */
  omegas: Float64Array;
  /** 方向列（rad） */
  thetas: Float64Array;
  /** S[ iTheta * nOmega + iOmega ] */
  values: Float64Array;
  depth: number;
}

/** 波浪场 k 网格上的振幅谱（FFT 海面输入） */
export interface WaveAmplitudeField {
  /** 网格分辨率（N×N，N 为 2 的幂） */
  size: number;
  /** 物理域边长 Lx=Ly，米 */
  domainLength: number;
  /** 波数分辨率 dk=2π/L */
  dk: number;
  /** 每个傅里叶系数对应的高斯随机复数振幅 h0(k)，长度 N*N，按行列存储 */
  h0: ComplexArray;
  /** 各系数的色散角频率 ω(k)，长度 N*N；0 波数处为 0 */
  omega: Float64Array;
  /** 各系数的波数模 |k| */
  kMag: Float64Array;
  depth: number;
  seed: number;
}

export interface ComplexArray {
  re: Float64Array;
  im: Float64Array;
}

/** 船舶 RAO：按浪向角 β（弧度，0=随浪，π=迎浪）与频率 ω 插值 */
export interface RaoTable {
  /** 浪向角（相对遭遇方向，rad） */
  headings: number[];
  /** 角频率 rad/s */
  omegas: number[];
  /** 幅值（无量纲/rad per m，按自由度），索引 [iHeading][iOmega] */
  rollAmp: number[][];
  rollPhase: number[][];
  pitchAmp: number[][];
  pitchPhase: number[][];
  heaveAmp: number[][];
  heavePhase: number[][];
}

export interface Vessel {
  id: string;
  name: string;
  type: 'oil_tanker_ballast' | 'container' | 'small_bulk';
  /** 船长 m */
  loa: number;
  /** 型宽 m */
  beam: number;
  /** 型深 m */
  depth: number;
  /** 吃水 m */
  draft: number;
  /** 干舷 m（=型深-吃水，录入时可覆盖） */
  freeboard: number;
  /** 初稳性高度 GM m（用于无 RAO 时粗估横摇固有周期） */
  gm: number;
  /** 排水量 t */
  displacement: number;
  /** 软梯在船中后的纵向位置（船中为 0，向后为负），m */
  ladderX: number;
  /** 软梯在舷侧的横向位置（正=右舷），m */
  ladderY: number;
  /** 软梯顶端距甲板/水面高度 m */
  ladderTopHeight: number;
  rao?: RaoTable;
  notes?: string;
}

export interface BoardingPoint {
  id: string;
  name: string;
  /** 经纬度 */
  lon: number;
  lat: number;
  /** 水深 m */
  depth: number;
  /** 常年主浪向 rad */
  dominantWaveDir: number;
  /** 潮流流向 rad */
  currentDir: number;
  /** 潮流流速 m/s */
  currentSpeed: number;
  notes?: string;
}

/** 站务设置中的安全阈值 */
export interface SafetyThresholds {
  /** 停航天气：最大允许有效波高 m */
  maxSignificantHeight: number;
  /** 软梯底端与艇甲板登梯点相对垂向位移有义值上限 m */
  maxRelativeDisplacement: number;
  /** 相对垂向速度有义值上限 m/s */
  maxRelativeVelocity: number;
  /** 干舷超过该值必须配组合梯 m */
  combinationLadderFreeboard: number;
  /** 安全跨梯窗口最少持续时长 s */
  minWindowDuration: number;
  /** 每分钟最少安全窗口数 */
  minWindowsPerMinute: number;
}

export interface StationSettings {
  id: string;
  stationName: string;
  /** 各登轮点可覆盖默认阈值；key=boardingPointId */
  pointOverrides: Record<string, Partial<SafetyThresholds>>;
  defaults: SafetyThresholds;
}
