/**
 * 极简 DOM 构建工具与 Canvas 图表（零外部依赖）。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListenerOrEventListenerObject> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

export function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function rad(degVal: number): number {
  return (degVal * Math.PI) / 180;
}

/** 数字输入框，返回 label+input 行 */
export function numberField(label: string, value: number, step: number, onChange: (v: number) => void, min?: number, max?: number): HTMLElement {
  const input = h('input', {
    type: 'number', value: String(value), step: String(step),
    ...(min !== undefined ? { min: String(min) } : {}),
    ...(max !== undefined ? { max: String(max) } : {}),
    oninput: () => onChange(Number((input as HTMLInputElement).value)),
  }) as HTMLInputElement;
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

/**
 * 滚动时间序列图：两条曲线（位移/速度），超过阈值的时间段标红。
 */
export class TimeSeriesChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  constructor(parent: HTMLElement, title: string, private unit: string, private limit: number) {
    this.canvas = h('canvas', { class: 'chart' }) as HTMLCanvasElement;
    parent.append(h('div', { class: 'chart-title' }, title), this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /**
   * @param times 时间轴
   * @param series 曲线数据
   * @param window 只显示最近 window 秒
   */
  draw(
    times: number[],
    series: Array<{ values: number[]; color: string; label: string }>,
    window: number,
    endTime: number,
  ): void {
    const dpr = self.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 600;
    const hgt = 180;
    this.canvas.width = w * dpr;
    this.canvas.height = hgt * dpr;
    this.canvas.style.height = `${hgt}px`;
    const ctx = this.ctx;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, hgt);

    const t0 = Math.max(0, endTime - window);
    const t1 = endTime;
    let vmin = -this.limit, vmax = this.limit;
    for (const s of series) for (const v of s.values) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    const pad = 8;
    const xOf = (t: number): number => pad + ((t - t0) / (t1 - t0 || 1)) * (w - 2 * pad);
    const yOf = (v: number): number => pad + (1 - (v - vmin) / (vmax - vmin || 1)) * (hgt - 2 * pad);

    // 网格与零轴
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = pad + (g / 4) * (hgt - 2 * pad);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }
    const y0 = yOf(0);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.moveTo(pad, y0); ctx.lineTo(w - pad, y0); ctx.stroke();

    // 超限红带（第一条曲线超 ±limit）
    if (series.length > 0) {
      ctx.fillStyle = 'rgba(230, 60, 60, 0.28)';
      let inRed = false;
      let redStart = 0;
      const vals = series[0].values;
      for (let i = 0; i <= times.length; i++) {
        const bad = i < vals.length && Math.abs(vals[i]) > this.limit && times[i] >= t0;
        if (bad && !inRed) { inRed = true; redStart = times[i]; }
        if ((!bad || i === times.length) && inRed) {
          inRed = false;
          const xA = xOf(redStart), xB = xOf(i < times.length ? times[i] : t1);
          ctx.fillRect(xA, pad, Math.max(1, xB - xA), hgt - 2 * pad);
        }
      }
    }

    // 阈值线
    ctx.strokeStyle = 'rgba(230,120,120,0.8)';
    ctx.setLineDash([5, 4]);
    for (const lv of [this.limit, -this.limit]) {
      const y = yOf(lv);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // 曲线
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < times.length; i++) {
        if (times[i] < t0) continue;
        const x = xOf(times[i]), y = yOf(s.values[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 坐标标注
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '11px system-ui';
    ctx.fillText(`${vmax.toFixed(1)} ${this.unit}`, pad + 2, pad + 10);
    ctx.fillText(`${vmin.toFixed(1)}`, pad + 2, hgt - pad);
    ctx.fillText(`${t0.toFixed(0)}s`, pad, hgt - 1);
    ctx.fillText(`${t1.toFixed(0)}s`, w - pad - 28, hgt - 1);
  }
}

/** 柱状谱图（方向谱一维能量分布） */
export function drawSpectrumBars(canvas: HTMLCanvasElement, omegas: number[], s1d: number[]): void {
  const dpr = self.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const hgt = 160;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  canvas.style.height = `${hgt}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, hgt);
  const max = Math.max(...s1d, 1e-9);
  const bw = (w - 16) / omegas.length;
  s1d.forEach((v, i) => {
    const bh = (v / max) * (hgt - 24);
    ctx.fillStyle = i % 2 ? '#3d7ea6' : '#4f97c0';
    ctx.fillRect(8 + i * bw, hgt - 16 - bh, Math.max(1, bw - 0.5), bh);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '11px system-ui';
  ctx.fillText(`ω ${omegas[0].toFixed(2)}~${omegas[omegas.length - 1].toFixed(2)} rad/s`, 8, 12);
}
