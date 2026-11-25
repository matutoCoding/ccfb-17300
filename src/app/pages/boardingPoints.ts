/** 页面一：登轮点档案。 */
import { h, clear, fmt, deg, rad, numberField } from '../dom.ts';
import type { BoardingPoint } from '../../core/types.ts';
import { store } from '../store.ts';
import { uid } from '../../db/database.ts';
import { kFromOmega } from '../../core/dispersion.ts';

export function renderBoardingPoints(root: HTMLElement): void {
  clear(root);
  const listCard = h('div', { class: 'card' });
  const formCard = h('div', { class: 'card' });

  function drawList(): void {
    clear(listCard);
    listCard.append(h('h2', {}, '登轮点档案（锚地外引航登轮区）'));
    const table = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '名称'), h('th', {}, '经度'), h('th', {}, '纬度'),
        h('th', {}, '水深 m'), h('th', {}, '主浪向'), h('th', {}, '潮流'), h('th', {}, '操作'),
      )),
    );
    const tb = h('tbody');
    for (const p of store.points) {
      const shallow = p.depth < 25;
      tb.append(h('tr', {},
        h('td', {}, p.name, h('div', { class: 'muted' }, p.notes ?? '')),
        h('td', {}, fmt(p.lon, 4)),
        h('td', {}, fmt(p.lat, 4)),
        h('td', {}, String(p.depth), shallow ? h('span', { class: 'tag warn' }, '浅水修正') : h('span', { class: 'tag info' }, '深水')),
        h('td', {}, `${Math.round(deg(p.dominantWaveDir))}°`),
        h('td', {}, `${Math.round(deg(p.currentDir))}° / ${fmt(p.currentSpeed)}m/s`),
        h('td', {},
          h('button', { class: 'btn small', onclick: () => drawForm(p) }, '编辑'),
          ' ',
          h('button', { class: 'btn small danger', onclick: () => store.deletePoint(p.id) }, '删除'),
        ),
      ));
    }
    table.append(tb);
    listCard.append(
      table,
      h('div', { style: 'margin-top:12px' },
        h('button', { class: 'btn', onclick: () => drawForm(null) }, '＋ 新建登轮点'),
      ),
    );
  }

  function drawForm(existing: BoardingPoint | null): void {
    clear(formCard);
    const p: BoardingPoint = existing ?? {
      id: uid('bp'), name: '', lon: 122, lat: 30, depth: 30,
      dominantWaveDir: rad(90), currentDir: rad(120), currentSpeed: 1, notes: '',
    };
    const draft = { ...p };
    const nameInput = h('input', { value: draft.name, oninput: (e) => { draft.name = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
    const notesInput = h('textarea', { rows: '2', oninput: (e) => { draft.notes = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
    notesInput.value = draft.notes ?? '';

    const shallowInfo = h('div', { class: 'muted' });
    function updateShallow(): void {
      // 以 8s 周期涌为例，对比深水/有限水深波数，展示色散修正幅度
      const omega = (2 * Math.PI) / 8;
      const kDeep = (omega * omega) / 9.80665;
      const kReal = kFromOmega(omega, draft.depth);
      const diff = 100 * (kReal - kDeep) / kDeep;
      shallowInfo.textContent = Number.isFinite(draft.depth)
        ? `8s 涌在该水深波数比深水增大 ${fmt(diff, 1)}%，FFT 海面将按 ω²=gk·tanh(kh) 自动修正`
        : '';
    }
    updateShallow();

    formCard.append(
      h('h2', {}, existing ? '编辑登轮点' : '新建登轮点'),
      h('label', { class: 'field' }, h('span', {}, '名称'), nameInput),
      h('div', { class: 'grid-2' },
        numberField('经度', draft.lon, 0.001, (v) => { draft.lon = v; }),
        numberField('纬度', draft.lat, 0.001, (v) => { draft.lat = v; }),
      ),
      h('div', { class: 'grid-3' },
        numberField('水深 m', draft.depth, 0.5, (v) => { draft.depth = v; updateShallow(); }, 1),
        numberField('常年主浪向 °', deg(draft.dominantWaveDir), 1, (v) => { draft.dominantWaveDir = rad(v); }, 0, 360),
        numberField('潮流流向 °', deg(draft.currentDir), 1, (v) => { draft.currentDir = rad(v); }, 0, 360),
      ),
      numberField('潮流流速 m/s', draft.currentSpeed, 0.1, (v) => { draft.currentSpeed = v; }, 0),
      h('label', { class: 'field' }, h('span', {}, '备注'), notesInput),
      shallowInfo,
      h('div', { style: 'display:flex;gap:10px;margin-top:10px' },
        h('button', {
          class: 'btn', onclick: async () => {
            if (!draft.name.trim()) { alert('请填写名称'); return; }
            await store.savePoint(draft);
            drawList();
            clear(formCard);
          },
        }, '保存'),
        h('button', { class: 'btn ghost', onclick: () => clear(formCard) }, '取消'),
      ),
    );
  }

  root.append(h('div', { class: 'grid-2' }, listCard, formCard));
  drawList();
}
