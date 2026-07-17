// CoreWise Academy — hero star chart.
// The curriculum rendered as a constellation atlas: guides are stars,
// prerequisite links are constellation lines, the cursor is a lantern
// that connects nearby stars. Five clusters = five tracks.
// Deterministic first frame (seeded PRNG, fixed initial rotation);
// honors prefers-reduced-motion (renders a single settled frame);
// pauses on document.hidden; static <canvas> fallback text if no WebGL.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const canvas = document.getElementById('sky');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(7);

// ------------------------------------------------------------ sky data
// Five track-constellations, arranged as an arc. Each has a whimsical
// chart name; sizes echo how much is published (Practitioner-heavy).
const TRACKS = [
  { name: 'THE LENS', stars: 16, cx: -3.4, cy: 0.9, spread: 1.0 },   // Foundations
  { name: 'THE LOOM', stars: 22, cx: -1.5, cy: -0.5, spread: 1.15 }, // Prompting
  { name: 'THE COURIER', stars: 14, cx: 0.4, cy: 0.8, spread: 0.95 },// Agents
  { name: 'THE FORGE', stars: 18, cx: 2.1, cy: -0.6, spread: 1.05 }, // Building
  { name: 'THE METRONOME', stars: 12, cx: 3.6, cy: 0.7, spread: 0.85 }, // Practice
];
const FIELD_STARS = 260; // faint background population

const starPos = [];   // flat xyz
const starMeta = [];  // {cluster: -1 field | idx, base: brightness, size}
const linkPairs = []; // constellation line index pairs

for (let c = 0; c < TRACKS.length; c++) {
  const t = TRACKS[c];
  const first = starPos.length / 3;
  const pts = [];
  for (let i = 0; i < t.stars; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * t.spread;
    const x = t.cx + Math.cos(a) * r;
    const y = t.cy + Math.sin(a) * r * 0.72;
    const z = (rand() - 0.5) * 0.9;
    pts.push([x, y, z]);
    starPos.push(x, y, z);
    starMeta.push({ cluster: c, base: 0.75 + rand() * 0.25, size: 3.2 + rand() * 4.2 });
  }
  // constellation lines: connect each star to its nearest sibling (+ a spine)
  for (let i = 1; i < pts.length; i++) {
    let best = 0, bd = 1e9;
    for (let j = 0; j < i; j++) {
      const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    linkPairs.push(first + i, first + best);
  }
}
for (let i = 0; i < FIELD_STARS; i++) {
  starPos.push((rand() - 0.5) * 11.5, (rand() - 0.5) * 5.2, (rand() - 0.5) * 2.4);
  starMeta.push({ cluster: -1, base: 0.2 + rand() * 0.3, size: 1.6 + rand() * 2 });
}
const N = starMeta.length;

// ------------------------------------------------------------ renderer
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
} catch {
  canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'sky-fallback' }));
  throw new Error('WebGL unavailable — static hero');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 60);
camera.position.set(0, 0, 7.2);

const sky = new THREE.Group();
scene.add(sky);

// ---- stars (custom shader: per-star size, brightness, twinkle) ----
const positions = new Float32Array(starPos);
const aBase = new Float32Array(N);
const aSize = new Float32Array(N);
const aPhase = new Float32Array(N);
const aLantern = new Float32Array(N); // 0..1, cursor proximity — CPU-updated
for (let i = 0; i < N; i++) {
  aBase[i] = starMeta[i].base;
  aSize[i] = starMeta[i].size;
  aPhase[i] = rand() * Math.PI * 2;
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
starGeo.setAttribute('aBase', new THREE.BufferAttribute(aBase, 1));
starGeo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
starGeo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
starGeo.setAttribute('aLantern', new THREE.BufferAttribute(aLantern, 1));

const starUniforms = {
  uTime: { value: 0 },
  uColor: { value: new THREE.Color('#1c31a4') },
  uGlow: { value: new THREE.Color('#2743d0') },
  uDpr: { value: Math.min(devicePixelRatio, 2) },
};
const starMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
  uniforms: starUniforms,
  vertexShader: /* glsl */ `
    attribute float aBase, aSize, aPhase, aLantern;
    uniform float uTime, uDpr;
    varying float vBright, vLantern;
    void main() {
      float tw = 0.82 + 0.18 * sin(uTime * 1.6 + aPhase * 3.7);
      vBright = aBase * tw + aLantern * 0.9;
      vLantern = aLantern;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = (aSize + aLantern * 3.5) * uDpr * (8.4 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor, uGlow;
    varying float vBright, vLantern;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      float core = smoothstep(0.5, 0.06, d);
      // four-point diffraction spike for the brightest states
      float spike = max(0.0, 1.0 - abs(uv.x) * 14.0) + max(0.0, 1.0 - abs(uv.y) * 14.0);
      float a = core * vBright + spike * vBright * 0.18 * (0.35 + vLantern);
      vec3 col = mix(uColor, uGlow, vLantern * 0.8);
      if (a < 0.02) discard;
      gl_FragColor = vec4(col, min(a, 1.0));
    }`,
});
const stars = new THREE.Points(starGeo, starMat);
sky.add(stars);

// ---- constellation lines (faint, always on) ----
const linePos = new Float32Array(linkPairs.length * 3);
for (let i = 0; i < linkPairs.length; i++) {
  const s = linkPairs[i] * 3;
  linePos.set([starPos[s], starPos[s + 1], starPos[s + 2]], i * 3);
}
const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
const lineMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22, color: '#2743d0' });
const constellations = new THREE.LineSegments(lineGeo, lineMat);
sky.add(constellations);

// ---- lantern edges (drawn live between stars near the cursor) ----
// Each strand has a lifecycle: it eases in slowly, grows outward from its
// midpoint, and fades out even more slowly — per-vertex alpha via shader,
// so nothing pops. A persistent map + hysteresis keeps the set stable.
const MAX_LANTERN_EDGES = 240;
const lanternPos = new Float32Array(MAX_LANTERN_EDGES * 6);
const lanternAlpha = new Float32Array(MAX_LANTERN_EDGES * 2);
const lanternGeo = new THREE.BufferGeometry();
lanternGeo.setAttribute('position', new THREE.BufferAttribute(lanternPos, 3));
lanternGeo.setAttribute('aAlpha', new THREE.BufferAttribute(lanternAlpha, 1));
lanternGeo.setDrawRange(0, 0);
const lanternMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uColor: { value: new THREE.Color('#2743d0') }, uOpacity: { value: 0.5 } },
  vertexShader: /* glsl */ `
    attribute float aAlpha;
    varying float vAlpha;
    void main() {
      vAlpha = aAlpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(uColor, vAlpha * uOpacity); }`,
});
const lanternLines = new THREE.LineSegments(lanternGeo, lanternMat);
sky.add(lanternLines);
const edgeLife = new Map(); // "a_b" -> { a, b, s: strength 0..1, on: bool }

// ------------------------------------------------------------ theme
function readTheme() {
  const css = getComputedStyle(document.body);
  const star = css.getPropertyValue('--star').trim() || '#1c31a4';
  const glow = css.getPropertyValue('--accent').trim() || '#2743d0';
  starUniforms.uColor.value.set(star);
  starUniforms.uGlow.value.set(glow);
  lineMat.color.set(glow);
  lanternMat.uniforms.uColor.value.set(glow);
  meteorMat.color.set(glow);
  const night = document.documentElement.dataset.theme === 'night';
  lineMat.opacity = night ? 0.3 : 0.22;
  lanternMat.uniforms.uOpacity.value = night ? 0.7 : 0.55;
  render();
}
new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ------------------------------------------------------------ lantern
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const mouseNdc = new THREE.Vector2(10, 10); // offscreen until first move
const lantern = new THREE.Vector3(6.5, 3.2, 0); // enters from just beyond the sky's edge
const lanternTarget = new THREE.Vector3(6.5, 3.2, 0); // mutated in place, never reassigned

// With no visitor, the lantern keeps its own rounds: it wanders from
// constellation to constellation, lacing webs as it goes.
let pointerActive = false;
const wander = { wp: new THREE.Vector3(), idx: -1 };
function pickWaypoint() {
  let next;
  do { next = Math.floor(Math.random() * TRACKS.length); } while (next === wander.idx);
  wander.idx = next;
  const t = TRACKS[next];
  wander.wp.set(
    t.cx + (Math.random() - 0.5) * t.spread * 0.8,
    t.cy + (Math.random() - 0.5) * t.spread * 0.5,
    0,
  );
}
pickWaypoint();

canvas.parentElement.addEventListener('pointermove', (e) => {
  pointerActive = true;
  const r = canvas.getBoundingClientRect();
  mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouseNdc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hit)) lanternTarget.copy(sky.worldToLocal(hit));
});
canvas.parentElement.addEventListener('pointerleave', () => { pointerActive = false; });

const LANTERN_R = 1.6;
const smooth = (t) => t * t * (3 - 2 * t); // smoothstep 0..1
// time-based easing so the feel is identical at 60Hz and 144Hz:
// fraction of remaining distance covered per second, applied as 1-e^(-k*dt)
const ease = (k, dt) => 1 - Math.exp(-k * dt);
function updateLantern(dt) {
  if (!pointerActive) {
    // unattended: glide toward the current waypoint, then choose the next room
    lanternTarget.lerp(wander.wp, ease(0.5, dt));
    if (lanternTarget.distanceTo(wander.wp) < 0.35) pickWaypoint();
  }
  lantern.lerp(lanternTarget, ease(pointerActive ? 5.5 : 2.2, dt)); // the light drifts, it doesn't snap
  const near = [];
  for (let i = 0; i < N; i++) {
    const dx = starPos[i * 3] - lantern.x, dy = starPos[i * 3 + 1] - lantern.y;
    const d = Math.hypot(dx, dy);
    const v = smooth(Math.max(0, 1 - d / LANTERN_R));
    // asymmetric ease: stars warm up gently, cool down even more gently
    aLantern[i] += (v - aLantern[i]) * ease(v > aLantern[i] ? 4.2 : 2.6, dt);
    if (aLantern[i] > 0.22 && starMeta[i].cluster !== -1) near.push([i, d]);
  }
  starGeo.attributes.aLantern.needsUpdate = true;

  // candidate strands among the warmest stars (hysteresis: born > 0.3, kept until < 0.12).
  // Shortest pairs first, at most 3 strands per star — a web, not a hairball.
  near.sort((a, b) => a[1] - b[1]);
  const picks = near.slice(0, 20).map((n) => n[0]);
  const pairs = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i], b = picks[j];
      const d = Math.hypot(starPos[a * 3] - starPos[b * 3], starPos[a * 3 + 1] - starPos[b * 3 + 1]);
      if (d < 0.95 && aLantern[a] > 0.3 && aLantern[b] > 0.3) pairs.push([d, a, b]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0]);
  const degree = new Map();
  const wanted = new Set();
  const claim = (a, b, key) => {
    wanted.add(key);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  };
  // living strands keep their claim first — otherwise the greedy re-selection
  // flips a strand's fate frame to frame while the lantern moves, and it flickers
  for (const [key, edge] of edgeLife) {
    if (edge.s > 0.04 && aLantern[edge.a] > 0.16 && aLantern[edge.b] > 0.16) claim(edge.a, edge.b, key);
  }
  // new strands only fill the remaining degree budget
  for (const [, a, b] of pairs) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (wanted.has(key)) continue;
    if ((degree.get(a) ?? 0) >= 3 || (degree.get(b) ?? 0) >= 3) continue;
    claim(a, b, key);
  }
  for (const key of wanted) {
    if (!edgeLife.has(key) && edgeLife.size < MAX_LANTERN_EDGES) {
      const [a, b] = key.split('_').map(Number);
      edgeLife.set(key, { a, b, s: 0 });
    }
  }

  // ease every strand toward its fate; write the growing geometry
  let e = 0;
  for (const [key, edge] of edgeLife) {
    const alive = wanted.has(key) && aLantern[edge.a] > 0.12 && aLantern[edge.b] > 0.12;
    edge.s += ((alive ? 1 : 0) - edge.s) * ease(alive ? 3.2 : 2.0, dt); // slow bloom, slower fade
    if (!alive && edge.s < 0.02) { edgeLife.delete(key); continue; }
    const g = smooth(edge.s);
    const a3 = edge.a * 3, b3 = edge.b * 3;
    const mx = (starPos[a3] + starPos[b3]) / 2, my = (starPos[a3 + 1] + starPos[b3 + 1]) / 2, mz = (starPos[a3 + 2] + starPos[b3 + 2]) / 2;
    // the strand grows outward from its midpoint toward both stars
    lanternPos.set([
      mx + (starPos[a3] - mx) * g, my + (starPos[a3 + 1] - my) * g, mz + (starPos[a3 + 2] - mz) * g,
      mx + (starPos[b3] - mx) * g, my + (starPos[b3 + 1] - my) * g, mz + (starPos[b3 + 2] - mz) * g,
    ], e * 6);
    // feather each strand by how warm its endpoint is — the web breathes at the rim
    lanternAlpha[e * 2] = g * Math.min(1, aLantern[edge.a] * 1.4);
    lanternAlpha[e * 2 + 1] = g * Math.min(1, aLantern[edge.b] * 1.4);
    e++;
    if (e >= MAX_LANTERN_EDGES) break;
  }
  lanternGeo.setDrawRange(0, e * 2);
  lanternGeo.attributes.position.needsUpdate = true;
  lanternGeo.attributes.aAlpha.needsUpdate = true;
}

// ---- meteors: a click casts a shooting star ----
const MAX_METEORS = 6;
const meteors = []; // {x, y, vx, vy, life}
const meteorPos = new Float32Array(MAX_METEORS * 6);
const meteorGeo = new THREE.BufferGeometry();
meteorGeo.setAttribute('position', new THREE.BufferAttribute(meteorPos, 3));
meteorGeo.setDrawRange(0, 0);
const meteorMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, color: '#2743d0' }); // recolored by readTheme
const meteorLines = new THREE.LineSegments(meteorGeo, meteorMat);
sky.add(meteorLines);

canvas.parentElement.addEventListener('pointerdown', (e) => {
  if (meteors.length >= MAX_METEORS || e.target.closest('a, button')) return;
  const r = canvas.getBoundingClientRect();
  mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouseNdc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return;
  const p = sky.worldToLocal(hit.clone());
  const a = Math.PI * (1.1 + Math.random() * 0.3); // down-left-ish
  meteors.push({ x: p.x, y: p.y, vx: Math.cos(a) * 4.2, vy: Math.sin(a) * 4.2, life: 1 });
});

function updateMeteors(dt) {
  let n = 0;
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt * 1.4;
    if (m.life <= 0) { meteors.splice(i, 1); continue; }
    const tail = 0.55 * m.life;
    meteorPos.set([m.x, m.y, 0.4, m.x - m.vx * tail * 0.22, m.y - m.vy * tail * 0.22, 0.4], n * 6);
    n++;
  }
  meteorMat.opacity = 0.9;
  meteorGeo.setDrawRange(0, n * 2);
  meteorGeo.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------ loop
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => { resize(); render(); });
resize();

let t0 = performance.now();
function render(now = t0) {
  starUniforms.uTime.value = (now - t0) / 1000;
  // slow celestial drift + cursor parallax
  sky.rotation.y = Math.sin(starUniforms.uTime.value * 0.05) * 0.06 + mouseNdc.x * 0.03 * (Math.abs(mouseNdc.x) < 2 ? 1 : 0);
  sky.rotation.x = mouseNdc.y * -0.02 * (Math.abs(mouseNdc.y) < 2 ? 1 : 0);
  sky.position.y = Math.sin(starUniforms.uTime.value * 0.11) * 0.05;
  renderer.render(scene, camera);
}

if (reduced) {
  readTheme(); // single settled frame, no loop
} else {
  let raf, last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    updateLantern(dt); updateMeteors(dt); render(now);
    raf = requestAnimationFrame(loop);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(loop);
  });
  readTheme();
  raf = requestAnimationFrame(loop);
}

// dev hook for automated visual checks (harmless in production)
window.__sky = {
  aLantern, edgeLife, lantern, lanternTarget, lanternGeo,
  // advance the simulation deterministically, independent of rAF throttling
  step(frames = 1, dt = 1 / 60) { for (let i = 0; i < frames; i++) { updateLantern(dt); updateMeteors(dt); } render(performance.now()); },
};

// expose the live census for the corner micro-labels
document.querySelectorAll('[data-star-count]').forEach((el) => { el.textContent = N; });
document.querySelectorAll('[data-link-count]').forEach((el) => { el.textContent = linkPairs.length / 1; });
