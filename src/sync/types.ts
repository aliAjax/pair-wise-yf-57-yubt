// 离线巡护同步领域模型 —— 纯类型，不依赖 Taro，可在 Node 下直接测试。

export type Role = 'ranger' | 'lead';

/** 观察记录 / 轨迹点 / 样本三类业务对象 */
export type RecordKind = 'observation' | 'point' | 'sample';

export type Risk = 'low' | 'medium' | 'high';
export type SampleStatus = 'draft' | 'submitted' | 'verified';

/** 字段级版本：每个可合并字段独立记录版本与修改人 */
export interface FieldMeta {
  /** 本地单调修订号，每次修改该字段 +1；上送时作为合并依据之一 */
  rev: number;
  /** 修改时间戳（毫秒） */
  at: number;
  /** 修改人角色：同刻冲突时站点负责人优先 */
  by: Role;
}

export interface VersionedField<T = unknown> {
  value: T;
  meta: FieldMeta;
}

export type FieldBag = {
  // 观察记录
  note?: VersionedField<string>;
  risk?: VersionedField<Risk>;
  // 轨迹点
  latitude?: VersionedField<number>;
  longitude?: VersionedField<number>;
  /** 现场采集时刻（由设备给出），幂等去重使用 */
  capturedAt?: VersionedField<number>;
  source?: VersionedField<'gps' | 'manual'>;
  // 样本
  code?: VersionedField<string>;
  species?: VersionedField<string>;
  count?: VersionedField<number>;
  /** 样本生命周期，单调升级 draft < submitted < verified */
  status?: VersionedField<SampleStatus>;
};

/**
 * 统一的版本化记录。字段以版本包裹，合并时逐字段裁决，
 * 避免“本地旧副本整行盖住负责人修改”。
 */
export interface PatrolRecord {
  id: string;
  kind: RecordKind;
  /** 所属巡护批次 */
  batchId: string;
  createdAt: number;
  fields: FieldBag;
  /** 已并入本地的服务器记录修订（合并依据基线，未上送时为 0） */
  baseRev: number;
  /** 该记录是否存在未同步的本地修改 */
  dirty: boolean;
}

export type BatchStatus = 'open' | 'uploaded';

export interface PatrolBatch {
  id: string;
  label: string;
  createdAt: number;
  /** 全部操作上送成功后置为 uploaded */
  status: BatchStatus;
}

export type OpKind = 'upsert-record' | 'record-point';

export type OpStatus =
  | 'queued' // 待同步
  | 'inflight' // 正在同步（崩溃/重启后回收为 failed）
  | 'failed' // 同步失败，等待重连重试
  | 'done'; // 已完成（服务端已接受或判定为重复/已合并），永不重发

export interface SyncOp {
  opId: string;
  batchId: string;
  kind: OpKind;
  recordId: string;
  /**
   * 上送的记录快照（含逐字段 meta）。
   * 重试始终复用同一 opId 与同一份意图。
   */
  payload: PatrolRecord;
  status: OpStatus;
  attempts: number;
  /** 最近一次失败原因，供界面展示“为什么没传完” */
  lastError?: string;
  /** 服务端结果（done 后写入），重复重试拿到的是同一份 */
  outcome?: SyncOutcome;
  createdAt: number;
  updatedAt: number;
}

/** 服务端对单次上送的裁决 */
export interface SyncOutcome {
  recordId: string;
  /** created=新建；merged=按字段合并；duplicate=同一轨迹点已存在，未新建第二条 */
  effect: 'created' | 'merged' | 'duplicate';
  /** 合并后完整的服务器记录，用于回灌本地 */
  serverRecord: ServerRecord;
  /** 本次被对方版本盖住的本地字段（用于合并说明） */
  supersededFields?: string[];
}

/** 服务端存储形态：逐字段版本 + 记录级修订号 */
export type ServerField = VersionedField;
export interface ServerRecord {
  id: string;
  kind: RecordKind;
  /** 所属巡护批次（轨迹点自然键查重按批次作用域） */
  batchId: string;
  fields: PatrolRecord['fields'];
  /** 记录级修订号，记录每被写入一次 +1 */
  rev: number;
  /** 轨迹点自然键去重命中时，指向既有记录的 opId */
  createdByOpId?: string;
}

export interface SyncEngineState {
  batches: PatrolBatch[];
  records: PatrolRecord[];
  ops: SyncOp[];
  online: boolean;
  syncing: boolean;
  /** 最近一次整批同步的摘要（重启后仍可见） */
  lastRun?: SyncRunReport;
}

export interface SyncRunReport {
  at: number;
  attempted: number;
  succeeded: number;
  duplicate: number;
  merged: number;
  failed: number;
  /** 因网络中断而未完成、留给下次的操作数 */
  remaining: number;
  stoppedAt?: string;
}

/** 样本状态序：只许升级，不许退回 */
export const SAMPLE_STATUS_RANK: Record<SampleStatus, number> = {
  draft: 0,
  submitted: 1,
  verified: 2
};
