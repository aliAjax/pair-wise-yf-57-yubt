// 出队箱：本地编辑 → 出队操作的组织规则，纯可变逻辑（Immer 下直接改 draft）。
//
// 关键不变量：
// 1. 每条“未完成”的记录最多对应一个出队 op；重复保存只刷新同一条 op 的快照，
//    断网重试因此不会新增第二条。
// 2. 轨迹点额外使用 record-point 类型，服务端再按自然键兜底。
// 3. 重启后把 inflight 的 op 回收为 failed —— “看清每批剩余项”。

import { trackNaturalKey } from './merge';
import type {
  FieldBag,
  OpKind,
  PatrolBatch,
  PatrolRecord,
  RecordKind,
  Role,
  SampleStatus,
  SyncEngineState,
  SyncOp,
  VersionedField
} from './types';

let idSeq = 0;
export function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}${Math.floor(Math.random() * 1e4)}`;
}

export function initialState(now = Date.now()): SyncEngineState {
  const batchId = uid('b');
  return {
    batches: [{ id: batchId, label: `巡护批次 ${new Date(now).toLocaleString()}`, createdAt: now, status: 'open' }],
    records: [],
    ops: [],
    online: true,
    syncing: false
  };
}

/** 给记录打一批带版本的字段（新字段 rev=1，已存在字段 rev+1） */
function stampFields(target: FieldBag, patch: Record<string, unknown>, by: Role, at: number): FieldBag {
  const out: FieldBag = { ...target };
  Object.entries(patch).forEach(([name, value]) => {
    if (value === undefined || value === null || value === '') return;
    const prev = (out as Record<string, VersionedField | undefined>)[name];
    if (prev && prev.value === value) return;
    const stamped: VersionedField = { value, meta: { rev: prev ? prev.meta.rev + 1 : 1, at, by } };
    (out as Record<string, VersionedField>)[name] = stamped;
  });
  return out;
}

export function createBatch(state: SyncEngineState, label?: string): PatrolBatch {
  const now = Date.now();
  const batch: PatrolBatch = {
    id: uid('b'),
    label: label ?? `巡护批次 ${new Date(now).toLocaleString()}`,
    createdAt: now,
    status: 'open'
  };
  state.batches.unshift(batch);
  return batch;
}

export function currentBatchId(state: SyncEngineState): string {
  return state.batches[0]?.id ?? createBatch(state).id;
}

function enqueue(state: SyncEngineState, record: PatrolRecord, kind: OpKind, now: number) {
  const pending = state.ops.find(
    (op) => op.recordId === record.id && op.status !== 'done'
  );
  const snapshot: PatrolRecord = JSON.parse(JSON.stringify(record));
  if (pending) {
    // 同一记录的离线连续修改并入同一个待发操作：重试只发最新意图一次
    pending.kind = kind;
    pending.payload = snapshot;
    pending.status = pending.status === 'failed' ? 'queued' : pending.status;
    pending.lastError = undefined;
    pending.updatedAt = now;
  } else {
    state.ops.push({
      opId: uid('op'),
      batchId: record.batchId,
      kind,
      recordId: record.id,
      payload: snapshot,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now
    });
  }
  const batch = state.batches.find((b) => b.id === record.batchId);
  if (batch && batch.status === 'uploaded') batch.status = 'open';
}

interface NewRecordInput {
  kind: RecordKind;
  batchId: string;
  by?: Role;
  patch: Record<string, unknown>;
}

export function addRecord(state: SyncEngineState, input: NewRecordInput): PatrolRecord {
  const now = Date.now();
  const by = input.by ?? 'ranger';
  const fields = stampFields({}, input.patch, by, now);

  // 轨迹点本地幂等：同批次同采集秒/同坐标只保留一条（断网点位重放、重复点击）。
  // 服务端自然键是跨设备/重装后的第二道兜底。
  if (input.kind === 'point') {
    const key = trackNaturalKey({ batchId: input.batchId, fields });
    const dup = state.records.find(
      (r) => r.kind === 'point' && trackNaturalKey(r) === key
    );
    if (dup) return dup;
  }

  const record: PatrolRecord = {
    id: uid(input.kind === 'point' ? 'p' : input.kind === 'sample' ? 's' : 'o'),
    kind: input.kind,
    batchId: input.batchId,
    createdAt: now,
    fields,
    baseRev: 0,
    dirty: true
  };
  state.records.unshift(record);
  enqueue(state, record, input.kind === 'point' ? 'record-point' : 'upsert-record', now);
  return record;
}

/** 本地修改记录字段，并刷新该记录对应的待发 op */
export function editRecord(
  state: SyncEngineState,
  recordId: string,
  patch: Record<string, unknown>,
  by: Role = 'ranger'
) {
  const record = state.records.find((r) => r.id === recordId);
  if (!record) return;
  const now = Date.now();
  record.fields = stampFields(record.fields, patch, by, now);
  record.dirty = true;
  enqueue(state, record, record.kind === 'point' ? 'record-point' : 'upsert-record', now);
}

/** 样本提交：draft → submitted（状态字段也带版本） */
export function markSampleSubmitted(state: SyncEngineState, recordId: string) {
  editRecord(state, recordId, { status: 'submitted' satisfies SampleStatus }, 'ranger');
}

/** 崩溃/重启回收：正在途中的操作回到 failed，等待重连只重试失败部分 */
export function recoverInflight(state: SyncEngineState) {
  state.ops.forEach((op) => {
    if (op.status === 'inflight') {
      op.status = 'failed';
      op.lastError = op.lastError ?? '同步中断（应用重启），等待重连重试';
    }
  });
}

/** 一批/全局剩余项（未完成 = 未上送或失败） */
export function pendingOps(state: SyncEngineState, batchId?: string): SyncOp[] {
  return state.ops.filter(
    (op) => op.status !== 'done' && (batchId === undefined || op.batchId === batchId)
  );
}

export function batchRemaining(state: SyncEngineState, batchId: string): number {
  return pendingOps(state, batchId).length;
}

/** 同步执行器依赖的服务端端口，方便测试替换 */
export interface StationPort {
  upload(op: SyncOp): Promise<import('./types').SyncOutcome>;
}
