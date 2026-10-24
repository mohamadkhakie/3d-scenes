import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, CopyPass, Effect, EffectAttribute, BloomEffect } from 'postprocessing';
import { VelocityDepthNormalPass, SSGIEffect, SSREffect, TRAAEffect, MotionBlurEffect, HBAOEffect, SSAOEffect } from 'realism-effects';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/* =====================================================================
   Frame: the reference image is 941 × 1672. The camera is level (pitch 0)
   with a lens shift so the horizon sits at y = 550 px, focal length 2000 px.
   Every object is placed by the pixel it occupies in the reference plus
   its distance, so the framing matches the reference directly.
   ===================================================================== */
const W = 941, HT = 1672;
const F = 2000;          // focal length in px
const HZ = 550;          // horizon row in px
const CX = W / 2;
const EYE = 1.76;        // camera height (world units)
const wx = (px, d) => ((px - CX) / F) * d;
const wy = (py, d) => EYE + ((HZ - py) / F) * d;
const wl = (len, d) => (len / F) * d;

const TOKENS = location.hash.slice(1).split('.');
const FX = {
  ssgi: !TOKENS.includes('no-ssgi'),
  ssr: TOKENS.includes('fx-ssr'),
  hbao: !TOKENS.includes('no-hbao'),
  ssao: TOKENS.includes('fx-ssao'),
  traa: !TOKENS.includes('no-traa'),
  motionBlur: !TOKENS.includes('no-motionblur'),
  dof: !TOKENS.includes('no-dof'),
};
// SSGI adds bounce light from the sky and neighbouring surfaces; the shaders' own ambient term is lowered to match,
// and the albedo the G-buffer sees is scaled so the bounce stays a soft fill rather than a wash.
const GI_ALBEDO = 0.45;
const AMBIENT = FX.ssgi ? 0.8 : 1;
const V3 = THREE.Vector3, C = (h) => new THREE.Color(h);
const canvas = document.getElementById('c');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, HT, false);
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xf1dcc6, 0.0065);
scene.environment = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#e9cfc2'); grad.addColorStop(0.35, '#f6dcc6'); grad.addColorStop(0.49, '#fdf0c2');
  grad.addColorStop(0.51, '#b9b083'); grad.addColorStop(0.7, '#6d7b55'); grad.addColorStop(1, '#4a5a40');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  const sun = g.createRadialGradient(384, 126, 0, 384, 126, 70);   // sun sits toward -z (u = 0.75)
  sun.addColorStop(0, 'rgba(255,250,225,1)'); sun.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = sun; g.fillRect(0, 0, 512, 256);
  const src = g.getImageData(0, 0, 512, 256).data, data = new Uint8Array(src.length);
  for (let y = 0; y < 256; y++) data.set(src.subarray((255 - y) * 2048, (256 - y) * 2048), y * 2048);   // DataTexture rows run bottom-up
  const t = new THREE.DataTexture(data, 512, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
})();
scene.environmentIntensity = 0.5;

// Lens shift lives in the projection matrix (not setViewOffset), because TRAA jitters the camera with setViewOffset
// and the velocity pass switches the view offset off; both must keep the same off-centre horizon.
const SHIFT = 1 - (2 * HZ) / HT;   // NDC height of the horizon row
const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(HT / 2 / F)), W / HT, 0.05, 1200);
camera.updateProjectionMatrix = function () {
  THREE.PerspectiveCamera.prototype.updateProjectionMatrix.call(this);
  this.projectionMatrix.elements[9] -= SHIFT;
  this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
};
camera.updateProjectionMatrix();
camera.position.set(0, EYE, 0);
camera.lookAt(0, EYE, -1);

/* ---------- light & atmosphere ---------- */
const SUN = new V3((478 - CX) / F, (HZ - 540) / F, -1).normalize();
const shared = {
  uTime: { value: 0 }, uSunDir: { value: SUN }, uSunCol: { value: C('#ffe0a4') },
  uAmb: { value: C('#c9c1b2') }, uHazeA: { value: C('#efd2c2') }, uHazeB: { value: C('#fdf0bf') },
};
scene.add(new THREE.HemisphereLight(0xfff2e6, 0x7d8a60, 1.6));
const sunLight = new THREE.DirectionalLight(0xffdfa6, 2.0); sunLight.position.copy(SUN).multiplyScalar(80); scene.add(sunLight);
const fill = new THREE.DirectionalLight(0xffeee6, 1.3); fill.position.set(0, 4, 10); scene.add(fill);

const COMMON = /* glsl */`
uniform float uTime; uniform vec3 uSunDir, uSunCol, uAmb, uHazeA, uHazeB;
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3=fract(p3*.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec3 hash33(vec3 p3){ p3=fract(p3*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
vec3 hazeColor(vec3 vd){ float s=max(dot(vd,uSunDir),0.); return mix(uHazeA,uHazeB,pow(s,10.)) + uSunCol*pow(s,200.)*0.35; }
vec3 applyHaze(vec3 col, vec3 wp, float k){ vec3 d=wp-cameraPosition; float dist=length(d); return mix(col, hazeColor(d/dist), 1.-exp(-dist*k)); }
`;

/* ---------- shell fur (grass, hill turf, foliage over Tripo meshes) ---------- */
const FUR_VS = COMMON + /* glsl */`
attribute float aLayer;
uniform float uLen, uWind;
varying float vL; varying vec3 vBase, vWorld, vN; varying vec2 vUv;
void main(){
  vec4 wp = modelMatrix*vec4(position,1.);
  vec3 wn = normalize(transpose(inverse(mat3(modelMatrix)))*normal);
  vBase = wp.xyz; vUv = uv;
  float L = aLayer;
  vec3 p = wp.xyz + wn*L*uLen;
  float w = uWind*L*L;
  p.x += w*(sin(uTime + wp.x*0.7 + wp.z*0.35)*0.6 + sin(uTime*3. + wp.z*1.7)*0.25);
  p.z += w*cos(uTime + wp.x*0.5)*0.4;
  vL = L; vWorld = p; vN = wn;
  gl_Position = projectionMatrix*viewMatrix*vec4(p,1.);
}`;
const FUR_FS = COMMON + /* glsl */`
uniform float uDensity, uMode, uHazeK, uGround, uRim, uUseMap, uSat, uThin, uBack, uAmbK, uClump, uOrange, uTopK, uRimGlow;
uniform vec3 uRimGlowCol;
uniform vec3 uBase, uTip, uBase2, uTip2;
uniform sampler2D uMap;
varying float vL; varying vec3 vBase, vWorld, vN; varying vec2 vUv;
void main(){
  vec3 q = vBase*uDensity;
  if(uClump > 0.){   // strands lean into their tuft's centre, so the grass reads as fluffy clumps
    vec2 cq = q.xz/3.5; vec2 cid = floor(cq); vec2 cc = (cid + 0.5 + (hash22(cid+3.1)-0.5)*0.6)*3.5;
    q.xz = mix(q.xz, cc, vL*vL*uClump);
  }
  float dist, r, r2;
  float camD = length(vWorld-cameraPosition);
  if(uMode < 0.5){
    vec2 qq = mat2(0.8,-0.6,0.6,0.8)*q.xz;                                   // off-axis grid so no rows line up with the view
    qq += (vec2(vnoise(q.xz*0.13), vnoise(q.xz*0.13+7.3))-0.5)*2.4;           // gentle warp breaks the regular spacing
    vec2 id=floor(qq); vec2 f=fract(qq)-0.5; f-=(hash22(id)-0.5)*0.75;
    vec2 lean = (hash22(id+5.7)-0.5)*1.3 + (vec2(vnoise(q.xz*0.05+3.), vnoise(q.xz*0.05+9.))-0.5)*0.9;
    f -= lean*vL*vL;                                                          // strands bend in their own direction
    dist=length(f); r=hash12(id); r2=hash12(id+17.3);
  } else {
    vec3 id=floor(q); vec3 f=fract(q)-0.5; f-=(hash33(id)-0.5)*0.4;
    dist=length(f); r=hash13(id); r2=hash13(id+7.7);
  }
  float h = mix(0.42,1.0,r);
  float thick = mix(1.0,1.8,smoothstep(8.,40.,camD));
  if(vL > 0.001){
    if(vL > h) discard;
    float rad = (uMode<0.5?0.42:0.62)*uThin*pow(1.-vL/h,0.6)*thick;
    if(dist > rad) discard;
  }
  float big = vnoise(vBase.xz*0.35)*0.6 + vnoise(vBase.xz*1.3)*0.4;
  float mask = 0.;
  if(uGround > 0.5){
    float d = -vBase.z;
    vec2 pp = vec2(vBase.x/3.8, (d-7.05)/(d > 7.05 ? 1.05 : 0.95));
    mask = 1.-smoothstep(0.35,1.1,length(pp)+(big-0.5)*0.5);
  }
  vec3 base = mix(uBase,uBase2,mask), tip = mix(uTip,uTip2,mask);
  if(uUseMap > 0.5){
    vec3 tc = texture2D(uMap, vUv).rgb;
    tc = mix(vec3(dot(tc, vec3(0.2126,0.7152,0.0722))), tc, uSat);
    base *= tc; tip *= tc;
  }
  vec3 alb = mix(base, tip, clamp(vL/h,0.,1.));
  alb *= mix(0.84,1.14,r2)*mix(0.9,1.08,big);
  vec3 n = normalize(vN); vec3 V = normalize(cameraPosition-vWorld);
  float diff = clamp(dot(n,uSunDir)*0.5+0.55,0.,1.);
  float ao = mix(0.35,1.0,pow(vL,0.8));
  float back = pow(clamp(dot(-V,uSunDir),0.,1.),4.)*vL*vL;
  float lit = 1.;
  if(uGround > 0.5){
    float d = -vBase.z;
    lit = mix(0.84,1.0,smoothstep(4.6,6.4,d));     // soft shade band just in front of the sunlit patch
    lit = max(lit, mask);
    float crest = smoothstep(7.6, 9.4, d)*(1.-mask);
    alb = mix(alb, vec3(0.78,0.8,0.42)*mix(0.8,1.15,vL), crest);
    ao = mix(ao, 1., crest*0.8);
  }
  vec3 col = alb*(uAmb*uAmbK + uSunCol*diff*0.75*lit)*ao + uSunCol*alb*back*(uBack+mask*1.1)*lit;
  col += uSunCol*mask*0.3*vL;
  float rim = pow(1.-clamp(dot(n,V),0.,1.),2.5)*(0.4+0.6*clamp(dot(n,uSunDir)*0.5+0.5,0.,1.))*uRim;
  col += uSunCol*alb*rim*1.3 + uSunCol*rim*0.1;
  float upN = smoothstep(-0.5, 0.9, n.y);
  col *= mix(1. - uTopK*0.45, 1. + uTopK*0.35, upN);                                     // lit crown, shaded base
  col += uRimGlowCol * uRimGlow * pow(1.-clamp(dot(n,V),0.,1.), 2.) * mix(0.25, 1.0, upN) * mix(0.5, 1.0, vL);
  // low sun scattering through the turf: a soft orange glow on surfaces seen against the sun
  float toSun = max(dot(-V, uSunDir), 0.);
  float glow = pow(toSun, 100.);                                     // only within a few degrees of the sun
  col = mix(col, col*vec3(1.2,0.86,0.6) + vec3(0.32,0.13,0.03), uOrange*glow*0.9);   // warm the colour itself
  col += vec3(1.0, 0.5, 0.18) * uOrange * (glow*0.22 + pow(toSun, 1500.)*0.4) * mix(0.6, 1.0, vL);
  col = applyHaze(col, vWorld, uHazeK);
  gl_FragColor = vec4(col,1.);
}`;

const FUR = [];
function furMaterial(o) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uLen: { value: o.len }, uDensity: { value: o.density }, uMode: { value: o.mode ?? 1 },
      uWind: { value: o.wind ?? 0 }, uHazeK: { value: o.haze ?? 0.016 },
      uGround: { value: o.ground ? 1 : 0 }, uRim: { value: o.rim ?? 1 }, uThin: { value: o.thin ?? 1 }, uBack: { value: o.back ?? 0.7 }, uAmbK: { value: (o.amb ?? 0.78) * AMBIENT }, uClump: { value: o.clump ?? 0 }, uOrange: { value: o.orange ?? 0 }, uTopK: { value: o.topK ?? 0 }, uRimGlow: { value: o.rimGlow ?? 0 }, uRimGlowCol: { value: C(o.rimGlowCol ?? '#e8e08a') },
      uBase: { value: C(o.base) }, uTip: { value: C(o.tip) },
      uBase2: { value: C(o.base2 ?? o.base) }, uTip2: { value: C(o.tip2 ?? o.tip) },
      uMap: { value: o.map ?? null }, uUseMap: { value: o.map ? 1 : 0 }, uSat: { value: o.sat ?? 1 },
    },
    vertexShader: FUR_VS, fragmentShader: FUR_FS,
  });
}
function fur(geo, o) {
  const a = new Float32Array(o.layers);
  for (let i = 0; i < o.layers; i++) a[i] = i / (o.layers - 1);
  if (!geo.getAttribute('aLayer') || geo.getAttribute('aLayer').count !== o.layers)
    geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(a, 1));
  const mat = furMaterial(o);
  // SSGI's G-buffer reads .color / .map / .roughness from materials; give the shader material honest values
  mat.color = C(o.base).lerp(C(o.tip), 0.65).multiplyScalar(GI_ALBEDO); mat.roughness = 1; mat.metalness = 0;
  if (o.map) mat.map = o.map;
  const m = new THREE.InstancedMesh(geo, mat, o.layers);
  m.frustumCulled = false;
  m.userData.layers = o.layers;
  FUR.push(m);
  return m;
}

/* ---------- sky ---------- */
const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { ...shared, uTop: { value: C('#f3dbcd') }, uHor: { value: C('#fdf1c3') } },
  vertexShader: `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: COMMON + `uniform vec3 uTop,uHor; varying vec3 vDir;
  void main(){ vec3 d=normalize(vDir); float s=max(dot(d,uSunDir),0.);
    vec3 col=mix(uHor,uTop,smoothstep(0.02,0.27,d.y));
    col=mix(col,vec3(1.,.97,.82),pow(s,22.)*0.5);
    col+=vec3(1.,.93,.75)*pow(s,2500.)*0.35;
    col+=vec3(1.,.97,.9)*smoothstep(cos(0.021),cos(0.017),s)*1.2;
    gl_FragColor=vec4(col,1.); }`,
}));
sky.renderOrder = -1;
scene.add(sky);

/* ---------- foreground mound ---------- */
const CREST = 9.6;
function groundY(x, d) {
  const k = d < CREST ? 0.003 * (CREST - d) ** 2 : 0.06 * (d - CREST) ** 2;
  return 0.16 - k - 0.01 * x * x;
}
const groundGeo = new THREE.PlaneGeometry(14, 27, 150, 320);
groundGeo.rotateX(-Math.PI / 2); groundGeo.translate(0, 0, -13);
{ const p = groundGeo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, groundY(p.getX(i), -p.getZ(i))); groundGeo.computeVertexNormals(); }
scene.add(fur(groundGeo, {
  layers: 40, len: 0.075, density: 64, mode: 0, wind: 0.03, haze: 0.006, ground: true, rim: 0, thin: 1.05, clump: 0.45, orange: 0.6,
  base: '#223833', tip: '#9cbda4', base2: '#b0844a', tip2: '#ffe0a8',
}));

/* ---------- rolling hills, sculpted from the reference silhouettes ----------
   Each layer: its ridge line in reference pixels, its distance, and its depth. */
const HILLS = [
  { d: 20, e: 5,  pts: [[-60, 794], [0, 800], [100, 812], [200, 825], [300, 838], [400, 850], [500, 858], [600, 876], [720, 905]] },
  { d: 24, e: 6,  pts: [[430, 880], [520, 838], [600, 822], [700, 806], [800, 795], [941, 785], [1010, 782]] },
  { d: 32, e: 8,  pts: [[-60, 742], [0, 745], [100, 752], [200, 760], [300, 770], [400, 782], [500, 792], [600, 800], [700, 815], [820, 845]] },
  { d: 42, e: 9,  pts: [[330, 828], [430, 800], [500, 785], [600, 760], [700, 735], [800, 715], [941, 700], [1010, 698]] },
  { d: 58, e: 12, pts: [[-60, 580], [50, 577], [150, 578], [250, 590], [350, 612], [450, 640], [550, 668], [650, 695], [760, 722], [880, 750]] },
  { d: 70, e: 14, pts: [[280, 708], [400, 670], [470, 650], [550, 632], [650, 615], [750, 600], [850, 592], [941, 588], [1010, 588]] },
];
const FAR = [
  { d: 230, e: 50, pts: [[-60, 468], [100, 465], [200, 482], [300, 510], [400, 546], [470, 565], [560, 595], [660, 640]] },
  { d: 260, e: 55, pts: [[360, 612], [470, 566], [550, 545], [650, 520], [750, 498], [850, 488], [941, 484], [1010, 484]] },
];

function ridgeGeometry({ d, e, pts }, nx = 160, nz = 44) {
  const px0 = pts[0][0], px1 = pts[pts.length - 1][0];
  const target = [];
  for (let i = 0; i <= nx; i++) {
    const px = px0 + ((px1 - px0) * i) / nx;
    let k = 0; while (k < pts.length - 2 && pts[k + 1][0] < px) k++;
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const t = Math.min(1, Math.max(0, (px - ax) / (bx - ax)));
    target.push([px, ay + (by - ay) * t]);
  }
  for (let pass = 0; pass < 4; pass++)            // smooth the polyline into soft curves
    for (let i = 1; i < nx; i++) target[i][1] = (target[i - 1][1] + 2 * target[i][1] + target[i + 1][1]) / 4;
  const hh = e * 0.45;
  const xs = target.map(([px]) => wx(px, d));
  const top = target.map(([, py]) => wy(py, d));
  const vs = Array.from({ length: nz + 1 }, (_, j) => -1 + (2 * j) / nz);
  const prof = (v) => hh * (1 - Math.sqrt(Math.max(0, 1 - v * v)));
  // Seen from above, a dome's outline sits a little behind its crest; solve so the outline lands on the reference line.
  for (let it = 0; it < 4; it++) {
    for (let i = 0; i <= nx; i++) {
      let best = 1e9;
      for (const v of vs) { const D = d + v * e; const y = top[i] - prof(v); const sy = HZ + ((EYE - y) / D) * F; if (sy < best) best = sy; }
      top[i] += ((best - target[i][1]) / F) * d;
    }
  }
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const v = vs[j];
    pos.push(xs[i] * (d + v * e) / d, top[i] - prof(v), -(d + v * e));
    uv.push(i / nx, j / nz);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, dd = c + 1;
    idx.push(a, b, c, b, dd, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
for (const h of HILLS) {
  scene.add(fur(ridgeGeometry(h), { layers: 10, len: 0.035 + h.d * 0.001, density: 22 - h.d * 0.15, mode: 1, wind: 0, haze: 0.011, rim: 1, back: 1.8, amb: 0.55, orange: 1.35, base: '#6c7a4c', tip: '#c9c582' }));
}
const farMat = (col) => Object.assign(new THREE.ShaderMaterial({
  uniforms: { ...shared, uCol: { value: C(col) }, uHazeK: { value: 0.0042 } },
  vertexShader: `varying vec3 vWorld, vN; void main(){ vec4 wp=modelMatrix*vec4(position,1.); vWorld=wp.xyz; vN=normal; gl_Position=projectionMatrix*viewMatrix*wp; }`,
  fragmentShader: COMMON + `uniform vec3 uCol; uniform float uHazeK; varying vec3 vWorld, vN;
    void main(){ vec3 n=normalize(vN); vec3 V=normalize(cameraPosition-vWorld);
      vec3 alb=uCol*mix(0.94,1.04,vnoise(vWorld.xz*0.04));
      float diff=clamp(dot(n,uSunDir)*0.5+0.5,0.,1.);
      float rim=pow(1.-clamp(dot(n,V),0.,1.),3.);
      float tow=pow(clamp(dot(-V,uSunDir),0.,1.),6.);
      vec3 col=alb*(uAmb*0.85+uSunCol*diff*0.4)+uSunCol*rim*(0.15+0.9*tow)*0.6;
      gl_FragColor=vec4(applyHaze(col,vWorld,uHazeK),1.); }`,
}), { color: C(col).multiplyScalar(GI_ALBEDO), roughness: 1, metalness: 0 });
for (const h of FAR) scene.add(new THREE.Mesh(ridgeGeometry(h, 120, 24), farMat('#b78e8a')));

/* ---------- props: placed by reference pixel + distance ---------- */
const PLACES = {
  // canopy centre / radius in px; base = where the trunk meets the hill
  tree: [
    { c: [-114, 462], r: 208, d: 4.6 },
    { c: [860, 562], r: 124, d: 42, base: [885, 706] },
  ],
  // centre x, width in px, top row in px
  bush: [
    { cx: 50, w: 92, ty: 706, d: 30 },
    { cx: 82, w: 178, ty: 820, d: 15 },
    { cx: 740, w: 64, ty: 708, d: 40 },
    { cx: 793, w: 46, ty: 709, d: 40 },
    { cx: 802, w: 80, ty: 826, d: 16 },
    { cx: 945, w: 86, ty: 820, d: 16 },
    { cx: 990, w: 300, ty: 1215, d: 3.4 },
  ],
  // flowers on stems: base point (hidden behind the crest), total height in px
  stem: [
    { base: [860, 900], h: 56, d: 14 },
    { base: [952, 890], h: 56, d: 16 },
    { base: [-2, 890], h: 44, d: 16 },
  ],
  // face-on blurred foreground flowers: head centre, head width in px
  face: [
    { c: [80, 1416], w: 390, d: 1.55 },
    { c: [918, 1420], w: 390, d: 1.6 },
  ],
  cloud: [
    { c: [18, 222], w: 160, d: 26 },
    { c: [948, 232], w: 150, d: 26 },
  ],
};

const trunkMat = new THREE.MeshStandardMaterial({ color: '#6b3a36', roughness: 0.9, emissive: '#3a1a18', emissiveIntensity: 0.3 });

function extract(root) {
  let mesh; root.updateMatrixWorld(true); root.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  const src = mesh.geometry, g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name); if (!a) continue;
    const n = a.itemSize, arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) { arr[i * n] = a.getX(i); if (n > 1) arr[i * n + 1] = a.getY(i); if (n > 2) arr[i * n + 2] = a.getZ(i); }
    g.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.computeBoundingBox();
  const b = g.boundingBox; g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2); g.computeBoundingBox();
  return { geo: g, material: mesh.material };
}

/* fallbacks if a model file is missing */
function fallbackGeo(kind) {
  const g = kind === 'bush' ? new THREE.SphereGeometry(0.5, 96, 48, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.SphereGeometry(0.5, 96, 64);
  g.computeBoundingBox(); const b = g.boundingBox; g.translate(0, -b.min.y, 0); g.computeBoundingBox();
  return { geo: g, material: null };
}
function fallbackFlower() {
  const head = new THREE.Group();
  const pm = new THREE.MeshStandardMaterial({ color: '#f592b6', emissive: '#ee5f8c', emissiveIntensity: 0.5, roughness: 0.55 });
  const pg = new THREE.SphereGeometry(1, 40, 20);
  for (let i = 0; i < 5; i++) { const piv = new THREE.Group(); piv.rotation.y = (i / 5) * Math.PI * 2; const p = new THREE.Mesh(pg, pm); p.scale.set(0.5, 0.17, 0.4); p.position.x = 0.46; p.rotation.z = 0.28; piv.add(p); head.add(piv); }
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 16), new THREE.MeshStandardMaterial({ color: '#fff1b8', emissive: '#ffd98a', emissiveIntensity: 3 }));
  core.scale.y = 0.55; core.position.y = 0.1; head.add(core); head.position.y = 2;
  const g = new THREE.Group(); g.add(head);
  g.add(Object.assign(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2, 10), new THREE.MeshStandardMaterial({ color: '#5d7d3c' })), { position: new V3(0, 1, 0) }));
  return g;
}
function fallbackCloud() {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: '#fff4ee', emissive: '#ffd8c6', emissiveIntensity: 0.6 });
  for (const [x, y, z, r] of [[0, 0, 0, .55], [.5, -.1, .1, .42], [-.5, -.12, .05, .4], [.2, .25, -.1, .4], [-.25, .2, .1, .35]]) { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), m); s.position.set(x, y, z); g.add(s); }
  return g;
}

const FOLIAGE = { tree: { sat: 0.6, base: '#5e6b55', tip: '#e2e5c0' }, bush: { sat: 0.7, base: '#8d9e72', tip: '#f4f6d2' } };

function placeFoliage(kind, src) {
  const { geo, material } = src;
  const bb = geo.boundingBox, w0 = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), h0 = bb.max.y;
  const map = material?.map ?? null;
  const look = FOLIAGE[kind];
  for (const p of PLACES[kind]) {
    let s, pos;
    if (kind === 'tree') {
      const rW = wl(p.r, p.d); s = (2 * rW) / w0;
      const topY = wy(p.c[1], p.d) + rW;
      pos = new V3(wx(p.c[0], p.d), topY - h0 * s, -p.d);
      if (p.base) {
        const baseY = wy(p.base[1], p.d);
        const len = pos.y - baseY + rW * 0.9;
        if (len > 0) {
          const t = new THREE.Mesh(new THREE.CylinderGeometry(rW * 0.24, rW * 0.28, len, 24), trunkMat);
          t.position.set(pos.x - wl(4, p.d), baseY + len / 2, -p.d); scene.add(t);
        }
      }
    } else {
      s = wl(p.w, p.d) / w0;
      pos = new V3(wx(p.cx, p.d), wy(p.ty, p.d) - h0 * s, -p.d);
    }
    const size = w0 * s;
    const m = fur(geo, {
      layers: 16, len: size * 0.035, density: 30 / size, mode: 1, wind: 0.004 * size, haze: p.d > 10 ? 0.009 : 0.02, rim: 1, topK: 1.25, rimGlow: 0.9, rimGlowCol: '#f1e796',
      map, sat: look.sat, base: '#' + C(look.base).multiplyScalar(p.d < 6 ? 1.6 : 1).getHexString(), tip: '#' + C(look.tip).multiplyScalar(p.d < 6 ? 1.3 : 1).getHexString(),
    });
    m.position.copy(pos); m.scale.setScalar(s); m.rotation.y = p.d * 1.7;
    scene.add(m);
    if (kind === 'bush') ANIM.bushes.push({ o: m, s, phase: p.d * 0.9 });
  }
}

const GLOW = { flower: 0.3, cloud: 0.12 };
const ANIM = { trees: [], bushes: [], stems: [], faces: [], clouds: [] };

// Soft storybook shading on top of the PBR result: desaturate toward sage, darken the underside,
// and add the warm backlit rim the sun gives every rounded silhouette in the reference.
function stylize(mat, o) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRimCol = { value: C(o.rim ?? '#ffd892') };
    sh.uniforms.uRim = { value: o.rimK ?? 1 };
    sh.uniforms.uSat = { value: o.sat ?? 0.75 };
    sh.uniforms.uTint = { value: C(o.tint ?? '#ffffff') };
    sh.uniforms.uUnder = { value: o.under ?? 0.6 };
    sh.uniforms.uUnderCol = { value: C(o.underCol ?? '#ffffff') };
    sh.uniforms.uGlow = { value: o.glow ?? 0 };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uRimCol, uTint, uUnderCol; uniform float uRim, uSat, uUnder, uGlow;\nvoid main() {')
      .replace('#include <fog_fragment>', `
        {
          vec3 nV = normalize(normal);
          vec3 upV = normalize((viewMatrix * vec4(0., 1., 0., 0.)).xyz);
          float facing = clamp(dot(nV, normalize(vViewPosition)), 0., 1.);
          float up = dot(nV, upV);
          vec3 c = gl_FragColor.rgb;
          c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSat) * uTint;
          c *= mix(uUnder * uUnderCol, vec3(1.12), smoothstep(-0.75, 0.85, up));
          c += uRimCol * uGlow * (0.4 + 0.6 * smoothstep(-0.2, 0.9, up));   // soft inner glow (light through the puff)
          float rim = pow(1. - facing, 2.3);
          c += uRimCol * rim * mix(0.3, 1.0, smoothstep(-0.3, 0.8, up)) * uRim;
          gl_FragColor.rgb = c;
        }
        #include <fog_fragment>`);
  };
  mat.customProgramCacheKey = () => 'stylize-' + JSON.stringify(o);
  mat.needsUpdate = true;
}
function prepModel(kind, root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material?.map) return;
    const m = o.material;
    m.emissive = new THREE.Color(0xffffff); m.emissiveMap = m.map; m.emissiveIntensity = GLOW[kind];
    if (kind === 'cloud') stylize(m, { sat: 0.2, tint: '#fff0e6', under: 0.9, underCol: '#f6c4b4', rim: '#ffe7c4', rimK: 0.9, glow: 0.12 });
    if (kind === 'flower') stylize(m, { sat: 0.95, tint: '#fff0ee', under: 0.72, underCol: '#f2c0c8', rim: '#ffd9a8', rimK: 0.75 });
    m.needsUpdate = true;
  });
  return root;
}
function fitByBox(template, rx, ry) {
  const inner = template.clone(true);
  inner.rotation.set(rx, ry, 0);
  const outer = new THREE.Group(); outer.add(inner); outer.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(outer);
  return { outer, inner, b };
}
function headCentre(root, b) {
  // average of the vertices in the upper third: the bloom, not the stem
  const acc = new V3(), v = new V3(); let n = 0; const cut = b.max.y - (b.max.y - b.min.y) * 0.33;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 7) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); if (v.y > cut) { acc.add(v); n++; } }
  });
  return n ? acc.divideScalar(n) : b.getCenter(new V3());
}
// Trees use the Tripo model as-is (its own trunk and texture, no fur layer).
// With a base point the model spans canopy top to trunk base; without one it is sized by canopy width.
function placeTrees(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.color = new THREE.Color('#c4c2a4');
    if (m.map) { m.emissive = new THREE.Color('#d8c9a0'); m.emissiveMap = m.map; m.emissiveIntensity = 0.05; }
    m.roughness = 1; m.metalness = 0;
    stylize(m, { sat: 0.62, tint: '#e6e2c6', under: 0.5, rim: '#ffd58a', rimK: 1.4 });
  });
  PLACES.tree.forEach((p, i) => {
    const inner = root.clone(true);
    inner.rotation.y = i * 2.4;
    const outer = new THREE.Group(); outer.add(inner); outer.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(outer), size = b.getSize(new V3()), c = b.getCenter(new V3());
    inner.position.set(-c.x, -b.min.y, -c.z);
    const rW = wl(p.r, p.d), topY = wy(p.c[1], p.d) + rW;
    let s, baseY;
    if (p.base) { baseY = wy(p.base[1], p.d) - wl(4, p.d); s = (topY - baseY) / size.y; }
    else { s = (2 * rW) / Math.max(size.x, size.z); baseY = topY - size.y * s; }
    outer.scale.setScalar(s);
    outer.position.set(wx(p.c[0], p.d), baseY, -p.d);
    scene.add(outer);
    ANIM.trees.push({ o: outer, s, phase: i * 1.9 });
  });
}

// Bushes: the moss-ball model, sized by width and top row like the reference, same shading as the trees.
function placeBushes(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.color = new THREE.Color('#9fa385');
    if (m.map) { m.emissive = new THREE.Color('#d8c9a0'); m.emissiveMap = m.map; m.emissiveIntensity = 0.04; }
    m.roughness = 1; m.metalness = 0;
    stylize(m, { sat: 0.45, tint: '#d2d3b8', under: 0.48, rim: '#ffd58a', rimK: 1.1 });
  });
  PLACES.bush.forEach((p, i) => {
    const inner = root.clone(true);
    inner.rotation.y = i * 1.7;
    const outer = new THREE.Group(); outer.add(inner); outer.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(outer), size = b.getSize(new V3()), c = b.getCenter(new V3());
    inner.position.set(-c.x, -b.min.y, -c.z);
    const s = wl(p.w, p.d) / Math.max(size.x, size.z);
    outer.scale.setScalar(s);
    outer.position.set(wx(p.cx, p.d), wy(p.ty, p.d) - size.y * s, -p.d);
    scene.add(outer);
    ANIM.bushes.push({ o: outer, s, phase: i * 2.3 });
  });
}
function placeProps(kind, template) {
  if (kind === 'flower') {
    PLACES.stem.forEach((p, i) => {
      const { outer, inner, b } = fitByBox(template, 0, i * 2.1);
      const s = wl(p.h, p.d) / (b.max.y - b.min.y);
      inner.position.y = -b.min.y;
      outer.scale.setScalar(s); outer.position.set(wx(p.base[0], p.d), wy(p.base[1], p.d) - 0.02, -p.d);
      scene.add(outer);
      ANIM.stems.push({ o: outer, phase: i * 2.2 });
    });
    PLACES.face.forEach((p, i) => {
      const inner = template.clone(true);
      const b = new THREE.Box3().setFromObject(inner), size = b.getSize(new V3());
      const head = headCentre(inner, b);
      inner.position.sub(head);
      const spin = new THREE.Group(); spin.add(inner); spin.rotation.y = 0;
      const tilt = new THREE.Group(); tilt.add(spin); tilt.rotation.x = 0;   // the bloom faces the camera
      const outer = new THREE.Group(); outer.add(tilt);
      outer.scale.setScalar(wl(p.w, p.d) / size.x);
      outer.position.set(wx(p.c[0], p.d), wy(p.c[1], p.d), -p.d);
      scene.add(outer);
      ANIM.faces.push({ o: outer, phase: i * 2.7 });
    });
  } else {
    PLACES.cloud.forEach((p, i) => {
      const { outer, inner, b } = fitByBox(template, 0, i * 2.6);
      const c = b.getCenter(new V3());
      const s = wl(p.w, p.d) / (b.max.x - b.min.x);
      inner.position.sub(c);
      outer.scale.setScalar(s); outer.position.set(wx(p.c[0], p.d), wy(p.c[1], p.d), -p.d);
      scene.add(outer);
      ANIM.clouds.push({ o: outer, x: outer.position.x, y: outer.position.y, amp: wl(16, p.d), phase: i * 3.1 });
    });
  }
}

/* ---------- post-processing: realism-effects + depth of field + bloom ----------
   Effects can be switched from the address: #fx-ssr, #fx-ssao, #no-ssgi, #no-hbao, #no-traa, #no-motionblur, #no-dof
   (join several with dots, e.g. #no-ssgi.fx-ssao). */

class DofEffect extends Effect {   // circle-of-confusion gather blur, focus on the sunlit patch
  constructor() {
    super('DofEffect', /* glsl */`
      uniform float uFocus, uK, uMaxR;
      uniform float uFarK;
      float coc(float d){ float k = 1./uFocus - 1./d; return clamp(uK*abs(k)*(k > 0. ? uFarK : 1.), 0., uMaxR); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
        float d0 = -getViewZ(depth), c0 = coc(d0);
        vec3 acc = inputColor.rgb; float wsum = 1.;
        float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453)*6.2831;
        const int N = 112;
        for(int i=1;i<N;i++){
          float fi = float(i);
          float r = sqrt(fi/float(N))*uMaxR;
          float a = fi*2.39996323 + jit;
          vec2 p = uv + vec2(cos(a),sin(a))*r*texelSize;
          float ds = -getViewZ(readDepth(p)), cs = coc(ds);
          if(ds > d0) cs = min(cs, c0);
          float w = clamp(cs - r + 1., 0., 1.);
          acc += texture2D(inputBuffer, p).rgb*w; wsum += w;
        }
        outputColor = vec4(acc/wsum, inputColor.a);
      }`, {
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map([['uFocus', new THREE.Uniform(8.5)], ['uK', new THREE.Uniform(72)], ['uMaxR', new THREE.Uniform(48)], ['uFarK', new THREE.Uniform(1.4)]]),
    });
  }
}
class GrainEffect extends Effect {
  constructor() {
    super('GrainEffect', `
      float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        outputColor = vec4(inputColor.rgb + (h(uv*1000.+fract(time))-0.5)*0.005, inputColor.a);
      }`);
  }
}

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const vdn = new VelocityDepthNormalPass(scene, camera);
composer.addPass(vdn);

const giOptions = {
  distance: 6, thickness: 2.5, autoThickness: false, maxRoughness: 1, blend: 0.95,
  denoiseIterations: 3, denoiseKernel: 3, denoiseDiffuse: 25, denoiseSpecular: 25,
  depthPhi: 5, normalPhi: 28, roughnessPhi: 18, envBlur: 0.8, importanceSampling: true,
  directLightMultiplier: 1, steps: 20, refineSteps: 4, spp: 1, resolutionScale: 1, missedRays: false,
};
const lighting = [];
if (FX.ssgi) lighting.push(new SSGIEffect(scene, camera, vdn, giOptions));
if (FX.ssr) lighting.push(new SSREffect(scene, camera, vdn, { ...giOptions, distance: 12, blend: 0.9 }));
if (FX.hbao) lighting.push(new HBAOEffect(composer, camera, scene, { resolutionScale: 1, spp: 16, distance: 0.45, distancePower: 1, power: 0.4, bias: 40, thickness: 0.05, iterations: 2, radius: 12, samples: 16 }));
if (FX.ssao) lighting.push(new SSAOEffect(composer, camera, scene, { resolutionScale: 1, spp: 16, distance: 0.45, distancePower: 0.7, power: 0.5, bias: 250, thickness: 0.08, iterations: 2, radius: 12, samples: 16 }));
if (lighting.length) composer.addPass(new EffectPass(camera, ...lighting));

const temporal = [];
if (FX.traa) temporal.push(new TRAAEffect(scene, camera, vdn));
if (FX.motionBlur) temporal.push(new MotionBlurEffect(vdn, { intensity: 1, jitter: 1, samples: 16 }));
if (temporal.length) composer.addPass(new EffectPass(camera, ...temporal));

if (FX.dof) {
  // The depth texture belongs to the scene buffer; after an odd number of swaps the DoF pass would draw into that
  // buffer while sampling its depth (a feedback loop), so a copy pass evens the count.
  if ((lighting.length ? 1 : 0) + (temporal.length ? 1 : 0) === 1) composer.addPass(new CopyPass());
  composer.addPass(new EffectPass(camera, new DofEffect()));
}
composer.addPass(new EffectPass(camera,
  new BloomEffect({ intensity: 0.35, luminanceThreshold: 0.93, luminanceSmoothing: 0.08, mipmapBlur: true, radius: 0.7 }),
  new GrainEffect()));
composer.setSize(W, HT, false);

// The G-buffer passes ignore the fur's shell offsets and discards, so every shell would be the same surface:
// draw just one layer there to keep them cheap.
for (const pass of [vdn, ...lighting.map((e) => e.ssgiPass).filter(Boolean)]) {
  const render = pass.render.bind(pass);
  pass.render = (...args) => {
    for (const m of FUR) m.count = 1;
    render(...args);
    for (const m of FUR) m.count = m.userData.layers;
  };
}

/* ---------- display: fixed 941 × 1672 render, scaled to fit the window ----------
   Add #overlay, #split or #ref to the URL to lay reference.png over the render. */
const refImg = document.getElementById('ref');
function fit() {
  const s = Math.min(innerWidth / W, innerHeight / HT);
  for (const el of [canvas, refImg]) { el.style.width = W * s + 'px'; el.style.height = HT * s + 'px'; }
  const tokens = location.hash.slice(1).split('.');
  const mode = ['overlay', 'ref', 'split', 'splitr'].find((t) => tokens.includes(t));
  refImg.hidden = !mode;
  refImg.style.opacity = mode === 'overlay' ? 0.5 : 1;
  refImg.style.clipPath = mode === 'split' ? 'inset(0 0 0 50%)' : mode === 'splitr' ? 'inset(0 50% 0 0)' : 'none';
}
addEventListener('resize', fit); addEventListener('hashchange', fit); fit();

/* ---------- models ---------- */
const MODELS_DIR = window.MODELS_DIR ?? './models/';
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const load = (k) => (window.loadModel ? window.loadModel(k, loader) : loader.loadAsync(MODELS_DIR + k + '.glb'));
const kinds = ['tree', 'bush', 'flower', 'cloud'];
Promise.allSettled(kinds.map(load)).then((res) => {
  res.forEach((r, i) => {
    const k = kinds[i], ok = r.status === 'fulfilled';
    if (!ok) console.warn(`models/${k}.glb not loaded, using built-in shape`, r.reason);
    if (k === 'tree' && ok) placeTrees(r.value.scene);
    else if (k === 'tree' || k === 'bush') placeFoliage(k, ok ? extract(r.value.scene) : fallbackGeo(k));
    else placeProps(k, ok ? prepModel(k, r.value.scene) : k === 'flower' ? fallbackFlower() : fallbackCloud());
  });
  start();
});

/* ---------- loop ---------- */
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock = new THREE.Clock();
// Everything moves on whole-number harmonics of one 8-second phase, so the animation loops seamlessly
// (like the reference clip): clouds drift and bob, trees sway and breathe, flowers nod, grass ripples,
// and the camera drifts a few centimetres for a hint of parallax.
const LOOP = 8;
function animate(ph) {
  for (const a of ANIM.clouds) {
    a.o.position.x = a.x + a.amp * Math.sin(ph + a.phase);
    a.o.position.y = a.y + a.amp * 0.25 * Math.sin(ph * 2 + a.phase);
  }
  for (const a of ANIM.trees) {
    a.o.rotation.z = 0.012 * Math.sin(ph + a.phase);
    a.o.rotation.x = 0.006 * Math.sin(ph * 2 + a.phase);
    a.o.scale.setScalar(a.s * (1 + 0.006 * Math.sin(ph * 2 + a.phase)));
  }
  for (const a of ANIM.bushes) a.o.scale.setScalar(a.s * (1 + 0.012 * Math.sin(ph * 2 + a.phase)));
  for (const a of ANIM.stems) a.o.rotation.z = 0.07 * Math.sin(ph + a.phase) + 0.025 * Math.sin(ph * 3 + a.phase);
  for (const a of ANIM.faces) { a.o.rotation.z = 0.035 * Math.sin(ph + a.phase); a.o.rotation.x = 0.03 * Math.sin(ph * 2 + a.phase); }
  camera.position.set(0.04 * Math.sin(ph), EYE + 0.012 * Math.sin(ph * 2), 0.02 * Math.sin(ph + 1.2));
  camera.updateMatrixWorld();
}
function start() {
  renderer.setAnimationLoop(() => {
    const dt = Math.max(clock.getDelta(), 1 / 240), t = clock.elapsedTime;
    const ph = reduce ? 0 : ((t % LOOP) / LOOP) * Math.PI * 2;
    shared.uTime.value = ph;
    animate(ph);
    composer.render(dt);
    canvas.classList.add('ready');
  });
}
