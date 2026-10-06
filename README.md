# pair-wise-yf-57 野外巡护离线调查应用

## 源提示词摘要
巡护员离线记录观察、轨迹点、样本编号、风险等级和现场情况，回到有网络环境后同步给站点负责人。负责人复核重复观察、位置异常、证据缺失和能力范围外事项；多人修改同一记录时保留版本并允许合并，应用需要适配手机屏幕、电量、弱网和后台恢复。

## 技术栈
Taro 3 + React + TypeScript + NutUI + Redux Toolkit + RTK Query + React Hook Form + Zod + Taro 国际化方案。

## 已实现闭环
- 观察记录、轨迹点、样本三类业务对象，全部按**巡护批次**组织：开始批次后连续录入，结束批次后整批待上传。
- **单条版本合并**：每条记录带 version / baseVersion / baseSnapshot，联网时按三向合并处理负责人与巡护员的同时修改，负责人修订不被本地旧副本覆盖。
- **幂等上传**：每条操作带唯一幂等键，断网重试、响应丢失后重连都只去重、不新增第二条轨迹点/记录。
- **样本状态只进不退**：draft → submitted → verified，合并时取最高状态，已核验样本不退回草稿。
- **失败保留与增量重试**：操作队列（outbox）逐条记录 pending / syncing / synced / failed，同步失败保留错误与次数；重连后只重试失败部分，已同步操作绝不重发。
- **持久化**：批次、记录、操作队列写入 Taro 本地存储，重启后每批剩余项（待同步/失败）一目了然，可按批次或全部重试。
- 模拟联网/断网切换、同步日志、合并提示横幅。

## 同步引擎验证
`scripts/` 下提供脱离 Taro CLI 的逻辑验证（mock 本地存储后直接运行）：
```bash
node scripts/test-sync.cjs    # 幂等去重、响应丢失重试、三向合并、样本状态 monotonic
node scripts/test-store.cjs   # 批次队列、失败保留、增量重试、持久化
node scripts/test-render.cjs  # 页面渲染冒烟
```

## 启动
```bash
npm install
npm run dev
```
开发端口：62022

> 注：Taro 3.6 的原生绑定未提供 linux-arm64-gnu 预编译包，该环境下 `taro build` 无法运行；类型检查 `npx tsc --noEmit` 与上述同步逻辑验证均可正常执行。
