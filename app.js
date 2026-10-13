'use strict';
/* PhotoGeo — phase 1: map, spots, photo upload (GPS/EXIF), Google Drive backup.
   Plain JS, no build step. See PROJECT_NOTES.md for architecture. */

// ===================== CONFIG (fill in — see SETUP.md) =====================
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBMyeioAEamn2bdo9_G22cUK85QPUML3xw',
  authDomain: 'photogeo-fc2cd.firebaseapp.com',
  projectId: 'photogeo-fc2cd',
  storageBucket: 'photogeo-fc2cd.firebasestorage.app',
  messagingSenderId: '606040829040',
  appId: '1:606040829040:web:76d87301d1d7ec1a4818b5',
};
// OAuth Web client ID (Google Cloud console → Credentials → "Web client (auto created by Google Service)")
const OAUTH_CLIENT_ID = '606040829040-0cpvdg76k9m8hnh3ulouqc715ib3tlv2.apps.googleusercontent.com';
const ALLOWED_EMAIL = 'stgp.art@gmail.com';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'PhotoGeo Images';
const SAME_SPOT_METERS = 60;           // photos closer than this to a spot can join it
const THUMB_PX = 400;                  // thumbnail long edge, stored in Firestore
const DEFAULT_CENTER = [-121.8947, 36.6002]; // Monterey
const IS_CONFIGURED = !FIREBASE_CONFIG.apiKey.startsWith('REPLACE');

// ===================== Map style (free, no billing) =====================
const MAP_STYLE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    roads: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
    },
    labels: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    },
    streets: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: '© OpenStreetMap contributors',
    },
    terrain: {
      type: 'raster-dem', tileSize: 256, maxzoom: 15, encoding: 'terrarium',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Terrain: Mapzen/AWS',
    },
  },
  layers: [
    { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: 'none' } },
    { id: 'satellite', type: 'raster', source: 'satellite' },
    { id: 'roads', type: 'raster', source: 'roads', paint: { 'raster-opacity': 0.7 } },
    { id: 'labels', type: 'raster', source: 'labels' },
  ],
};

// ===================== Helpers =====================
const $ = (s, el = document) => el.querySelector(s);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function newId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso() { return new Date().toISOString(); }
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtCoord(lat, lng) { return `${lat.toFixed(5)}, ${lng.toFixed(5)}`; }
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function show(which) {
  $('#signin').classList.toggle('hidden', which !== 'signin');
  $('#app').classList.toggle('hidden', which !== 'app');
}

// Simple promise-based modal. buttons: [{label, value, cls}]
function dialog({ title, message = '', input = null, buttons }) {
  return new Promise(resolve => {
    const wrap = $('#dialog');
    wrap.innerHTML = `<div class="dialog-card">
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${input !== null ? `<input id="dlgInput" type="text" value="${esc(input)}" autocomplete="off">` : ''}
      <div class="dialog-btns">${buttons.map((b, i) => `<button data-i="${i}" class="btn ${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    wrap.classList.remove('hidden');
    const inp = $('#dlgInput', wrap);
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const finish = b => { wrap.classList.add('hidden'); wrap.onclick = null; resolve({ value: b.value, text: inp ? inp.value.trim() : null }); };
    wrap.onclick = e => { const btn = e.target.closest('button[data-i]'); if (btn) finish(buttons[+btn.dataset.i]); };
    if (inp) inp.onkeydown = e => { if (e.key === 'Enter') finish(buttons[buttons.length - 1]); };
  });
}

// ===================== IndexedDB (local queue + image cache) =====================
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('photogeo', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('pending', { keyPath: 'photoId' }); // photos waiting for Drive upload
        r.result.createObjectStore('images', { keyPath: 'driveId' });  // full-size cache
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  put(store, v) { return this.run(store, 'readwrite', s => s.put(v)); },
  get(store, k) { return this.run(store, 'readonly', s => s.get(k)); },
  del(store, k) { return this.run(store, 'readwrite', s => s.delete(k)); },
  all(store) { return this.run(store, 'readonly', s => s.getAll()); },
};

// ===================== State =====================
let auth = null, db = null, user = null, map = null;
const spots = new Map();   // id -> spot
const photos = new Map();  // id -> photo
const markers = new Map(); // spotId -> maplibre Marker
let unsubSpots = null, unsubPhotos = null, metaRef = null;
let currentSpotId = null;
let placing = null;        // null | {mode:'new'} | {mode:'move', spotId}
let is3D = false, baseLayer = 'satellite', didInitialFit = false, photosLoaded = false;

// ===================== Firebase / auth =====================
function initFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  auth.getRedirectResult().catch(e => toast('Sign-in failed: ' + (e.code || e.message), 6000));
  auth.onAuthStateChanged(onAuth);
}

async function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ login_hint: ALLOWED_EMAIL, prompt: 'select_account' });
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'];
    if (fallback.includes(e.code)) await auth.signInWithRedirect(provider);
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') toast('Sign-in failed: ' + (e.code || e.message), 6000);
  }
}

function onAuth(u) {
  if (!u) { user = null; stopListeners(); show('signin'); return; }
  if (ALLOWED_EMAIL && (u.email || '').toLowerCase() !== ALLOWED_EMAIL) {
    toast(`PhotoGeo is set up for ${ALLOWED_EMAIL}. Signing you out.`, 6000);
    auth.signOut();
    return;
  }
  user = u;
  $('#btnAccount').textContent = (u.displayName || u.email || '?').trim()[0].toUpperCase();
  show('app');
  initMap();
  startListeners();
  updateBanner();
  flushUploads();
}

function userCol(name) { return db.collection('users').doc(user.uid).collection(name); }

function startListeners() {
  stopListeners();
  metaRef = userCol('meta').doc('app');
  unsubSpots = userCol('spots').onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') spots.delete(ch.doc.id);
      else spots.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
    });
    renderAll();
    if (!didInitialFit) { didInitialFit = true; if (spots.size) fitToSpots(); else locateMe(false); }
  }, err => toast('Sync error (spots): ' + err.code, 6000));
  unsubPhotos = userCol('photos').onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') photos.delete(ch.doc.id);
      else photos.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
    });
    const first = !photosLoaded; photosLoaded = true;
    renderAll();
    if (first) flushUploads();
  }, err => toast('Sync error (photos): ' + err.code, 6000));
}
function stopListeners() {
  if (unsubSpots) unsubSpots(); if (unsubPhotos) unsubPhotos();
  unsubSpots = unsubPhotos = null;
}

// ===================== Map =====================
function initMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: 'map', style: MAP_STYLE, center: DEFAULT_CENTER, zoom: 10,
    maxPitch: 80, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('load', () => renderMarkers());
}

let userDot = null;
async function locateMe(announce = true) {
  try {
    const p = await getDevicePosition();
    map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14) });
    if (!userDot) {
      const el = document.createElement('div'); el.className = 'me-dot';
      userDot = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
    } else userDot.setLngLat([p.lng, p.lat]);
  } catch (e) {
    if (announce) toast("Couldn't get your location. Check location permission for this site.", 5000);
  }
}

function getDevicePosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Location not available'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

function toggle3D() {
  is3D = !is3D;
  if (is3D) { map.setTerrain({ source: 'terrain', exaggeration: 1.4 }); map.easeTo({ pitch: 65, duration: 800 }); }
  else { map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0, duration: 600 }); }
  $('#btn3d').classList.toggle('on', is3D);
}

function toggleLayer() {
  baseLayer = baseLayer === 'satellite' ? 'streets' : 'satellite';
  const sat = baseLayer === 'satellite';
  ['satellite', 'roads', 'labels'].forEach(id => map.setLayoutProperty(id, 'visibility', sat ? 'visible' : 'none'));
  map.setLayoutProperty('streets', 'visibility', sat ? 'none' : 'visible');
  $('#btnLayer').textContent = sat ? '🛰 Satellite' : '🗺 Streets';
}

function fitToSpots() {
  const arr = [...spots.values()];
  if (!arr.length) return;
  if (arr.length === 1) { map.jumpTo({ center: [arr[0].lng, arr[0].lat], zoom: 14 }); return; }
  const b = new maplibregl.LngLatBounds();
  arr.forEach(s => b.extend([s.lng, s.lat]));
  map.fitBounds(b, { padding: { top: 90, bottom: 140, left: 50, right: 70 }, maxZoom: 15, duration: 0 });
}

function spotPhotos(spotId) {
  return [...photos.values()].filter(p => p.spotId === spotId)
    .sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));
}

function renderMarkers() {
  if (!map) return;
  for (const [id, m] of markers) if (!spots.has(id)) { m.remove(); markers.delete(id); }
  for (const s of spots.values()) {
    const cover = spotPhotos(s.id)[0];
    const key = `${cover ? cover.id : '-'}|${s.lat}|${s.lng}|${s.name}`;
    let m = markers.get(s.id);
    if (m && m._pgKey === key) continue;
    if (m) m.remove();
    const el = document.createElement('button');
    el.className = 'marker' + (cover ? ' has-photo' : '');
    el.title = s.name;
    el.innerHTML = cover ? `<img src="${cover.thumb}" alt="">` : '<span>📍</span>';
    el.addEventListener('click', e => { e.stopPropagation(); openSpot(s.id); });
    m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([s.lng, s.lat]).addTo(map);
    m._pgKey = key;
    markers.set(s.id, m);
  }
}

function renderAll() {
  renderMarkers();
  if (currentSpotId) renderSpotSheet();
  if (!$('#listSheet').classList.contains('hidden')) renderList();
  const v = $('#viewer');
  if (!v.classList.contains('hidden') && v.dataset.pid) {
    const p = photos.get(v.dataset.pid);
    if (!p) closeViewer(); else $('#viewerMeta').innerHTML = photoMetaHtml(p);
  }
}

// ===================== Spot sheet =====================
function openSpot(id, fly = true) {
  currentSpotId = id;
  closeList();
  renderSpotSheet();
  $('#sheet').classList.remove('hidden');
  const s = spots.get(id);
  if (s && fly) map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15), offset: [0, -140], duration: 700 });
}
function closeSpot() { currentSpotId = null; $('#sheet').classList.add('hidden'); }

function renderSpotSheet() {
  const s = spots.get(currentSpotId);
  if (!s) { closeSpot(); return; }
  $('#spotName').textContent = s.name;
  $('#spotCoords').textContent = fmtCoord(s.lat, s.lng);
  $('#spotDirections').href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const notes = $('#spotNotes');
  if (document.activeElement !== notes && notes.dataset.spot !== s.id + '|' + (s.updatedAt || '')) {
    notes.value = s.notes || '';
    notes.dataset.spot = s.id + '|' + (s.updatedAt || '');
  }
  const list = spotPhotos(s.id);
  $('#spotCount').textContent = list.length ? `${list.length} photo${list.length === 1 ? '' : 's'}` : 'No photos yet';
  $('#spotGrid').innerHTML = list.map(p => `
    <button class="thumb" data-pid="${p.id}">
      <img src="${p.thumb}" alt="" loading="lazy">
      <span class="thumb-date">${esc(new Date(p.takenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }))}</span>
      ${p.driveStatus !== 'done' ? '<span class="thumb-flag" title="Waiting to save to Google Drive">⏳</span>' : ''}
    </button>`).join('');
}

let notesTimer = null;
function onNotesInput() {
  const id = currentSpotId, val = $('#spotNotes').value;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    const updatedAt = nowIso();
    $('#spotNotes').dataset.spot = id + '|' + updatedAt;
    userCol('spots').doc(id).update({ notes: val, updatedAt }).catch(e => toast('Notes not saved: ' + e.code, 5000));
  }, 700);
}

async function spotMenu() {
  const s = spots.get(currentSpotId); if (!s) return;
  const r = await dialog({
    title: s.name, buttons: [
      { label: 'Rename', value: 'rename' },
      { label: 'Move pin', value: 'move' },
      { label: 'Delete spot', value: 'delete', cls: 'danger' },
      { label: 'Close', value: null },
    ]
  });
  if (r.value === 'rename') {
    const n = await dialog({ title: 'Rename spot', input: s.name, buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, cls: 'primary' }] });
    if (n.value && n.text) userCol('spots').doc(s.id).update({ name: n.text, updatedAt: nowIso() });
  } else if (r.value === 'move') {
    startPlacing({ mode: 'move', spotId: s.id });
  } else if (r.value === 'delete') {
    const list = spotPhotos(s.id);
    const c = await dialog({
      title: `Delete "${s.name}"?`,
      message: list.length ? `This removes the spot and its ${list.length} photo${list.length === 1 ? '' : 's'} from PhotoGeo. The image files stay in your Google Drive folder.` : 'This removes the spot from PhotoGeo.',
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }]
    });
    if (!c.value) return;
    const batch = db.batch();
    list.forEach(p => { batch.delete(userCol('photos').doc(p.id)); idb.del('pending', p.id).catch(() => {}); });
    batch.delete(userCol('spots').doc(s.id));
    batch.commit().catch(e => toast('Delete failed: ' + e.code, 5000));
    closeSpot();
    updateBanner();
  }
}

// ===================== Placing / moving a pin by hand =====================
function startPlacing(p) {
  placing = p;
  closeSpot(); closeList();
  if (p.mode === 'move') {
    const s = spots.get(p.spotId);
    map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 16) });
    $('#placeText').textContent = `Drag the map to move "${s.name}"`;
  } else $('#placeText').textContent = 'Drag the map to put the pin on the spot';
  document.body.classList.add('placing');
}
function stopPlacing() { placing = null; document.body.classList.remove('placing'); }
async function confirmPlacing() {
  const c = map.getCenter(), p = placing;
  stopPlacing();
  if (!p) return;
  if (p.mode === 'move') {
    await userCol('spots').doc(p.spotId).update({ lat: c.lat, lng: c.lng, updatedAt: nowIso() }).catch(e => toast('Move failed: ' + e.code, 5000));
    openSpot(p.spotId, false);
  } else {
    const id = await createSpot(c.lat, c.lng);
    if (id) openSpot(id, false);
  }
}

// ===================== Spots =====================
function nearestSpot(lat, lng) {
  let best = null;
  for (const s of spots.values()) {
    const d = distM(s, { lat, lng });
    if (!best || d < best.d) best = { spot: s, d };
  }
  return best;
}

async function suggestName(lat, lng) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`,
      { headers: { 'Accept-Language': 'en' }, signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json(); const a = j.address || {};
    return j.name || a.leisure || a.tourism || a.natural || a.road || a.neighbourhood || a.suburb || a.city || a.town || 'New spot';
  } catch { return 'New spot'; }
}

async function createSpot(lat, lng) {
  const guess = await suggestName(lat, lng);
  const r = await dialog({
    title: 'Name this spot', message: fmtCoord(lat, lng), input: guess,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save spot', value: true, cls: 'primary' }]
  });
  if (!r.value) return null;
  const id = newId('spot');
  const data = { name: r.text || guess, lat, lng, notes: '', createdAt: nowIso(), updatedAt: nowIso() };
  spots.set(id, { id, ...data });
  userCol('spots').doc(id).set(data).catch(e => toast('Spot not saved: ' + e.code, 6000));
  renderMarkers();
  return id;
}

// ===================== Adding photos =====================
let addTargetSpot = null;
function pickPhotos(targetSpotId) {
  addTargetSpot = targetSpotId || null;
  const inp = $('#fileInput'); inp.value = ''; inp.click();
}

async function readPhotoMeta(file) {
  const out = { lat: null, lng: null, takenAt: null, camera: null };
  try {
    const ex = await exifr.parse(file, { tiff: true, exif: true, gps: true });
    if (ex) {
      if (typeof ex.latitude === 'number' && typeof ex.longitude === 'number' && !(ex.latitude === 0 && ex.longitude === 0)) {
        out.lat = ex.latitude; out.lng = ex.longitude;
      }
      const dt = ex.DateTimeOriginal || ex.CreateDate;
      if (dt instanceof Date && !isNaN(dt)) out.takenAt = dt.toISOString();
      const iso = Array.isArray(ex.ISO) ? ex.ISO[0] : (ex.ISO ?? ex.ISOSpeedRatings ?? null);
      if (ex.FNumber || ex.ExposureTime || iso) {
        out.camera = {
          make: ex.Make || '', model: ex.Model || '', lens: ex.LensModel || '',
          fNumber: ex.FNumber ?? null, exposureTime: ex.ExposureTime ?? null, iso: iso ?? null,
          focalLength: ex.FocalLength ?? null, focalLength35: ex.FocalLengthIn35mmFormat ?? null,
          exposureComp: ex.ExposureCompensation ?? null,
        };
      }
    }
  } catch (e) { /* no EXIF — fine */ }
  return out;
}

async function makeThumb(blob, max) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i);
      i.onerror = () => rej(new Error("this browser can't read that image format"));
      i.src = url;
    });
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } finally { URL.revokeObjectURL(url); }
}

async function handleFiles(fileList) {
  const files = [...fileList]; const target = addTargetSpot; addTargetSpot = null;
  if (!files.length) return;
  const batchSpots = []; let lastSpot = null;
  for (let i = 0; i < files.length; i++) {
    toast(files.length > 1 ? `Adding photo ${i + 1} of ${files.length}…` : 'Adding photo…', 8000);
    try { lastSpot = await addOnePhoto(files[i], target, batchSpots) || lastSpot; }
    catch (e) { console.error(e); toast(`Couldn't add ${files[i].name}: ${e.message || e}`, 6000); }
  }
  if (lastSpot) { toast('Saved ✓', 1500); openSpot(lastSpot); }
  updateBanner();
  flushUploads();
}

async function addOnePhoto(file, targetSpotId, batchSpots) {
  const meta = await readPhotoMeta(file);
  let lat = meta.lat, lng = meta.lng, locSource = 'photo';
  if (lat == null) {
    if (targetSpotId && spots.get(targetSpotId)) {
      const s = spots.get(targetSpotId); lat = s.lat; lng = s.lng; locSource = 'spot';
    } else {
      try { const p = await getDevicePosition(); lat = p.lat; lng = p.lng; locSource = 'device'; }
      catch {
        const c = map.getCenter(); lat = c.lat; lng = c.lng; locSource = 'map';
        toast("Couldn't get your location, so the pin is at the map center. Use ⋯ → Move pin to fix it.", 6000);
      }
    }
  }
  const takenAt = meta.takenAt || nowIso();
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
  const thumb = await makeThumb(blob, THUMB_PX);

  let spotId = targetSpotId && spots.has(targetSpotId) ? targetSpotId : null;
  if (!spotId) {
    const sameBatch = batchSpots.find(id => spots.get(id) && distM(spots.get(id), { lat, lng }) <= SAME_SPOT_METERS);
    if (sameBatch) spotId = sameBatch;
    else {
      const near = nearestSpot(lat, lng);
      if (near && near.d <= SAME_SPOT_METERS) {
        const r = await dialog({
          title: 'Add to an existing spot?',
          message: `This photo is ${Math.round(near.d)} m from "${near.spot.name}".`,
          buttons: [{ label: 'New spot', value: 'new' }, { label: `Add to ${near.spot.name}`, value: 'add', cls: 'primary' }]
        });
        if (r.value === 'add') spotId = near.spot.id;
      }
      if (!spotId) {
        spotId = await createSpot(lat, lng);
        if (!spotId) return null; // cancelled
      }
    }
    if (!batchSpots.includes(spotId)) batchSpots.push(spotId);
  }

  const photoId = newId('ph');
  const doc = {
    spotId, thumb, takenAt, lat, lng, locSource,
    camera: meta.camera,
    fileName: file.name || 'photo.jpg', mimeType: blob.type, size: blob.size,
    driveId: null, driveStatus: 'pending',
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  // Keep the original on this device until it's safely in Drive.
  await idb.put('pending', { photoId, blob, name: doc.fileName, type: doc.mimeType });
  photos.set(photoId, { id: photoId, ...doc });
  userCol('photos').doc(photoId).set(doc).catch(e => toast('Photo record not saved: ' + e.code, 6000));
  return spotId;
}

// ===================== Google Drive =====================
let driveToken = null, tokenClient = null, tokenWaiter = null;

function hasDriveToken() {
  if (!driveToken) {
    try {
      const t = JSON.parse(localStorage.getItem('pg_drive_token') || 'null');
      if (t && user && t.email === user.email) driveToken = t;
    } catch {}
  }
  return !!(driveToken && driveToken.exp > Date.now() + 60000);
}
function clearDriveToken() { driveToken = null; try { localStorage.removeItem('pg_drive_token'); } catch {} }

// Must be called directly from a tap (opens a Google popup that closes itself once access was granted before).
function requestDriveToken() {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google library still loading, try again'));
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: OAUTH_CLIENT_ID, scope: DRIVE_SCOPE,
        callback: resp => {
          const w = tokenWaiter; tokenWaiter = null;
          if (resp.error) return w && w.reject(new Error(resp.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) return w && w.reject(new Error('Drive access was not allowed'));
          driveToken = { token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000, email: user.email };
          try { localStorage.setItem('pg_drive_token', JSON.stringify(driveToken)); } catch {}
          w && w.resolve(driveToken.token);
        },
        error_callback: err => { const w = tokenWaiter; tokenWaiter = null; w && w.reject(new Error(err.type || 'popup failed')); },
      });
    }
    tokenWaiter = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '', login_hint: user.email });
  });
}

async function driveFetch(url, opts = {}) {
  if (!hasDriveToken()) { const e = new Error('Google Drive not connected'); e.status = 401; throw e; }
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + driveToken.token } });
  if (r.status === 401) { clearDriveToken(); const e = new Error('Google Drive connection expired'); e.status = 401; throw e; }
  if (!r.ok) { const e = new Error(`Drive error ${r.status}`); e.status = r.status; throw e; }
  return r;
}

let folderId = null;
async function ensureFolder(force = false) {
  if (folderId && !force) return folderId;
  if (!force) {
    const m = await metaRef.get().catch(() => null);
    const cached = m && m.exists && m.data().driveFolderId;
    if (cached) return (folderId = cached);
  }
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const j = await (await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`)).json();
  let id = j.files && j.files[0] && j.files[0].id;
  if (!id) {
    const c = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = (await c.json()).id;
  }
  folderId = id;
  metaRef.set({ driveFolderId: id }, { merge: true }).catch(() => {});
  return id;
}

async function uploadToDrive(item, p) {
  const send = async parent => {
    const ext = ((item.type.split('/')[1]) || 'jpg').replace('jpeg', 'jpg');
    const spot = spots.get(p.spotId);
    const safe = (spot ? spot.name : 'Spot').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
    const meta = { name: `${safe} ${p.takenAt.slice(0, 10)} ${item.photoId}.${ext}`, parents: [parent], mimeType: item.type, description: `PhotoGeo ${fmtCoord(p.lat, p.lng)}` };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', item.blob);
    const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
    return (await r.json()).id;
  };
  try { return await send(await ensureFolder()); }
  catch (e) { if (e.status === 404) return send(await ensureFolder(true)); throw e; } // folder was deleted
}

let flushing = false;
async function flushUploads() {
  if (flushing || !user || !photosLoaded || !hasDriveToken()) return;
  const pending = await idb.all('pending').catch(() => []);
  if (!pending.length) return;
  flushing = true; let done = 0;
  try {
    for (const item of pending) {
      const p = photos.get(item.photoId);
      if (!p) { await idb.del('pending', item.photoId); continue; } // photo record was deleted
      const driveId = await uploadToDrive(item, p);
      await idb.put('images', { driveId, blob: item.blob });
      await idb.del('pending', item.photoId);
      userCol('photos').doc(item.photoId).update({ driveId, driveStatus: 'done', updatedAt: nowIso() }).catch(() => {});
      done++;
      updateBanner(pending.length - done);
    }
    if (done) toast(`Saved ${done} photo${done === 1 ? '' : 's'} to Google Drive ✓`);
  } catch (e) {
    if (e.status !== 401) toast('Drive upload paused: ' + (e.message || e), 6000);
  } finally {
    flushing = false;
    updateBanner();
  }
}

async function updateBanner(count) {
  if (count === undefined) count = (await idb.all('pending').catch(() => [])).length;
  const b = $('#banner');
  if (!count) { b.classList.add('hidden'); return; }
  $('#bannerText').textContent = `${count} photo${count === 1 ? '' : 's'} waiting to save to Google Drive`;
  $('#bannerBtn').textContent = hasDriveToken() ? (flushing ? 'Saving…' : 'Save now') : 'Connect Drive';
  b.classList.remove('hidden');
}

function onBannerTap() {
  if (hasDriveToken()) { flushUploads(); return; }
  requestDriveToken().then(() => flushUploads()).catch(e => toast('Google Drive connect failed: ' + e.message, 6000));
}

async function getFullImage(p) {
  const pend = await idb.get('pending', p.id).catch(() => null);
  if (pend) return pend.blob;
  if (!p.driveId) return null;
  const cached = await idb.get('images', p.driveId).catch(() => null);
  if (cached) return cached.blob;
  if (!hasDriveToken()) return null;
  const blob = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${p.driveId}?alt=media`)).blob();
  idb.put('images', { driveId: p.driveId, blob }).catch(() => {});
  return blob;
}

// ===================== Photo viewer =====================
function fmtShutter(t) {
  if (!t) return null;
  return t >= 1 ? `${+t.toFixed(1)}s` : `1/${Math.round(1 / t)}s`;
}
function photoMetaHtml(p) {
  const s = spots.get(p.spotId);
  const src = { photo: 'GPS from the photo', device: "Phone's location when added", spot: 'Added to this spot', map: 'Placed by hand' }[p.locSource] || '';
  let cam = '';
  if (p.camera) {
    const c = p.camera;
    const body = [c.make && !String(c.model).startsWith(c.make) ? c.make : '', c.model].filter(Boolean).join(' ');
    const bits = [
      c.fNumber ? `f/${+Number(c.fNumber).toFixed(1)}` : null,
      fmtShutter(c.exposureTime),
      c.iso ? `ISO ${c.iso}` : null,
      c.focalLength ? `${Math.round(c.focalLength)}mm${c.focalLength35 && c.focalLength35 !== Math.round(c.focalLength) ? ` (${c.focalLength35}mm eq.)` : ''}` : null,
      c.exposureComp ? `${c.exposureComp > 0 ? '+' : ''}${+Number(c.exposureComp).toFixed(1)} EV` : null,
    ].filter(Boolean);
    cam = `<div class="meta-row"><span>📷</span><div><b>${esc(body || 'Camera')}</b>${c.lens ? `<br><small>${esc(c.lens)}</small>` : ''}<div class="settings">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div></div></div>`;
  } else {
    cam = `<div class="meta-row muted"><span>📷</span><div>No camera settings in this file</div></div>`;
  }
  return `
    <div class="meta-row"><span>📍</span><div><b>${esc(s ? s.name : '')}</b><br><small>${fmtCoord(p.lat, p.lng)} · ${esc(src)}</small></div></div>
    <div class="meta-row"><span>🕒</span><div>${esc(fmtDate(p.takenAt))}</div></div>
    ${cam}
    <div class="meta-row ${p.driveStatus === 'done' ? '' : 'muted'}"><span>${p.driveStatus === 'done' ? '☁️' : '⏳'}</span><div>${p.driveStatus === 'done' ? 'Saved to Google Drive' : 'Waiting to save to Google Drive (kept on this device)'}</div></div>`;
}

let viewerUrl = null;
async function openPhoto(pid) {
  const p = photos.get(pid); if (!p) return;
  const v = $('#viewer'), img = $('#viewerImg');
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  img.src = p.thumb;
  $('#viewerMeta').innerHTML = photoMetaHtml(p);
  $('#viewerLoad').classList.add('hidden');
  v.dataset.pid = pid;
  v.classList.remove('hidden');
  try {
    const blob = await getFullImage(p);
    if (v.dataset.pid !== pid) return;
    if (blob) { viewerUrl = URL.createObjectURL(blob); img.src = viewerUrl; }
    else if (p.driveId) $('#viewerLoad').classList.remove('hidden');
  } catch (e) {
    if (e.status === 401) $('#viewerLoad').classList.remove('hidden');
    else toast('Full-size image unavailable: ' + (e.message || e), 5000);
  }
}
function closeViewer() {
  const v = $('#viewer'); v.classList.add('hidden'); delete v.dataset.pid;
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
}
async function deleteCurrentPhoto() {
  const pid = $('#viewer').dataset.pid; const p = photos.get(pid); if (!p) return;
  const c = await dialog({
    title: 'Delete this photo?', message: 'It will be removed from PhotoGeo. If it was saved to Google Drive, the file stays in your PhotoGeo Images folder.',
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }]
  });
  if (!c.value) return;
  closeViewer();
  idb.del('pending', pid).catch(() => {});
  photos.delete(pid);
  userCol('photos').doc(pid).delete().catch(e => toast('Delete failed: ' + e.code, 5000));
  renderAll(); updateBanner();
}

// ===================== Spot list =====================
function openList() { closeSpot(); renderList(); $('#listSheet').classList.remove('hidden'); }
function closeList() { $('#listSheet').classList.add('hidden'); }
function renderList() {
  const q = $('#listSearch').value.trim().toLowerCase();
  const arr = [...spots.values()]
    .filter(s => !q || s.name.toLowerCase().includes(q) || (s.notes || '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#listItems').innerHTML = arr.map(s => {
    const ph = spotPhotos(s.id);
    return `<button class="list-row" data-id="${s.id}">
      ${ph[0] ? `<img src="${ph[0].thumb}" alt="">` : '<span class="ph-empty">📍</span>'}
      <span class="lr-text"><b>${esc(s.name)}</b><small>${ph.length} photo${ph.length === 1 ? '' : 's'}${s.notes ? ' · ' + esc(s.notes.slice(0, 60)) : ''}</small></span>
    </button>`;
  }).join('') || `<p class="empty">${spots.size ? 'No matches.' : 'No spots yet. Tap “Add photo” when you’re at a location.'}</p>`;
}

// ===================== Account menu =====================
async function accountMenu() {
  const r = await dialog({
    title: user.email, message: hasDriveToken() ? 'Google Drive: connected' : 'Google Drive: not connected right now',
    buttons: [
      { label: hasDriveToken() ? 'Disconnect Drive' : 'Connect Drive', value: 'drive' },
      { label: 'Sign out', value: 'out', cls: 'danger' },
      { label: 'Close', value: null },
    ]
  });
  if (r.value === 'out') { clearDriveToken(); auth.signOut(); }
  if (r.value === 'drive') {
    if (hasDriveToken()) { clearDriveToken(); updateBanner(); toast('Drive disconnected on this device'); }
    else onBannerTap();
  }
}

// ===================== Wire up =====================
function bindUI() {
  $('#btnSignIn').onclick = () => { if (IS_CONFIGURED) signIn(); };
  $('#btnAddPhoto').onclick = () => pickPhotos(null);
  $('#spotAddPhoto').onclick = () => pickPhotos(currentSpotId);
  $('#fileInput').onchange = e => handleFiles(e.target.files);
  $('#btnAddSpot').onclick = () => startPlacing({ mode: 'new' });
  $('#placeCancel').onclick = () => { const p = placing; stopPlacing(); if (p && p.mode === 'move') openSpot(p.spotId, false); };
  $('#placeConfirm').onclick = confirmPlacing;
  $('#btnList').onclick = () => $('#listSheet').classList.contains('hidden') ? openList() : closeList();
  $('#listClose').onclick = closeList;
  $('#listSearch').oninput = renderList;
  $('#listItems').onclick = e => { const b = e.target.closest('.list-row'); if (b) openSpot(b.dataset.id); };
  $('#btn3d').onclick = toggle3D;
  $('#btnLocate').onclick = () => locateMe(true);
  $('#btnLayer').onclick = toggleLayer;
  $('#btnAccount').onclick = accountMenu;
  $('#sheetClose').onclick = closeSpot;
  $('#spotMore').onclick = spotMenu;
  $('#spotNotes').oninput = onNotesInput;
  $('#spotCoords').onclick = () => {
    const s = spots.get(currentSpotId); if (!s) return;
    navigator.clipboard && navigator.clipboard.writeText(fmtCoord(s.lat, s.lng)).then(() => toast('Coordinates copied'));
  };
  $('#spotGrid').onclick = e => { const t = e.target.closest('.thumb'); if (t) openPhoto(t.dataset.pid); };
  $('#viewerClose').onclick = closeViewer;
  $('#viewerDelete').onclick = deleteCurrentPhoto;
  $('#viewerLoad').onclick = () => {
    const pid = $('#viewer').dataset.pid;
    requestDriveToken().then(() => { openPhoto(pid); flushUploads(); }).catch(e => toast('Google Drive connect failed: ' + e.message, 6000));
  };
  $('#bannerBtn').onclick = onBannerTap;
  window.addEventListener('online', () => flushUploads());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateBanner(); flushUploads(); } });
}

function boot() {
  bindUI();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!IS_CONFIGURED) {
    show('signin');
    $('#setupNote').classList.remove('hidden');
    $('#btnSignIn').disabled = true;
    return;
  }
  initFirebase();
}

boot();
