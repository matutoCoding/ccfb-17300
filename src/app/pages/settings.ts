/** 页面六：站务设置（停航阈值、相对位移/速度上限、登轮点覆盖）。 */
import { h, clear, numberField } from '../dom.ts';
import { store } from '../store.ts';
import type { SafetyThresholds } from '../../core/types.ts';

export function renderSettings(root: HTMLElement): void {
  clear(root);
  root.classList.remove('wide');
  const draft = structuredClone(store.settings);
  const saved = h('div', {});

  function thresholdEditor(th: SafetyThresholds, onChange: () => void): HTMLElement {
    const f = (label: string, key: keyof SafetyThresholds, step: number, min = 0) =>
      numberField(label, th[key], step, (v) => { th[key] = v; onChange(); }, min);
    return h('div', { class: 'grid-3' },
      f('停航最大 Hs m', 'maxSignificantHeight', 0.1),
      f('相对位移上限 m', 'maxRelativeDisplacement', 0.05),
      f('相对速度上限 m/s', 'maxRelativeVelocity', 0.1),
      f('组合梯干舷阈值 m', 'combinationLadderFreeboard', 0.5),
      f('安全窗口最短 s', 'minWindowDuration', 0.5),
      f('每分钟最少窗口数', 'minWindowsPerMinute', 0.5),
    );
  }

  const defaultCard = h('div', { class: 'card' },
    h('h2', {}, '全站默认阈值'),
    h('label', { class: 'field' }, h('span', {}, '引航站名称'),
      h('input', { value: draft.stationName, oninput: (e) => { draft.stationName = (e.target as HTMLInputElement).value; } })),
    thresholdEditor(draft.defaults, () => {}),
  );

  const overrideCard = h('div', { class: 'card' }, h('h2', {}, '各登轮点阈值覆盖（留空继承默认）'));
  const overrideWrap = h('div', {});
  function drawOverrides(): void {
    clear(overrideWrap);
    for (const p of store.points) {
      const box = h('div', { class: 'card', style: 'background:var(--panel-2)' },
        h('h3', {}, p.name),
        h('label', { class: 'switch' },
          Object.assign(h('input', {
            type: 'checkbox',
            onchange: (e) => {
              if ((e.target as HTMLInputElement).checked) draft.pointOverrides[p.id] = {};
              else delete draft.pointOverrides[p.id];
              drawOverrides();
            },
          }), { checked: !!draft.pointOverrides[p.id] }),
          h('span', {}, '启用独立阈值')),
      );
      if (draft.pointOverrides[p.id]) {
        const partial = draft.pointOverrides[p.id]!;
        const opt = (label: string, key: keyof SafetyThresholds, step: number) => {
          const val = partial[key];
          return h('label', { class: 'field' }, h('span', {}, label + '（空=默认）'),
            h('input', {
              type: 'number', step: String(step),
              ...(val !== undefined ? { value: String(val) } : { placeholder: `默认 ${draft.defaults[key]}` }),
              oninput: (e) => {
                const raw = (e.target as HTMLInputElement).value;
                if (raw === '') delete partial[key];
                else partial[key] = Number(raw);
              },
            }));
        };
        box.append(h('div', { class: 'grid-3' },
          opt('停航 Hs m', 'maxSignificantHeight', 0.1),
          opt('位移上限 m', 'maxRelativeDisplacement', 0.05),
          opt('速度上限 m/s', 'maxRelativeVelocity', 0.1),
        ));
      }
      overrideWrap.append(box);
    }
  }
  drawOverrides();
  overrideCard.append(overrideWrap);

  const actionCard = h('div', { class: 'card' },
    h('h2', {}, '保存与说明'),
    h('p', { class: 'muted' }, '阈值同时作用于推演页超限标红、安全窗口统计与可行性单；干舷超过组合梯阈值时系统自动提示改用组合梯（IMO/引航软梯规则，默认 9 m）。'),
    h('div', { style: 'display:flex;gap:10px' },
      h('button', {
        class: 'btn', onclick: async () => {
          await store.saveSettings(draft);
          saved.className = 'alert ok';
          saved.textContent = '设置已保存并对所有页面生效';
        },
      }, '保存站务设置'),
      h('button', {
        class: 'btn ghost', onclick: () => { location.reload(); },
      }, '放弃修改'),
      saved,
    ),
  );

  root.append(defaultCard, overrideCard, actionCard);
}
