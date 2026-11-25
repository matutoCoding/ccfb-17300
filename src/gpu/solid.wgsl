// 实体着色器：船舶、引航艇、软梯。白天用平行光，夜间叠加若干点/聚光灯
// （大船舷侧登乘灯、引航艇探照灯）。

struct SolidParams {
  viewProj: mat4x4<f32>,   // 0..63
  model: mat4x4<f32>,      // 64..127
  camPos: vec3<f32>,       // 128..139
  nightMode: f32,          // 140
  sunDir: vec3<f32>,       // 144..155
  lightCount: u32,         // 156
  baseColor: vec3<f32>,    // 160..171
  _pad: f32,               // 172
};                         // 总 176 字节
struct Light {             // 每个 48 字节
  pos: vec4<f32>,          // 0..15
  dirAndCut: vec4<f32>,    // 16..31
  colorAndPower: vec4<f32>,// 32..47
};

@group(0) @binding(0) var<uniform> P: SolidParams;
@group(1) @binding(0) var<storage, read> lights: array<Light>;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn solidVertex(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>) -> VOut {
  var out: VOut;
  let w = P.model * vec4<f32>(pos, 1.0);
  out.world = w.xyz;
  out.normal = normalize((P.model * vec4<f32>(nrm, 0.0)).xyz);
  out.clip = P.viewProj * w;
  return out;
}

@fragment
fn solidFragment(in: VOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let v = normalize(P.camPos - in.world);
  var color = vec3<f32>(0.0);

  if (P.nightMode < 0.5) {
    let l = normalize(P.sunDir);
    let diff = clamp(dot(n, l), 0.0, 1.0);
    let spec = pow(clamp(dot(reflect(-l, n), v), 0.0, 1.0), 40.0);
    color = P.baseColor * (0.3 + 0.7 * diff) + vec3<f32>(spec * 0.4);
  } else {
    // 夜间：极弱环境光 + 动态灯
    color = P.baseColor * 0.06;
  }

  // 动态点/聚光灯（昼夜都叠加，夜间为主），硬上限 4 防越界
  let nLights = min(P.lightCount, 4u);
  for (var i = 0u; i < nLights; i = i + 1u) {
    let L = lights[i];
    let toLight = L.pos.xyz - in.world;
    let dist = length(toLight);
    let l = toLight / dist;
    var atten = L.colorAndPower.w / (1.0 + 0.15 * dist * dist);
    if (L.pos.w > 0.5) {
      // 聚光灯：方向夹角裁剪
      let spot = dot(l, normalize(L.dirAndCut.xyz));
      let cut = L.dirAndCut.w;
      atten = atten * smoothstep(cut - 0.08, cut, spot);
    }
    let diff = clamp(dot(n, l), 0.0, 1.0);
    let spec = pow(clamp(dot(reflect(-l, n), v), 0.0, 1.0), 32.0);
    color += L.colorAndPower.xyz * atten * (diff * P.baseColor + vec3<f32>(spec * 0.5));
  }
  return vec4<f32>(color, 1.0);
}
