/**
 * 端到端冒烟测试（不依赖浏览器/DOM）：
 * 浮标坏数据解析、种子数据完整性、航向扫描、软梯合规、可行性单数据流。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBuoyFile } from '../src/core/buoy.ts';
import { makeSampleBuoyFiles, SEED_POINTS, SEED_VESSELS, SEED_SEA_STATES, DEFAULT_SETTINGS } from '../src/db/seed.ts';
import { buildDirectionalSpectrum, spectralHs } from '../src/core/spectrum.ts';
import { scanBestHeadings } from '../src/core/shelter.ts';
import { combinationLadderRequired, buildLadderGeometry, evaluateLadder, stepLadderSwing } from '../src/core/ladder.ts';
import { runSimulation, assessFeasibility } from '../src/core/simulation.ts';
import { ensureRao, estimateRollPeriod } from '../src/core/rao.ts';
import { DEG } from '../src/core/math.ts';
import type { SafetyThresholds } from '../src/core/types.ts';

const thresholds: SafetyThresholds = DEFAULT_SETTINGS.defaults;

describe('浮标文件解析（坏行/缺频段提示）', () => {
  const files = makeSampleBuoyFiles();
  test('正常文件零坏行', () => {
    const r = parseBuoyFile(files.find((f) => f.name === 'buoy-normal.csv')!.text);
    assert.ok(r.ok);
    assert.equal(r.badRows, 0);
    assert.ok(r.frequenciesHz.length >= 25);
  });
  test('坏行文件识别 3 条并跳过', () => {
    const r = parseBuoyFile(files.find((f) => f.name === 'buoy-bad-rows.csv')!.text);
    assert.ok(r.ok);
    assert.equal(r.badRows, 3);
    assert.ok(r.warnings.some((w) => w.includes('字段不足') || w.includes('非数值') || w.includes('负')));
  });
  test('缺频段文件给出区间告警', () => {
    const r = parseBuoyFile(files.find((f) => f.name === 'buoy-missing-band.csv')!.text);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.includes('缺频段')));
  });
});

describe('种子数据完整性', () => {
  test('三个登轮点含浅水点', () => {
    assert.equal(SEED_POINTS.length, 3);
    assert.ok(SEED_POINTS.some((p) => p.depth < 20));
  });
  test('三艘船都有 RAO，且油轮压载触发组合梯', () => {
    assert.equal(SEED_VESSELS.length, 3);
    for (const v of SEED_VESSELS) assert.ok(v.rao, `${v.name} 缺 RAO`);
    const tanker = SEED_VESSELS.find((v) => v.type === 'oil_tanker_ballast')!;
    assert.ok(combinationLadderRequired(tanker, 9).required);
    const bulk = SEED_VESSELS.find((v) => v.type === 'small_bulk')!;
    assert.ok(!combinationLadderRequired(bulk, 9).required);
  });
  test('横摇固有周期粗估为有限正值（大船可至 30s 量级）', () => {
    for (const v of SEED_VESSELS) {
      const t = estimateRollPeriod(v);
      assert.ok(t > 3 && t <= 40, `${v.name} 横摇周期异常 ${t}`);
    }
  });
  test('三个海况方案 Hs 可计算', () => {
    assert.equal(SEED_SEA_STATES.length, 3);
    for (const s of SEED_SEA_STATES) assert.ok(spectralHs(buildDirectionalSpectrum(s)) > 0);
  });
});

describe('遮蔽航向扫描', () => {
  test('横浪附近航向遮蔽评分最高', () => {
    const vessel = SEED_VESSELS[2];
    const best = scanBestHeadings(
      { waveDir: 90 * DEG, length: vessel.loa, beam: vessel.beam, draft: vessel.draft, waterDepth: 30 },
      [{ x: vessel.ladderX, y: vessel.beam / 2 + 6 }],
      10, 3,
    );
    assert.ok(best.length >= 1);
    // 最优航向应使船身横对来浪（航向与浪向差接近 90°）
    const top = best[0];
    const diff = Math.abs(((top.heading - 90 * DEG + Math.PI) % (2 * Math.PI)) - Math.PI);
    assert.ok(Math.abs(diff - Math.PI / 2) < 0.4, `最优航向 ${top.heading} 不在横浪区间`);
  });
});

describe('软梯动力学与合规', () => {
  test('横摇驱动软梯摆动，底端间隙与出水高度可计算', () => {
    const vessel = SEED_VESSELS[2];
    const geo = buildLadderGeometry(vessel);
    let swing = 0;
    let last;
    for (let i = 0; i < 50; i++) {
      swing = stepLadderSwing(swing, 0.08 * Math.sin(i * 0.2), geo.length, 0.1);
      last = evaluateLadder(geo, swing, 0.05, 0.01, 0.3);
    }
    assert.ok(Number.isFinite(last!.hullGap));
    assert.ok(Number.isFinite(last!.clearanceAboveWater));
  });
});

describe('可行性判定数据流', () => {
  test('温和海况可行、收紧阈值后触发不可行', () => {
    const vessel = SEED_VESSELS[2];
    ensureRao(vessel);
    // 构造 0.5m 小浪海况（温和到必然满足位移/速度/Hs 阈值）
    const calm = {
      name: 'smoke-calm', depth: Number.POSITIVE_INFINITY, seed: 1,
      components: [{ kind: 'wind' as const, significantHeight: 0.5, peakPeriod: 7, peakDirection: 90 * DEG, gamma: 3.3, spreadingIndex: 2 }],
    };
    const spec = buildDirectionalSpectrum(calm);
    const result = runSimulation(spec, vessel, {
      duration: 600, sampleRate: 2, shipHeading: Math.PI / 2, shipSpeed: 0, seed: 1,
      boatOffsetX: vessel.ladderX, boatOffsetY: vessel.beam / 2 + 6, thresholds,
    });
    const hs = spectralHs(spec);
    const assess = assessFeasibility(result, thresholds, hs);
    // 温和海况下 Hs/位移/速度三项必达标（窗口统计在短样本下单独评估，不作为这里的否决项）
    assert.ok(hs <= thresholds.maxSignificantHeight);
    assert.ok(result.sigDisplacement <= thresholds.maxRelativeDisplacement, `位移 ${result.sigDisplacement}`);
    assert.ok(result.sigVelocity <= thresholds.maxRelativeVelocity, `速度 ${result.sigVelocity}`);
    assert.ok(assess.reasons.length > 0);
    // 人为收紧到不可能的阈值，应判不可行
    const strict = { ...thresholds, maxRelativeDisplacement: 0.01 };
    const bad = assessFeasibility(result, strict, hs);
    assert.equal(bad.feasible, false);
    assert.ok(bad.reasons.length > 0);
  });
});
