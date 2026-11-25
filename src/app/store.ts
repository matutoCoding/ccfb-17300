/**
 * 应用状态中心：从 IndexedDB 装载登轮点/船舶/海况/设置/记录，
 * 提供简单订阅，页面按需读写。
 */
import type {
  BoardingPoint,
  SeaStateInput,
  StationSettings,
  Vessel,
} from '../core/types.ts';
import {
  repo,
  ensureSeedData,
  type OperationRecord,
  type BuoyFileRecord,
} from '../db/database.ts';
import { DEFAULT_SETTINGS } from '../db/seed.ts';

type Listener = () => void;

class Store {
  points: BoardingPoint[] = [];
  vessels: Vessel[] = [];
  seaStates: SeaStateInput[] = [];
  operations: OperationRecord[] = [];
  settings: StationSettings = DEFAULT_SETTINGS;
  buoyFiles: BuoyFileRecord[] = [];
  /** 当前推演选中的实体 id */
  currentPointId = '';
  currentVesselId = '';
  currentSeaStateId = '';
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  async load(): Promise<void> {
    await ensureSeedData();
    this.points = await repo.getAll<BoardingPoint>('boardingPoints');
    this.vessels = await repo.getAll<Vessel>('vessels');
    this.seaStates = await repo.getAll<SeaStateInput>('seaStates');
    this.operations = await repo.getAll<OperationRecord>('operations');
    this.operations.sort((a, b) => b.createdAt - a.createdAt);
    this.settings = (await repo.get<StationSettings>('settings', DEFAULT_SETTINGS.id)) ?? DEFAULT_SETTINGS;
    this.buoyFiles = await repo.getAll<BuoyFileRecord>('buoyFiles');
    this.currentPointId ||= this.points[0]?.id ?? '';
    this.currentVesselId ||= this.vessels[0]?.id ?? '';
    this.currentSeaStateId ||= this.seaStates[0]?.id ?? '';
    this.emit();
  }

  currentPoint(): BoardingPoint | undefined {
    return this.points.find((p) => p.id === this.currentPointId);
  }
  currentVessel(): Vessel | undefined {
    return this.vessels.find((v) => v.id === this.currentVesselId);
  }
  currentSeaState(): SeaStateInput | undefined {
    return this.seaStates.find((s) => s.id === this.currentSeaStateId);
  }

  /** 取登轮点生效阈值（覆盖默认） */
  thresholdsFor(pointId: string): StationSettings['defaults'] {
    return { ...this.settings.defaults, ...(this.settings.pointOverrides[pointId] ?? {}) };
  }

  async savePoint(p: BoardingPoint): Promise<void> {
    await repo.put('boardingPoints', p);
    await this.load();
  }
  async deletePoint(id: string): Promise<void> {
    await repo.remove('boardingPoints', id);
    await this.load();
  }
  async saveVessel(v: Vessel): Promise<void> {
    await repo.put('vessels', v);
    await this.load();
  }
  async deleteVessel(id: string): Promise<void> {
    await repo.remove('vessels', id);
    await this.load();
  }
  async saveSeaState(s: SeaStateInput): Promise<void> {
    await repo.put('seaStates', s);
    await this.load();
  }
  async deleteSeaState(id: string): Promise<void> {
    await repo.remove('seaStates', id);
    await this.load();
  }
  async saveOperation(rec: OperationRecord): Promise<void> {
    await repo.put('operations', rec);
    await this.load();
  }
  async saveSettings(s: StationSettings): Promise<void> {
    await repo.put('settings', s);
    await this.load();
  }
  async saveBuoyFile(f: BuoyFileRecord): Promise<void> {
    await repo.put('buoyFiles', f);
    await this.load();
  }
}

export const store = new Store();
