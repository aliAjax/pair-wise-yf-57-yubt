// 同步执行器：联网后逐单上送，失败即停并保留剩余操作。
//
// 语义：
// - 只挑 status 为 queued/failed 的 op（done 永不重发 → 重复上传不新增第二条）。
// - 按批次、创建时间排序逐单处理；某单网络失败时整轮停止，后续 op 原样保留。
// - 成功单回灌服务端合并结果，并在该批全部完成时把批次置为 uploaded。
//
// 同步过程以事件流表达（syncSteps）：
// - Node 测试/命令式调用方用 runSync 直接在普通对象上落地；
// - Redux thunk 逐事件 dispatch，reducer 复用同一批 apply* 纯函数操作 Immer draft。

import { reconcileLocal } from './merge';
import { pendingOps, type StationPort } from './outbox';
import type { SyncEngineState, SyncOp, SyncOutcome, SyncRunReport } from './types';

export function emptyReport(remaining: number, stoppedAt?: string): SyncRunReport {
  return { at: Date.now(), attempted: 0, succeeded: 0, duplicate: 0, merged: 0, failed: remaining, remaining, stoppedAt };
}

/** 本轮要发送的操作（启动时一次性快照，同步途中不重读状态） */
export function selectTodo(state: SyncEngineState): SyncOp[] {
  return pendingOps(state)
    .slice()
    .sort((a, b) =>
      a.batchId === b.batchId ? a.createdAt - b.createdAt : a.batchId < b.batchId ? -1 : 1
    )
    .map((op) => JSON.parse(JSON.stringify(op)) as SyncOp);
}

export function applySyncStart(state: SyncEngineState) {
  state.syncing = true;
}

export function applyOpStart(state: SyncEngineState, opId: string) {
  const op = state.ops.find((o) => o.opId === opId);
  if (!op) return;
  op.status = 'inflight';
  op.attempts += 1;
}

export function applyOpSuccess(state: SyncEngineState, opId: string, outcome: SyncOutcome) {
  const op = state.ops.find((o) => o.opId === opId);
  if (!op) return;
  const record = state.records.find((r) => r.id === op.recordId);
  if (record && outcome.effect !== 'duplicate') {
    const merged = reconcileLocal(record, outcome);
    record.fields = merged.fields;
    record.baseRev = merged.baseRev;
    record.dirty = false;
  }
  op.status = 'done';
  op.outcome = outcome;
  op.lastError = undefined;
}

export function applyOpFailure(state: SyncEngineState, opId: string, error: string) {
  // 请求未确认：保留为 failed，同 opId 下次重放（服务端幂等兜底）
  const op = state.ops.find((o) => o.opId === opId);
  if (!op) return;
  op.status = 'failed';
  op.lastError = error;
}

/** 批次完成度：无剩余 op 的批次标记 uploaded，否则仍是 open */
export function applyFinish(state: SyncEngineState, report: SyncRunReport) {
  state.syncing = false;
  state.lastRun = report;
  state.batches.forEach((batch) => {
    const left = state.ops.some((op) => op.batchId === batch.id && op.status !== 'done');
    batch.status = left ? 'open' : 'uploaded';
  });
}

export type SyncEvent =
  | { type: 'start' }
  | { type: 'opStart'; opId: string }
  | { type: 'opSuccess'; opId: string; outcome: SyncOutcome }
  | { type: 'opFailure'; opId: string; error: string }
  | { type: 'finish'; report: SyncRunReport };

/** 同步计划的异步事件流；调用方负责把事件落地到自己的状态容器 */
export async function* syncSteps(state: SyncEngineState, station: StationPort): AsyncGenerator<SyncEvent> {
  const remainingTotal = pendingOps(state).length;
  if (!state.online) {
    yield { type: 'finish', report: emptyReport(remainingTotal, '当前离线，已保留全部待发操作') };
    return;
  }

  const todo = selectTodo(state);
  if (todo.length === 0) {
    yield { type: 'finish', report: emptyReport(0) };
    return;
  }

  yield { type: 'start' };
  const report: SyncRunReport = {
    at: Date.now(),
    attempted: 0,
    succeeded: 0,
    duplicate: 0,
    merged: 0,
    failed: 0,
    remaining: todo.length
  };

  for (const op of todo) {
    yield { type: 'opStart', opId: op.opId };
    try {
      const outcome = await station.upload(op);
      yield { type: 'opSuccess', opId: op.opId, outcome };
      report.attempted += 1;
      report.succeeded += 1;
      if (outcome.effect === 'duplicate') report.duplicate += 1;
      if (outcome.effect === 'merged') report.merged += 1;
      report.remaining -= 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'opFailure', opId: op.opId, error: message };
      report.attempted += 1;
      report.failed += 1;
      report.stoppedAt = message;
      break;
    }
  }

  yield { type: 'finish', report };
}

/** 命令式入口：把事件流直接落地到普通可变对象（Node 测试用） */
export async function runSync(state: SyncEngineState, station: StationPort): Promise<SyncRunReport> {
  let report = emptyReport(pendingOps(state).length);
  for await (const event of syncSteps(state, station)) {
    if (event.type === 'start') applySyncStart(state);
    else if (event.type === 'opStart') applyOpStart(state, event.opId);
    else if (event.type === 'opSuccess') applyOpSuccess(state, event.opId, event.outcome);
    else if (event.type === 'opFailure') applyOpFailure(state, event.opId, event.error);
    else if (event.type === 'finish') {
      report = event.report;
      applyFinish(state, event.report);
    }
  }
  return report;
}
