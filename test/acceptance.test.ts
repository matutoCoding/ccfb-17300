/**
 * 数值验收测试（node:test，纯 CPU 参考实现）。
 * 对应需求硬指标：
 *  A. FFT 海面实测 Hs 与输入 Hs 误差 < 3%
 *  B. 软梯/引航艇相对垂向运动有义值：时域 vs 频域 RAO 积分 < 5%
 *  C. 浅水色散关系与解析极限一致
 *  D. 谱标定：纯 JONSWAP 积分 Hs 与输入误差 < 1%
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GRAVITY, DEG } from '../src/core/math.ts';
import { kFromOmega, omegaFromK, groupSpeed } from '../src/core/dispersion.ts';
import {
  buildDirectionalSpectrum,
  jonswapSpectrum,
  spectralHs,
  directionalSpreading,
} from '../src/core/spectrum.ts';
import {
  buildWaveField,
  evaluateHeight,
  fieldTheoreticalHs,
  measuredHs,
  recommendDomainLength,
} from '../src/core/waveField.ts';
import { generateAnalyticRao } from '../src/core/rao.ts';
import { integrateRelativeMotion } from '../src/core/shipResponse.ts';
import { runSimulationEnsemble } from '../src/core/simulation.ts';
import type { SeaStateInput, Vessel, SafetyThresholds } from '../src/core/types.ts';
import { trapz } from '../src/core/math.ts';

const thresholds: SafetyThresholds = {
  maxSignificantHeight: 2.5,
  maxRelativeDisplacement: 1.2,
  maxRelativeVelocity: 2.5,
  combinationLadderFreeboard: 9,
  minWindowDuration: 2,
  minWindowsPerMinute: 1,
};

function seaState(
  hs: number,
  tp: number,
  dirDeg: number,
  depth: number,
  seed = 42,
  withSwell = false,
): SeaStateInput {
  return {
    name: 'test',
    depth,
    seed,
    components: [
      {
        kind: 'wind',
        significantHeight: withSwell ? hs * 0.8 : hs,
        peakPeriod: tp,
        peakDirection: dirDeg * DEG,
        gamma: 3.3,
        spreadingIndex: 2,
      },
      ...(withSwell
        ? [
            {
              kind: 'swell' as const,
              significantHeight: hs * 0.6,
              peakPeriod: 14,
              peakDirection: (dirDeg + 35) * DEG,
              gamma: 15,
              spreadingIndex: 8,
            },
          ]
        : []),
    ],
  };
}

const testVessel: Vessel = {
  id: 'v-test',
  name: '测试船',
  type: 'container',
  loa: 280,
  beam: 40,
  depth: 24,
  draft: 12,
  freeboard: 12,
  gm: 1.2,
  displacement: 80000,
  ladderX: -30,
  ladderY: 20,
  ladderTopHeight: 12,
};
testVessel.rao = generateAnalyticRao(testVessel);

describe('色散关系', () => {
  test('深水极限 ω²=gk 正反解一致', () => {
    const k = 0.05;
    const w = omegaFromK(k, Number.POSITIVE_INFINITY);
    assert.ok(Math.abs(w * w - GRAVITY * k) < 1e-12);
    const kBack = kFromOmega(w, Number.POSITIVE_INFINITY);
    assert.ok(Math.abs(kBack - k) / k < 1e-10);
  });

  test('有限水深频率低于同波数深水频率', () => {
    const k = 0.05;
    const wDeep = omegaFromK(k, Number.POSITIVE_INFINITY);
    const wShallow = omegaFromK(k, 15);
    assert.ok(wShallow < wDeep);
    // Newton 反解回代
    const kBack = kFromOmega(wShallow, 15);
    assert.ok(Math.abs(kBack - k) / k < 1e-9);
  });

  test('极浅水波群速度趋近 √(gh)', () => {
    const w = 0.3;
    const cg = groupSpeed(w, 10);
    const shallowLimit = Math.sqrt(GRAVITY * 10);
    assert.ok(Math.abs(cg - shallowLimit) / shallowLimit < 0.08);
  });
});

describe('JONSWAP 谱标定', () => {
  test('单分量谱积分 Hs 与目标误差 < 0.5%', () => {
    for (const hs of [0.8, 1.5, 3.0, 4.5]) {
      const omegas = new Float64Array(400);
      for (let i = 0; i < 400; i++) omegas[i] = 0.08 + (2.9 * i) / 399;
      const s = jonswapSpectrum(omegas, hs, 8, 3.3);
      const m0 = trapz(omegas, s);
      const hsBack = 4 * Math.sqrt(m0);
      assert.ok(
        Math.abs(hsBack - hs) / hs < 0.005,
        `Hs=${hs} 回算 ${hsBack.toFixed(4)}`,
      );
    }
  });

  test('方向分布积分归一化', () => {
    const thetas = new Float64Array(360);
    for (let i = 0; i < 360; i++) thetas[i] = (2 * Math.PI * i) / 360;
    for (const s of [1, 4, 10]) {
      const d = directionalSpreading(thetas, 1.2, s);
      const integral = d.reduce((a, b) => a + b, 0) * ((2 * Math.PI) / 360);
      assert.ok(Math.abs(integral - 1) < 1e-3);
    }
  });

  test('风浪+涌浪叠加后方向谱 Hs 等于分量能量和', () => {
    const input = seaState(2, 8, 45, Number.POSITIVE_INFINITY, 1, true);
    const spec = buildDirectionalSpectrum(input);
    const hsSpec = spectralHs(spec);
    const expected = Math.sqrt(
      input.components.reduce((a, c) => a + c.significantHeight ** 2, 0),
    );
    assert.ok(Math.abs(hsSpec - expected) / expected < 0.01);
  });
});

describe('FFT 海面有效波高精度（硬指标 <3%）', () => {
  const cases: Array<{ hs: number; tp: number; dir: number; depth: number; label: string }> = [
    { hs: 1.0, tp: 6, dir: 30, depth: Number.POSITIVE_INFINITY, label: '深水小浪' },
    { hs: 2.0, tp: 8, dir: 90, depth: Number.POSITIVE_INFINITY, label: '深水中浪' },
    { hs: 3.5, tp: 10, dir: 150, depth: Number.POSITIVE_INFINITY, label: '深水大浪' },
    { hs: 1.8, tp: 7, dir: 60, depth: 20, label: '有限水深 20m' },
    { hs: 1.2, tp: 9, dir: 200, depth: 14, label: '浅水 14m' },
  ];

  for (const c of cases) {
    test(`${c.label}：Hs=${c.hs}m Tp=${c.tp}s`, () => {
      const input = seaState(c.hs, c.tp, c.dir, c.depth, 7);
      const L = recommendDomainLength(input);
      const field = buildWaveField(input, { size: 512, domainLength: L });
      // 理论场 Hs（Parseval，不经 FFT）
      const hsTheory = fieldTheoreticalHs(field);
      assert.ok(
        Math.abs(hsTheory - c.hs) / c.hs < 0.03,
        `理论场 Hs ${hsTheory.toFixed(4)} vs 输入 ${c.hs}`,
      );
      // 实测：120 帧、每帧 512² 空间统计
      const frames: Float64Array[] = [];
      for (let f = 0; f < 120; f++) {
        frames.push(evaluateHeight(field, f * 0.5));
      }
      const hsMeasured = measuredHs(frames);
      const err = Math.abs(hsMeasured - c.hs) / c.hs;
      assert.ok(err < 0.03, `实测 Hs ${hsMeasured.toFixed(4)} vs 输入 ${c.hs}，误差 ${(err * 100).toFixed(2)}%`);
    });
  }

  test('风浪涌浪双分量混合海况同样达标', () => {
    const input = seaState(2.2, 8, 45, Number.POSITIVE_INFINITY, 11, true);
    const expected = Math.sqrt(
      input.components.reduce((a, c) => a + c.significantHeight ** 2, 0),
    );
    const L = recommendDomainLength(input);
    const field = buildWaveField(input, { size: 512, domainLength: L });
    const frames: Float64Array[] = [];
    for (let f = 0; f < 120; f++) frames.push(evaluateHeight(field, f * 0.5));
    const err = Math.abs(measuredHs(frames) - expected) / expected;
    assert.ok(err < 0.03, `混合海况误差 ${(err * 100).toFixed(2)}%`);
  });
});

describe('相对垂向运动：时域 vs 频域（硬指标 <5%）', () => {
  const headings = [0, 45, 90, 135].map((d) => d * DEG);
  for (const heading of headings) {
    test(`浪向夹角 ${Math.round(heading / DEG)}°，位移与速度有义值偏差 <5%`, () => {
      const input = seaState(2.0, 8, 0, Number.POSITIVE_INFINITY, 23);
      const spec = buildDirectionalSpectrum(input, { nOmega: 200, nTheta: 120 });
      // 频域基准（船位参考点）
      const fd = integrateRelativeMotion(spec, testVessel, heading, {
        x: testVessel.ladderX,
        y: testVessel.ladderY,
      });
      // 时域：关闭空间相位与频域物理模型对齐；8 次独立相位实现集合平均，
      // 把单实现随机相位涨落按 1/√8 压到 5% 以内
      const result = runSimulationEnsemble(
        spec,
        testVessel,
        {
          duration: 1800,
          sampleRate: 2,
          shipHeading: heading,
          shipSpeed: 0,
          seed: 99,
          boatOffsetX: testVessel.ladderX,
          boatOffsetY: testVessel.beam / 2 + 6,
          thresholds,
          includeSpatialPhase: false,
        },
        8,
      );
      const errD =
        Math.abs(result.sigDisplacement - fd.significantDisplacement) /
        fd.significantDisplacement;
      const errV =
        Math.abs(result.sigVelocity - fd.significantVelocity) /
        fd.significantVelocity;
      assert.ok(errD < 0.05, `位移偏差 ${(errD * 100).toFixed(2)}%（时域 ${result.sigDisplacement.toFixed(3)} / 频域 ${fd.significantDisplacement.toFixed(3)}）`);
      assert.ok(errV < 0.05, `速度偏差 ${(errV * 100).toFixed(2)}%（时域 ${result.sigVelocity.toFixed(3)} / 频域 ${fd.significantVelocity.toFixed(3)}）`);
    });
  }

  test('浅水海况下 5% 指标同样成立', () => {
    const input = seaState(1.6, 9, 30 * DEG, 16, 31);
    const spec = buildDirectionalSpectrum(input, { nOmega: 200, nTheta: 120 });
    const fd = integrateRelativeMotion(spec, testVessel, Math.PI / 2, {
      x: testVessel.ladderX,
      y: testVessel.ladderY,
    });
    const result = runSimulationEnsemble(
      spec,
      testVessel,
      {
        duration: 1800,
        sampleRate: 2,
        shipHeading: Math.PI / 2,
        shipSpeed: 0,
        seed: 5,
        boatOffsetX: testVessel.ladderX,
        boatOffsetY: testVessel.beam / 2 + 6,
        thresholds,
        includeSpatialPhase: false,
      },
      8,
    );
    const errD =
      Math.abs(result.sigDisplacement - fd.significantDisplacement) /
      fd.significantDisplacement;
    assert.ok(errD < 0.05, `浅水位移偏差 ${(errD * 100).toFixed(2)}%`);
  });
});

describe('回放一致性', () => {
  test('相同种子生成逐位相同的波面', () => {
    const make = (seed: number) =>
      buildWaveField(seaState(1.5, 7, 45, Number.POSITIVE_INFINITY, seed), {
        size: 256,
        domainLength: 400,
      });
    const a = make(123);
    const b = make(123);
    const c = make(124);
    assert.deepEqual(Array.from(a.h0.re), Array.from(b.h0.re));
    assert.ok(!a.h0.re.every((v, i) => v === c.h0.re[i]));
    const ha = evaluateHeight(a, 12.3);
    const hb = evaluateHeight(b, 12.3);
    assert.deepEqual(Array.from(ha), Array.from(hb));
  });
});
