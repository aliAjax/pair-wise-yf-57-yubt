// Redux store 离线队列行为验证
const Module = require('module');
const path = require('path');

globalThis.window = {}; // 启用 store 订阅持久化

const memory = {};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@tarojs/taro') {
    return {
      getStorageSync: (k) => (k in memory ? memory[k] : ''),
      setStorageSync: (k, v) => { memory[k] = String(v); },
      removeStorageSync: (k) => { delete memory[k]; }
    };
  }
  return origLoad.apply(this, arguments);
};

require('@babel/register')({
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
  extensions: ['.js', '.ts', '.tsx'],
  cache: false
});

const { resetServer } = require(path.join(process.cwd(), 'src/server/fakeServer.ts'));
const storeMod = require(path.join(process.cwd(), 'src/store/index.ts'));
const {
  startBatch, endBatch, setOnline,
  addObservation, addPoint, addSample,
  syncBatch, syncAll
} = storeMod;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra ?? ''); }
}

Math.random = () => 0.99; // 确定性：不触发响应丢失
resetServer();
const store = storeMod.store;
const seedState = store.getState().patrol;

// 初始：seed 批次 b1 有 2 个待同步操作（o2、s1）
{
  const b1 = seedState.batches.find((b) => b.id === 'b-20260929-am');
  check('seed 批次存在且已结束', !!b1 && b1.status === 'closed');
  const pending = seedState.outbox.filter((o) => o.batchId === b1.id && o.status === 'pending');
  check('seed 批次含 2 个待同步操作', pending.length === 2, pending.length);
}

// 开始新批次并录入
store.dispatch(startBatch());
{
  const s = store.getState().patrol;
  check('开始批次后 currentBatchId 指向 open 批次', s.currentBatchId && s.batches[0].status === 'open');
}
store.dispatch(addObservation({ note: '垭口西侧发现新鲜痕迹', risk: 'high' }));
store.dispatch(addPoint());
store.dispatch(addSample({ code: 'WD-1006-01', species: '疑似斑羚粪便', count: 2 }));
{
  const s = store.getState().patrol;
  const batchId = s.currentBatchId;
  const ops = s.outbox.filter((o) => o.batchId === batchId);
  check('新批次 3 条记录各自带操作', ops.length === 3, ops.length);
  check('新记录状态为待同步', s.observations[0].sync === 'queued' && s.points[s.points.length - 1].sync === 'queued' && s.samples[0].sync === 'queued');
  check('新记录 baseVersion 为 0（从未同步）', s.observations[0].baseVersion === 0);
}

// 同步 seed 批次：o2 合并、s1 状态不退回
(async () => {
  await store.dispatch(syncBatch('b-20260929-am'));
  let s = store.getState().patrol;
  const o2 = s.observations.find((o) => o.id === 'o2');
  const s1 = s.samples.find((x) => x.id === 's1');
  check('o2 同步后 v3 且保留负责人复核', o2.sync === 'synced' && o2.version === 3 && o2.reviewed === true, { sync: o2.sync, v: o2.version });
  check('o2 负责人补充说明未被本地覆盖', /负责人已联系后勤/.test(o2.note), o2.note);
  check('s1 同步后状态仍为 verified（不退回草稿）', s1.sync === 'synced' && s1.status === 'verified', s1.status);
  const b1Ops = s.outbox.filter((o) => o.batchId === 'b-20260929-am');
  check('seed 批次操作全部 synced', b1Ops.every((o) => o.status === 'synced'));
  check('日志记录了合并', s.log.some((l) => /按版本合并/.test(l.text)));

  // 重复同步：已同步操作绝不重发
  const logCount = s.log.length;
  await store.dispatch(syncBatch('b-20260929-am'));
  s = store.getState().patrol;
  check('重复同步不产生新日志（无重发）', s.log.length === logCount, { before: logCount, after: s.log.length });

  // 新批次同步：3 条全部成功
  const newBatchId = s.batches[0].id;
  await store.dispatch(syncBatch(newBatchId));
  s = store.getState().patrol;
  const newOps = s.outbox.filter((o) => o.batchId === newBatchId);
  check('新批次 3 项全部同步成功', newOps.every((o) => o.status === 'synced'), newOps.map((o) => o.status));

  // 断网 -> 新记录同步失败但保留；恢复后只重试失败部分
  store.dispatch(setOnline(false));
  store.dispatch(addObservation({ note: '断网期间记录', risk: 'low' }));
  const offlineBatch = store.getState().patrol.currentBatchId;
  await store.dispatch(syncBatch(offlineBatch));
  s = store.getState().patrol;
  const offlineOps = s.outbox.filter((o) => o.batchId === offlineBatch);
  const offlineOnly = offlineOps.filter((o) => o.status !== 'synced');
  check('断网同步：仅未完成操作标记失败且保留', offlineOnly.every((o) => o.status === 'failed') && offlineOnly.every((o) => o.attempts === 1), offlineOnly.map((o) => o.status));
  check('断网同步：已同步操作不受影响', offlineOps.filter((o) => o.status === 'synced').length === 3);
  check('断网记录状态为 failed', s.observations.find((o) => o.note === '断网期间记录')?.sync === 'failed');

  store.dispatch(setOnline(true));
  await store.dispatch(syncAll());
  s = store.getState().patrol;
  const retried = s.outbox.filter((o) => o.batchId === offlineBatch);
  check('重连后失败操作重试成功', retried.every((o) => o.status === 'synced'), retried.map((o) => o.status));
  check('已同步操作未被重发（attempts 不变）', s.outbox.filter((o) => o.status === 'synced').every((o) => o.attempts <= 1));

  // 持久化：存储中包含批次与操作（重启后可看清每批剩余项）
  const persisted = JSON.parse(memory['yf57-patrol-state']);
  check('持久化包含批次', Array.isArray(persisted.batches) && persisted.batches.length >= 2);
  check('持久化包含操作队列', Array.isArray(persisted.outbox) && persisted.outbox.length >= 6);
  check('持久化不包含 syncing 标志', persisted.syncing === undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
