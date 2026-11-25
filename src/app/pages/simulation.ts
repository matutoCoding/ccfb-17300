/** 页面四：登轮推演（3D FFT 海面 + 船舶运动 + 相对运动曲线 + 航向扫描）。 */
import { h, clear, deg, rad, TimeSeriesChart } from '../dom.ts';
import { store } from '../store.ts';
import { buildDirectionalSpectrum, spectralHs } from '../../core/spectrum.ts';
import { buildWaveField, recommendDomainLength } from '../../core/waveField.ts';
import { ensureRao } from '../../core/rao.ts';
import { OceanRenderer } from '../../gpu/renderer.ts';
import { SimScene, type SceneFrameStats } from '../../gpu/simScene.ts';
import { runSimulation, assessFeasibility, runSimulationEnsemble } from '../../core/simulation.ts';
import { scanBestHeadings } from '../../core/shelter.ts';
import { combinationLadderRequired, ladderWaterWarning } from '../../core/ladder.ts';
import type { DirectionalSpectrumData } from '../../core/types.ts';
import { buoyImportCache } from './seaStates.ts';

export function renderSimulation(root: HTMLElement): void {
  clear(root);
  root.classList.add('wide');

  const pointMaybe = store.currentPoint();
  const vesselMaybe = store.currentVessel();
  const seaMaybe = store.currentSeaState();
  if (!pointMaybe || !vesselMaybe || !seaMaybe) {
    root.append(h('div', { class: 'fallback' }, '请先在档案/海况页选择登轮点、船舶与海况方案'));
    return;
  }
  const point = pointMaybe;
  const vessel = vesselMaybe;
  const sea = seaMaybe;
  ensureRao(vessel);
  const thresholds = store.thresholdsFor(point.id);

  // 谱：优先浮标缓存，否则按参数构建
  const spec: DirectionalSpectrumData = buoyImportCache.get(sea.id!) ?? buildDirectionalSpectrum(sea);
  const hs = spectralHs(spec);

  let heading = point.dominantWaveDir;
  let shipSpeed = 0;
  let night = false;
  let running = true;

  const wrap = h('div', { class: 'sim-grid' });
  const view = h('div', { class: 'sim-view' });
  const side = h('div', { class: 'sim-side' });
  wrap.append(view, side);
  root.append(wrap);

  // ---- 侧栏：选择器与控制 ----
  const headingVal = h('b', {}, `${Math.round(deg(heading))}°`);
  const speedVal = h('b', {}, `${shipSpeed.toFixed(1)} kn`);
  const perfVal = h('span', { class: 'muted' }, 'GPU 启动中…');
  const metricBox = h('div', {});
  const windowBox = h('div', {});
  const ladderBox = h('div', {});
  const scanBox = h('div', {});

  side.append(
    h('div', { class: 'card' },
      h('h2', {}, '推演配置'),
      selector('登轮点', point.name, store.points.map((p) => [p.id, p.name]), store.currentPointId, (id) => { store.currentPointId = id; location.reload(); }),
      selector('船舶', vessel.name, store.vessels.map((v) => [v.id, v.name]), store.currentVesselId, (id) => { store.currentVesselId = id; location.reload(); }),
      selector('海况', sea.name, store.seaStates.map((s) => [s.id, s.name]), store.currentSeaStateId, (id) => { store.currentSeaStateId = id; location.reload(); }),
    ),
    h('div', { class: 'card' },
      h('h2', {}, '船舶操纵'),
      h('div', { class: 'slider-row' },
        h('span', {}, '航向'), headingVal,
        h('input', {
          type: 'range', min: '0', max: '360', value: String(Math.round(deg(heading))),
          oninput: (e) => { heading = rad(Number((e.target as HTMLInputElement).value)); headingVal.textContent = `${Math.round(deg(heading))}°`; scene?.setHeading(heading); refreshScan(); },
        }),
      ),
      h('div', { class: 'slider-row' },
        h('span', {}, '航速'), speedVal,
        h('input', {
          type: 'range', min: '0', max: '12', step: '0.2', value: '0',
          oninput: (e) => { shipSpeed = Number((e.target as HTMLInputElement).value) * 0.5144; speedVal.textContent = `${(shipSpeed / 0.5144).toFixed(1)} kn`; },
        }),
      ),
      h('label', { class: 'switch', style: 'margin-top:10px' },
        Object.assign(h('input', { type: 'checkbox', onchange: (e) => { night = (e.target as HTMLInputElement).checked; scene?.setNight(night); } }), { checked: false }),
        h('span', {}, '夜间/低能见度照明（登乘灯+探照灯）'),
      ),
      h('div', { style: 'margin-top:8px' }, perfVal),
    ),
    h('div', { class: 'card' }, h('h2', {}, '实时相对运动'), metricBox),
    h('div', { class: 'card' }, h('h2', {}, '软梯状态'), ladderBox),
    h('div', { class: 'card' }, h('h2', {}, '安全跨梯窗口（未来每分钟）'), windowBox),
    h('div', { class: 'card' }, h('h2', {}, '下风舷遮蔽航向扫描'), scanBox),
  );

  // ---- 图表 ----
  const chartCard = h('div', { class: 'card', style: 'position:absolute;left:12px;right:12px;bottom:12px;background:rgba(14,22,32,0.92)' });
  const dispChart = new TimeSeriesChart(chartCard, '软梯底端—艇甲板 相对垂向位移 (m)', 'm', thresholds.maxRelativeDisplacement);
  const velChart = new TimeSeriesChart(chartCard, '相对垂向速度 (m/s)', 'm/s', thresholds.maxRelativeVelocity);
  view.append(chartCard);

  // ---- 3D 初始化 ----
  let scene: SimScene | null = null;
  const canvas = h('canvas', { class: 'gpu' }) as HTMLCanvasElement;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  view.prepend(canvas);

  const field = buildWaveField(sea, { size: 512, domainLength: recommendDomainLength(sea) });
  const shelterBase = {
    waveDir: sea.components[0]?.peakDirection ?? 0,
    length: vessel.loa, beam: vessel.beam, draft: vessel.draft, waterDepth: point.depth,
  };
  const boatX = vessel.ladderX;
  const boatY = (vessel.ladderY > 0 ? 1 : -1) * (vessel.beam / 2 + 6);

  // 记录用缓冲（最近 120s）
  const buffer: SceneFrameStats[] = [];
  const BUFFER_SEC = 120;

  async function boot(): Promise<void> {
    const supported = await OceanRenderer.isSupported();
    if (!supported) {
      view.querySelector('.fallback')?.remove();
      view.append(h('div', { class: 'fallback' },
        h('div', {}, '当前浏览器/硬件不支持 WebGPU，已切换为 CPU 数值推演模式（无 3D 渲染）'),
        h('div', { class: 'muted' }, '相对运动曲线、航向扫描与可行性判定仍可正常使用'),
      ));
      startCpuOnly();
      return;
    }
    const renderer = new OceanRenderer();
    await renderer.init(canvas);
    renderer.setWaveField(field);
    scene = new SimScene(renderer, {
      vessel, spec, seed: sea.seed, shipHeading: heading,
      boatOffsetX: boatX, boatOffsetY: boatY, shelter: shelterBase,
    });
    renderer.onPerf = (ms) => { perfVal.textContent = `512×512 海面帧耗时 ${ms.toFixed(1)} ms（${(1000 / Math.max(1, ms)).toFixed(0)} FPS）`; };
    scene.onFrame = (s) => onStats(s);
    let last = performance.now();
    const loop = (): void => {
      if (!running) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      scene?.update(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function onStats(s: SceneFrameStats): void {
    buffer.push(s);
    const cutoff = s.t - BUFFER_SEC;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
    const times = buffer.map((b) => b.t);
    dispChart.draw(times, [{ values: buffer.map((b) => b.relDisp), color: '#4aa8e0', label: '位移' }], 60, s.t);
    velChart.draw(times, [{ values: buffer.map((b) => b.relVel), color: '#e6b24a', label: '速度' }], 60, s.t);
    // 指标
    const recent = buffer.slice(-600);
    const rmsD = Math.sqrt(recent.reduce((a, b) => a + b.relDisp ** 2, 0) / recent.length);
    const rmsV = Math.sqrt(recent.reduce((a, b) => a + b.relVel ** 2, 0) / recent.length);
    clear(metricBox);
    metricBox.append(
      metric('相对位移有义值', `${(4 * rmsD).toFixed(2)} m`, 4 * rmsD, thresholds.maxRelativeDisplacement),
      metric('相对速度有义值', `${(4 * rmsV).toFixed(2)} m/s`, 4 * rmsV, thresholds.maxRelativeVelocity),
      metric('输入有效波高 Hs', `${hs.toFixed(2)} m`, hs, thresholds.maxSignificantHeight),
    );
    // 软梯
    const lastS = buffer[buffer.length - 1];
    const combo = combinationLadderRequired(vessel, thresholds.combinationLadderFreeboard);
    const ww = ladderWaterWarning({ clearanceAboveWater: lastS.ladderClearance } as never);
    clear(ladderBox);
    ladderBox.append(
      h('div', { class: `alert ${combo.required ? 'danger' : 'ok'}` }, combo.reason),
      h('div', { class: `alert ${ww.level === 'ok' ? 'ok' : ww.level === 'warn' ? 'warn' : 'danger'}` }, ww.message),
      metricRow('横摇角', `${deg(lastS.roll).toFixed(1)}°`),
      metricRow('软梯摆角', `${deg(lastS.swing).toFixed(1)}°`),
      metricRow('梯底距水面', `${lastS.ladderClearance.toFixed(2)} m`),
      metricRow('梯-船壳间隙', `${lastS.hullGap.toFixed(2)} m`),
    );
  }

  function refreshScan(): void {
    clear(scanBox);
    const stations = [-0.2, 0, 0.2].map((f) => ({ x: vessel.ladderX + f * vessel.loa * 0.2, y: boatY }));
    const best = scanBestHeadings(shelterBase, stations, 5, 5);
    const rows = best.map((b) => h('tr', {
      onclick: () => { heading = b.heading; scene?.setHeading(heading); headingVal.textContent = `${Math.round(deg(heading))}°`; },
      style: 'cursor:pointer',
    },
      h('td', {}, `${Math.round(deg(b.heading))}°`),
      h('td', {}, h('span', { class: 'tag info' }, `遮蔽评分 ${(b.score * 100).toFixed(0)}`)),
      h('td', {}, `波能比 ${(b.energyRatio * 100).toFixed(0)}%`),
    ));
    scanBox.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '推荐航向'), h('th', {}, '遮蔽'), h('th', {}, '残余波能'))), h('tbody', {}, ...rows)),
      h('div', { class: 'muted', style: 'margin-top:6px' }, '点击行直接采用该航向；遮蔽为半经验绕射模型，用于调度参考'));
  }
  refreshScan();

  // 周期性跑一次完整统计更新安全窗口（每 10s，200s 样本，避免阻塞渲染帧）
  function updateWindows(): void {
    const result = runSimulation(spec, vessel, {
      duration: 200, sampleRate: 2, shipHeading: heading, shipSpeed, seed: sea.seed,
      boatOffsetX: boatX, boatOffsetY: boatY, thresholds,
    });
    const assess = assessFeasibility(result, thresholds, hs);
    clear(windowBox);
    windowBox.append(
      h('div', { class: `alert ${assess.feasible ? 'ok' : 'danger'}` },
        assess.feasible ? '✓ 当前具备安全登轮条件' : '✗ 当前不满足登轮阈值'),
      ...assess.reasons.map((r) => h('div', { class: 'muted' }, '· ' + r)),
      metricRow('每分钟安全窗口', result.safeWindowsPerMinute.toFixed(1)),
      metricRow('近未来安全窗口数', String(result.safeWindows.length)),
      metricRow('超限时段数', String(result.exceedWindows.length)),
      h('button', {
        class: 'btn', style: 'margin-top:10px',
        onclick: () => issueReport(result.sigDisplacement, result.sigVelocity, result.safeWindowsPerMinute),
      }, '一键生成当班登轮可行性单'),
    );
  }
  updateWindows();
  const windowTimer = self.setInterval(updateWindows, 10000);

  function startCpuOnly(): void {
    // CPU 降级：用 runSimulation 离线生成 120s 数据驱动图表
    const result = runSimulation(spec, vessel, {
      duration: 120, sampleRate: 5, shipHeading: heading, shipSpeed, seed: sea.seed,
      boatOffsetX: boatX, boatOffsetY: boatY, thresholds,
    });
    let i = 0;
    const timer = self.setInterval(() => {
      const slice = result.samples.slice(0, i);
      i += 5;
      if (slice.length === 0) return;
      dispChart.draw(slice.map((s) => s.t), [{ values: slice.map((s) => s.relDisp), color: '#4aa8e0', label: '' }], 60, slice[slice.length - 1].t);
      velChart.draw(slice.map((s) => s.t), [{ values: slice.map((s) => s.relVel), color: '#e6b24a', label: '' }], 60, slice[slice.length - 1].t);
      if (i >= result.samples.length) self.clearInterval(timer);
    }, 200);
  }

  function issueReport(sigD: number, sigV: number, wpm: number): void {
    const result = runSimulationEnsemble(spec, vessel, {
      duration: 1800, sampleRate: 2, shipHeading: heading, shipSpeed, seed: sea.seed,
      boatOffsetX: boatX, boatOffsetY: boatY, thresholds,
    }, 4);
    const assess = assessFeasibility(result, thresholds, hs);
    const stations = [-0.2, 0, 0.2].map((f) => ({ x: vessel.ladderX + f * vessel.loa * 0.2, y: boatY }));
    const best = scanBestHeadings(shelterBase, stations, 5, 3).map((b) => `${Math.round(deg(b.heading))}°`);
    const win = self.open('', '_blank');
    if (!win) { alert('请允许弹出窗口以生成可行性单'); return; }
    win.document.write(feasibilityHtml({
      point: point!.name, vessel: vessel!.name, seaName: sea!.name, hs, heading: deg(heading),
      speedKn: shipSpeed / 0.5144, sigD, sigV, wpm, feasible: assess.feasible, reasons: assess.reasons,
      bestHeadings: best, thresholds,
    }));
  }

  root.onDestroy = () => { running = false; self.clearInterval(windowTimer); };
  boot();
}

function selector(label: string, _value: string, options: Array<[string | undefined, string]>, current: string, onChange: (id: string) => void): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label),
    Object.assign(h('select', {}, ...options.map(([id, name]) => h('option', { value: id ?? '' }, name))),
      { value: current, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) }));
}

function metric(label: string, val: string, current: number, limit: number): HTMLElement {
  const over = current > limit;
  return h('div', { class: 'metric-row' }, h('span', {}, label),
    h('b', { style: over ? 'color:var(--danger)' : 'color:var(--ok)' }, val, over ? ' ⚠' : ''));
}
function metricRow(label: string, val: string): HTMLElement {
  return h('div', { class: 'metric-row' }, h('span', {}, label), h('b', {}, val));
}

interface ReportData {
  point: string; vessel: string; seaName: string; hs: number; heading: number; speedKn: number;
  sigD: number; sigV: number; wpm: number; feasible: boolean; reasons: string[];
  bestHeadings: string[]; thresholds: typeof store.settings.defaults;
}
function feasibilityHtml(d: ReportData): string {
  const now = new Date().toLocaleString('zh-CN');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>当班登轮可行性单</title>
  <style>body{font-family:'Microsoft YaHei',sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#1a1a1a}
  h1{text-align:center;font-size:22px}table{width:100%;border-collapse:collapse;margin:14px 0}
  td,th{border:1px solid #888;padding:8px 10px;font-size:14px}.ok{color:#0a7d4c;font-weight:bold}.no{color:#c0392b;font-weight:bold}
  .sign{margin-top:50px;display:flex;justify-content:space-between}.muted{color:#666;font-size:12px}</style></head><body>
  <h1>当班引航登轮可行性单</h1>
  <p class="muted">签发时间：${now}　系统：引航登离轮海况推演系统</p>
  <table>
  <tr><th>登轮点</th><td>${d.point}</td><th>船舶</th><td>${d.vessel}</td></tr>
  <tr><th>海况方案</th><td>${d.seaName}</td><th>有效波高</th><td>${d.hs.toFixed(2)} m（停航阈值 ${d.thresholds.maxSignificantHeight} m）</td></tr>
  <tr><th>建议航向</th><td>${d.heading.toFixed(0)}°</td><th>航速</th><td>${d.speedKn.toFixed(1)} kn</td></tr>
  <tr><th>相对位移有义值</th><td>${d.sigD.toFixed(2)} m（上限 ${d.thresholds.maxRelativeDisplacement} m）</td>
      <th>相对速度有义值</th><td>${d.sigV.toFixed(2)} m/s（上限 ${d.thresholds.maxRelativeVelocity} m/s）</td></tr>
  <tr><th>每分钟安全窗口</th><td>${d.wpm.toFixed(1)} 个（要求 ≥${d.thresholds.minWindowsPerMinute}）</td>
      <th>遮蔽优选航向</th><td>${d.bestHeadings.join('、')}</td></tr>
  </table>
  <h3>结论：<span class="${d.feasible ? 'ok' : 'no'}">${d.feasible ? '具备登轮条件，同意实施' : '不具备登轮条件，建议暂停/调整操纵'}</span></h3>
  <ul>${d.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
  <div class="sign"><div>值班调度员：____________</div><div>值班站长（签发）：____________</div></div>
  <p class="muted">本单由方向谱 FFT 海况推演与 RAO 频域积分生成，数值口径经 Hs<3%、相对运动<5% 验收。</p>
  </body></html>`;
}

declare global {
  interface HTMLElement { onDestroy?: () => void; }
}
