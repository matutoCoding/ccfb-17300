/** 列主序 4x4 矩阵工具（WebGPU 用）。 */
export function identityMat4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
export function translation(x: number, y: number, z: number): Float32Array {
  const m = identityMat4();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}
export function rotationX(a: number): Float32Array {
  const m = identityMat4();
  const c = Math.cos(a), s = Math.sin(a);
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}
export function rotationY(a: number): Float32Array {
  const m = identityMat4();
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}
export function rotationZ(a: number): Float32Array {
  const m = identityMat4();
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}
export function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
export function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function normalize3(a: number[]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function perspective(eye: [number, number, number], target: [number, number, number]): Float32Array {
  const fov = (50 * Math.PI) / 180;
  const aspect = (typeof self !== 'undefined' && self.innerWidth) ? self.innerWidth / self.innerHeight : 1.5;
  const near = 0.5, far = 4000;
  const f = 1 / Math.tan(fov / 2);
  const z = normalize3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const up = [0, 1, 0];
  const x = normalize3(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1;
  m[12] = -dot3(x, eye);
  m[13] = -dot3(y, eye);
  m[14] = -dot3(z, eye) * (far + near) / (near - far) + (2 * far * near) / (near - far);
  return m;
}
