// 模拟站点服务器：真实后端语义的本地替身。
// - opId 幂等：同一上送（含断网重试）永远返回首次结果，不会产生第二条。
// - 轨迹点自然键：同批次同秒同位只落一条。
// - 网络：可切换联网/断网、可让接下来若干次上送“请求丢失”，模拟弱网重试。
// 纯 TypeScript + 异步存储接口，Taro 环境与 Node 测试均可运行。

import { reconcileLocal } from './merge';
import { trackNaturalKey, upsertRecord } from './merge';
import type {
  FieldBag,
  PatrolRecord,
  RecordKind,
  Role,
  SyncOp,
  SyncOutcome
} from './types';

export interface KVStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

interface ServerPersist {
  records: Record<string, ReturnType<JSON['parse']>>;
  opResults: Record<string, SyncOutcome>;
  trackIndex: Record<string, string>;
}

const STORAGE_KEY = 'yf57-mock-server';

export class NetworkError extends Error {
  constructor(message = '网络不可达，操作未到达站点') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class MockStationServer {
  private records = new Map<string, import('./types').ServerRecord>();
  private opResults = new Map<string, SyncOutcome>();
  private trackIndex = new Map<string, string>();
  private online = true;
  /** 接下来 N 次上送强制失败（模拟弱网下请求丢失），每次失败消耗一次 */
  private failNext = 0;
  private latencyMs = 120;
  private revSeq = 1000;

  private ready: Promise<void>;

  constructor(private kv?: KVStore) {
    this.ready = this.restore();
  }

  /** 等待持久化状态恢复完成后再做 seed/upload（存储后端为异步时必须 await） */
  waitReady() {
    return this.ready;
  }

  private async restore() {
    if (!this.kv) return;
    try {
      const raw = await this.kv.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as ServerPersist;
      this.records = new Map(Object.entries(data.records ?? {}));
      this.opResults = new Map(Object.entries(data.opResults ?? {}));
      this.trackIndex = new Map(Object.entries(data.trackIndex ?? {}));
    } catch {
      /* 存储损坏时以空库启动 */
    }
  }

  private persist() {
    if (!this.kv) return;
    const data: ServerPersist = {
      records: Object.fromEntries(this.records),
      opResults: Object.fromEntries(this.opResults),
      trackIndex: Object.fromEntries(this.trackIndex)
    };
    return this.kv.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  setOnline(online: boolean) {
    this.online = online;
  }
  isOnline() {
    return this.online;
  }
  /** 让接下来 n 次上送因网络问题失败 */
  injectFailures(n: number) {
    this.failNext = n;
  }

  /** 站点负责人在站点终端直接修改/核验（始终在线、立即落库） */
  async leadEdit(recordId: string, kind: RecordKind, batchId: string, fields: FieldBag): Promise<SyncOutcome> {
    await this.ready;
    const stamped: FieldBag = {};
    const now = Date.now();
    (Object.keys(fields) as (keyof FieldBag)[]).forEach((name) => {
      const vf = fields[name];
      if (!vf) return;
      const stampedField = { ...vf, meta: { ...vf.meta, at: now, by: 'lead' as Role } };
      (stamped as Record<string, unknown>)[name] = stampedField;
    });
    const existing = this.records.get(recordId);
    const result = upsertRecord(existing, recordId, kind, batchId, stamped, ++this.revSeq);
    this.records.set(recordId, result.record);
    if (kind === 'point') this.trackIndex.set(trackNaturalKey(result.record), recordId);
    await this.persist();
    return {
      recordId,
      effect: result.effect,
      serverRecord: result.record,
      supersededFields: result.superseded
    };
  }

  getRecord(id: string) {
    return this.records.get(id);
  }

  /**
   * 上送一条出队操作。
   * - 网络层失败：抛 NetworkError，服务端状态不变，由调用方保留 op 待重试。
   * - 同一 opId 重放：直接返回缓存结果（幂等）。
   * - 轨迹点自然键撞车：返回既有记录，effect=duplicate，不新建。
   */
  async upload(op: SyncOp): Promise<SyncOutcome> {
    await this.ready;
    await this.delay();
    if (!this.online || this.failNext > 0) {
      if (this.failNext > 0) this.failNext -= 1;
      throw new NetworkError();
    }

    const cached = this.opResults.get(op.opId);
    if (cached) return cached;

    const rec: PatrolRecord = op.payload;

    if (op.kind === 'record-point') {
      const key = trackNaturalKey(rec);
      const existingId = this.trackIndex.get(key);
      if (existingId && existingId !== rec.id) {
        const dupRecord = this.records.get(existingId)!;
        const outcome: SyncOutcome = {
          recordId: rec.id,
          effect: 'duplicate',
          serverRecord: dupRecord
        };
        this.opResults.set(op.opId, outcome);
        await this.persist();
        return outcome;
      }
    }

    const existing = this.records.get(rec.id);
    const result = upsertRecord(existing, rec.id, rec.kind, rec.batchId, rec.fields, ++this.revSeq);
    this.records.set(rec.id, result.record);
    if (op.kind === 'record-point') {
      this.trackIndex.set(trackNaturalKey(rec), rec.id);
    }
    const outcome: SyncOutcome = {
      recordId: rec.id,
      effect: result.effect,
      serverRecord: result.record,
      supersededFields: result.superseded
    };
    this.opResults.set(op.opId, outcome);
    await this.persist();
    return outcome;
  }

  /** 用服务端最新版本回灌本地记录 */
  applyOutcome(local: PatrolRecord, outcome: SyncOutcome): PatrolRecord {
    if (outcome.effect === 'duplicate') return local;
    return reconcileLocal(local, outcome);
  }

  private delay() {
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  /** 仅供测试/演示预置服务端状态 */
  async seed(records: import('./types').ServerRecord[]) {
    await this.ready;
    records.forEach((r) => {
      this.records.set(r.id, r);
      if (r.kind === 'point') this.trackIndex.set(trackNaturalKey(r), r.id);
    });
    await this.persist();
  }

  /** 是否已初始化过（演示数据只在首次启动注入） */
  async isSeeded(): Promise<boolean> {
    await this.ready;
    return this.records.size > 0;
  }
}
