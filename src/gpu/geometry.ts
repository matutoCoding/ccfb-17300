/**
 * 程序化网格几何（无外部模型依赖）。
 * 返回交错顶点数据，单位米，船坐标系 x 船首、y 右舷、z 向上。
 */
export interface MeshData {
  positions: Float32Array; // xyz 交错
  normals: Float32Array;
  indices: Uint32Array;
}

function emptyMesh(): MeshData {
  return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };
}

/** 由带法线的三角形列表直接构建 */
function fromTriangles(tris: Array<{ p: [number, number, number]; n: [number, number, number] }>): MeshData {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => {
    positions.set(t.p, i * 9);
    normals.set(t.n, i * 9);
    indices.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  });
  return { positions, normals, indices };
}

function box(w: number, h: number, d: number, center: [number, number, number]): MeshData {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const [cx, cy, cz] = center;
  const corners: [number, number, number][] = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ];
  const faces: Array<[number, number, number, [number, number, number]]> = [
    [0, 1, 2, [0, 0, -1]], [0, 2, 3, [0, 0, -1]],
    [4, 6, 5, [0, 0, 1]], [4, 7, 6, [0, 0, 1]],
    [0, 4, 5, [0, -1, 0]], [0, 5, 1, [0, -1, 0]],
    [1, 5, 6, [1, 0, 0]], [1, 6, 2, [1, 0, 0]],
    [3, 2, 6, [0, 1, 0]], [3, 6, 7, [0, 1, 0]],
    [0, 3, 7, [-1, 0, 0]], [0, 7, 4, [-1, 0, 0]],
  ];
  const tris = faces.flatMap(([a, b, c, n]) => [
    { p: corners[a], n }, { p: corners[b], n }, { p: corners[c], n },
  ]);
  return fromTriangles(tris);
}

/**
 * 简化船体：长方体主船体 + 船首楔形收尖。
 * 原点在船中静水面，z 向上，甲板在 z=freeboard。
 */
export function buildShipHull(loa: number, beam: number, draft: number, freeboard: number): MeshData {
  const parts: MeshData[] = [];
  const height = draft + freeboard;
  const centerZ = freeboard - height / 2;
  // 主船体（船长 75%）
  const mainLen = loa * 0.75;
  parts.push(box(beam, height, mainLen, [0, 0, centerZ]));
  // 船首楔：用 4 个三角形连接方形截面到尖点
  const stern = mainLen / 2;
  const bow = loa / 2;
  const top = freeboard;
  const bot = -draft;
  const hb = beam / 2;
  const tip: [number, number, number] = [bow, 0, centerZ];
  const quad: [number, number, number][] = [
    [stern, -hb, bot], [stern, hb, bot], [stern, hb, top], [stern, -hb, top],
  ];
  const wedgeTris: Array<{ p: [number, number, number]; n: [number, number, number] }> = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [tip[0] - a[0], tip[1] - a[1], tip[2] - a[2]];
    const n: [number, number, number] = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    wedgeTris.push({ p: a, n: [n[0] / nl, n[1] / nl, n[2] / nl] }, { p: b, n: [n[0] / nl, n[1] / nl, n[2] / nl] }, { p: tip, n: [n[0] / nl, n[1] / nl, n[2] / nl] });
  }
  parts.push(fromTriangles(wedgeTris));
  // 上层建筑（驾驶台）
  parts.push(box(beam * 0.5, freeboard * 0.5, loa * 0.12, [-loa * 0.12, 0, freeboard + freeboard * 0.25]));
  return mergeMeshes(parts);
}

/** 引航艇：小型船体 + 驾驶舱 */
export function buildPilotBoat(): MeshData {
  const parts: MeshData[] = [];
  parts.push(box(4.2, 1.6, 12, [0, 0, 0.2]));
  // 尖头
  const tip: [number, number, number] = [0, 0, 7.5];
  const a: [number, number, number] = [2.1, -0.6, 6];
  const b: [number, number, number] = [-2.1, -0.6, 6];
  const c: [number, number, number] = [2.1, 1.0, 6];
  const d: [number, number, number] = [-2.1, 1.0, 6];
  const t = (p: [number, number, number], q: [number, number, number], r: [number, number, number]): { p: [number, number, number]; n: [number, number, number] } => {
    const u: [number, number, number] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v: [number, number, number] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    return { p, n: [n[0] / nl, n[1] / nl, n[2] / nl] };
  };
  parts.push(fromTriangles([t(a, b, tip), t(c, a, tip), t(d, c, tip), t(b, d, tip)]));
  parts.push(box(2.6, 1.4, 3.5, [0, 0, 1.7])); // 驾驶舱
  return mergeMeshes(parts);
}

/**
 * 软梯：两根侧绳 + 等距踏步，用细长盒子表达。
 * 长度 freeboard+1.5m，宽度 0.4m。
 */
export function buildLadder(length: number): MeshData {
  const parts: MeshData[] = [];
  const width = 0.4;
  const rungCount = Math.max(6, Math.round(length / 0.33));
  for (let i = 0; i <= rungCount; i++) {
    const z = -(i * length) / rungCount;
    parts.push(box(width, 0.05, 0.08, [0, 0, z])); // 踏步沿 x
  }
  // 两侧绳
  parts.push(box(0.04, 0.04, length, [width / 2, 0, -length / 2]));
  parts.push(box(0.04, 0.04, length, [-width / 2, 0, -length / 2]));
  return mergeMeshes(parts);
}

export function mergeMeshes(meshes: MeshData[]): MeshData {
  if (meshes.length === 1) return meshes[0];
  const totalV = meshes.reduce((a, m) => a + m.positions.length / 3, 0);
  const totalI = meshes.reduce((a, m) => a + m.indices.length, 0);
  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const indices = new Uint32Array(totalI);
  let vo = 0, io = 0, base = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    for (const idx of m.indices) indices[io++] = idx + base;
    vo += m.positions.length / 3;
    base = vo;
  }
  return { positions, normals, indices };
}

export { emptyMesh, box as boxMesh };
