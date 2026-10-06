import { configureStore, createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import Taro from '@tarojs/taro';
import { syncRecord, type Kind, type ServerRecord } from '../server/fakeServer';

export type SyncState = 'local' | 'queued' | 'syncing' | 'synced' | 'failed' | 'conflict';
export type BatchStatus = 'open' | 'closed';

export interface PatrolBatch {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  status: BatchStatus;
}

interface Versioned {
  version: number;
  baseVersion: number;
  baseSnapshot: Record<string, any> | null;
  batchId: string;
  updatedAt: number;
}

export interface PatrolObservation extends Versioned {
  id: string;
  time: string;
  note: string;
  risk: 'low' | 'medium' | 'high';
  sync: SyncState;
  reviewed: boolean;
}

export interface TrackPoint extends Versioned {
  id: string;
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
  sync: SyncState;
}

export interface Sample extends Versioned {
  id: string;
  code: string;
  species: string;
  count: number;
  status: 'draft' | 'submitted' | 'verified';
  sync: SyncState;
}

export interface OutboxOp {
  id: string;
  batchId: string;
  kind: Kind;
  recordId: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: number;
}

export interface LogEntry {
  id: string;
  at: string;
  text: string;
  tone: 'ok' | 'warn' | 'err' | 'info';
}

interface State {
  batches: PatrolBatch[];
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  outbox: OutboxOp[];
  currentBatchId: string | null;
  online: boolean;
  syncing: boolean;
  log: LogEntry[];
  lastMerge: string | null;
}

const b1 = 'b-20260929-am';

const seed: State = {
  batches: [
    { id: b1, name: '09-29 东坡上午巡护', startedAt: '2026-09-29 07:00', endedAt: '2026-09-29 09:30', status: 'closed' }
  ],
  observations: [
    { id: 'o1', batchId: b1, time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, version: 1, baseVersion: 1, baseSnapshot: { time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewed: false }, updatedAt: 0 },
    // 本地旧副本：服务端负责人已补充跟进说明并复核（v2），本地仍基于 v1
    { id: 'o2', batchId: b1, time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, version: 1, baseVersion: 1, baseSnapshot: { time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewed: false }, updatedAt: 0 },
    { id: 'o3', batchId: b1, time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, version: 1, baseVersion: 1, baseSnapshot: { time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', reviewed: true }, updatedAt: 0 }
  ],
  points: [
    { id: 'p1', batchId: b1, latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', sync: 'synced', version: 1, baseVersion: 1, baseSnapshot: { latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' }, updatedAt: 0 },
    { id: 'p2', batchId: b1, latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', sync: 'synced', version: 1, baseVersion: 1, baseSnapshot: { latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }, updatedAt: 0 }
  ],
  samples: [
    // 本地旧副本仍是 submitted，服务端负责人已核验为 verified（v2）
    { id: 's1', batchId: b1, code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', sync: 'queued', version: 1, baseVersion: 1, baseSnapshot: { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' }, updatedAt: 0 }
  ],
  outbox: [
    { id: 'op-seed-o2', batchId: b1, kind: 'observation', recordId: 'o2', status: 'pending', attempts: 0, lastError: null, createdAt: 0 },
    { id: 'op-seed-s1', batchId: b1, kind: 'sample', recordId: 's1', status: 'pending', attempts: 0, lastError: null, createdAt: 0 }
  ],
  currentBatchId: null,
  online: true,
  syncing: false,
  log: [{ id: 'log-seed', at: '启动', text: '本地记录已从存储恢复，待同步操作按批次保留', tone: 'info' }],
  lastMerge: null
};

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<State>;
      return { ...seed, ...parsed, syncing: false, log: parsed.log?.length ? parsed.log : seed.log };
    }
  } catch { /* ignore */ }
  return seed;
}

function findRecord(state: State, kind: Kind, recordId: string): (Versioned & Record<string, any>) | null {
  const list = kind === 'observation' ? state.observations : kind === 'point' ? state.points : state.samples;
  return (list as any[]).find((r) => r.id === recordId) ?? null;
}

function recordData(rec: Record<string, any>): Record<string, any> {
  const { id, sync, version, baseVersion, baseSnapshot, serverId, batchId, updatedAt, ...data } = rec;
  return data;
}

function now() { return new Date().toLocaleTimeString(); }
let ridCounter = 0;
function rid(prefix: string) {
  ridCounter += 1;
  return `${prefix}-${Date.now()}-${ridCounter}-${Math.floor(Math.random() * 1e6)}`;
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    startBatch: (state) => {
      if (state.batches.some((b) => b.status === 'open')) return;
      const batch: PatrolBatch = { id: rid('b'), name: `巡护批次 ${new Date().toLocaleString()}`, startedAt: new Date().toLocaleString(), endedAt: null, status: 'open' };
      state.batches.unshift(batch);
      state.currentBatchId = batch.id;
      state.log.unshift({ id: rid('log'), at: now(), text: `已开始批次「${batch.name}」，本批记录将在联网后整批上传`, tone: 'info' });
    },
    endBatch: (state) => {
      const batch = state.batches.find((b) => b.id === state.currentBatchId);
      if (batch) {
        batch.status = 'closed';
        batch.endedAt = new Date().toLocaleString();
        state.log.unshift({ id: rid('log'), at: now(), text: `批次「${batch.name}」已结束，剩余 ${state.outbox.filter((o) => o.batchId === batch.id && o.status !== 'synced').length} 项待同步`, tone: 'info' });
      }
      state.currentBatchId = null;
    },
    setOnline: (state, action: PayloadAction<boolean>) => {
      state.online = action.payload;
      state.log.unshift({ id: rid('log'), at: now(), text: action.payload ? '网络已恢复，可重试失败的同步操作' : '已模拟断网：新记录继续离线排队，失败操作保留不丢失', tone: action.payload ? 'ok' : 'warn' });
    },
    addObservation: (state, action: PayloadAction<{ note: string; risk: 'low' | 'medium' | 'high' }>) => {
      ensureBatch(state);
      const batchId = state.currentBatchId!;
      const id = rid('o');
      state.observations.unshift({ id, batchId, time: new Date().toLocaleString(), ...action.payload, sync: 'queued', reviewed: false, version: 1, baseVersion: 0, baseSnapshot: null, updatedAt: Date.now() });
      state.outbox.push({ id: rid('op'), batchId, kind: 'observation', recordId: id, status: 'pending', attempts: 0, lastError: null, createdAt: Date.now() });
    },
    addPoint: (state) => {
      ensureBatch(state);
      const batchId = state.currentBatchId!;
      const id = rid('p');
      const latitude = 30.5821 + (Math.random() - 0.5) * 0.01;
      const longitude = 103.2174 + (Math.random() - 0.5) * 0.01;
      state.points.push({ id, batchId, latitude, longitude, at: new Date().toLocaleTimeString(), source: 'gps', sync: 'queued', version: 1, baseVersion: 0, baseSnapshot: null, updatedAt: Date.now() });
      state.outbox.push({ id: rid('op'), batchId, kind: 'point', recordId: id, status: 'pending', attempts: 0, lastError: null, createdAt: Date.now() });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      ensureBatch(state);
      const batchId = state.currentBatchId!;
      const id = rid('s');
      state.samples.unshift({ id, batchId, ...action.payload, status: 'draft', sync: 'queued', version: 1, baseVersion: 0, baseSnapshot: null, updatedAt: Date.now() });
      state.outbox.push({ id: rid('op'), batchId, kind: 'sample', recordId: id, status: 'pending', attempts: 0, lastError: null, createdAt: Date.now() });
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item) { item.reviewed = true; item.version += 1; item.updatedAt = Date.now(); }
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) { item.status = 'verified'; item.version += 1; item.updatedAt = Date.now(); }
    },
    setOpSyncing: (state, action: PayloadAction<string>) => {
      const op = state.outbox.find((o) => o.id === action.payload);
      if (op) op.status = 'syncing';
      const rec = findRecord(state, op?.kind ?? 'observation', op?.recordId ?? '');
      if (rec) rec.sync = 'syncing';
      state.syncing = true;
    },
    opSucceeded: (state, action: PayloadAction<{ opId: string; record: ServerRecord; duplicated: boolean; merged: boolean }>) => {
      const op = state.outbox.find((o) => o.id === action.payload.opId);
      if (!op) return;
      op.status = 'synced';
      op.lastError = null;
      const rec = findRecord(state, op.kind, op.recordId);
      if (rec) {
        // 合并后的服务端数据（负责人修订、核验状态等）必须回写到本地记录，
        // 否则本地旧字段会在下次展示/同步时重新冒出来
        Object.assign(rec, action.payload.record.data);
        rec.sync = 'synced';
        rec.serverId = action.payload.record.recordId;
        rec.version = action.payload.record.version;
        rec.baseVersion = action.payload.record.version;
        rec.baseSnapshot = { ...action.payload.record.data };
        rec.updatedAt = Date.now();
      }
      if (action.payload.duplicated) {
        state.log.unshift({ id: rid('log'), at: now(), text: `操作 ${op.id.slice(-6)} 命中幂等去重：服务端已有同一条记录，重复上传未新增第二条`, tone: 'ok' });
      } else if (action.payload.merged) {
        state.lastMerge = '已按单条版本合并：负责人对观察记录的复核意见与样本核验结果已保留，未被本地旧副本覆盖';
        state.log.unshift({ id: rid('log'), at: now(), text: `记录 ${op.recordId} 服务端版本更新，已按版本合并（样本状态只进不退）`, tone: 'ok' });
      } else {
        state.log.unshift({ id: rid('log'), at: now(), text: `记录 ${op.recordId} 同步成功`, tone: 'ok' });
      }
      state.syncing = state.outbox.some((o) => o.status === 'syncing');
    },
    opFailed: (state, action: PayloadAction<{ opId: string; error: string }>) => {
      const op = state.outbox.find((o) => o.id === action.payload.opId);
      if (!op) return;
      op.status = 'failed';
      op.attempts += 1;
      op.lastError = action.payload.error;
      const rec = findRecord(state, op.kind, op.recordId);
      if (rec) rec.sync = 'failed';
      state.log.unshift({ id: rid('log'), at: now(), text: `操作 ${op.id.slice(-6)} 同步失败（第 ${op.attempts} 次）：${action.payload.error}。失败操作已保留，重连后只重试该项`, tone: 'err' });
      state.syncing = state.outbox.some((o) => o.status === 'syncing');
    },
    clearLog: (state) => { state.log = []; }
  }
});

/** 没有打开的批次时自动建一个，保证每条记录都归属某个巡护批次 */
function ensureBatch(state: State) {
  if (!state.currentBatchId || !state.batches.some((b) => b.id === state.currentBatchId && b.status === 'open')) {
    const batch: PatrolBatch = { id: rid('b'), name: `巡护批次 ${new Date().toLocaleString()}`, startedAt: new Date().toLocaleString(), endedAt: null, status: 'open' };
    state.batches.unshift(batch);
    state.currentBatchId = batch.id;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOps(ops: OutboxOp[], getState: () => unknown, dispatch: any) {
  for (const op of ops) {
    dispatch(setOpSyncing(op.id));
    await delay(180);
    const s = (getState() as { patrol: State }).patrol;
    const rec = findRecord(s, op.kind, op.recordId);
    if (!rec) {
      dispatch(opFailed({ opId: op.id, error: '本地记录不存在' }));
      continue;
    }
    const res = syncRecord({
      online: s.online,
      kind: op.kind,
      recordId: op.recordId,
      idempotencyKey: op.id,
      data: recordData(rec),
      baseVersion: rec.baseVersion,
      baseSnapshot: rec.baseSnapshot
    });
    if (res.ok && res.record) {
      dispatch(opSucceeded({ opId: op.id, record: res.record, duplicated: res.duplicated, merged: res.merged }));
    } else {
      dispatch(opFailed({ opId: op.id, error: res.error ?? '同步失败' }));
    }
  }
}

/** 同步指定批次：只处理该批次未完成的操作，已同步的绝不重发 */
export const syncBatch = createAsyncThunk('patrol/syncBatch', async (batchId: string, { getState, dispatch }) => {
  const state = (getState() as { patrol: State }).patrol;
  const ops = state.outbox.filter((o) => o.batchId === batchId && o.status !== 'synced');
  await runOps(ops, getState, dispatch);
});

/** 全部重试：重连后只重试失败/待处理部分，已同步操作跳过 */
export const syncAll = createAsyncThunk('patrol/syncAll', async (_: void, { getState, dispatch }) => {
  const state = (getState() as { patrol: State }).patrol;
  const ops = state.outbox.filter((o) => o.status !== 'synced');
  await runOps(ops, getState, dispatch);
});

export const {
  startBatch, endBatch, setOnline,
  addObservation, addPoint, addSample,
  reviewObservation, verifySample,
  setOpSyncing, opSucceeded, opFailed, clearLog
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer },
  middleware: (getDefault) => getDefault()
});

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    const { patrol } = store.getState();
    const { syncing, ...persisted } = patrol;
    Taro.setStorageSync('yf57-patrol-state', JSON.stringify(persisted));
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
