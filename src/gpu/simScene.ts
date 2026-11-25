/**
 * 推演页 3D 场景控制器：协调 OceanRenderer、MotionSampler、
 * 软梯/小艇位姿、夜间灯光，并暴露逐帧统计回调给时间序列图。
 */
import type { DirectionalSpectrumData, Vessel } from '../core/types.ts';
import { OceanRenderer } from './renderer.ts';
import { MotionSampler, type FrameMotion } from './motionSampler.ts';
import { buildLadderGeometry, evaluateLadder, stepLadderSwing } from '../core/ladder.ts';
import { mul, translation, rotationX, rotationY } from './mat4.ts';
import type { ShelterInput } from '../core/shelter.ts';

export interface SceneOptions {
  vessel: Vessel;
  spec: DirectionalSpectrumData;
  seed: number;
  shipHeading: number;
  boatOffsetX: number;
  boatOffsetY: number;
  shelter?: Omit<ShelterInput, 'shipHeading'>;
}

export interface SceneFrameStats {
  t: number;
  relDisp: number;
  relVel: number;
  ladderClearance: number;
  hullGap: number;
  roll: number;
  swing: number;
}

export class SimScene {
  private renderer: OceanRenderer;
  private sampler: MotionSampler;
  private ladderGeo;
  private swing = 0;
  private t = 0;
  private lastMotion: FrameMotion | null = null;
  private heading: number;
  private shelterBase?: Omit<ShelterInput, 'shipHeading'>;
  onFrame?: (s: SceneFrameStats) => void;

  constructor(renderer: OceanRenderer, opts: SceneOptions) {
    this.renderer = renderer;
    this.ladderGeo = buildLadderGeometry(opts.vessel);
    this.heading = opts.shipHeading;
    this.shelterBase = opts.shelter;
    this.sampler = new MotionSampler(
      opts.spec,
      opts.vessel,
      opts.shipHeading,
      opts.seed,
      opts.boatOffsetX,
      opts.boatOffsetY,
      opts.shelter,
    );
    this.renderer.setVessel(opts.vessel);
    this.syncShelter();
  }

  private syncShelter(): void {
    if (!this.shelterBase) return;
    this.renderer.setShelter(
      {
        heading: this.heading,
        waveDir: this.shelterBase.waveDir,
        length: this.shelterBase.length,
        beam: this.shelterBase.beam,
        draft: this.shelterBase.draft,
        waterDepth: this.shelterBase.waterDepth,
      },
      true,
    );
  }

  setHeading(h: number): void {
    this.heading = h;
    this.sampler.setHeading(h);
    this.syncShelter();
  }

  setNight(on: boolean): void {
    this.renderer.setNight(on);
  }

  /** 主循环由外部 RAF 驱动；dt 秒 */
  update(dt: number): void {
    this.t += dt;
    const m = this.sampler.sample(this.t);
    this.lastMotion = m;
    this.swing = stepLadderSwing(this.swing, m.roll, this.ladderGeo.length, dt);
    const ladderState = evaluateLadder(this.ladderGeo, this.swing, m.roll, m.pitch, m.waveAtLadder);

    // 小艇模型：平移到下风舷外、随波起伏
    const boatModel = mul(
      translation(this.ladderGeo.vessel.ladderX, m.boatZ, this.boatY()),
      rotationY(0),
    );
    // 软梯模型：摆角 + 贴在舷侧
    const side = Math.sign(this.ladderGeo.topY) || 1;
    const ladderModel = mul(
      translation(this.ladderGeo.topX, this.ladderGeo.topZ + m.heave, this.ladderGeo.topY),
      rotationX(this.swing * side),
    );

    const lights = this.buildLights(m);
    this.renderer.renderFrame(m, lights, boatModel, ladderModel);

    // 相对垂向位移/速度（解析求导，与 5% 验收同源）
    const rel = m.ladderZ - m.boatZ;
    const relVel = m.ladderVel - m.boatVel;

    this.onFrame?.({
      t: this.t,
      relDisp: rel,
      relVel,
      ladderClearance: ladderState.clearanceAboveWater,
      hullGap: ladderState.hullGap,
      roll: m.roll,
      swing: this.swing,
    });
  }

  private boatY(): number {
    return (this.ladderGeo.vessel.ladderY > 0 ? 1 : -1) *
      (this.ladderGeo.vessel.beam / 2 + 6);
  }

  private buildLights(m: FrameMotion) {
    if (!this.renderer.nightMode) return [];
    const v = this.ladderGeo.vessel;
    const side = Math.sign(this.ladderGeo.topY) || 1;
    // 大船舷侧登乘灯（2 盏，软梯上下端附近）
    const boarding1 = {
      pos: [v.ladderX, v.freeboard * 0.7 + m.heave, side * v.beam / 2 + 1, 1] as [number, number, number, number],
      dirCut: [0, -0.5, side * 0.8, 0.5] as [number, number, number, number],
      colorPower: [1.0, 0.92, 0.7, 60] as [number, number, number, number],
    };
    const boarding2 = {
      pos: [v.ladderX, 1.5 + m.heave, side * v.beam / 2 + 1, 1] as [number, number, number, number],
      dirCut: [0, -0.2, side * 0.9, 0.55] as [number, number, number, number],
      colorPower: [1.0, 0.92, 0.7, 45] as [number, number, number, number],
    };
    // 引航艇探照灯，打向软梯底端
    const boat = {
      pos: [v.ladderX, m.boatZ + 2.5, this.boatY(), 1] as [number, number, number, number],
      dirCut: [0, 0.4, -side * 0.9, 0.6] as [number, number, number, number],
      colorPower: [0.85, 0.9, 1.0, 80] as [number, number, number, number],
    };
    return [boarding1, boarding2, boat];
  }

  get motion(): FrameMotion | null { return this.lastMotion; }
}
