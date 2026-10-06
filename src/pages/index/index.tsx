import { useMemo, useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addManualPoint,
  addObservation,
  addPoint,
  addSample,
  batchRemaining,
  injectFailures,
  leadEditThunk,
  newBatch,
  rangerEdit,
  setOnline,
  submitSample,
  syncThunk,
  type AppDispatch
} from '../../store';
import type {
  PatrolRecord,
  Risk,
  SyncEngineState,
  SyncOp
} from '../../sync/types';
import './index.scss';

const formSchema = z.object({
  note: z.string().min(2),
  risk: z.enum(['low', 'medium', 'high']),
  species: z.string(),
  code: z.string(),
  count: z.string()
});
type FormValues = z.infer<typeof formSchema>;

const riskLabel: Record<Risk, string> = { low: '低', medium: '中', high: '高' };
const statusLabel = { draft: '草稿', submitted: '已提交', verified: '已核验' } as const;
const opStatusLabel: Record<SyncOp['status'], string> = {
  queued: '待同步',
  inflight: '同步中',
  failed: '失败待重试',
  done: '已完成'
};
const kindLabel = { observation: '观察', point: '轨迹点', sample: '样本' } as const;
const opKindLabel: Record<SyncOp['kind'], string> = {
  'upsert-record': '记录上送',
  'record-point': '轨迹点'
};

function byLabel(by: string) {
  return by === 'lead' ? '负责人' : '巡护员';
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString();
}

function describeRecord(rec: PatrolRecord): string {
  const f = rec.fields;
  if (rec.kind === 'point') {
    return `${f.latitude?.value.toFixed(5) ?? '-'}, ${f.longitude?.value.toFixed(5) ?? '-'} · ${f.source?.value === 'manual' ? '手工' : 'GPS'}${f.capturedAt ? ' · ' + new Date(f.capturedAt.value).toLocaleTimeString() : ''}`;
  }
  if (rec.kind === 'sample') {
    return `${f.code?.value ?? ''} · ${f.species?.value ?? ''} × ${f.count?.value ?? 1} · ${statusLabel[f.status?.value ?? 'draft']}`;
  }
  return `${riskLabel[f.risk?.value ?? 'low']}风险 · ${f.note?.value ?? ''}`;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: { patrol: SyncEngineState }) => root.patrol);
  const [activeBatch, setActiveBatch] = useState<string>(state.batches[0]?.id ?? '');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', code: '', count: '1' }
  });

  const batchId = activeBatch || state.batches[0]?.id || '';
  const batchRecords = useMemo(
    () => state.records.filter((r) => r.batchId === batchId),
    [state.records, batchId]
  );
  const batchOps = useMemo(
    () => state.ops.filter((o) => o.batchId === batchId),
    [state.ops, batchId]
  );
  const remaining = batchRemaining(state, batchId);
  const totalRemaining = state.ops.filter((o) => o.status !== 'done').length;
  const failedCount = state.ops.filter((o) => o.status === 'failed').length;

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      // 无定位权限/室内无信号时给出就近手工点，保证离线可连续记录
      dispatch(addManualPoint({ latitude: 30.5821, longitude: 103.2174 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) {
      dispatch(
        addSample({
          code: values.code || `WD-${Date.now().toString().slice(-5)}`,
          species: values.species,
          count: Number(values.count) || 1
        })
      );
    }
    reset();
  };

  const sync = () => dispatch(syncThunk());

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / 批次化离线同步</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">山里连续记录，回站按批上送；逐字段版本合并，断网重试不产生第二条。</Text>
      </View>

      <View className="metrics">
        <View><Text>批次</Text><Text className="metric">{state.batches.length}</Text></View>
        <View><Text>本批剩余</Text><Text className="metric warn">{remaining}</Text></View>
        <View><Text>失败待重试</Text><Text className="metric">{failedCount}</Text></View>
      </View>

      {/* 批次与网络 */}
      <View className="card">
        <View className="card-title">
          巡护批次
          <Text className="count">未完成 {totalRemaining} 条</Text>
        </View>
        <ScrollView scrollX className="batch-tabs">
          {state.batches.map((b) => (
            <View
              key={b.id}
              className={`batch-tab ${b.id === batchId ? 'active' : ''} ${b.status === 'uploaded' ? 'done' : ''}`}
              onClick={() => setActiveBatch(b.id)}
            >
              <Text className="batch-label">{b.label}</Text>
              <Text className="batch-meta">
                {b.status === 'uploaded' ? '整批已上送' : `剩余 ${batchRemaining(state, b.id)}`}
              </Text>
            </View>
          ))}
        </ScrollView>
        <Button className="secondary" onClick={() => dispatch(newBatch(undefined))}>
          新建巡护批次
        </Button>
        <View className="net-row">
          <Button
            size="mini"
            className={state.online ? 'net-on' : 'net-off'}
            onClick={() => dispatch(setOnline(!state.online))}
          >
            {state.online ? '● 联网中（点击模拟断网）' : '○ 已断网（点击恢复联网）'}
          </Button>
          <Button size="mini" onClick={() => dispatch(injectFailures(1))}>
            注入1次弱网失败
          </Button>
          <Button size="mini" className="primary-mini" onClick={sync} disabled={state.syncing || totalRemaining === 0}>
            {state.syncing ? '同步中…' : `同步剩余 ${totalRemaining} 条`}
          </Button>
        </View>
        {state.lastRun && (
          <View className="hint report">
            上次同步 {formatTime(state.lastRun.at)}：尝试 {state.lastRun.attempted}，成功 {state.lastRun.succeeded}
            {state.lastRun.merged > 0 ? `，按字段合并 ${state.lastRun.merged}` : ''}
            {state.lastRun.duplicate > 0 ? `，重复点拦截 ${state.lastRun.duplicate}` : ''}
            {state.lastRun.failed > 0 ? `，失败中断，剩余 ${state.lastRun.remaining} 条保留` : `，剩余 ${state.lastRun.remaining} 条`}
            {state.lastRun.stoppedAt ? `（${state.lastRun.stoppedAt}）` : ''}
          </View>
        )}
      </View>

      {/* 现场录入 */}
      <View className="card">
        <View className="card-title">现场记录（写入当前批次，离线可用）</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea
            className="textarea"
            placeholder="记录观察、痕迹、设备问题或现场风险"
            {...register('note', { required: true })}
          />
          <View className="two">
            <Input className="input" placeholder="样本编号（可空）" {...register('code')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <Input className="input" placeholder="物种或样本名称（填写则同时登记样本）" {...register('species')} />
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      {/* 每批出队箱：重启后这里看清剩余项 */}
      <View className="card">
        <View className="card-title">
          出队箱（按批次）
          <Text className="count">{opStatusLabel.queued} {remaining}</Text>
        </View>
        <ScrollView scrollY className="list">
          {batchOps.length === 0 && <Text className="hint">本批暂无记录</Text>}
          {batchOps
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((op) => (
              <View className={`op op-${op.status}`} key={op.opId}>
                <View className="op-main">
                  <Text className="obs-title">{opKindLabel[op.kind]}</Text>
                  <Text className="muted">
                    {opStatusLabel[op.status]} · 第 {op.attempts} 次尝试 · opId {op.opId.slice(-4)}
                  </Text>
                  {op.lastError && <Text className="error-text">⚠ {op.lastError}</Text>}
                  {op.outcome?.effect === 'duplicate' && (
                    <Text className="ok-text">重复轨迹点，未新增第二条（合并到 {op.outcome.serverRecord.id}）</Text>
                  )}
                  {op.outcome?.effect === 'merged' && (
                    <Text className="ok-text">
                      已按字段合并{op.outcome.supersededFields?.length ? `：${op.outcome.supersededFields.join('、')}` : ''}
                    </Text>
                  )}
                </View>
                {op.status !== 'done' && (
                  <Button size="mini" onClick={sync} disabled={state.syncing || !state.online}>
                    重试本条
                  </Button>
                )}
              </View>
            ))}
        </ScrollView>
      </View>

      {/* 本批记录与双端修改 */}
      <View className="card">
        <View className="card-title">本批记录（逐字段版本）</View>
        <ScrollView scrollY className="list">
          {batchRecords.map((rec) => {
            const status = rec.fields.status?.value;
            const leadTouched = Object.values(rec.fields).some((vf) => vf?.meta.by === 'lead');
            return (
              <View className="observation" key={rec.id}>
                <View className="rec-body">
                  <Text className="obs-title">
                    {kindLabel[rec.kind]} · {describeRecord(rec)}
                  </Text>
                  <Text className="muted">
                    {rec.dirty ? '有未同步修改' : `基线 rev.${rec.baseRev}`}
                    {leadTouched ? ' · 含负责人版本' : ''}
                  </Text>
                  {rec.kind === 'observation' && (
                    <View className="edit-row">
                      <Input
                                        className="input mini-input"
                                        value={editing[rec.id] ?? rec.fields.note?.value ?? ''}
                                        onInput={(e) => setEditing((s) => ({ ...s, [rec.id]: e.detail.value }))}
                                      />
                                      <Button
                                        size="mini"
                                        onClick={() => {
                                          const val = editing[rec.id];
                                          if (val && val !== rec.fields.note?.value) {
                                            dispatch(rangerEdit({ recordId: rec.id, patch: { note: val } }));
                                          }
                                        }}
                                      >
                                        巡护员改备注
                                      </Button>
                                      <Button
                                        size="mini"
                                        className="lead-btn"
                                        onClick={() =>
                                          dispatch(
                                            leadEditThunk({
                                              recordId: rec.id,
                                              kind: rec.kind,
                                              batchId: rec.batchId,
                                              patch: { note: `${rec.fields.note?.value ?? ''}（负责人复核意见）` }
                                            })
                                          )
                                        }
                                      >
                                        负责人加复核意见
                                      </Button>
                                    </View>
                                  )}
                                  {rec.kind === 'sample' && (
                                    <View className="edit-row">
                                      <Button
                                        size="mini"
                                        disabled={status === 'submitted' || status === 'verified'}
                                        onClick={() => dispatch(submitSample(rec.id))}
                                      >
                                        巡护员提交
                                      </Button>
                                      <Button
                                        size="mini"
                                        className="lead-btn"
                                        disabled={status === 'verified'}
                                        onClick={() =>
                                          dispatch(
                                            leadEditThunk({
                                              recordId: rec.id,
                                              kind: rec.kind,
                                              batchId: rec.batchId,
                                              patch: { status: 'verified' }
                                            })
                                          )
                                        }
                                      >
                                        负责人核验
                                      </Button>
                                      {status === 'verified' && (
                                        <Text className="ok-text">已核验：任何旧草稿重传都不会退回</Text>
                                      )}
                                    </View>
                                  )}
                                </View>
                                {rec.fields.note?.meta && (
                                  <Text className="tag">
                                    {byLabel(rec.fields.note.meta.by)} v{rec.fields.note.meta.rev}
                                  </Text>
                                )}
                              </View>
                            );
                          })}
        </ScrollView>
      </View>
    </View>
  );
}
