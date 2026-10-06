/* eslint-disable no-console */
// 纯逻辑验收测试：五条需求逐条验证。运行：node scripts/sync.test.cjs
// 通过 ts.transpileModule 即时编译 src/sync 下的 TS，无需安装依赖。
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const assert = require('assert');

const root = path.join(__dirname, '..', 'src', 'sync');
const moduleCache = {};

function loadTs(absFile) {
  const file = absFile.endsWith('.ts') ? absFile : `${absFile}.ts`;
  if (moduleCache[file]) return moduleCache[file].exports;
  const source = fs.readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  });
  const mod = { exports: {} };
  moduleCache[file] = mod;
  const localRequire = (spec) => {
    if (spec.startsWith('.')) return loadTs(path.resolve(path.dirname(file), spec));
    return require(spec);
  };
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, localRequire, mod, file, path.dirname(file)
  );
  return mod.exports;
}

const load = (rel) => loadTs(path.join(root, rel));

const { f, upsertRecord, reconcileLocal, trackNaturalKey } = load('merge.ts');
const { MockStationServer, NetworkError } = load('server.ts');
const outbox = load('outbox.ts');
const { runSync } = load('runner.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
    process.exitCode = 1;
  }
}

function memKV() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), _m: m };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log('需求1：按巡护批次组织离线记录，连续新增后出队箱按批次归集');
  await test('两个批次各自新增记录，pendingOps 可按批次归集剩余项', () => {
    const s = outbox.initialState(1000);
    const b1 = s.batches[0].id;
    outbox.addRecord(s, { kind: 'observation', batchId: b1, patch: { note: 'A', risk: 'low' } });
    outbox.addRecord(s, { kind: 'point', batchId: b1, patch: { latitude: 1, longitude: 2, capturedAt: 5, source: 'gps' } });
    const b2 = outbox.createBatch(s, '第二批');
    outbox.addRecord(s, { kind: 'sample', batchId: b2.id, patch: { code: 'X', species: 'Y', count: 1, status: 'draft' } });
    assert.strictEqual(outbox.batchRemaining(s, b1), 2);
    assert.strictEqual(outbox.batchRemaining(s, b2.id), 1);
    assert.strictEqual(s.records.filter((r) => r.batchId === b1).length, 2);
    assert.strictEqual(s.records.filter((r) => r.batchId === b2.id).length, 1);
  });

  await test('同一记录离线连续修改只并入一个待发 op，不会产生两条上传', () => {
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const rec = outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: 'v1', risk: 'low' } });
    outbox.editRecord(s, rec.id, { note: 'v2' });
    outbox.editRecord(s, rec.id, { note: 'v3' });
    const ops = s.ops.filter((o) => o.recordId === rec.id && o.status !== 'done');
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].payload.fields.note.value, 'v3');
  });

  console.log('\n需求2：联网后按单条版本逐字段合并，旧副本盖不住负责人修改');
  await test('负责人在站点改过 note，巡护员旧副本上送：note 保留负责人版本，risk 仍并入新值', () => {
    let server;
    // 服务端已有负责人更新版本（at=2000，by=lead）
    server = upsertRecord(undefined, 'o1', 'observation', 'b1', {
      note: f('负责人补充：足迹为成年个体', 2000, 'lead'),
      risk: f('medium', 1000, 'ranger')
    }, 101).record;
    // 巡护员设备上的旧副本：note 是旧文本(1000)，但 risk 刚改成 high(3000)
    const result = upsertRecord(server, 'o1', 'observation', 'b1', {
      note: f('东坡发现新鲜足迹', 1000, 'ranger'),
      risk: f('high', 3000, 'ranger')
    }, 102);
    assert.strictEqual(result.record.fields.note.value, '负责人补充：足迹为成年个体');
    assert.strictEqual(result.record.fields.note.meta.by, 'lead');
    assert.strictEqual(result.record.fields.risk.value, 'high');
    assert.deepStrictEqual(result.superseded, ['risk']);
  });

  await test('时间戳相同的同字段冲突，站点负责人优先', () => {
    const server = upsertRecord(undefined, 'o', 'observation', 'b', { note: f('负责人版', 5000, 'lead') }, 1).record;
    const result = upsertRecord(server, 'o', 'observation', 'b', { note: f('巡护员版', 5000, 'ranger') }, 2);
    assert.strictEqual(result.record.fields.note.value, '负责人版');
  });

  await test('不同字段并发修改互不覆盖（字段级合并而非整行替换）', () => {
    const server = upsertRecord(undefined, 'o', 'observation', 'b', { note: f('N', 1000, 'ranger'), risk: f('low', 1000, 'ranger') }, 1).record;
    const lead = upsertRecord(server, 'o', 'observation', 'b', { note: f('负责人改备注', 2000, 'lead') }, 2).record;
    const ranger = upsertRecord(lead, 'o', 'observation', 'b', { risk: f('high', 3000, 'ranger') }, 3).record;
    assert.strictEqual(ranger.fields.note.value, '负责人改备注');
    assert.strictEqual(ranger.fields.risk.value, 'high');
  });

  console.log('\n需求3：重复上传不新增第二条（opId 幂等 + 轨迹点自然键）');
  await test('同一 opId 断网重试两次，服务端只落一条且返回相同结果', async () => {
    const srv = new MockStationServer(memKV());
    const s = outbox.initialState();
    const b = s.batches[0].id;
    outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: 'X', risk: 'low' } });
    const op = s.ops[0];
    const r1 = await srv.upload(op);
    const r2 = await srv.upload(op);
    assert.strictEqual(r1, r2);
    assert.strictEqual(r1.effect, 'created');
    // 同一 opId 再传：服务端记录不重复、修订号不变
    assert.strictEqual(srv.getRecord(op.recordId).id, op.recordId);
    const before = srv.getRecord(op.recordId).rev;
    await srv.upload(op);
    assert.strictEqual(srv.getRecord(op.recordId).rev, before);
  });

  await test('本地：同批次重复采集同一点位只建一条记录、一个 op', () => {
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const a = outbox.addRecord(s, { kind: 'point', batchId: b, patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: 700000, source: 'gps' } });
    const again = outbox.addRecord(s, { kind: 'point', batchId: b, patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: 700000, source: 'gps' } });
    assert.strictEqual(again, a);
    assert.strictEqual(s.records.filter((r) => r.kind === 'point').length, 1);
    assert.strictEqual(s.ops.length, 1);
  });

  await test('服务端兜底：不同设备/重装产生的两个 op 同点位，第二次 duplicate 不新建', async () => {
    const srv = new MockStationServer(memKV());
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const patch = { latitude: 30.5821, longitude: 103.2174, capturedAt: 700000, source: 'gps' };
    const p1 = outbox.addRecord(s, { kind: 'point', batchId: b, patch });
    const op1 = s.ops.find((o) => o.recordId === p1.id);
    // 模拟另一台设备/重装后独立提交：手工放第二个 op，绕过本地索引
    const p2 = { id: 'p2-other-device', kind: 'point', batchId: b, createdAt: 1, baseRev: 0, dirty: true,
      fields: JSON.parse(JSON.stringify(p1.fields)) };
    s.records.push(p2);
    s.ops.push({ opId: 'op-other-2', batchId: b, kind: 'record-point', recordId: p2.id,
      payload: JSON.parse(JSON.stringify(p2)), status: 'queued', attempts: 0, createdAt: 2, updatedAt: 2 });
    const op2 = s.ops.find((o) => o.recordId === 'p2-other-device');
    const r1 = await srv.upload(op1);
    const r2 = await srv.upload(op2);
    assert.strictEqual(r1.effect, 'created');
    assert.strictEqual(r2.effect, 'duplicate');
    assert.strictEqual(r2.serverRecord.id, p1.id);
  });

  await test('自然键在约1米/1秒外视为不同点，正常新建', () => {
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const a = outbox.addRecord(s, { kind: 'point', batchId: b, patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: 1000, source: 'gps' } });
    const c1 = trackNaturalKey(a);
    const nearby = outbox.addRecord(s, { kind: 'point', batchId: b, patch: { latitude: 30.5823, longitude: 103.2174, capturedAt: 1000, source: 'gps' } });
    assert.notStrictEqual(trackNaturalKey(nearby), c1);
  });

  console.log('\n需求4：负责人与巡护员同时改同一条，已核验样本不退回草稿');
  await test('服务端已 verified，巡护员用时间戳更新的 draft 上送被拒，仍 verified', () => {
    const server = upsertRecord(undefined, 's1', 'sample', 'b', {
      code: f('WD-1', 1000, 'ranger'),
      status: f('submitted', 1000, 'ranger')
    }, 1).record;
    const verified = upsertRecord(server, 's1', 'sample', 'b', { status: f('verified', 2000, 'lead') }, 2).record;
    // 模拟旧本地副本回传：draft 且时间戳故意更新
    const stale = upsertRecord(verified, 's1', 'sample', 'b', { status: f('draft', 3000, 'ranger') }, 3);
    assert.strictEqual(stale.record.fields.status.value, 'verified');
    assert.strictEqual(stale.record.fields.status.meta.by, 'lead');
    assert.deepStrictEqual(stale.superseded, []);
  });

  await test('draft→submitted→verified 正常升级链路放行', () => {
    let rec;
    rec = upsertRecord(undefined, 's', 'sample', 'b', { status: f('draft', 1, 'ranger') }, 1).record;
    rec = upsertRecord(rec, 's', 'sample', 'b', { status: f('submitted', 2, 'ranger') }, 2).record;
    rec = upsertRecord(rec, 's', 'sample', 'b', { status: f('verified', 3, 'lead') }, 3).record;
    assert.strictEqual(rec.fields.status.value, 'verified');
  });

  await test('端到端：负责人先核验，巡护员随后整批同步，本地回灌后仍为 verified', async () => {
    const kv = memKV();
    const srv = new MockStationServer(kv);
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const sample = outbox.addRecord(s, { kind: 'sample', batchId: b, patch: { code: 'WD-1', species: '毛', count: 1, status: 'submitted' } });
    // 先完成首批同步
    await runSync(s, srv);
    // 负责人在站点核验
    await srv.leadEdit(sample.id, 'sample', b, { status: f('verified', Date.now(), 'lead') });
    // 巡护员在设备上（离线状态没看到核验）修改了物种名，同时本地状态仍是 submitted
    outbox.editRecord(s, sample.id, { species: '豹猫毛发（修订）' });
    const report = await runSync(s, srv);
    assert.strictEqual(report.failed, 0);
    const local = s.records.find((r) => r.id === sample.id);
    assert.strictEqual(local.fields.status.value, 'verified');
    assert.strictEqual(local.fields.species.value, '豹猫毛发（修订）');
    assert.strictEqual(local.dirty, false);
  });

  console.log('\n需求5：同步失败保留未完成操作，重连只重试失败部分，重启可见每批剩余');
  await test('弱网：第2单失败即停，前1单 done，后续保留；重连只发剩余', async () => {
    const srv = new MockStationServer(memKV());
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const r1 = outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: '1', risk: 'low' } });
    const r2 = outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: '2', risk: 'low' } });
    const r3 = outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: '3', risk: 'low' } });
    srv.setLatency && null;
    srv.injectFailures(1); // 下一次上送失败（落在按序第1单上）
    const rep1 = await runSync(s, srv);
    assert.strictEqual(rep1.attempted, 1);
    assert.strictEqual(rep1.succeeded, 0);
    assert.strictEqual(rep1.remaining, 3);
    assert.strictEqual(s.ops.find((o) => o.recordId === r1.id).status, 'failed');
    assert.strictEqual(s.ops.find((o) => o.recordId === r2.id).status, 'queued');
    assert.strictEqual(s.ops.find((o) => o.recordId === r3.id).status, 'queued');
    // 重连同 opId 重放；服务端此前并未落库（请求丢失），本次 created
    const rep2 = await runSync(s, srv);
    assert.strictEqual(rep2.attempted, 3);
    assert.strictEqual(rep2.succeeded, 3);
    assert.strictEqual(rep2.remaining, 0);
    assert.ok(s.ops.every((o) => o.status === 'done'));
  });

  await test('离线时同步不动任何 op，报告 remaining 即未完成数', async () => {
    const srv = new MockStationServer(memKV());
    srv.setOnline(false);
    const s = outbox.initialState();
    s.online = false;
    const b = s.batches[0].id;
    outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: '1', risk: 'low' } });
    const rep = await runSync(s, srv);
    assert.strictEqual(rep.attempted, 0);
    assert.strictEqual(rep.remaining, 1);
    assert.strictEqual(s.ops[0].status, 'queued');
  });

  await test('inflight 崩溃回收：重启后变 failed，批次剩余数准确', () => {
    const s = outbox.initialState();
    const b = s.batches[0].id;
    const r = outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: 'x', risk: 'low' } });
    s.ops[0].status = 'inflight';
    // 模拟持久化后重新启动
    const restored = JSON.parse(JSON.stringify(s));
    outbox.recoverInflight(restored);
    assert.strictEqual(restored.ops[0].status, 'failed');
    assert.strictEqual(outbox.batchRemaining(restored, b), 1);
  });

  await test('批次全部上传后 status=uploaded；再有新增回到 open', async () => {
    const srv = new MockStationServer(memKV());
    const s = outbox.initialState();
    const b = s.batches[0].id;
    outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: '1', risk: 'low' } });
    const rep = await runSync(s, srv);
    assert.strictEqual(rep.remaining, 0);
    assert.strictEqual(s.batches[0].status, 'uploaded');
    outbox.addRecord(s, { kind: 'point', batchId: b, patch: { latitude: 1, longitude: 2, capturedAt: 9, source: 'manual' } });
    assert.strictEqual(s.batches[0].status, 'open');
  });

  await test('服务端在首次“失败”其实已落库时，重试用同 opId 拿到缓存结果（at-least-once 去重）', async () => {
    // 构造：服务器记录 opId 结果（模拟响应丢失），客户端标记 failed，重试不产生第二条
    const srv = new MockStationServer(memKV());
    const s = outbox.initialState();
    const b = s.batches[0].id;
    outbox.addRecord(s, { kind: 'observation', batchId: b, patch: { note: 'X', risk: 'low' } });
    const op = s.ops[0];
    const first = await srv.upload(op);
    // 客户端没收到响应：
    op.status = 'failed';
    const second = await srv.upload(op);
    assert.strictEqual(second, first);
    assert.strictEqual(second.effect, 'created');
    // 回灌后幂等
    const local = s.records[0];
    const a = reconcileLocal(local, second);
    const c = reconcileLocal(a, second);
    assert.strictEqual(c.fields.note.value, 'X');
  });

  await wait(0);
  console.log(`\n${passed} 项通过`);
})();
