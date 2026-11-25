/** 页面三：海况输入（手填 JONSWAP 风浪/涌浪 + 浮标方向谱导入）。 */
import { h, clear, fmt, deg, rad, numberField, drawSpectrumBars } from '../dom.ts';
import type { SeaComponent, SeaStateInput, DirectionalSpectrumData } from '../../core/types.ts';
import { store } from '../store.ts';
import { uid } from '../../db/database.ts';
import { defaultComponent, buildDirectionalSpectrum, spectralHs, spectralMeanDirection } from '../../core/spectrum.ts';
import { parseBuoyFile } from '../../core/buoy.ts';

export function renderSeaStates(root: HTMLElement): void {
  clear(root);
  const listCard = h('div', { class: 'card' });
  const formCard = h('div', { class: 'card' });

  function drawList(): void {
    clear(listCard);
    listCard.append(h('h2', {}, '海况方案'));
    const tb = h('tbody');
    for (const s of store.seaStates) {
      const hs = spectralHs(buildDirectionalSpectrum(s));
      tb.append(h('tr', {},
        h('td', {}, s.name, h('div', { class: 'muted' }, s.note ?? '')),
        h('td', {}, Number.isFinite(s.depth) ? `${s.depth} m` : '深水'),
        h('td', {}, s.components.map((c) =>
          h('span', { class: 'pill', style: 'margin-right:4px' },
            `${c.kind === 'wind' ? '风' : '涌'} Hs${fmt(c.significantHeight)} Tp${fmt(c.peakPeriod, 1)} ${Math.round(deg(c.peakDirection))}°`)).join('')),
        h('td', {}, h('b', {}, fmt(hs), ' m')),
        h('td', {}, `种子 ${s.seed}`),
        h('td', {},
          h('button', { class: 'btn small', onclick: () => drawForm(s) }, '编辑'),
          ' ',
          h('button', { class: 'btn small danger', onclick: () => { if (s.id) store.deleteSeaState(s.id); } }, '删除'),
        ),
      ));
    }
    listCard.append(
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', {}, '名称'), h('th', {}, '水深'), h('th', {}, '分量'), h('th', {}, '合成 Hs'), h('th', {}, '种子'), h('th', {}, '操作'),
      )), tb),
      h('div', { style: 'margin-top:12px;display:flex;gap:10px' },
        h('button', { class: 'btn', onclick: () => drawForm(null) }, '＋ 手填海况'),
        h('button', { class: 'btn ghost', onclick: () => drawBuoyImport() }, '导入浮标方向谱'),
      ),
    );
  }

  function componentEditor(comp: SeaComponent, onChange: () => void): HTMLElement {
    const box = h('div', { class: 'card', style: 'background:var(--panel-2)' },
      h('h3', {}, comp.kind === 'wind' ? '风浪分量（JONSWAP）' : '涌浪分量（窄峰 JONSWAP）'),
    );
    const f = (label: string, val: number, step: number, set: (x: number) => void, min?: number, max?: number) =>
      h('div', { onchange: () => onChange() }, numberField(label, val, step, (x) => { set(x); onChange(); }, min, max));
    box.append(
      h('div', { class: 'grid-3' },
        f('有效波高 Hs m', comp.significantHeight, 0.1, (x) => { comp.significantHeight = x; }, 0),
        f('谱峰周期 Tp s', comp.peakPeriod, 0.5, (x) => { comp.peakPeriod = x; }, 1),
        f('主浪向 °（来向）', deg(comp.peakDirection), 1, (x) => { comp.peakDirection = rad(x); }, 0, 360),
      ),
      h('div', { class: 'grid-2' },
        f('峰升因子 γ', comp.gamma, 0.1, (x) => { comp.gamma = x; }, 1, 40),
        f('方向分布指数 s', comp.spreadingIndex, 0.5, (x) => { comp.spreadingIndex = x; }, 0.5, 30),
      ),
    );
    return box;
  }

  function drawForm(existing: SeaStateInput | null): void {
    clear(formCard);
    const draft: SeaStateInput = existing
      ? structuredClone(existing)
      : { id: uid('sea'), name: '', depth: store.currentPoint()?.depth ?? 30, seed: (Math.random() * 1e9) | 0, components: [defaultComponent('wind')] };
    const nameInput = h('input', { value: draft.name, oninput: (e) => { draft.name = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
    const noteInput = h('textarea', { rows: '2', oninput: (e) => { draft.note = (e.target as HTMLTextAreaElement).value; } }) as HTMLTextAreaElement;
    noteInput.value = draft.note ?? '';
    const compsWrap = h('div', {});
    const summary = h('div', { class: 'alert ok' });
    const canvas = h('canvas', { class: 'chart' }) as HTMLCanvasElement;

    function refresh(): void {
      clear(compsWrap);
      draft.components.forEach((c, i) => {
        compsWrap.append(componentEditor(c, refresh),
          draft.components.length > 1
            ? h('button', { class: 'btn small danger', style: 'margin-bottom:10px', onclick: () => { draft.components.splice(i, 1); refresh(); } }, '删除该分量')
            : h('span'));
      });
      const spec = buildDirectionalSpectrum(draft);
      const hs = spectralHs(spec);
      const target = Math.sqrt(draft.components.reduce((a, c) => a + c.significantHeight ** 2, 0));
      const err = 100 * Math.abs(hs - target) / target;
      summary.className = `alert ${err < 1 ? 'ok' : 'warn'}`;
      summary.textContent = `合成有效波高 Hs=${fmt(hs)} m（分量能量和 ${fmt(target)} m，偏差 ${fmt(err, 2)}%）；能量加权主浪向 ${Math.round(deg(spectralMeanDirection(spec)))}°`;
      // 一维谱（方向积分）
      const s1d = integrateOverDirection(spec);
      drawSpectrumBars(canvas, Array.from(spec.omegas), s1d);
    }

    formCard.append(
      h('h2', {}, existing ? '编辑海况' : '手填海况'),
      h('label', { class: 'field' }, h('span', {}, '方案名称'), nameInput),
      h('div', { class: 'grid-2' },
        h('div', {}, numberField('水深 m（大数=深水）', draft.depth, 0.5, (x) => { draft.depth = x; refresh(); }, 1)),
        h('div', {}, numberField('随机种子', draft.seed, 1, (x) => { draft.seed = x | 0; })),
      ),
      compsWrap,
      h('div', { style: 'display:flex;gap:10px;margin:8px 0' },
        h('button', { class: 'btn small ghost', onclick: () => { draft.components.push(defaultComponent('swell')); refresh(); } }, '＋ 叠加涌浪'),
        h('button', { class: 'btn small ghost', onclick: () => { draft.components.push(defaultComponent('wind')); refresh(); } }, '＋ 叠加风浪'),
      ),
      summary,
      canvas,
      h('label', { class: 'field' }, h('span', {}, '备注'), noteInput),
      h('div', { style: 'display:flex;gap:10px;margin-top:10px' },
        h('button', {
          class: 'btn', onclick: async () => {
            if (!draft.name.trim()) { alert('请填写名称'); return; }
            await store.saveSeaState(draft);
            drawList();
            clear(formCard);
          },
        }, '保存海况'),
        h('button', { class: 'btn ghost', onclick: () => clear(formCard) }, '取消'),
      ),
    );
    refresh();
  }

  function drawBuoyImport(): void {
    clear(formCard);
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = '.csv,.txt';
    const result = h('div', {});
    pick.onchange = async (): Promise<void> => {
      const file = pick.files?.[0];
      if (!file) return;
      const parsed = parseBuoyFile(await file.text());
      clear(result);
      if (!parsed.ok) {
        result.append(h('div', { class: 'alert danger' }, parsed.errors.join('；')));
        return;
      }
      const warnings = h('div', {});
      warnings.append(
        h('div', { class: 'alert warn' },
          `解析完成：${parsed.totalRows} 行，坏行 ${parsed.badRows} 条，格式 ${parsed.format === 'dense' ? '稠密网格' : '矩参数'}`),
        ...parsed.warnings.map((w) => h('div', { class: 'muted', style: 'margin:4px 0' }, '⚠ ' + w)),
      );
      // 由浮标谱反算等效 Hs/峰频/主向，生成海况方案
      const spec = buoyToSpec(parsed);
      const hs = spectralHs(spec);
      result.append(warnings,
        h('div', { class: 'alert ok' }, `浮标谱 Hs=${fmt(hs)} m，可另存为海况方案（谱直接保留，非 JONSWAP 拟合）`),
        h('button', {
          class: 'btn', onclick: async () => {
            const rec: SeaStateInput = {
              id: uid('sea'), name: `浮标导入 ${file.name}`, depth: store.currentPoint()?.depth ?? 30,
              seed: (Math.random() * 1e9) | 0, components: [], note: `来自浮标文件 ${file.name}`,
            };
            // 浮标谱挂载到 note 之外：用全局缓存（见 buoyImportCache）
            buoyImportCache.set(rec.id!, spec);
            await store.saveSeaState(rec);
            drawList();
            clear(formCard);
          },
        }, '存为海况方案'),
      );
    };
    formCard.append(h('h2', {}, '导入浮标方向谱文件'),
      h('p', { class: 'muted' }, '支持 f_hz,theta_deg,energy 稠密格式或 f_hz,a1,b1,a2,b2[,E] 矩参数格式；系统自动标注坏行与缺频段。'),
      pick, h('div', { style: 'margin-top:10px' },
        h('button', { class: 'btn small ghost', onclick: () => loadSampleBuoy(result) }, '载入内置样例（含坏数据）'),
      ), result);
  }

  root.append(h('div', { class: 'grid-2' }, listCard, formCard));
  drawList();
}

/** 浮标谱缓存：导入的实测谱不经过 JONSWAP 参数化，直接供推演使用 */
export const buoyImportCache = new Map<string, DirectionalSpectrumData>();

function integrateOverDirection(spec: DirectionalSpectrumData): number[] {
  const nT = spec.thetas.length;
  const dTheta = nT > 1 ? spec.thetas[1] - spec.thetas[0] : 2 * Math.PI;
  return Array.from(spec.omegas, (_, i) => {
    let s = 0;
    for (let j = 0; j < nT; j++) s += spec.values[j * spec.omegas.length + i];
    return s * dTheta;
  });
}

function buoyToSpec(parsed: ReturnType<typeof parseBuoyFile>): DirectionalSpectrumData {
  const omegas = parsed.frequenciesHz.map((f) => 2 * Math.PI * f);
  const values = new Float64Array(parsed.thetas.length * omegas.length);
  for (let j = 0; j < parsed.thetas.length; j++) {
    for (let i = 0; i < omegas.length; i++) values[j * omegas.length + i] = parsed.values[j][i];
  }
  return { omegas: Float64Array.from(omegas), thetas: Float64Array.from(parsed.thetas), values, depth: store.currentPoint()?.depth ?? 30 };
}

async function loadSampleBuoy(result: HTMLElement): Promise<void> {
  const files = store.buoyFiles;
  clear(result);
  const tb = h('tbody');
  for (const f of files) {
    const parsed = parseBuoyFile(f.text);
    tb.append(h('tr', {},
      h('td', {}, f.name),
      h('td', {}, f.description),
      h('td', {}, parsed.ok
        ? h('span', { class: 'tag warn' }, `坏行 ${parsed.badRows}，告警 ${parsed.warnings.length}`)
        : h('span', { class: 'tag danger' }, '解析失败')),
      h('td', {}, h('button', {
        class: 'btn small', onclick: () => {
          clear(result);
          result.append(...parsed.warnings.map((w) => h('div', { class: 'alert warn' }, '⚠ ' + w)),
            h('div', { class: 'muted' }, `有效行 ${parsed.totalRows - parsed.badRows}/${parsed.totalRows}`));
        },
      }, '查看诊断')),
    ));
  }
  result.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '文件'), h('th', {}, '说明'), h('th', {}, '解析'), h('th', {}, '诊断'))), tb));
}
