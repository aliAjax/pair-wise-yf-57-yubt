/**
 * 模拟服务端：
 * - 每条记录有服务端版本号，按单条记录版本合并（3-way merge）
 * - 幂等键（idempotency key）：重复上传不会新增第二条，响应丢失后重试也能去重
 * - 样本状态只进不退（draft -> submitted -> verified），已核验不退回草稿
 */
import Taro from '@tarojs/taro';

export type Kind = 'observation' | 'point' | 'sample';
export type Online = boolean;

export interface ServerRecord {
  recordId: string;
  kind: Kind;
  version: number;
  data: Record<string, any>;
  idempotencyKey: string | null;
  updatedAt: number;
}

interface ServerState {
  records: Record<string, ServerRecord>;
  idempotency: Record<string, string>;
}

const SERVER_KEY = 'yf57-fake-server';
/** 模拟“服务端已写入但响应丢失”的概率，用于演示重试去重 */
const RESPONSE_LOSS_RATE = 0.25;

function seedServer(): ServerState {
  const now = Date.now();
  const rec = (recordId: string, kind: Kind, version: number, data: Record<string, any>): ServerRecord => ({
    recordId, kind, version, data, idempotencyKey: null, updatedAt: now
  });
  return {
    records: {
      o1: rec('o1', 'observation', 1, { time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', reviewed: false }),
      // 负责人在服务端已修改 o2：补充跟进说明并标记复核
      o2: rec('o2', 'observation', 2, {
        time: '2026-09-29 08:05',
        note: '红外相机外壳松动，已拍照待补报（负责人已联系后勤补发外壳，到件后更换）',
        risk: 'high',
        reviewed: true
      }),
      o3: rec('o3', 'observation', 1, { time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', reviewed: true }),
      p1: rec('p1', 'point', 1, { latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' }),
      p2: rec('p2', 'point', 1, { latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }),
      // 负责人已在服务端核验 s1，本地旧副本仍是 submitted
      s1: rec('s1', 'sample', 2, { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified' })
    },
    idempotency: {}
  };
}

function readServer(): ServerState {
  try {
    const raw = Taro.getStorageSync(SERVER_KEY);
    if (raw) return JSON.parse(raw) as ServerState;
  } catch { /* ignore */ }
  const seeded = seedServer();
  writeServer(seeded);
  return seeded;
}

function writeServer(state: ServerState) {
  try { Taro.setStorageSync(SERVER_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const SAMPLE_STATUS_RANK: Record<string, number> = { draft: 0, submitted: 1, verified: 2 };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

const META_FIELDS = new Set(['id', 'sync', 'version', 'baseVersion', 'baseSnapshot', 'serverId', 'batchId', 'updatedAt']);

/**
 * 三向合并：
 * - 本地未改、服务端改了 -> 采用服务端
 * - 本地改了、服务端未改 -> 保留本地
 * - 两边都改了（冲突）-> 观察/轨迹以负责人（服务端）为准；样本状态只进不退，取最高状态
 */
function threeWayMerge(
  base: Record<string, any>,
  local: Record<string, any>,
  remote: Record<string, any>,
  kind: Kind
): Record<string, any> {
  const out: Record<string, any> = { ...remote };
  const fields = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  fields.forEach((f) => {
    if (META_FIELDS.has(f)) return;
    const lv = local[f];
    const rv = remote[f];
    const bv = base[f];
    const localChanged = !deepEqual(lv, bv);
    const remoteChanged = !deepEqual(rv, bv);
    if (localChanged && remoteChanged) {
      if (kind === 'sample' && f === 'status') {
        const rank = Math.max(SAMPLE_STATUS_RANK[String(lv)] ?? 0, SAMPLE_STATUS_RANK[String(rv)] ?? 0);
        out[f] = rank === 2 ? 'verified' : rank === 1 ? 'submitted' : 'draft';
      } else {
        out[f] = rv;
      }
    } else if (localChanged) {
      out[f] = lv;
    } else {
      out[f] = rv;
    }
  });
  return out;
}

export interface SyncArgs {
  online: Online;
  kind: Kind;
  recordId: string;
  idempotencyKey: string;
  /** 本地当前字段（不含元信息） */
  data: Record<string, any>;
  /** 本地基于的服务端版本，0 表示从未同步成功 */
  baseVersion: number;
  /** 上次同步成功时的字段快照，用于三向合并 */
  baseSnapshot: Record<string, any> | null;
}

export interface SyncResult {
  ok: boolean;
  /** 命中幂等键：重复上传未新增第二条 */
  duplicated: boolean;
  /** 发生了按版本合并 */
  merged: boolean;
  record?: ServerRecord;
  error?: string;
}

export function syncRecord(args: SyncArgs): SyncResult {
  if (!args.online) {
    return { ok: false, duplicated: false, merged: false, error: '网络不可用，操作已保留，联网后自动重试' };
  }
  const state = readServer();

  // 1. 幂等去重：同一条操作重试（即使服务端已写入、响应丢失）也不会新增第二条
  const dupId = state.idempotency[args.idempotencyKey];
  if (dupId && state.records[dupId]) {
    return { ok: true, duplicated: true, merged: false, record: state.records[dupId] };
  }

  const existing = state.records[args.recordId];
  let merged = false;
  let finalData = args.data;
  let finalVersion = 1;

  if (existing) {
    if (existing.version > args.baseVersion) {
      // 2. 服务端有更新版本：按单条记录版本合并，而不是用本地旧副本整条覆盖
      finalData = threeWayMerge(args.baseSnapshot ?? args.data, args.data, existing.data, args.kind);
      merged = true;
      finalVersion = existing.version + 1;
    } else {
      finalVersion = existing.version + 1;
    }
  }

  const rec: ServerRecord = {
    recordId: args.recordId,
    kind: args.kind,
    version: finalVersion,
    data: finalData,
    idempotencyKey: args.idempotencyKey,
    updatedAt: Date.now()
  };
  state.records[args.recordId] = rec;
  state.idempotency[args.idempotencyKey] = args.recordId;
  writeServer(state);

  // 3. 模拟响应丢失：服务端已写入，但客户端收到失败 -> 重连后只重试该操作，幂等去重
  if (Math.random() < RESPONSE_LOSS_RATE) {
    return { ok: false, duplicated: false, merged, record: rec, error: '响应丢失（服务端已写入），重试不会重复新增' };
  }
  return { ok: true, duplicated: false, merged, record: rec };
}

export function resetServer() {
  try { Taro.removeStorageSync(SERVER_KEY); } catch { /* ignore */ }
}
