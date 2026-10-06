// 离线同步引擎逻辑验证（不依赖 Taro CLI 原生绑定）
// 运行：node /workspace/scripts/test-sync.cjs
const Module = require('module');
const path = require('path');

// 1. mock @tarojs/taro 的本地存储
const memory = {};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@tarojs/taro') {
    return {
      getStorageSync: (k) => (k in memory ? memory[k] : ''),
      setStorageSync: (k, v) => { memory[k] = String(v); },
      removeStorageSync: (k) => { delete memory[k]; }
    };
  }
  return origLoad.apply(this, arguments);
};

// 2. 用 babel 即时编译 TS
require('@babel/register')({
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
  extensions: ['.js', '.ts', '.tsx'],
  cache: false
});

const { syncRecord, resetServer } = require(path.join(process.cwd(), 'src/server/fakeServer.ts'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra ?? ''); }
}

resetServer();
const realRandom = Math.random;
Math.random = () => 0.99; // 默认确定性：不触发响应丢失

// 场景1：离线时操作保留，联网后成功
{
  const r1 = syncRecord({ online: false, kind: 'point', recordId: 'px1', idempotencyKey: 'op-px1', data: { latitude: 30.58, longitude: 103.21, at: '09:00', source: 'gps' }, baseVersion: 0, baseSnapshot: null });
  check('离线返回失败且不写入', r1.ok === false && /网络不可用/.test(r1.error || ''));
  const r2 = syncRecord({ online: true, kind: 'point', recordId: 'px1', idempotencyKey: 'op-px1', data: { latitude: 30.58, longitude: 103.21, at: '09:00', source: 'gps' }, baseVersion: 0, baseSnapshot: null });
  check('联网后同步成功 v1', r2.ok === true && r2.record.version === 1);
}

// 场景2：重复上传（同幂等键）不新增第二条
{
  const before = Object.keys(JSON.parse(memory['yf57-fake-server']).records).length;
  const r = syncRecord({ online: true, kind: 'point', recordId: 'px1', idempotencyKey: 'op-px1', data: { latitude: 30.58, longitude: 103.21, at: '09:00', source: 'gps' }, baseVersion: 1, baseSnapshot: null });
  const after = Object.keys(JSON.parse(memory['yf57-fake-server']).records).length;
  check('重试命中幂等去重', r.ok === true && r.duplicated === true);
  check('服务端记录数不增加', before === after);
}

// 场景3：服务端已写入但响应丢失 -> 重试不重复新增
{
  Math.random = () => 0.1; // 强制触发响应丢失
  const r1 = syncRecord({ online: true, kind: 'observation', recordId: 'ox9', idempotencyKey: 'op-ox9', data: { note: '新发现', risk: 'low', reviewed: false }, baseVersion: 0, baseSnapshot: null });
  check('响应丢失：客户端收到失败', r1.ok === false && /响应丢失/.test(r1.error || ''));
  const committed = JSON.parse(memory['yf57-fake-server']).records['ox9'];
  check('响应丢失：服务端已写入', !!committed && committed.version === 1);
  Math.random = () => 0.99;
  const r2 = syncRecord({ online: true, kind: 'observation', recordId: 'ox9', idempotencyKey: 'op-ox9', data: { note: '新发现', risk: 'low', reviewed: false }, baseVersion: 0, baseSnapshot: null });
  check('重连重试：幂等去重不新增', r2.ok === true && r2.duplicated === true);
}

// 场景4：o2 本地旧副本 vs 负责人 v2 -> 按版本合并，负责人修订不被覆盖
{
  const base = { time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewed: false };
  const r = syncRecord({ online: true, kind: 'observation', recordId: 'o2', idempotencyKey: 'op-seed-o2', data: base, baseVersion: 1, baseSnapshot: base });
  check('o2 合并成功', r.ok === true && r.merged === true, r.error);
  check('o2 版本升到 v3', r.record.version === 3);
  check('o2 负责人补充说明保留', /负责人已联系后勤/.test(r.record.data.note));
  check('o2 负责人复核保留', r.record.data.reviewed === true);
  check('o2 风险等级未被本地覆盖', r.record.data.risk === 'high');
}

// 场景5：s1 本地 submitted 旧副本 vs 负责人 verified -> 已核验不退回草稿
{
  const base = { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted' };
  const r = syncRecord({ online: true, kind: 'sample', recordId: 's1', idempotencyKey: 'op-seed-s1', data: base, baseVersion: 1, baseSnapshot: base });
  check('s1 合并成功', r.ok === true && r.merged === true, r.error);
  check('s1 状态保持 verified（不退回草稿）', r.record.data.status === 'verified');
}

// 场景6：两边都改同一字段 -> 负责人（服务端）优先；本地独有修改保留
{
  const base = { time: 't', note: '原始记录', risk: 'low', reviewed: false };
  // 服务端 v2：负责人改了 note 并复核；本地 v1 基础上也改了 note（模拟巡护员补充）
  // 先制造一个服务端 v2
  const s = JSON.parse(memory['yf57-fake-server']);
  s.records['o2b'] = { recordId: 'o2b', kind: 'observation', version: 2, data: { time: 't', note: '负责人修改', risk: 'medium', reviewed: true }, idempotencyKey: null, updatedAt: 1 };
  memory['yf57-fake-server'] = JSON.stringify(s);
  const r = syncRecord({ online: true, kind: 'observation', recordId: 'o2b', idempotencyKey: 'op-o2b', data: { time: 't', note: '巡护员也改了', risk: 'medium', reviewed: false }, baseVersion: 1, baseSnapshot: base });
  check('冲突字段以负责人为准', r.record.data.note === '负责人修改' && r.record.data.reviewed === true);
}

// 场景7：本地独有修改、服务端未改 -> 保留本地
{
  const s = JSON.parse(memory['yf57-fake-server']);
  s.records['o2c'] = { recordId: 'o2c', kind: 'observation', version: 1, data: { time: 't', note: '原始', risk: 'low', reviewed: false }, idempotencyKey: null, updatedAt: 1 };
  memory['yf57-fake-server'] = JSON.stringify(s);
  const r = syncRecord({ online: true, kind: 'observation', recordId: 'o2c', idempotencyKey: 'op-o2c', data: { time: 't', note: '巡护员补充细节', risk: 'low', reviewed: false }, baseVersion: 1, baseSnapshot: { time: 't', note: '原始', risk: 'low', reviewed: false } });
  check('本地独有修改保留且版本+1', r.record.data.note === '巡护员补充细节' && r.record.version === 2 && r.merged === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
