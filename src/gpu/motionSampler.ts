/**
 * 实时运动采样器：把方向谱离散成谐波，每帧解析计算
 * 大船六自由度中的 heave/pitch/roll、引航艇垂向、软梯位波面。
 * 与 core/simulation 同源（相同谐波/相位约定），但面向逐帧查询、无统计负担。
 */
import type { DirectionalSpectrumData, Vessel } from '../core/types.ts';
import { angleDiff, mulberry32 } from '../core/math.ts';
import { kFromOmega } from '../core/dispersion.ts';
import { lookupRao } from '../core/rao.ts';
import { pilotBoatVerticalTransfer } from '../core/shipResponse.ts';
import { shelterFactorAt, type ShelterInput } from '../core/shelter.ts';

interface RealtimeHarmonic {
  omega: number;
  kx: number;
  ky: number;
  amp: number;
  phase: number;
  theta: number;
}

export interface FrameMotion {
  heave: number;
  roll: number;
  pitch: number;
  /** 软梯位当地波面 */
  waveAtLadder: number;
  /** 小艇甲板垂向（含遮蔽） */
  boatZ: number;
  /** 小艇处波面（遮蔽前） */
  waveAtBoat: number;
  /** 软梯底端绝对垂向位移（解析） */
  ladderZ: number;
  /** 软梯底端垂向速度（解析） */
  ladderVel: number;
  /** 小艇甲板垂向速度（解析，含遮蔽） */
  boatVel: number;
}

export class MotionSampler {
  private harmonics: RealtimeHarmonic[] = [];
  private spec: DirectionalSpectrumData;
  private vessel: Vessel;
  private heading: number;
  private boatX: number;
  private boatY: number;
  private shelter?: Omit<ShelterInput, 'shipHeading'>;

  constructor(
    spec: DirectionalSpectrumData,
    vessel: Vessel,
    heading: number,
    seed: number,
    boatX: number,
    boatY: number,
    shelter?: Omit<ShelterInput, 'shipHeading'>,
  ) {
    this.spec = spec;
    this.vessel = vessel;
    this.heading = heading;
    this.boatX = boatX;
    this.boatY = boatY;
    this.shelter = shelter;
    this.build(seed);
  }

  private build(seed: number): void {
    const rng = mulberry32(seed >>> 0);
    const { omegas, thetas, values } = this.spec;
    const nO = omegas.length;
    const nT = thetas.length;
    const dTheta = nT > 1 ? thetas[1] - thetas[0] : 2 * Math.PI;
    // 控制实时谐波数量，按能量阈值保留主要分量（视觉足够、计算轻量）
    const cells: RealtimeHarmonic[] = [];
    for (let j = 0; j < nT; j++) {
      for (let i = 1; i < nO; i++) {
        const dw = omegas[i] - omegas[i - 1];
        const w = 0.5 * (omegas[i] + omegas[i - 1]);
        const s = 0.5 * (values[j * nO + i] + values[j * nO + i - 1]);
        const energy = s * dw * dTheta;
        if (energy <= 1e-9) continue;
        const k = kFromOmega(w, this.spec.depth);
        cells.push({
          omega: w,
          kx: k * Math.cos(thetas[j] + Math.PI),
          ky: k * Math.sin(thetas[j] + Math.PI),
          amp: Math.sqrt(2 * energy),
          phase: rng() * 2 * Math.PI,
          theta: thetas[j],
        });
      }
    }
    // 按能量降序保留前 240 个分量（覆盖 >99% 能量）
    cells.sort((a, b) => b.amp * b.amp - a.amp * a.amp);
    this.harmonics = cells.slice(0, 240);
  }

  setHeading(heading: number): void {
    this.heading = heading;
  }

  sample(t: number): FrameMotion {
    const rao = this.vessel.rao!;
    let heave = 0;
    let roll = 0;
    let pitch = 0;
    let waveL = 0;
    let waveB = 0;
    let boatZ = 0;
    let ladderZ = 0;
    let ladderVel = 0;
    let boatVel = 0;
    const lp = { x: this.vessel.ladderX, y: this.vessel.ladderY };

    for (const h of this.harmonics) {
      const argL = h.omega * t - (h.kx * lp.x + h.ky * lp.y) - h.phase;
      const c = Math.cos(argL);
      const sn = Math.sin(argL);
      waveL += h.amp * c;

      const mu = angleDiff(this.heading, h.theta);
      const r = lookupRao(rao, h.omega, mu);
      heave += h.amp * (r.heave.re * c + r.heave.im * sn);
      roll += h.amp * (r.roll.re * c + r.roll.im * sn);
      pitch += h.amp * (r.pitch.re * c + r.pitch.im * sn);

      // 软梯底端绝对垂向复传递 H = 1 + Hheave + y·Hroll - x·Hpitch
      const hlRe = 1 + r.heave.re + lp.y * r.roll.re - lp.x * r.pitch.re;
      const hlIm = r.heave.im + lp.y * r.roll.im - lp.x * r.pitch.im;
      ladderZ += h.amp * (hlRe * c + hlIm * sn);
      // d/dt Re[H e^{iarg}] = ω(-re·sin + im·cos)
      ladderVel += h.amp * h.omega * (-hlRe * sn + hlIm * c);

      const argB = h.omega * t - (h.kx * this.boatX + h.ky * this.boatY) - h.phase;
      const cB = Math.cos(argB);
      const sB = Math.sin(argB);
      waveB += h.amp * cB;
      const hb = pilotBoatVerticalTransfer(h.omega);
      let factor = 1;
      if (this.shelter) {
        factor = shelterFactorAt({ ...this.shelter, shipHeading: this.heading }, this.boatX, this.boatY);
      }
      boatZ += h.amp * factor * (hb.re * cB + hb.im * sB);
      boatVel += h.amp * factor * h.omega * (-hb.re * sB + hb.im * cB);
    }
    return {
      heave, roll, pitch,
      waveAtLadder: waveL, boatZ, waveAtBoat: waveB,
      ladderZ, ladderVel, boatVel,
    };
  }
}
