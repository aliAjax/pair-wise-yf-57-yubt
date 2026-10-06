import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Taro from '@tarojs/taro';
import {
  startBatch, endBatch, setOnline,
  addObservation, addPoint, addSample,
  reviewObservation, verifySample,
  syncBatch, syncAll, clearLog,
  type RootState, type AppDispatch, type PatrolBatch
} from '../../store';
import type { Kind } from '../../server/fakeServer';
import './index.scss';

const RISK_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' };
const SAMPLE_LABEL: Record<string, string> = { draft: '草稿', submitted: '已提交', verified: '已核验' };
const SYNC_LABEL: Record<string, string> = {
  local: '本地', queued: '待同步', syncing: '同步中', synced: '已同步', failed: '失败', conflict: '冲突'
};
const SYNC_COLOR: Record<string, string> = {
  local: '#8a9a93', queued: '#b07a00', syncing: '#2a6df4', synced: '#1f8a4c', failed: '#d23f31', conflict: '#d23f31'
};

interface RemainingItem {
  opId: string; kind: Kind; recordId: string;
  title: string; status: string; attempts: number; error: string | null;
}
interface BatchStats {
  pending: number; syncing: number; failed: number; synced: number;
  remaining: RemainingItem[];
}

function recordTitle(state: RootState['patrol'], kind: Kind, recordId: string): string {
  if (kind === 'observation') {
    const r = state.observations.find((o) => o.id === recordId);
    return r ? `观察：${r.note.slice(0, 18)}（风险${RISK_LABEL[r.risk]}）` : '观察记录';
  }
  if (kind === 'point') {
    const r = state.points.find((p) => p.id === recordId);
    return r ? `轨迹点：${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}` : '轨迹点';
  }
  const r = state.samples.find((s) => s.id === recordId);
  return r ? `样本：${r.code} ${r.species}` : '样本';
}

function useBatchStats(): Record<string, BatchStats> {
  const patrol = useSelector((s: RootState) => s.patrol);
  return useMemo(() => {
    const map: Record<string, BatchStats> = {};
    for (const b of patrol.batches) {
      const ops = patrol.outbox.filter((o) => o.batchId === b.id);
      map[b.id] = {
        pending: ops.filter((o) => o.status === 'pending').length,
        syncing: ops.filter((o) => o.status === 'syncing').length,
        failed: ops.filter((o) => o.status === 'failed').length,
        synced: ops.filter((o) => o.status === 'synced').length,
        remaining: ops.filter((o) => o.status !== 'synced').map((o) => ({
          opId: o.id, kind: o.kind, recordId: o.recordId,
          title: recordTitle(patrol, o.kind, o.recordId),
          status: o.status, attempts: o.attempts, error: o.lastError
        }))
      };
    }
    return map;
  }, [patrol]);
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <span className='card-title'>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

export default function Index() {
  const dispatch = useDispatch<AppDispatch>();
  const patrol = useSelector((s: RootState) => s.patrol);
  const stats = useBatchStats();
  const [tab, setTab] = useState<'obs' | 'point' | 'sample'>('obs');
  const [note, setNote] = useState('');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium');
  const [code, setCode] = useState('');
  const [species, setSpecies] = useState('');
  const [count, setCount] = useState(1);

  const openBatch = patrol.batches.find((b) => b.id === patrol.currentBatchId && b.status === 'open') ?? null;

  const submitObs = () => {
    if (!note.trim()) { Taro.showToast({ title: '请填写观察情况', icon: 'none' }); return; }
    dispatch(addObservation({ note: note.trim(), risk }));
    setNote('');
    Taro.showToast({ title: '已记入当前批次', icon: 'success' });
  };
  const submitPoint = () => {
    dispatch(addPoint());
    Taro.showToast({ title: '轨迹点已记录', icon: 'success' });
  };
  const submitSample = () => {
    if (!code.trim() || !species.trim()) { Taro.showToast({ title: '请填写样本编号和物种', icon: 'none' }); return; }
    dispatch(addSample({ code: code.trim(), species: species.trim(), count: Number(count) || 1 }));
    setCode(''); setSpecies(''); setCount(1);
    Taro.showToast({ title: '样本已登记', icon: 'success' });
  };

  const syncOne = (batchId: string) => {
    if (!patrol.online) Taro.showToast({ title: '当前离线，操作会保留', icon: 'none' });
    dispatch(syncBatch(batchId));
  };

  return (
    <div className='page'>
      <div className='topbar'>
        <span className='topbar-title'>野外巡护离线调查</span>
        <span className={`online-pill ${patrol.online ? 'on' : 'off'}`} onClick={() => dispatch(setOnline(!patrol.online))}>
          {patrol.online ? '在线' : '离线'}（点击切换）
        </span>
      </div>

      <div className='hero'>
        <div className='hero-title'>按批次离线记录，联网按版本合并</div>
        <div className='hero-sub'>每条记录带唯一幂等键，重试不重复新增；负责人修订按单条版本合并，已核验样本不退回草稿。</div>
      </div>

      {patrol.lastMerge && <div className='banner'>{patrol.lastMerge}</div>}

      <Section title='巡护批次'>
        {!openBatch ? (
          <button className='btn primary block' onClick={() => dispatch(startBatch())}>开始新的巡护批次</button>
        ) : (
          <div className='current-batch'>
            <div className='batch-name'>当前批次：{openBatch.name}</div>
            <div className='batch-sub'>开始于 {openBatch.startedAt}，本批记录将在回站点后整批上传</div>
            <button className='btn block' onClick={() => dispatch(endBatch())}>结束当前批次</button>
          </div>
        )}
      </Section>

      <Section title='离线记录录入' extra={<span className='hint'>自动归入当前批次</span>}>
        {!openBatch && <div className='empty'>请先开始一个巡护批次</div>}
        {openBatch && (
          <>
            <div className='tabs'>
              <span className={tab === 'obs' ? 'tab active' : 'tab'} onClick={() => setTab('obs')}>观察记录</span>
              <span className={tab === 'point' ? 'tab active' : 'tab'} onClick={() => setTab('point')}>轨迹点</span>
              <span className={tab === 'sample' ? 'tab active' : 'tab'} onClick={() => setTab('sample')}>样本</span>
            </div>
            {tab === 'obs' && (
              <div className='form'>
                <textarea className='input textarea' placeholder='现场观察情况，如：东坡发现新鲜足迹…' value={note} onChange={(e) => setNote(e.target.value)} />
                <div className='risk-row'>
                  {(['low', 'medium', 'high'] as const).map((r) => (
                    <span key={r} className={risk === r ? 'risk-chip active' : 'risk-chip'} onClick={() => setRisk(r)}>风险{RISK_LABEL[r]}</span>
                  ))}
                </div>
                <button className='btn primary block' onClick={submitObs}>保存观察记录</button>
              </div>
            )}
            {tab === 'point' && (
              <div className='form'>
                <div className='hint'>连续行走时可反复记录；每个轨迹点带唯一幂等键，断网重试不会重复写入第二条。</div>
                <button className='btn primary block' onClick={submitPoint}>记录当前 GPS 轨迹点</button>
              </div>
            )}
            {tab === 'sample' && (
              <div className='form'>
                <input className='input' placeholder='样本编号，如 WD-1006-02' value={code} onChange={(e) => setCode(e.target.value)} />
                <input className='input' placeholder='物种/痕迹，如 疑似豹猫毛发' value={species} onChange={(e) => setSpecies(e.target.value)} />
                <input className='input' type='number' placeholder='数量' value={count} onChange={(e) => setCount(Number(e.target.value))} />
                <button className='btn primary block' onClick={submitSample}>登记样本</button>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title='批次与剩余项' extra={
        <button className='btn small primary' onClick={() => dispatch(syncAll())} disabled={patrol.syncing}>
          {patrol.syncing ? '同步中…' : '重连后全部重试'}
        </button>
      }>
        {patrol.batches.length === 0 && <div className='empty'>暂无批次</div>}
        {patrol.batches.map((b: PatrolBatch) => {
          const st = stats[b.id];
          const total = st ? st.pending + st.failed + st.synced + st.syncing : 0;
          return (
            <div key={b.id} className='batch-card'>
              <div className='batch-head'>
                <span className='batch-name'>{b.name}</span>
                <span className={`badge ${b.status === 'open' ? 'on' : ''}`}>{b.status === 'open' ? '进行中' : '已结束'}</span>
              </div>
              <div className='batch-sub'>{b.startedAt}{b.endedAt ? ` ~ ${b.endedAt}` : ''} · 共 {total} 项</div>
              <div className='counts'>
                <span className='count pending'>待同步 {st?.pending ?? 0}</span>
                <span className='count failed'>失败 {st?.failed ?? 0}</span>
                <span className='count syncing'>同步中 {st?.syncing ?? 0}</span>
                <span className='count synced'>已同步 {st?.synced ?? 0}</span>
              </div>
              {st && st.remaining.length > 0 && (
                <div className='remaining'>
                  {st.remaining.map((it) => (
                    <div key={it.opId} className='remaining-item'>
                      <span>{it.title}</span>
                      <span className='remaining-status' style={{ color: it.status === 'failed' ? SYNC_COLOR.failed : SYNC_COLOR.queued }}>
                        {it.status === 'failed' ? `第 ${it.attempts} 次失败` : '待同步'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className='batch-actions'>
                <button className='btn small' onClick={() => syncOne(b.id)} disabled={patrol.syncing}>同步此批次</button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section title='记录列表（按单条版本合并）'>
        <div className='record-group'>
          <div className='group-label'>观察记录</div>
          {patrol.observations.map((o) => (
            <div key={o.id} className='record'>
              <div className='record-line'>
                <span className='record-note'>{o.note}</span>
                <span className='sync-tag' style={{ color: SYNC_COLOR[o.sync] }}>{SYNC_LABEL[o.sync]}</span>
              </div>
              <div className='record-sub'>{o.time} · 风险{RISK_LABEL[o.risk]} · 版本 v{o.version}{o.reviewed ? ' · 已复核' : ''}</div>
              {!o.reviewed && <button className='btn small' onClick={() => dispatch(reviewObservation(o.id))}>负责人复核</button>}
            </div>
          ))}
        </div>
        <div className='record-group'>
          <div className='group-label'>轨迹点</div>
          {patrol.points.map((p) => (
            <div key={p.id} className='record'>
              <div className='record-line'>
                <span className='record-note'>{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}</span>
                <span className='sync-tag' style={{ color: SYNC_COLOR[p.sync] }}>{SYNC_LABEL[p.sync]}</span>
              </div>
              <div className='record-sub'>{p.at} · {p.source === 'gps' ? 'GPS' : '手动'} · 版本 v{p.version}</div>
            </div>
          ))}
        </div>
        <div className='record-group'>
          <div className='group-label'>样本</div>
          {patrol.samples.map((s) => (
            <div key={s.id} className='record'>
              <div className='record-line'>
                <span className='record-note'>{s.code} {s.species} ×{s.count}</span>
                <span className='sync-tag' style={{ color: SYNC_COLOR[s.sync] }}>{SYNC_LABEL[s.sync]}</span>
              </div>
              <div className='record-sub'>状态 {SAMPLE_LABEL[s.status]} · 版本 v{s.version}</div>
              {s.status !== 'verified' && <button className='btn small' onClick={() => dispatch(verifySample(s.id))}>负责人核验</button>}
            </div>
          ))}
        </div>
      </Section>

      <Section title='同步日志' extra={<button className='btn small' onClick={() => dispatch(clearLog())}>清空</button>}>
        <div className='log'>
          {patrol.log.length === 0 && <div className='empty'>暂无日志</div>}
          {patrol.log.map((l) => (
            <div key={l.id} className='log-item'>
              <span className='log-at'>{l.at}</span>
              <span className={`log-text ${l.tone}`}>{l.text}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
