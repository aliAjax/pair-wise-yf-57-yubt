# pair-wise-yf-57 野外巡护离线调查应用

## 源提示词摘要
巡护员离线记录观察、轨迹点、样本编号、风险等级和现场情况，回到有网络环境后同步给站点负责人。负责人复核重复观察、位置异常、证据缺失和能力范围外事项；多人修改同一记录时保留版本并允许合并，应用需要适配手机屏幕、电量、弱网和后台恢复。

## 本轮需求与实现
巡护员在山里连续新增记录，回站整批上传；断网重试与并发修改必须安全。实现位于 `src/sync/`（纯 TS，不依赖 Taro，可在 Node 下直测）：

1. **按巡护批次组织离线记录** — 每条记录携带 `batchId`，批次有 `open/uploaded` 状态；出队箱（`outbox.ts`）按批次归集，UI 批次标签显示每批剩余项。同一记录离线连续修改只并入**同一个待发 op**。
2. **联网后按单条版本逐字段合并** — 每个字段独立版本 `{rev, at, by}`；服务端 `merge.ts` 做字段级 LWW（时间戳新者胜，同刻站点负责人 `lead` 优先）。本地旧副本整行上送盖不住负责人的新字段，巡护员改的其他字段照常并入。
3. **重复上传不新增第二条** — 双保险：
   - 每个同步操作有 `opId`，服务端缓存 `opId → 结果`，断网重试（含“服务端已落库但响应丢失”）返回同一结果；
   - 轨迹点自然键 `批次 + 采集秒 + 坐标(5位小数)`：本地先去重，服务端对跨设备/重装的重放返回 `duplicate` 而不是新建。
4. **已核验样本不退回草稿** — 样本状态序 `draft < submitted < verified` 单调升级；即使旧草稿带着更新的时间戳上送，降级也被闸门拒绝。
5. **失败保留、只重试失败部分、重启可见剩余** — 同步逐单执行，首个网络错误即停：成功单 `done`（永不重发），失败单 `failed`，未轮到的保持 `queued`；重连只挑 `queued/failed`。状态全部持久化，启动时把残留的 `inflight` 回收为 `failed`，每批剩余数一眼可见。

同步过程在 `runner.ts` 中表达为事件流（`start / opStart / opSuccess / opFailure / finish`），Redux thunk 逐事件 dispatch 到 Immer reducer；Node 测试把同一批纯函数直接落地到普通对象，两端行为一致。

## 文件结构
- `src/sync/types.ts` — 领域模型与状态类型
- `src/sync/merge.ts` — 字段级 LWW、样本状态单调、轨迹点自然键
- `src/sync/server.ts` — 模拟站点服务器（opId 幂等、断网/弱网注入、负责人直改、持久化）
- `src/sync/outbox.ts` — 批次、记录编辑、出队组织、崩溃回收
- `src/sync/runner.ts` — 同步事件流与执行器
- `src/store/index.ts` — Redux 接入、Taro 持久化、同步/负责人 thunk
- `scripts/sync.test.cjs` — 17 项需求验收测试
- `scripts/demo.cjs` — 端到端故事演练

## 技术栈
Taro 3 + React + TypeScript + NutUI + Redux Toolkit + React Hook Form + Zod。

## 验证
```bash
npm run test:sync   # 17 项验收测试
npm run demo:sync   # 打印完整业务故事（断网→负责人改→重连合并→重启剩余）
npx tsc --noEmit    # 全项目类型检查
```

## 启动
```bash
npm install
npm run dev
```
开发端口：62022

> 注：Taro 3.6 的原生 binding 未发布 linux-arm64 预编译包，arm64 机器上 `npm run build` 会因 `@tarojs/binding` 缺失而失败（x64 / macOS 正常）；纯逻辑测试与 `tsc` 类型检查不受影响。
