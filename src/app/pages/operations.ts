/** 页面五：作业记录（每次登离轮存档、同种子回放、分档统计）。 */
import { h, clear, fmt, deg } from '../dom.ts';
import { store } from '../store.ts';
import { uid, repo } from '../../db/database.ts';
import type { OperationRecord } from '../../db/database.ts';
import { buildDirectionalSpectrum, spectralHs } from '../../core/spectrum.ts';
import { runSimulation, assessFeasibility } from '../../core/simulation.ts';
import { ensureRao } from '../../core/rao.ts';
import type { SeaStateInput } from '../../core/types.ts';

export function renderOperations(root: HTMLElement): void {
  clear(root);
  root.classList.remove('wide');

  const statCard = h('div', { class: 'card' });
  const listCard = h('div', { class: 'card' });
  const entryCard = h('div', { class: 'card' });

  function drawStats(): void {
    clear(statCard);
    statCard.append(h('h2', {}, '可登/不可登分档统计'));
    // 按登轮点 × 结果统计
    const byPoint = new Map<string, { success: number; abort: number; incident: number }>();
    for (const op of store.operations) {
      const s = byPoint.get(op.boardingPointId) ?? { success: 0, abort: 0, incident: 0 };
      s[op.result]++;
      byPoint.set(op.boardingPointId, s);
    }
    // 按 Hs 分档
    const bins = [0, 1, 1.5, 2, 2.5, 9];
    const binStat = bins.slice(0, -1).map((lo, i) => ({ lo, hi: bins[i + 1], ok: 0, no: 0 }));
    for (const op of store.operations) {
      const b = binStat.find((x) => op.metrics.significantHeight >= x.lo && op.metrics.significantHeight < x.hi);
      if (!b) continue;
      if (op.result === 'success') b.ok++; else b.no++;
    }
    const pointRows = [...byPoint.entries()].map(([pid, s]) => {
      const name = store.points.find((p) => p.id === pid)?.name ?? pid;
      const total = s.success + s.abort + s.incident;
      const rate = total ? (100 * s.success / total).toFixed(0) : '—';
      return h('tr', {}, h('td', {}, name), h('td', {}, String(s.success)), h('td', {}, String(s.abort)),
        h('td', {}, String(s.incident)), h('td', {}, `${rate}%`));
    });
    const hsRows = binStat.map((b) => h('tr', {},
      h('td', {}, `${b.lo}~${b.hi === 9 ? '∞' : b.hi} m`),
      h('td', {}, String(b.ok)), h('td', {}, String(b.no)),
      h('td', {}, b.ok + b.no ? `${(100 * b.ok / (b.ok + b.no)).toFixed(0)}%` : '—')));

    statCard.append(
      h('div', { class: 'grid-2' },
        h('div', {}, h('h3', {}, '按登轮点'), h('table', {}, h('thead', {}, h('tr', {},
          h('th', {}, '登轮点'), h('th', {}, '成功'), h('th', {}, '中止'), h('th', {}, '险情'), h('th', {}, '成功率'))),
          h('tbody', {}, ...pointRows))),
        h('div', {}, h('h3', {}, '按有效波高分档'), h('table', {}, h('thead', {}, h('tr', {},
          h('th', {}, 'Hs 区间'), h('th', {}, '可登'), h('th', {}, '不可登'), h('th', {}, '可登率'))),
          h('tbody', {}, ...hsRows))),
      ),
    );
  }

  function drawList(): void {
    clear(listCard);
    listCard.append(h('h2', {}, `登离轮作业记录（${store.operations.length}）`));
    const tb = h('tbody');
    for (const op of store.operations) {
      const tag = op.result === 'success' ? h('span', { class: 'tag ok' }, '成功登轮')
        : op.result === 'abort' ? h('span', { class: 'tag warn' }, '中止')
          : h('span', { class: 'tag danger' }, '险情');
      tb.append(h('tr', {},
        h('td', {}, new Date(op.createdAt).toLocaleString('zh-CN')),
        h('td', {}, op.boardingPointName),
        h('td', {}, op.vesselName),
        h('td', {}, `Hs ${fmt(op.metrics.significantHeight)} / 航向 ${Math.round(deg(op.shipHeading))}°`),
        h('td', {}, tag),
        h('td', {}, op.pilotName || '—', h('div', { class: 'muted' }, op.pilotFeedback)),
        h('td', {},
          h('button', { class: 'btn small', onclick: () => replay(op) }, '同种子回放'),
          ' ',
          h('button', { class: 'btn small danger', onclick: async () => { await repoRemove(op.id); drawAll(); } }, '删除'),
        ),
      ));
    }
    listCard.append(h('table', {}, h('thead', {}, h('tr', {},
      h('th', {}, '时间'), h('th', {}, '登轮点'), h('th', {}, '船舶'), h('th', {}, '海况/操纵'),
      h('th', {}, '结果'), h('th', {}, '引航员反馈'), h('th', {}, '操作'))), tb));
  }

  function drawEntry(): void {
    clear(entryCard);
    const point = store.currentPoint();
    const vessel = store.currentVessel();
    const sea = store.currentSeaState();
    if (!point || !vessel || !sea) { entryCard.append(h('div', { class: 'muted' }, '请先选择登轮点/船舶/海况')); return; }
    ensureRao(vessel);
    const spec = buildDirectionalSpectrum(sea);
    const hs = spectralHs(spec);
    const thresholds = store.thresholdsFor(point.id);
    const form = {
      heading: point.dominantWaveDir,
      speed: 0,
      result: 'success' as OperationRecord['result'],
      pilot: '',
      feedback: '',
    };
    const preview = h('div', {});
    function runPreview(): void {
      const result = runSimulation(spec, vessel!, {
        duration: 1800, sampleRate: 2, shipHeading: form.heading, shipSpeed: form.speed, seed: sea!.seed,
        boatOffsetX: vessel!.ladderX, boatOffsetY: (vessel!.ladderY > 0 ? 1 : -1) * (vessel!.beam / 2 + 6),
        thresholds,
      });
      const assess = assessFeasibility(result, thresholds, hs);
      clear(preview);
      preview.append(
        h('div', { class: `alert ${assess.feasible ? 'ok' : 'danger'}` }, assess.feasible ? '推演可行' : '推演超限'),
        ...assess.reasons.map((r) => h('div', { class: 'muted' }, '· ' + r)),
      );
    }
    runPreview();

    entryCard.append(
      h('h2', {}, '登记本次登离轮'),
      h('div', { class: 'grid-3' },
        h('label', { class: 'field' }, h('span', {}, '航向 °'), h('input', { type: 'number', value: String(Math.round(deg(form.heading))), oninput: (e) => { form.heading = deg(Number((e.target as HTMLInputElement).value)); runPreview(); } })),
        h('label', { class: 'field' }, h('span', {}, '航速 kn'), h('input', { type: 'number', value: '0', oninput: (e) => { form.speed = Number((e.target as HTMLInputElement).value) * 0.5144; runPreview(); } })),
        h('label', { class: 'field' }, h('span', {}, '结果'), Object.assign(h('select', {},
          h('option', { value: 'success' }, '成功登轮'), h('option', { value: 'abort' }, '中止'), h('option', { value: 'incident' }, '险情')),
          { onchange: (e: Event) => { form.result = (e.target as HTMLSelectElement).value as OperationRecord['result']; } })),
      ),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', {}, '引航员'), h('input', { placeholder: '姓名', oninput: (e) => { form.pilot = (e.target as HTMLInputElement).value; } })),
        h('label', { class: 'field' }, h('span', {}, '现场反馈'), h('input', { placeholder: '如：涌浪偏大、下风舷遮蔽良好', oninput: (e) => { form.feedback = (e.target as HTMLInputElement).value; } })),
      ),
      preview,
      h('button', {
        class: 'btn', onclick: async () => {
          const result = runSimulation(spec, vessel, {
            duration: 1800, sampleRate: 2, shipHeading: form.heading, shipSpeed: form.speed, seed: sea.seed,
            boatOffsetX: vessel.ladderX, boatOffsetY: (vessel.ladderY > 0 ? 1 : -1) * (vessel.beam / 2 + 6), thresholds,
          });
          const rec: OperationRecord = {
            id: uid('op'), createdAt: Date.now(),
            boardingPointId: point.id, boardingPointName: point.name,
            vesselId: vessel.id, vesselName: vessel.name,
            seaState: structuredClone(sea), shipHeading: form.heading, shipSpeed: form.speed,
            result: form.result,
            metrics: {
              significantHeight: hs, sigDisplacement: result.sigDisplacement,
              sigVelocity: result.sigVelocity, safeWindowsPerMinute: result.safeWindowsPerMinute,
              minClearance: result.minClearance,
            },
            pilotName: form.pilot, pilotFeedback: form.feedback,
          };
          await store.saveOperation(rec);
          drawAll();
        },
      }, '保存作业记录（含海况快照与随机种子）'),
    );
  }

  function replay(op: OperationRecord): void {
    // 同种子回放：把当时海况快照载入为当前海况并跳转推演页
    const replaySea: SeaStateInput = { ...op.seaState, id: uid('sea-replay'), name: `回放-${op.vesselName}` };
    store.saveSeaState(replaySea).then(() => {
      store.currentSeaStateId = replaySea.id!;
      store.currentPointId = op.boardingPointId;
      store.currentVesselId = op.vesselId;
      sessionStorage.setItem('pilot-replay-heading', String(op.shipHeading));
      location.hash = '#/simulation';
      location.reload();
    });
  }

  async function repoRemove(id: string): Promise<void> {
    await repo.remove('operations', id);
  }

  function drawAll(): void { drawStats(); drawList(); drawEntry(); }
  root.append(statCard, listCard, entryCard);
  drawAll();
}
