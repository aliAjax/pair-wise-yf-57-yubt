/* eslint-disable no-console */
// 端到端场景演练（命令式）：把需求里的故事完整走一遍并打印结果。
// 运行：node scripts/demo.cjs
const path = require('path');
const ts = require('typescript');
const fs = require('fs');

const root = path.join(__dirname, '..', 'src', 'sync');
const cache = {};
function loadTs(absFile) {
  const file = absFile.endsWith('.ts') ? absFile : `${absFile}.ts`;
  if (cache[file]) return cache[file].exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  });
  const mod = { exports: {} };
  cache[file] = mod;
  const req = (s) => (s.startsWith('.') ? loadTs(path.resolve(path.dirname(file), s)) : require(s));
  new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    mod.exports, req, mod, file, path.dirname(file)
  );
  return mod.exports;
}
const load = (r) => loadTs(path.join(root, r));
const { f } = load('merge.ts');
const { MockStationServer } = load('server.ts');
const outbox = load('outbox.ts');
const { runSync } = load('runner.ts');

function memKV() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v) };
}

const line = (s) => console.log(`\n— ${s}`);

(async () => {
  const kv = memKV();
  const srv = new MockStationServer(kv);
  const s = outbox.initialState(new Date('2026-10-06T07:00:00').getTime());
  const batch = s.batches[0].id;
  s.batches[0].label = '10-06 东坡巡护批次';

  line('1) 山里连续新增：观察、样本、轨迹点（同一点位重复记录两次）');
  s.online = false;
  const obs = outbox.addRecord(s, { kind: 'observation', batch, patch: { note: '新鲜足迹，沿溪谷', risk: 'medium' } });
  const sample = outbox.addRecord(s, { kind: 'sample', batch, patch: { code: 'WD-1006-01', species: '豹猫毛发', count: 1, status: 'submitted' } });
  const point = outbox.addRecord(s, { kind: 'point', batch, patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: 700000, source: 'gps' } });
  outbox.addRecord(s, { kind: 'point', batch, patch: { latitude: 30.5821, longitude: 103.2174, capturedAt: 700000, source: 'gps' } });
  console.log(`   本地记录 ${s.records.length} 条，出队 op ${s.ops.length} 个（重复点未新增第二条）`);

  line('2) 回站点，首次同步前网络闪断 1 次');
  s.online = true;
  srv.injectFailures(1);
  let rep = await runSync(s, srv);
  console.log(`   第1轮：尝试 ${rep.attempted}，成功 ${rep.succeeded}，失败中断，剩余 ${rep.remaining}`);

  line('3) 站点负责人趁巡护员重试时改了观察备注，并核验了样本');
  await srv.leadEdit(obs.id, 'observation', batch, { note: f('新鲜足迹（负责人：成年个体，南段加密巡护）', Date.now() + 1000, 'lead') });
  await srv.leadEdit(sample.id, 'sample', batch, { status: f('verified', Date.now() + 2000, 'lead') });
  // 巡护员设备上的旧副本此时也改了风险，但没看到负责人的修改
  outbox.editRecord(s, obs.id, { risk: 'high' });

  line('4) 重连，只重试未完成部分');
  rep = await runSync(s, srv);
  console.log(`   第2轮：尝试 ${rep.attempted}，成功 ${rep.succeeded}，合并 ${rep.merged}，剩余 ${rep.remaining}`);

  line('5) 合并结果');
  const localObs = s.records.find((r) => r.id === obs.id);
  const localSample = s.records.find((r) => r.id === sample.id);
  console.log(`   观察备注：${localObs.fields.note.value}`);
  console.log(`   备注版本来自：${localObs.fields.note.meta.by === 'lead' ? '负责人 ✓（旧副本没盖住）' : '巡护员 ✗'}`);
  console.log(`   风险等级：${localObs.fields.risk.value}（巡护员新值已并入）`);
  console.log(`   样本状态：${localSample.fields.status.value}（已核验，未退回草稿）`);

  line('6) 模拟应用重启（序列化→回收 inflight）');
  const restored = JSON.parse(JSON.stringify(s));
  outbox.recoverInflight(restored);
  const perBatch = restored.batches.map((b) => `${b.label}=${outbox.batchRemaining(restored, b.id)} 剩余（${b.status === 'uploaded' ? '整批已上送' : '未完成'}）`);
  console.log(`   重启后每批剩余：${perBatch.join('；')}`);
  console.log(`   done op 数：${restored.ops.filter((o) => o.status === 'done').length}，无重发`);
})();
