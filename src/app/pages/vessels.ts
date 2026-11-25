/** 页面二：船舶运动库。 */
import { h, clear, fmt, numberField } from '../dom.ts';
import type { RaoTable, Vessel } from '../../core/types.ts';
import { store } from '../store.ts';
import { uid } from '../../db/database.ts';
import { estimateRollPeriod, ensureRao, RAO_HEADINGS, RAO_OMEGAS } from '../../core/rao.ts';
import { combinationLadderRequired } from '../../core/ladder.ts';

export function renderVessels(root: HTMLElement): void {
  clear(root);
  const listCard = h('div', { class: 'card' });
  const formCard = h('div', { class: 'card' });

  function drawList(): void {
    clear(listCard);
    listCard.append(h('h2', {}, '船舶运动库'));
    const tb = h('tbody');
    for (const v of store.vessels) {
      const rollT = estimateRollPeriod(v);
      const combo = combinationLadderRequired(v, store.settings.defaults.combinationLadderFreeboard);
      tb.append(h('tr', {},
        h('td', {}, v.name, h('div', { class: 'muted' }, typeLabel(v.type))),
        h('td', {}, `${fmt(v.loa, 1)}×${fmt(v.beam, 1)}×${fmt(v.depth, 1)}`),
        h('td', {}, `吃水 ${fmt(v.draft)} / 干舷 ${fmt(v.freeboard)}`),
        h('td', {}, Number.isFinite(rollT) ? `${fmt(rollT)} s` : '—'),
        h('td', {}, v.rao
          ? h('span', { class: 'tag ok' }, `RAO ${v.rao.headings.length}×${v.rao.omegas.length}`)
          : h('span', { class: 'tag warn' }, '无表·粗估')),
        h('td', {}, combo.required ? h('span', { class: 'tag danger' }, '需组合梯') : h('span', { class: 'tag info' }, '单软梯')),
        h('td', {},
          h('button', { class: 'btn small', onclick: () => drawForm(v) }, '编辑'),
          ' ',
          h('button', { class: 'btn small danger', onclick: () => store.deleteVessel(v.id) }, '删除'),
        ),
      ));
    }
    listCard.append(
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', {}, '船名/类型'), h('th', {}, '主尺度 m'), h('th', {}, '吃水/干舷'),
        h('th', {}, '横摇固有周期'), h('th', {}, 'RAO'), h('th', {}, '梯具'), h('th', {}, '操作'),
      )), tb),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => drawForm(null) }, '＋ 新建船舶')),
    );
  }

  function drawForm(existing: Vessel | null): void {
    clear(formCard);
    const v: Vessel = existing ?? {
      id: uid('v'), name: '', type: 'small_bulk', loa: 150, beam: 25, depth: 13,
      draft: 8, freeboard: 5, gm: 0.8, displacement: 25000,
      ladderX: -18, ladderY: 12.5, ladderTopHeight: 5,
    };
    const draft = structuredClone(v);
    const raoBox = h('div', {});

    function refreshRaoBox(): void {
      clear(raoBox);
      const hasRao = !!draft.rao;
      raoBox.append(
        h('h3', {}, 'RAO 横摇/纵摇/垂向幅值相位表'),
        hasRao
          ? h('div', {},
              h('span', { class: 'tag ok' }, `已配置 ${draft.rao!.headings.length} 浪向 × ${draft.rao!.omegas.length} 频率`),
              ' ',
              h('button', { class: 'btn small ghost', onclick: () => { delete draft.rao; refreshRaoBox(); } }, '移除（改用粗估）'),
              raoPreview(draft.rao!),
            )
          : h('div', {},
              h('span', { class: 'tag warn' }, '无 RAO 表，将按船宽与 GM 粗估横摇固有周期'),
              ' ',
              h('button', { class: 'btn small', onclick: () => { draft.rao = ensureRao(draft); refreshRaoBox(); } }, '生成解析 RAO'),
            ),
        h('div', { style: 'margin-top:8px' },
          h('button', { class: 'btn small ghost', onclick: () => importRao(draft, refreshRaoBox) }, '导入 RAO CSV（omega,heading,rollAmp,...）'),
        ),
      );
    }

    formCard.append(
      h('h2', {}, existing ? '编辑船舶' : '新建船舶'),
      h('label', { class: 'field' }, h('span', {}, '船名'),
        h('input', { value: draft.name, oninput: (e) => { draft.name = (e.target as HTMLInputElement).value; } })),
      h('label', { class: 'field' }, h('span', {}, '船型'),
        Object.assign(h('select', {},
          h('option', { value: 'oil_tanker_ballast' }, '油轮（压载）'),
          h('option', { value: 'container' }, '集装箱船'),
          h('option', { value: 'small_bulk' }, '散货船'),
        ), { value: draft.type, onchange: (e: Event) => { draft.type = (e.target as HTMLSelectElement).value as Vessel['type']; } })),
      h('div', { class: 'grid-3' },
        numberField('船长 LOA m', draft.loa, 1, (x) => { draft.loa = x; }),
        numberField('船宽 B m', draft.beam, 0.5, (x) => { draft.beam = x; }),
        numberField('型深 D m', draft.depth, 0.5, (x) => { draft.depth = x; }),
      ),
      h('div', { class: 'grid-3' },
        numberField('吃水 m', draft.draft, 0.1, (x) => { draft.draft = x; }),
        numberField('干舷 m', draft.freeboard, 0.1, (x) => { draft.freeboard = x; }),
        numberField('初稳性高 GM m', draft.gm, 0.05, (x) => { draft.gm = x; }, 0.05),
      ),
      numberField('排水量 t', draft.displacement, 100, (x) => { draft.displacement = x; }),
      h('h3', {}, '软梯位置（船中为原点，x 向后为负，y 右舷为正）'),
      h('div', { class: 'grid-3' },
        numberField('梯纵向 x m', draft.ladderX, 0.5, (x) => { draft.ladderX = x; }),
        numberField('梯横向 y m', draft.ladderY, 0.5, (x) => { draft.ladderY = x; }),
        numberField('梯顶高度 m', draft.ladderTopHeight, 0.1, (x) => { draft.ladderTopHeight = x; }),
      ),
      raoBox,
      h('div', { style: 'display:flex;gap:10px;margin-top:12px' },
        h('button', {
          class: 'btn', onclick: async () => {
            if (!draft.name.trim()) { alert('请填写船名'); return; }
            await store.saveVessel(draft);
            drawList();
            clear(formCard);
          },
        }, '保存'),
        h('button', { class: 'btn ghost', onclick: () => clear(formCard) }, '取消'),
      ),
    );
    refreshRaoBox();
  }

  root.append(h('div', { class: 'grid-2' }, listCard, formCard));
  drawList();
}

function typeLabel(t: Vessel['type']): string {
  return { oil_tanker_ballast: '油轮·压载', container: '集装箱船', small_bulk: '散货船' }[t];
}

function raoPreview(rao: RaoTable): HTMLElement {
  const head = h('div', { class: 'muted', style: 'margin:8px 0 4px' },
    `浪向 ${RAO_HEADINGS.map((x) => `${Math.round(x * 180 / Math.PI)}°`).join('/')}；频率 ${RAO_OMEGAS[0].toFixed(2)}~${RAO_OMEGAS[RAO_OMEGAS.length - 1].toFixed(2)} rad/s`);
  // 横浪 90° 下横摇幅值前 6 点
  const ih = rao.headings.indexOf(Math.PI / 2);
  const rows = rao.omegas.slice(0, 6).map((w, i) => h('tr', {},
    h('td', {}, fmt(w, 2)),
    h('td', {}, fmt(rao.rollAmp[ih][i], 3)),
    h('td', {}, fmt(rao.pitchAmp[ih][i], 3)),
    h('td', {}, fmt(rao.heaveAmp[ih][i], 3)),
  ));
  return h('div', {}, head,
    h('table', { style: 'max-width:420px' }, h('thead', {}, h('tr', {},
      h('th', {}, 'ω'), h('th', {}, '横摇'), h('th', {}, '纵摇'), h('th', {}, '垂荡'))),
      h('tbody', {}, ...rows)));
}

function importRao(draft: Vessel, refresh: () => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.txt';
  input.onchange = async (): Promise<void> => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      draft.rao = parseRaoCsv(text);
      refresh();
    } catch (e) {
      alert(`RAO 解析失败：${(e as Error).message}`);
    }
  };
  input.click();
}

/** CSV 列：omega,heading_deg,rollAmp,rollPhase,pitchAmp,pitchPhase,heaveAmp,heavePhase */
function parseRaoCsv(text: string): RaoTable {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.toLowerCase().startsWith('omega'));
  const omSet = new Set<number>();
  const hSet = new Set<number>();
  const rows: Array<{ w: number; hd: number; v: number[] }> = [];
  for (const line of lines) {
    const c = line.split(/[,\t]+/).map(Number);
    if (c.length < 8 || c.some((x) => !Number.isFinite(x))) throw new Error(`坏行：${line}`);
    omSet.add(c[0]);
    hSet.add((c[1] * Math.PI) / 180);
    rows.push({ w: c[0], hd: (c[1] * Math.PI) / 180, v: c.slice(2) });
  }
  const omegas = [...omSet].sort((a, b) => a - b);
  const headings = [...hSet].sort((a, b) => a - b);
  const blank = (): number[][] => headings.map(() => new Array(omegas.length).fill(0));
  const rao: RaoTable = {
    headings, omegas,
    rollAmp: blank(), rollPhase: blank(), pitchAmp: blank(), pitchPhase: blank(),
    heaveAmp: blank(), heavePhase: blank(),
  };
  for (const r of rows) {
    const io = omegas.indexOf(r.w);
    const ih = headings.indexOf(r.hd);
    rao.rollAmp[ih][io] = r.v[0]; rao.rollPhase[ih][io] = r.v[1];
    rao.pitchAmp[ih][io] = r.v[2]; rao.pitchPhase[ih][io] = r.v[3];
    rao.heaveAmp[ih][io] = r.v[4]; rao.heavePhase[ih][io] = r.v[5];
  }
  return rao;
}
