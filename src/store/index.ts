import {
  createSlice,
  type PayloadAction,
  configureStore,
  createAsyncThunk
} from '@reduxjs/toolkit';
import Taro from '@tarojs/taro';
import { MockStationServer, type KVStore } from '../sync/server';
import {
  addRecord,
  batchRemaining,
  createBatch,
  currentBatchId,
  editRecord,
  initialState,
  pendingOps,
  recoverInflight
} from '../sync/outbox';
import {
  applyFinish,
  applyOpFailure,
  applyOpStart,
  applyOpSuccess,
  applySyncStart,
  syncSteps
} from '../sync/runner';
import type {
  FieldBag,
  PatrolRecord,
  RecordKind,
  Risk,
  SampleStatus,
  SyncEngineState,
  SyncRunReport
} from '../sync/types';

const STATE_KEY = 'yf57-patrol-v2';

const taroKV: KVStore = {
  getItem: (key) => Taro.getStorageSync(key) ?? null,
  setItem: (key, value) => Taro.setStorageSync(key, value)
};

export const station = new MockStationServer(taroKV);

/**
 * 首次启动在模拟站点预置“负责人已先处理过”的状态：
 * o1 备注已被负责人复核改写（时间戳晚于本地），s1 已核验为 verified。
 * 巡护员回站上送旧副本时，逐字段合并与状态单调闸门即可现场演示。
 */
let seedPromise: Promise<void> | null = null;
function ensureStationSeeded(state: SyncEngineState): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      await station.waitReady();
      if (await station.isSeeded()) return;
      const batchId = state.batches[0]?.id;
      if (!batchId) return;
      const base = new Date('2026-10-06T07:20:00').getTime();
      await station.seed([
        {
          id: 'o1',
          kind: 'observation',
          batchId,
          rev: 3,
          fields: {
            note: {
              value: '东坡发现新鲜足迹（负责人复核：疑似成年个体，已加排南段样线）',
              meta: { rev: 2, at: base + 3_600_000, by: 'lead' }
            },
            risk: { value: 'medium', meta: { rev: 1, at: base, by: 'ranger' } }
          }
        },
        {
          id: 's1',
          kind: 'sample',
          batchId,
          rev: 2,
          fields: {
            status: { value: 'verified', meta: { rev: 2, at: base + 3_600_000, by: 'lead' } }
          }
        }
      ]);
    })();
  }
  return seedPromise;
}

function loadState(): SyncEngineState {
  try {
    const raw = Taro.getStorageSync(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SyncEngineState;
      recoverInflight(parsed);
      return parsed;
    }
  } catch {
    /* 读取失败则用空批次启动 */
  }
  return seedDemo();
}

/**
 * 首次启动预置一个“进行中批次”：
 * - 观察 o1 已在站点被负责人复核改过，本地仍是旧文本（演示旧副本盖不住新版本）。
 * - 样本 s1 已在站点核验为 verified（演示已核验不退回草稿）。
 * - 两个完全相同的轨迹点（断网重试产生，自然键去重）。
 */
function seedDemo(): SyncEngineState {
  const state = initialState(new Date('2026-10-06T07:00:00').getTime());
  const batchId = state.batches[0].id;
  state.batches[0].label = '10-06 东坡巡护批次';

  const base = new Date('2026-10-06T07:20:00').getTime();

  const rename = (record: PatrolRecord, id: string) => {
    const oldId = record.id;
    record.id = id;
    state.ops.forEach((op) => {
      if (op.recordId === oldId) {
        op.recordId = id;
        op.payload.id = id;
      }
    });
  };

  const o1 = addRecord(state, {
    kind: 'observation',
    batchId,
    patch: { note: '东坡发现新鲜足迹，沿溪谷移动', risk: 'medium' }
  });
  rename(o1, 'o1');
  o1.createdAt = base;
  o1.fields.note!.meta.at = base;
  o1.fields.risk!.meta.at = base;

  const s1 = addRecord(state, {
    kind: 'sample',
    batchId,
    patch: { code: 'WD-1006-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' as SampleStatus }
  });
  rename(s1, 's1');
  s1.createdAt = base;

  // 轨迹点：断网期间连续点击/点位重放在本地即合并为一条；
  // 第二道兜底（服务端自然键）由 scripts/sync.test.cjs 覆盖。
  const p1 = addRecord(state, {
    kind: 'point',
    batchId,
    patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: base, source: 'gps' }
  });
  rename(p1, 'p1');
  const p1Again = addRecord(state, {
    kind: 'point',
    batchId,
    patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: base, source: 'gps' }
  });
  assertSeed(p1Again.id === 'p1', '重复轨迹点应在本地合并为同一条');

  return state;
}

function assertSeed(condition: boolean, message: string) {
  if (!condition) throw new Error(`种子数据异常：${message}`);
}

const slice = createSlice({
  name: 'patrolSync',
  initialState: loadState(),
  reducers: {
    newBatch: (state, action: PayloadAction<string | undefined>) => {
      createBatch(state, action.payload);
    },
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk }>) => {
      addRecord(state, {
        kind: 'observation',
        batchId: currentBatchId(state),
        patch: action.payload
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      addRecord(state, {
        kind: 'point',
        batchId: currentBatchId(state),
        patch: { ...action.payload, capturedAt: Date.now(), source: 'gps' }
      });
    },
    addManualPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      addRecord(state, {
        kind: 'point',
        batchId: currentBatchId(state),
        patch: { ...action.payload, capturedAt: Date.now(), source: 'manual' }
      });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number }>) => {
      addRecord(state, {
        kind: 'sample',
        batchId: currentBatchId(state),
        patch: { ...action.payload, status: 'draft' as SampleStatus }
      });
    },
    rangerEdit: (state, action: PayloadAction<{ recordId: string; patch: Record<string, unknown> }>) => {
      editRecord(state, action.payload.recordId, action.payload.patch, 'ranger');
    },
    submitSample: (state, action: PayloadAction<string>) => {
      editRecord(state, action.payload, { status: 'submitted' as SampleStatus }, 'ranger');
    },
    setOnline: (state, action: PayloadAction<boolean>) => {
      state.online = action.payload;
      station.setOnline(action.payload);
    },
    injectFailures: (state, action: PayloadAction<number>) => {
      station.injectFailures(action.payload);
    },
    /** 站点负责人在站点终端的修改：先落服务端，回灌结果在 thunk 中完成 */
    leadApplied: (
      state,
      action: PayloadAction<{ recordId: string; fields: FieldBag }>
    ) => {
      const record = state.records.find((r) => r.id === action.payload.recordId);
      if (!record) return;
      Object.entries(action.payload.fields).forEach(([name, vf]) => {
        if (vf) (record.fields as Record<string, unknown>)[name] = vf;
      });
      record.dirty = false;
    },
    /** 同步执行器事件落地：所有状态变化都在 Immer draft 内完成 */
    syncEvent: (state, action: PayloadAction<import('../sync/runner').SyncEvent>) => {
      const ev = action.payload;
      if (ev.type === 'start') applySyncStart(state);
      else if (ev.type === 'opStart') applyOpStart(state, ev.opId);
      else if (ev.type === 'opSuccess') applyOpSuccess(state, ev.opId, ev.outcome);
      else if (ev.type === 'opFailure') applyOpFailure(state, ev.opId, ev.error);
      else if (ev.type === 'finish') applyFinish(state, ev.report);
    }
  },
  extraReducers: (builder) => {
    builder.addCase(syncThunk.rejected, (state) => {
      state.syncing = false;
      recoverInflight(state);
    });
  }
});

/** 联网同步：重连后只重试 queued/failed 部分，done 不再发送 */
export const syncThunk = createAsyncThunk<SyncRunReport, void, { state: { patrol: SyncEngineState } }>(
  'patrolSync/sync',
  async (_arg, { getState, dispatch }) => {
    await ensureStationSeeded(getState().patrol);
    let report: SyncRunReport | undefined;
    // syncSteps 只读取 state（计划本轮待发），所有写入通过事件 dispatch
    for await (const ev of syncSteps(getState().patrol, station)) {
      dispatch(slice.actions.syncEvent(ev));
      if (ev.type === 'finish') report = ev.report;
    }
    return report!;
  }
);

/** 站点负责人直接在站点改记录/核验样本（服务端立即生效，随后回灌本地） */
export const leadEditThunk = createAsyncThunk<
  void,
  { recordId: string; kind: RecordKind; batchId: string; patch: Record<string, unknown> },
  { state: { patrol: SyncEngineState } }
>('patrolSync/leadEdit', async (arg, { dispatch, getState }) => {
  const fields: FieldBag = {};
  const now = Date.now();
  Object.entries(arg.patch).forEach(([name, value]) => {
    if (value === undefined || value === '') return;
    (fields as Record<string, unknown>)[name] = {
      value,
      meta: { rev: 1000, at: now, by: 'lead' }
    };
  });
  const outcome = await station.leadEdit(arg.recordId, arg.kind, arg.batchId, fields);
  const local = getState().patrol.records.find((r) => r.id === arg.recordId);
  if (local) {
    dispatch(
      slice.actions.leadApplied({
        recordId: arg.recordId,
        fields: outcome.serverRecord.fields
      })
    );
  }
});

export { batchRemaining, pendingOps };
export const {
  addObservation,
  addPoint,
  addManualPoint,
  addSample,
  rangerEdit,
  submitSample,
  newBatch,
  setOnline,
  injectFailures
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer }
});

if (typeof window !== 'undefined') {
  station.setOnline(store.getState().patrol.online);
  void ensureStationSeeded(store.getState().patrol);
  store.subscribe(() => {
    Taro.setStorageSync(STATE_KEY, JSON.stringify(store.getState().patrol));
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type { PatrolRecord, SyncEngineState };
