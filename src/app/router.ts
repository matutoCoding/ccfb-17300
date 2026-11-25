/** hash 路由与页面装配。 */
import { h, clear } from './dom.ts';
import { store } from './store.ts';
import { renderBoardingPoints } from './pages/boardingPoints.ts';
import { renderVessels } from './pages/vessels.ts';
import { renderSeaStates } from './pages/seaStates.ts';
import { renderSimulation } from './pages/simulation.ts';
import { renderOperations } from './pages/operations.ts';
import { renderSettings } from './pages/settings.ts';
import { OceanRenderer } from '../gpu/renderer.ts';

const ROUTES: Array<{ hash: string; label: string; render: (root: HTMLElement) => void }> = [
  { hash: '#/points', label: '登轮点档案', render: renderBoardingPoints },
  { hash: '#/vessels', label: '船舶运动库', render: renderVessels },
  { hash: '#/sea', label: '海况输入', render: renderSeaStates },
  { hash: '#/simulation', label: '登轮推演', render: renderSimulation },
  { hash: '#/operations', label: '作业记录', render: renderOperations },
  { hash: '#/settings', label: '站务设置', render: renderSettings },
];

export function startApp(): void {
  const app = document.getElementById('app')!;
  const nav = h('nav', { class: 'tabs' });
  const envPill = h('span', { class: 'env-pill' }, 'WebGPU 方向谱 FFT');
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, '引航登离轮海况推演系统'),
    nav, h('div', { class: 'spacer' }), envPill);
  const main = h('main', { class: 'layout' });
  const pageRoot = h('div', { class: 'page' });
  main.append(pageRoot);
  app.append(topbar, main);

  // WebGPU 能力探测，更新环境徽标
  OceanRenderer.isSupported().then((ok) => {
    envPill.textContent = ok ? 'WebGPU 已就绪 · 512² FFT' : 'WebGPU 不可用 · CPU 降级';
    envPill.style.color = ok ? 'var(--ok)' : 'var(--warn)';
  });

  let currentCleanup: (() => void) | null = null;

  function route(): void {
    const hash = location.hash || '#/simulation';
    const target = ROUTES.find((r) => r.hash === hash) ?? ROUTES[3];
    clear(nav);
    for (const r of ROUTES) {
      nav.append(h('button', {
        class: r.hash === target.hash ? 'active' : '',
        onclick: () => { location.hash = r.hash; },
      }, r.label));
    }
    currentCleanup?.();
    currentCleanup = null;
    clear(pageRoot);
    pageRoot.className = 'page';
    target.render(pageRoot);
    currentCleanup = () => (pageRoot as HTMLElement & { onDestroy?: () => void }).onDestroy?.();
  }
  window.addEventListener('hashchange', route);
  store.load().then(route);
}
