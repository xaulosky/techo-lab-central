import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (s) => document.querySelector(s);
const MODEL_PATHS = ['./modelo.glb', '../modelo.glb'];
const STORE_KEY = 'techo-lab-central-anotaciones-v1';
const PIN_TYPES = [
  ['Fisura', '#e53935'], ['Humedad / filtración', '#1e88e5'], ['Desprendimiento', '#fb8c00'],
  ['Corrosión', '#a1887f'], ['Acumulación / suciedad', '#7cb342'], ['Otro', '#ab47bc'],
];
const COLORS = ['#ff1744', '#ffea00', '#00e676', '#2979ff', '#ff9100', '#ffffff'];
const ICONS = {
  nav: '<path d="M5 3l14 8-6 2-2 6z"/>',
  pen: '<path d="M3 21l3-1 13-13-2-2L4 18z"/><path d="M14 6l4 4"/>',
  pin: '<path d="M12 22s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  area: '<path d="M4 7l9-3 7 6-3 9-11-2z"/>',
  erase: '<path d="M8 20h12M5 14l8-9 6 6-6 7H8z"/>',
  calib: '<path d="M3 12h18M3 8v8M21 8v8M8 10v4M16 10v4"/>',
};
const TOOLS = [
  ['nav', 'Navegar', 'Gira alrededor de la esfera. Arrástrala o haz doble clic en el techo para mover el centro de giro (V)'],
  ['pen', 'Lápiz', 'Arrastra sobre la superficie para dibujar. Botón derecho/rueda: mover cámara (D)'],
  ['pin', 'Marcador', 'Clic en la superficie para colocar un marcador con nota (M)'],
  ['measure', 'Medir', 'Clic en 2 puntos para medir distancia (R)'],
  ['area', 'Área', 'Clic en cada vértice; Enter o doble clic para cerrar (A)'],
  ['erase', 'Borrar', 'Clic sobre una anotación para eliminarla (E)'],
  ['calib', 'Escala', 'Clic en 2 puntos de distancia conocida y escribe su longitud real (C)'],
];
const KEYS = { v: 'nav', d: 'pen', m: 'pin', r: 'measure', a: 'area', e: 'erase', c: 'calib' };

// ---------- estado ----------
let tool = 'nav';
let color = COLORS[0];
let lineWidth = 3;
let pinType = 0;
let scale = 1; // unidades del modelo -> metros
let anns = [];
let sel = null;
let undoStack = [];
let redoStack = [];
let nextId = 1;
let ready = false;
let dirty = true;
let modelName = 'modelo.glb';
const objs = new Map(); // id -> {group, badge}
const meshes = [];
let modelBox = new THREE.Box3();
let draft = null; // {type, pts:[Vector3], line}
let hoverPt = null;

// ---------- escena ----------
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2127);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
camera.position.set(40, 160, 90);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI;
const annGroup = new THREE.Group();
scene.add(annGroup);
// pivote: esfera + ejes en el centro de giro (tamaño constante en pantalla)
function makePivot(opacity) {
  const g = new THREE.Group();
  const sph = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x3fb6d8, transparent: true, opacity, depthTest: false }));
  sph.renderOrder = 1000; g.add(sph);
  for (const [dir, c] of [[[1, 0, 0], 0xff5252], [[0, 1, 0], 0x69f0ae], [[0, 0, 1], 0x448aff]]) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...dir).multiplyScalar(-1), new THREE.Vector3(...dir)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity, depthTest: false }));
    l.renderOrder = 1000; g.add(l);
  }
  scene.add(g);
  return g;
}
const pivot = makePivot(0.9);
const pivotGhost = makePivot(0.45);
pivotGhost.visible = false;
let pivotDrag = false;
function pivotScreenDist(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const v = controls.target.clone().project(camera);
  return Math.hypot((v.x * 0.5 + 0.5) * r.width + r.left - cx, (-v.y * 0.5 + 0.5) * r.height + r.top - cy);
}
function setPivot(p) {
  const off = camera.position.clone().sub(controls.target);
  flyTo(p.clone().add(off), p.clone());
}
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const lineMats = [];
function lineMat(c, w) {
  const m = new LineMaterial({ color: new THREE.Color(c), linewidth: w, worldUnits: false });
  m.resolution.set(canvas.clientWidth, canvas.clientHeight);
  lineMats.push(m);
  return m;
}

function resize() {
  const st = $('#stage');
  const w = st.clientWidth, h = st.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const m of lineMats) m.resolution.set(w, h);
  dirty = true;
}
new ResizeObserver(resize).observe($('#stage'));

// ---------- utilidades ----------
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = 'none'), ms);
}
function fmtLen(units) {
  const m = units * scale;
  return m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`;
}
function fmtArea(u2) {
  const m2 = u2 * scale * scale;
  return m2 < 1 ? `${(m2 * 1e4).toFixed(0)} cm²` : `${m2.toFixed(2)} m²`;
}
function pathLen(pts, closed) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i].distanceTo(pts[i - 1]);
  if (closed && pts.length > 2) l += pts[0].distanceTo(pts[pts.length - 1]);
  return l;
}
function polyArea(pts) {
  const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 1; i < pts.length - 1; i++) {
    a.subVectors(pts[i], pts[0]); b.subVectors(pts[i + 1], pts[0]);
    n.add(a.cross(b));
  }
  return n.length() / 2;
}
const V = (p) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v) => [v.x, v.y, v.z];

function surfaceHit(cx, cy, offsetScale = 1) {
  if (!ready) return null;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const n = hit.face.normal.clone();
  if (n.dot(raycaster.ray.direction) > 0) n.negate();
  const off = Math.max(0.004, camera.position.distanceTo(hit.point) * 0.0012) * offsetScale;
  return { point: hit.point.clone(), lifted: hit.point.clone().addScaledVector(n, off), normal: n };
}

// ---------- carga del modelo ----------
async function fetchWithProgress(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) { $('#lprog').value = got / total; $('#lmsg').textContent = `Descargando modelo… ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`; }
    else $('#lmsg').textContent = `Descargando modelo… ${(got / 1048576).toFixed(0)} MB`;
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}
function showLoadError(msg) {
  const l = $('#loading'); l.style.display = 'flex'; l.classList.add('err');
  $('#lmsg').textContent = msg; $('#lprog').style.display = 'none';
}
async function loadModel(source, name) {
  ready = false; setToolsEnabled();
  const l = $('#loading'); l.style.display = 'flex'; l.classList.remove('err');
  $('#lprog').style.display = ''; $('#lprog').value = 0;
  try {
    let buf;
    if (source instanceof ArrayBuffer) buf = source;
    else if (source instanceof Blob) buf = await source.arrayBuffer();
    else {
      let lastErr;
      for (const p of source) { try { buf = await fetchWithProgress(p); break; } catch (e) { lastErr = e; } }
      if (!buf) throw lastErr || new Error('sin modelo');
    }
    $('#lmsg').textContent = 'Procesando geometría y texturas…'; $('#lprog').removeAttribute('value');
    await new Promise((r) => setTimeout(r, 30));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, '');
    for (const m of meshes) { scene.remove(m); m.geometry.dispose?.(); }
    meshes.length = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshBasicMaterial({ map: old.map, side: THREE.DoubleSide });
      old.dispose?.();
      if (o.geometry.attributes.color) o.geometry.deleteAttribute('color');
      meshes.push(o);
    });
    scene.add(gltf.scene);
    modelName = name || 'modelo.glb';
    modelBox = new THREE.Box3().setFromObject(gltf.scene);
    $('#lmsg').textContent = 'Preparando selección sobre la superficie…';
    await new Promise((r) => setTimeout(r, 30));
    for (const m of meshes) { m.geometry.computeBoundsTree(); await new Promise((r) => setTimeout(r)); }
    ready = true; setToolsEnabled();
    setBrightness($('#bright').value);
    setView('home', true);
    l.style.display = 'none';
    loadFromStorage();
    dirty = true;
  } catch (e) {
    console.error(e);
    showLoadError('No se pudo cargar el modelo. Abre esta página con iniciar.bat (servidor local) o arrastra aquí el archivo .glb. (' + (e.message || e) + ')');
  }
}

// ---------- vistas ----------
let tween = null;
let oblIdx = 0;
function flyTo(pos, target, ms = 600) {
  const p0 = camera.position.clone(), t0 = controls.target.clone(), s = performance.now();
  tween = (now) => {
    const k = Math.min(1, (now - s) / ms), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(p0, pos, e);
    controls.target.lerpVectors(t0, target, e);
    if (k >= 1) tween = null;
  };
}
function setView(v, instant) {
  const c = modelBox.getCenter(new THREE.Vector3()), sz = modelBox.getSize(new THREE.Vector3());
  const R = Math.max(sz.x, sz.z) * 0.9;
  let pos;
  if (v === 'top') pos = c.clone().add(new THREE.Vector3(0.001, Math.max(R * 1.25, 10), 0.001));
  else if (v === 'obl') { oblIdx = (oblIdx + 1) % 4; const a = Math.PI / 4 + oblIdx * Math.PI / 2; pos = c.clone().add(new THREE.Vector3(Math.cos(a) * R, R * 0.8, Math.sin(a) * R)); }
  else pos = c.clone().add(new THREE.Vector3(R * 0.5, R * 0.9, R * 0.9));
  if (instant) { camera.position.copy(pos); controls.target.copy(c); } else flyTo(pos, c);
  dirty = true;
}
function setBrightness(v) {
  for (const m of meshes) m.material.color.setScalar(+v);
  dirty = true;
}

// ---------- anotaciones: dibujo ----------
function pointsOf(a) { return a.pts.map(V); }
function anchorOf(a) {
  const p = pointsOf(a);
  if (a.type === 'pen') return p[Math.floor(p.length / 2)];
  if (a.type === 'measure') return p[0].clone().lerp(p[1], 0.5);
  if (a.type === 'area') { const c = new THREE.Vector3(); p.forEach((q) => c.add(q)); return c.divideScalar(p.length); }
  return p[0];
}
function labelOf(a) {
  const p = pointsOf(a);
  if (a.type === 'measure') return fmtLen(pathLen(p));
  if (a.type === 'area') return `${fmtArea(polyArea(p))} · P ${fmtLen(pathLen(p, true))}`;
  return null;
}
function nameOf(a) {
  const idx = anns.filter((x) => x.type === a.type).indexOf(a) + 1;
  const base = { pen: 'Trazo', pin: 'Marcador', measure: 'Medición', area: 'Área' }[a.type];
  return `${base} ${idx}` + (a.type === 'pin' ? ` · ${PIN_TYPES[a.pinType || 0][0]}` : '');
}
function makeLine(pts, c, w, closed) {
  const p = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  const g = new LineGeometry();
  g.setPositions(p.flatMap(arr));
  const l = new Line2(g, lineMat(c, w));
  l.frustumCulled = false;
  return l;
}
function build(a) {
  destroyObj(a.id);
  const group = new THREE.Group();
  const p = pointsOf(a);
  if (a.type === 'pen' && p.length > 1) group.add(makeLine(p, a.color, a.width, false));
  if (a.type === 'measure' || a.type === 'area') {
    if (p.length > 1) group.add(makeLine(p, a.color, a.width, a.type === 'area'));
    const g = new THREE.BufferGeometry().setFromPoints(p);
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: a.color, size: 9, sizeAttenuation: false, depthTest: false })));
  }
  group.visible = a.visible !== false;
  annGroup.add(group);
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.addEventListener('pointerdown', (e) => e.stopPropagation());
  badge.addEventListener('click', (e) => { e.stopPropagation(); if (tool === 'erase') removeAnn(a.id); else select(a.id, true); });
  $('#overlay').appendChild(badge);
  objs.set(a.id, { group, badge });
  styleBadge(a);
}
function styleBadge(a) {
  const o = objs.get(a.id); if (!o) return;
  const b = o.badge;
  b.style.background = a.type === 'pin' ? PIN_TYPES[a.pinType || 0][1] : a.color;
  const lbl = labelOf(a);
  b.classList.toggle('lbl', !!lbl);
  b.classList.toggle('sel', sel === a.id);
  b.textContent = lbl || (a.type === 'pin' ? `📍${anns.filter((x) => x.type === 'pin').indexOf(a) + 1}` : `✎${anns.filter((x) => x.type === 'pen').indexOf(a) + 1}`);
  b.style.borderColor = lbl ? a.color : '#fff';
  b.style.display = a.visible === false || !$('#showAnn').checked ? 'none' : '';
  o.group.visible = a.visible !== false && $('#showAnn').checked;
}
function destroyObj(id) {
  const o = objs.get(id); if (!o) return;
  annGroup.remove(o.group);
  o.group.traverse((c) => { c.geometry?.dispose(); if (c.material) { const i = lineMats.indexOf(c.material); if (i >= 0) lineMats.splice(i, 1); c.material.dispose(); } });
  o.badge.remove(); objs.delete(id);
}
function rebuildAll() {
  for (const id of [...objs.keys()]) destroyObj(id);
  anns.forEach(build);
  renderList(); dirty = true;
}
const tmp = new THREE.Vector3();
function updateBadges() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const a of anns) {
    const o = objs.get(a.id); if (!o) continue;
    tmp.copy(anchorOf(a)).project(camera);
    const vis = tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    o.badge.style.visibility = vis ? 'visible' : 'hidden';
    if (vis) o.badge.style.left = `${(tmp.x * 0.5 + 0.5) * w}px`, o.badge.style.top = `${(-tmp.y * 0.5 + 0.5) * h}px`;
  }
}

// ---------- historial ----------
function snapshot() { return JSON.stringify({ anns, scale, nextId }); }
function commit() {
  undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  saveToStorage(); refreshButtons();
}
function restore(s) {
  const d = JSON.parse(s); anns = d.anns; scale = d.scale; nextId = d.nextId;
  if (!anns.some((a) => a.id === sel)) sel = null;
  rebuildAll(); saveToStorage(); refreshButtons();
}
function undo() { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); restore(undoStack[undoStack.length - 1]); }
function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); restore(s); }
function refreshButtons() {
  $('#undo').disabled = undoStack.length < 2; $('#redo').disabled = !redoStack.length;
  $('#count').textContent = `(${anns.length})`;
  $('#scaleInfo').textContent = `escala ×${scale.toPrecision(4)}`;
}
function saveToStorage() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ anns, scale, nextId })); } catch { /* sin almacenamiento */ }
}
function loadFromStorage() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d?.anns) { anns = d.anns; scale = d.scale || 1; nextId = d.nextId || anns.length + 1; }
  } catch { /* ignorar */ }
  undoStack = [snapshot()]; redoStack = [];
  rebuildAll(); refreshButtons();
}

// ---------- operaciones ----------
function addAnn(a) {
  a.id = nextId++; a.visible = true; a.note = a.note || ''; a.created = new Date().toISOString();
  anns.push(a); build(a); commit(); select(a.id, false); renderList(); dirty = true;
  return a;
}
function removeAnn(id) {
  anns = anns.filter((a) => a.id !== id);
  destroyObj(id); if (sel === id) sel = null;
  commit(); renderList(); dirty = true;
}
function select(id, fly) {
  sel = id;
  for (const a of anns) styleBadge(a);
  renderList(); dirty = true;
  const el = document.querySelector(`.item[data-id="${id}"]`);
  el?.scrollIntoView({ block: 'nearest' });
  if (fly) {
    const a = anns.find((x) => x.id === id); if (!a) return;
    const p = pointsOf(a), c = anchorOf(a);
    const r = new THREE.Box3().setFromPoints(p).getBoundingSphere(new THREE.Sphere()).radius;
    const d = Math.max(3, r * 3);
    const dir = camera.position.clone().sub(controls.target).normalize();
    flyTo(c.clone().addScaledVector(dir, d), c);
  }
}
function finishDraft() {
  if (!draft) return;
  const { type, pts } = draft;
  clearDraft();
  if (type === 'measure' && pts.length === 2) addAnn({ type, color: '#ffea00', width: 3, pts: pts.map(arr) });
  else if (type === 'area' && pts.length >= 3) addAnn({ type, color: '#00e5ff', width: 3, pts: pts.map(arr) });
  else if (type === 'calib' && pts.length === 2) {
    const u = pathLen(pts);
    const s = prompt(`Longitud real entre los dos puntos (en metros).\nActualmente mide ${fmtLen(u)}:`, (u * scale).toFixed(2));
    const v = parseFloat((s || '').replace(',', '.'));
    if (v > 0) { scale = v / u; commit(); anns.forEach(styleBadge); renderList(); toast(`Escala calibrada: ×${scale.toPrecision(4)}`); }
  }
  setTool('nav');
}
function clearDraft() {
  if (draft?.line) { annGroup.remove(draft.line); draft.line.geometry.dispose(); }
  if (draft?.dots) { annGroup.remove(draft.dots); draft.dots.geometry.dispose(); }
  draft = null; dirty = true;
}
function updateDraft(extra) {
  if (!draft) return;
  const pts = extra ? [...draft.pts, extra] : draft.pts;
  if (draft.line) { annGroup.remove(draft.line); draft.line.geometry.dispose(); draft.line = null; }
  if (draft.dots) { annGroup.remove(draft.dots); draft.dots.geometry.dispose(); draft.dots = null; }
  if (pts.length > 1) { draft.line = makeLine(pts, draft.color, draft.width, draft.type === 'area' && pts.length > 2); annGroup.add(draft.line); }
  if (draft.type !== 'pen' && draft.pts.length) {
    draft.dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(draft.pts), new THREE.PointsMaterial({ color: draft.color, size: 9, sizeAttenuation: false, depthTest: false }));
    annGroup.add(draft.dots);
  }
  dirty = true;
}

// ---------- puntero ----------
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button };
  if (!ready) return;
  if (pivot.visible && e.button === 0 && e.isPrimary && pivotScreenDist(e.clientX, e.clientY) < 16) {
    pivotDrag = true; controls.enabled = false; down = null;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (tool === 'pen' && e.button === 0 && e.isPrimary) {
    const h = surfaceHit(e.clientX, e.clientY);
    if (h) {
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      draft = { type: 'pen', pts: [h.lifted], color, width: lineWidth, last: { x: e.clientX, y: e.clientY }, drawing: true };
    }
  }
}, { capture: true });

let moveQueued = false;
canvas.addEventListener('pointermove', (e) => {
  if (!ready) return;
  if (pivotDrag) {
    const h = surfaceHit(e.clientX, e.clientY, 0);
    pivotGhost.visible = !!h;
    if (h) pivotGhost.position.copy(h.point);
    dirty = true;
    return;
  }
  if (!draft && e.buttons === 0) {
    const near = pivot.visible && pivotScreenDist(e.clientX, e.clientY) < 16;
    canvas.style.cursor = near ? 'move' : tool === 'nav' ? 'grab' : 'crosshair';
  }
  if (draft?.drawing) {
    const dx = e.clientX - draft.last.x, dy = e.clientY - draft.last.y;
    if (dx * dx + dy * dy >= 9) {
      const h = surfaceHit(e.clientX, e.clientY);
      if (h) { draft.pts.push(h.lifted); draft.last = { x: e.clientX, y: e.clientY }; updateDraft(); }
    }
    return;
  }
  if (draft && !moveQueued && (tool === 'measure' || tool === 'area' || tool === 'calib')) {
    moveQueued = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => { moveQueued = false; const h = surfaceHit(clientX, clientY); if (h && draft) updateDraft(h.lifted); });
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (pivotDrag) {
    pivotDrag = false; controls.enabled = true;
    if (pivotGhost.visible) setPivot(pivotGhost.position);
    pivotGhost.visible = false; dirty = true;
    canvas.style.cursor = tool === 'nav' ? 'grab' : 'crosshair';
    return;
  }
  if (draft?.drawing) {
    controls.enabled = true;
    const d = draft; clearDraft();
    if (d.pts.length > 1) addAnn({ type: 'pen', color: d.color, width: d.width, pts: d.pts.map(arr) });
    down = null; return;
  }
  if (!down || down.btn !== 0 || !ready) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved > 5 || performance.now() - down.t > 600) return;
  onClick(e);
});
canvas.addEventListener('dblclick', (e) => {
  if (tool === 'area' && draft) { draft.pts.pop(); finishDraft(); return; }
  if (tool === 'nav') { const h = surfaceHit(e.clientX, e.clientY, 0); if (h) setPivot(h.point); }
});

function onClick(e) {
  if (tool === 'nav' || tool === 'erase') {
    const id = pickAnn(e.clientX, e.clientY);
    if (tool === 'erase') { if (id) removeAnn(id); }
    else if (id) select(id, false); else if (sel) select(null);
    return;
  }
  const h = surfaceHit(e.clientX, e.clientY);
  if (!h) return;
  if (tool === 'pin') {
    addAnn({ type: 'pin', color: PIN_TYPES[pinType][1], pinType, width: 3, pts: [arr(h.lifted)] });
    document.querySelector(`.item[data-id="${sel}"] textarea`)?.focus();
    $('#panel').classList.add('open');
  } else if (tool === 'measure' || tool === 'calib' || tool === 'area') {
    if (!draft) draft = { type: tool, pts: [], color: tool === 'measure' ? '#ffea00' : tool === 'area' ? '#00e5ff' : '#ff4081', width: 3 };
    draft.pts.push(h.lifted); updateDraft();
    if ((tool === 'measure' || tool === 'calib') && draft.pts.length === 2) finishDraft();
  }
}
function pickAnn(cx, cy) {
  const r = canvas.getBoundingClientRect();
  let best = null, bd = 14;
  const proj = (p) => { const v = p.clone().project(camera); return v.z > 1 ? null : { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top }; };
  for (const a of anns) {
    if (a.visible === false || !$('#showAnn').checked) continue;
    const P = pointsOf(a).map(proj);
    const closed = a.type === 'area';
    let d = Infinity;
    if (P.length === 1 && P[0]) d = Math.hypot(P[0].x - cx, P[0].y - cy);
    for (let i = 0; i < P.length - (closed ? 0 : 1); i++) {
      const A = P[i], B = P[(i + 1) % P.length]; if (!A || !B) continue;
      const vx = B.x - A.x, vy = B.y - A.y, l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((cx - A.x) * vx + (cy - A.y) * vy) / l2));
      d = Math.min(d, Math.hypot(A.x + t * vx - cx, A.y + t * vy - cy));
    }
    if (d < bd) { bd = d; best = a.id; }
  }
  return best;
}

// ---------- UI ----------
function setToolsEnabled() { document.querySelectorAll('#tools button[data-tool]').forEach((b) => (b.disabled = !ready)); }
function setTool(t) {
  if (draft) clearDraft();
  tool = t;
  document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const info = TOOLS.find((x) => x[0] === t);
  $('#hint').textContent = `${info[1]}: ${info[2]}`;
  canvas.style.cursor = t === 'nav' ? 'grab' : 'crosshair';
  $('#pinsel').style.display = t === 'pin' ? '' : 'none';
}
function buildTools() {
  const box = $('#tools');
  for (const [id, name, tip] of TOOLS) {
    const b = document.createElement('button');
    b.dataset.tool = id; b.title = tip; b.disabled = true;
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[id]}</svg><span>${name}</span>`;
    b.onclick = () => setTool(id);
    box.appendChild(b);
  }
  box.appendChild(document.createElement('hr'));
  const sw = document.createElement('div'); sw.className = 'swatches';
  COLORS.forEach((c, i) => {
    const b = document.createElement('button'); b.className = 'sw' + (i === 0 ? ' on' : ''); b.style.background = c; b.title = 'Color del lápiz';
    b.onclick = () => { color = c; sw.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b)); if (sel) { const a = anns.find((x) => x.id === sel); if (a?.type === 'pen') { a.color = c; build(a); commit(); renderList(); } } };
    sw.appendChild(b);
  });
  box.appendChild(sw);
  const w = document.createElement('input'); w.type = 'range'; w.id = 'width'; w.min = 1; w.max = 12; w.value = lineWidth; w.title = 'Grosor';
  w.oninput = () => (lineWidth = +w.value);
  box.appendChild(w);
  const ps = document.createElement('select'); ps.id = 'pinsel'; ps.style.display = 'none'; ps.title = 'Tipo de marcador';
  PIN_TYPES.forEach(([n], i) => ps.add(new Option(n, i)));
  ps.onchange = () => (pinType = +ps.value);
  box.appendChild(ps);
}
function renderList() {
  const list = $('#list');
  const keepFocus = document.activeElement?.closest?.('.item') ? document.activeElement : null;
  if (keepFocus && keepFocus.tagName === 'TEXTAREA') return; // no interrumpir la escritura
  list.innerHTML = '';
  if (!anns.length) { list.innerHTML = '<div class="empty">Sin anotaciones.<br>Usa el lápiz, marcadores o las herramientas de medición.</div>'; return; }
  for (const a of anns) {
    const it = document.createElement('div');
    it.className = 'item' + (a.id === sel ? ' sel' : ''); it.dataset.id = a.id;
    const lbl = labelOf(a);
    it.innerHTML = `<div class="hd"><span class="dot" style="background:${a.type === 'pin' ? PIN_TYPES[a.pinType || 0][1] : a.color}"></span><span class="nm"></span>
      <button class="ic" data-act="eye" title="Mostrar/ocultar">${a.visible === false ? '🚫' : '👁'}</button>
      <button class="ic" data-act="del" title="Eliminar">✕</button></div>
      ${lbl ? `<div class="dt">${lbl}</div>` : ''}`;
    it.querySelector('.nm').textContent = nameOf(a);
    it.querySelector('.nm').onclick = () => select(a.id, true);
    if (a.type === 'pin') {
      const s = document.createElement('select');
      PIN_TYPES.forEach(([n], i) => s.add(new Option(n, i)));
      s.value = a.pinType || 0;
      s.onchange = () => { a.pinType = +s.value; a.color = PIN_TYPES[a.pinType][1]; commit(); renderList(); styleBadge(a); };
      it.appendChild(s);
    }
    const ta = document.createElement('textarea'); ta.placeholder = 'Observaciones…'; ta.value = a.note || '';
    ta.oninput = () => { a.note = ta.value; };
    ta.onchange = () => commit();
    ta.onfocus = () => { if (sel !== a.id) { sel = a.id; anns.forEach(styleBadge); } };
    it.appendChild(ta);
    it.querySelector('[data-act=eye]').onclick = () => { a.visible = a.visible === false; styleBadge(a); commit(); renderList(); dirty = true; };
    it.querySelector('[data-act=del]').onclick = () => removeAnn(a.id);
    list.appendChild(it);
  }
}
function download(name, blob) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
}
function screenshot() {
  const pv = pivot.visible;
  pivot.visible = false;
  renderer.render(scene, camera);
  pivot.visible = pv; dirty = true;
  const w = canvas.width, h = canvas.height, k = w / canvas.clientWidth;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(canvas, 0, 0);
  g.font = `bold ${12 * k}px sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'center';
  for (const a of anns) {
    const o = objs.get(a.id); if (!o || o.badge.style.display === 'none' || o.badge.style.visibility === 'hidden') continue;
    const x = parseFloat(o.badge.style.left) * k, y = parseFloat(o.badge.style.top) * k, t = o.badge.textContent;
    const tw = g.measureText(t).width + 14 * k;
    g.fillStyle = o.badge.classList.contains('lbl') ? '#000c' : o.badge.style.background;
    g.strokeStyle = '#fff'; g.lineWidth = 2 * k;
    g.beginPath(); g.roundRect(x - tw / 2, y - 10 * k, tw, 20 * k, 10 * k); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.fillText(t, x, y);
  }
  c.toBlob((b) => download(`inspeccion-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, b));
}

// ---------- eventos ----------
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => ready && setView(b.dataset.view)));
$('#bright').oninput = (e) => setBrightness(e.target.value);
$('#showAnn').onchange = () => { anns.forEach(styleBadge); dirty = true; };
$('#showPivot').onchange = (e) => { pivot.visible = e.target.checked; dirty = true; };
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#clearAll').onclick = () => { if (anns.length && confirm('¿Borrar todas las anotaciones?')) { anns = []; sel = null; rebuildAll(); commit(); } };
$('#openGlb').onclick = () => $('#glbFile').click();
$('#glbFile').onchange = (e) => { const f = e.target.files[0]; if (f) loadModel(f, f.name); e.target.value = ''; };
$('#saveJson').onclick = () => download('anotaciones-techo.json', new Blob([JSON.stringify({ version: 1, model: modelName, scale, anns }, null, 1)], { type: 'application/json' }));
$('#loadJson').onclick = () => $('#jsonFile').click();
$('#jsonFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.anns)) throw new Error('formato inválido');
    anns = d.anns; scale = d.scale || 1; nextId = Math.max(0, ...anns.map((a) => a.id || 0)) + 1;
    sel = null; rebuildAll(); commit(); toast(`${anns.length} anotaciones cargadas`);
  } catch (err) { toast('No se pudo leer el archivo: ' + err.message, 4000); }
};
$('#shot').onclick = screenshot;
$('#ptoggle').onclick = () => $('#panel').classList.toggle('open');
$('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
addEventListener('keydown', (e) => {
  if (e.target.matches('textarea,input,select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { if (draft) clearDraft(); else setTool('nav'); }
  else if (e.key === 'Enter' && draft?.type === 'area') finishDraft();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) removeAnn(sel);
  else if (ready && KEYS[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) setTool(KEYS[e.key.toLowerCase()]);
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.name.toLowerCase().endsWith('.glb')) loadModel(f, f.name); });
controls.addEventListener('change', () => (dirty = true));

// ---------- bucle ----------
function frame(now) {
  requestAnimationFrame(frame);
  if (tween) tween(now);
  const moved = controls.update();
  if (moved || dirty || tween) {
    const d = camera.position.distanceTo(controls.target);
    camera.near = Math.max(0.02, d / 400); camera.far = Math.max(500, d * 30);
    camera.updateProjectionMatrix();
    pivot.position.copy(controls.target);
    pivot.scale.setScalar(d * 0.06);
    pivotGhost.scale.setScalar(camera.position.distanceTo(pivotGhost.position) * 0.06);
    renderer.render(scene, camera);
    updateBadges();
    dirty = false;
  }
}
buildTools(); setTool('nav'); refreshButtons(); renderList(); resize();
requestAnimationFrame(frame);
loadModel(MODEL_PATHS, 'modelo.glb');
window.__app = { camera, controls, scene, get anns() { return anns; }, setTool, surfaceHit };
