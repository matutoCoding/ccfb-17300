/**
 * IndexedDB 持久化层。
 * 库 pilot-sea-db，对象仓库：
 *  boardingPoints / vessels / seaStates / operations / settings / buoyFiles
 * 所有写操作走统一仓储，记录含 createdAt/updatedAt，支持按索引查询。
 */
import type {
  BoardingPoint,
  SeaStateInput,
  StationSettings,
} from '../core/types.ts';
import {
  DEFAULT_SETTINGS,
  SEED_POINTS,
  SEED_SEA_STATES,
  SEED_VESSELS,
  makeSampleBuoyFiles,
} from './seed.ts';

export interface OperationRecord {
  id: string;
  createdAt: number;
  boardingPointId: string;
  boardingPointName: string;
  vesselId: string;
  vesselName: string;
  /** 当时海况完整快照（含随机种子，用于原样回放） */
  seaState: SeaStateInput;
  shipHeading: number;
  shipSpeed: number;
  /** 结果：success=成功登轮，abort=中止，incident=险情 */
  result: 'success' | 'abort' | 'incident';
  /** 相对位移/速度有义值、Hs 等关键指标快照 */
  metrics: {
    significantHeight: number;
    sigDisplacement: number;
    sigVelocity: number;
    safeWindowsPerMinute: number;
    minClearance: number;
  };
  pilotFeedback: string;
  pilotName: string;
  /** 可行性单签发信息 */
  feasibility?: FeasibilityReport;
}

export interface FeasibilityReport {
  issuedAt: number;
  dispatcher: string;
  stationChief: string;
  feasible: boolean;
  reasons: string[];
  thresholds: StationSettings['defaults'];
  recommendedHeadings: number[];
}

export interface BuoyFileRecord {
  id: string;
  name: string;
  description: string;
  text: string;
  importedAt: number;
}

const DB_NAME = 'pilot-sea-db';
const DB_VERSION = 1;
const STORES = [
  'boardingPoints',
  'vessels',
  'seaStates',
  'operations',
  'settings',
  'buoyFiles',
] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'operations') {
            store.createIndex('createdAt', 'createdAt');
            store.createIndex('boardingPointId', 'boardingPointId');
            store.createIndex('vesselId', 'vesselId');
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const repo = {
  async getAll<T>(store: StoreName): Promise<T[]> {
    return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  },
  async put<T>(store: StoreName, value: T): Promise<void> {
    await tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
  },
  async remove(store: StoreName, id: string): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(store: StoreName): Promise<void> {
    await tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  },
};

/** 首次启动写入种子数据（已存在则跳过） */
export async function ensureSeedData(): Promise<void> {
  const existing = await repo.getAll<BoardingPoint>('boardingPoints');
  if (existing.length > 0) return;
  for (const p of SEED_POINTS) await repo.put('boardingPoints', p);
  for (const v of SEED_VESSELS) await repo.put('vessels', v);
  for (const s of SEED_SEA_STATES) await repo.put('seaStates', s);
  await repo.put('settings', DEFAULT_SETTINGS);
  for (const f of makeSampleBuoyFiles()) {
    const rec: BuoyFileRecord = {
      id: `buoy-${f.name}`,
      name: f.name,
      description: f.description,
      text: f.text,
      importedAt: Date.now(),
    };
    await repo.put('buoyFiles', rec);
  }
}

/** 生成带时间戳的唯一 ID */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
