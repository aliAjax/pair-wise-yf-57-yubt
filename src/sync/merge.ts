// 同步裁决纯逻辑：字段级 LWW 合并、样本状态单调、轨迹点自然键去重。
// 不依赖 Taro/Redux，输入输出均为普通对象，便于 Node 直接单测。

import {
  SAMPLE_STATUS_RANK,
  type FieldBag,
  type FieldMeta,
  type PatrolRecord,
  type RecordKind,
  type Role,
  type SampleStatus,
  type ServerField,
  type ServerRecord,
  type SyncOutcome,
  type VersionedField
} from './types';

/** 同一时刻冲突时，站点负责人的字段优先 */
function metaWins(a: FieldMeta, b: FieldMeta): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if (a.by !== b.by) return a.by === 'lead';
  return a.rev >= b.rev;
}

/** 字段级三路裁决：仅当入参字段比服务器字段更新时才覆盖 */
function resolveField(
  server: VersionedField | undefined,
  incoming: VersionedField
): { winner: VersionedField; changed: boolean } {
  if (!server) return { winner: incoming, changed: true };
  if (server.value === incoming.value && server.meta.at === incoming.meta.at) {
    return { winner: server, changed: false };
  }
  const incomingWins = metaWins(incoming.meta, server.meta);
  return { winner: incomingWins ? incoming : server, changed: incomingWins && server.value !== incoming.value };
}

/** 样本状态：除 LWW 外再加“只许升级”闸门，已核验绝不退回草稿 */
function resolveStatus(
  server: VersionedField<SampleStatus> | undefined,
  incoming: VersionedField<SampleStatus>
): { winner: VersionedField<SampleStatus>; changed: boolean; blocked: boolean } {
  if (!server) return { winner: incoming, changed: true, blocked: false };
  if (server.value === incoming.value) return { winner: server, changed: false, blocked: false };
  const downgrade =
    SAMPLE_STATUS_RANK[incoming.value] < SAMPLE_STATUS_RANK[server.value];
  // 任何降级（哪怕时间戳更新，例如巡护员拿旧草稿重传）一律拒绝
  if (downgrade) return { winner: server, changed: false, blocked: true };
  const incomingWins = metaWins(incoming.meta, server.meta);
  return {
    winner: incomingWins ? incoming : server,
    changed: incomingWins && server.value !== incoming.value,
    blocked: false
  };
}

/** 轨迹点自然键：同批次、采集时间（秒级）、坐标（约 1 米，5 位小数）即视为同一点位 */
export function trackNaturalKey(rec: Pick<PatrolRecord, 'batchId' | 'fields'>): string {
  const lat = rec.fields.latitude?.value ?? 0;
  const lng = rec.fields.longitude?.value ?? 0;
  const at = rec.fields.capturedAt?.value ?? 0;
  return `track:${rec.batchId}:${Math.round(at / 1000)}:${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function mergeFields(
  serverFields: FieldBag,
  incomingFields: FieldBag
): { fields: FieldBag; superseded: string[]; blocked: string[] } {
  const out: FieldBag = { ...serverFields };
  const superseded: string[] = [];
  const blocked: string[] = [];
  (Object.keys(incomingFields) as (keyof FieldBag)[]).forEach((name) => {
    const incoming = incomingFields[name] as VersionedField | undefined;
    if (!incoming) return;
    if (name === 'status') {
      const r = resolveStatus(
        serverFields.status as VersionedField<SampleStatus> | undefined,
        incoming as VersionedField<SampleStatus>
      );
      if (r.blocked) blocked.push(name);
      if (r.changed) superseded.push(name);
      out.status = r.winner;
      return;
    }
    const server = serverFields[name] as ServerField | undefined;
    const r = resolveField(server, incoming);
    if (r.changed) superseded.push(name);
    // changed=false 时保留服务器原值（含负责人更新的字段）
    (out as Record<string, unknown>)[name] = r.winner;
  });
  return { fields: out, superseded, blocked };
}

/**
 * 服务端 upsert：
 * - 新记录 → created
 * - 既有记录 → 逐字段合并（旧字段盖不住新字段）→ merged
 * 调用方负责 opId 幂等与自然键查重。
 */
export function upsertRecord(
  existing: ServerRecord | undefined,
  recordId: string,
  kind: RecordKind,
  batchId: string,
  incomingFields: FieldBag,
  nextRev: number
): { record: ServerRecord; effect: SyncOutcome['effect']; superseded: string[] } {
  if (!existing) {
    return {
      record: { id: recordId, kind, batchId, fields: { ...incomingFields }, rev: nextRev },
      effect: 'created',
      superseded: []
    };
  }
  const { fields, superseded } = mergeFields(existing.fields, incomingFields);
  return {
    record: { ...existing, fields, rev: existing.rev + (superseded.length ? 1 : 0) },
    effect: 'merged',
    superseded
  };
}

/** 把服务端记录回灌本地：保留本地新增字段中“比服务器新”的部分，基线推进 */
export function reconcileLocal(local: PatrolRecord, outcome: SyncOutcome): PatrolRecord {
  const merged = mergeFields(outcome.serverRecord.fields, local.fields).fields;
  return {
    ...local,
    fields: merged,
    baseRev: outcome.serverRecord.rev,
    dirty: false
  };
}

/** 供测试/演示快速构造版本字段 */
export function f<T>(value: T, at: number, by: Role = 'ranger', rev = 1): VersionedField<T> {
  return { value, meta: { rev, at, by } };
}
