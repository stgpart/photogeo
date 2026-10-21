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
const THUMB_PX = 720;                  // grid/preview long edge, stored in Firestore (full-size original lives in Drive)
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
let listFilter = 'all';     // 'all' | a CATEGORIES key. Resets each launch so pins never stay hidden by surprise.
try { localStorage.removeItem('pg_filter'); } catch {}
// Utility categories (one per spot). Add more here later.
const CATEGORIES = {
  parking:  { label: 'Parking',  plural: 'Parking',   badge: 'P',  color: '#1e6fff' },
  bathroom: { label: 'Bathroom', plural: 'Bathrooms', badge: 'WC', color: '#00a88f' },
};
const catOf = s => (s && CATEGORIES[s.category]) ? s.category : null;
const catBadge = (c, cls = 'p-badge') => { const i = c === 'permit' ? { badge: '!', color: '#e5484d' } : CATEGORIES[c]; return `<span class="${cls}" style="background:${i.color}">${i.badge}</span>`; };
let areaFilter = null;     // null | { key, name, kind, feature } — show only spots inside this city/community
const PERMIT_FLAG = { label: 'Permit needed', plural: 'Permit needed', badge: '!', color: '#e5484d' };
const filterInfo = f => f === 'permit' ? PERMIT_FLAG : CATEGORIES[f];
const matchesFilter = s => listFilter === 'all' || (listFilter === 'permit' ? !!(s && s.permit) : catOf(s) === listFilter);
const hiddenByFilter = s => !matchesFilter(s) || (areaFilter && !inArea(s));

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
    setTimeout(sweepAreas, 1500);
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
  const ready = () => { if (overlaysReady) return; renderMarkers(); try { setupOverlays(); } catch (e) { console.warn('overlays', e); } };
  map.on('load', ready);
  map.on('idle', ready); // backup: some browsers/tile errors can delay 'load'
  map.on('styledata', ready); // earliest point the style is usable
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ready(); });
  map.on('moveend', scheduleOverlayRefresh);
  map.on('dragstart', () => { if (followMe) { followMe = false; $('#btnLocate').classList.remove('on'); } });
  startLocationWatch();
  map.on('click', onMapClick);
}

// ===================== Live location =====================
// Phones hand back a rough Wi-Fi/cell guess first and only tighten up to real GPS after a few seconds,
// so we keep a live watch running and always use the freshest, most accurate reading.
let userDot = null, accSourceAdded = false, geoWatch = null, lastFix = null, followMe = false;
const GOOD_ACC = 15;      // metres: good enough to pin a photo/spot immediately
const OK_ACC = 40;        // metres: acceptable after waiting
function startLocationWatch() {
  if (geoWatch !== null || !navigator.geolocation) return;
  geoWatch = navigator.geolocation.watchPosition(onFix, err => {
    if (err.code === 1) { stopLocationWatch(); toast('Location is blocked for PhotoGeo. Allow it in your browser settings to pin spots where you stand.', 6000); }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function stopLocationWatch() { if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
function onFix(pos) {
  const f = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 9999, t: pos.timestamp || Date.now() };
  lastFix = f;
  drawMe(f);
  fixWaiters.forEach(w => w(f));
  if (followMe) map.easeTo({ center: [f.lng, f.lat], duration: 500 });
}
function accCircle(f, steps = 48) {
  const R = 6378137, pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (f.acc * Math.cos(a)) / R, dLng = (f.acc * Math.sin(a)) / (R * Math.cos(f.lat * Math.PI / 180));
    pts.push([f.lng + dLng * 180 / Math.PI, f.lat + dLat * 180 / Math.PI]);
  }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }] };
}
function drawMe(f) {
  if (!map) return;
  if (!userDot) {
    const el = document.createElement('div'); el.className = 'me-dot';
    userDot = new maplibregl.Marker({ element: el }).setLngLat([f.lng, f.lat]).addTo(map);
  } else userDot.setLngLat([f.lng, f.lat]);
  userDot.getElement().classList.toggle('rough', f.acc > OK_ACC);
  try {
    if (!accSourceAdded && map.style && map.style._loaded) {
      map.addSource('me-acc', { type: 'geojson', data: accCircle(f) });
      map.addLayer({ id: 'me-acc', type: 'fill', source: 'me-acc', paint: { 'fill-color': '#4a90ff', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'me-acc-line', type: 'line', source: 'me-acc', paint: { 'line-color': '#4a90ff', 'line-width': 1, 'line-opacity': 0.6 } });
      accSourceAdded = true;
    } else if (accSourceAdded) map.getSource('me-acc').setData(accCircle(f));
  } catch (e) { /* style not ready yet; next fix will add it */ }
  $('#btnLocate small').textContent = f.acc <= 999 ? `±${Math.round(f.acc)} m` : 'Me';
}
const fixWaiters = new Set();
// Best position for pinning: waits (up to ~10s) for GPS to settle instead of taking the first rough guess.
function getDevicePosition({ maxWait = 10000, onProgress } = {}) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Location not available'));
    startLocationWatch();
    let best = (lastFix && Date.now() - lastFix.t < 5000) ? lastFix : null;
    if (best && best.acc <= GOOD_ACC) return res(best);
    const done = (f) => { clearTimeout(timer); fixWaiters.delete(w); f ? res(f) : rej(new Error('No location fix')); };
    const w = f => {
      if (!best || f.acc < best.acc) best = f;
      onProgress && onProgress(best);
      if (best.acc <= GOOD_ACC) done(best);
    };
    fixWaiters.add(w);
    const timer = setTimeout(() => done(best), maxWait);
    // also nudge a one-off high-accuracy read (some browsers only start GPS this way)
    navigator.geolocation.getCurrentPosition(pos => w({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 9999, t: pos.timestamp || Date.now() }),
      err => { if (err.code === 1) { clearTimeout(timer); fixWaiters.delete(w); rej(err); } }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxWait });
  });
}
async function locateMe(announce = true) {
  startLocationWatch();
  if (announce) {
    followMe = !followMe || !lastFix;
    $('#btnLocate').classList.toggle('on', followMe);
    if (followMe) toast('Following your location. Drag the map to stop.', 2500);
  }
  try {
    const p = (lastFix && Date.now() - lastFix.t < 5000) ? lastFix : await getDevicePosition({ maxWait: 6000 });
    map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16) });
  } catch (e) {
    if (announce) toast("Couldn't get your location. Check location permission for this site.", 5000);
  }
}
async function preciseFixWithToast(purpose) {
  toast(`Getting a precise location for ${purpose}…`, 12000);
  const f = await getDevicePosition({ onProgress: b => toast(`Getting a precise location… ±${Math.round(b.acc)} m`, 12000) });
  toast(`Location ±${Math.round(f.acc)} m`, 2000);
  return f;
}

function toggle3D() {
  is3D = !is3D;
  if (is3D) { map.setTerrain({ source: 'terrain', exaggeration: 1.4 }); map.easeTo({ pitch: 65, duration: 800 }); }
  else { map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0, duration: 600 }); }
  $('#btn3d').classList.toggle('on', is3D);
}

function setBaseLayer(name) {
  baseLayer = name;
  const sat = baseLayer === 'satellite';
  ['satellite', 'roads', 'labels'].forEach(id => map.setLayoutProperty(id, 'visibility', sat ? 'visible' : 'none'));
  map.setLayoutProperty('streets', 'visibility', sat ? 'none' : 'visible');
  try { localStorage.setItem('pg_base', baseLayer); } catch {}
  renderLayersPanel();
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
    const cat = catOf(s);
    const key = `${cover ? cover.id : '-'}|${s.lat}|${s.lng}|${s.name}|${cat}|${!!s.permit}`;
    let m = markers.get(s.id);
    if (m && m._pgKey === key) { m.getElement().classList.toggle('filtered-out', hiddenByFilter(s)); continue; }
    if (m) m.remove();
    const el = document.createElement('button');
    el.className = 'marker' + (cat ? ' cat' : cover ? ' has-photo' : '');
    if (hiddenByFilter(s)) el.classList.add('filtered-out');
    el.title = s.name;
    el.innerHTML = (s.permit ? '<i class="permit-dot" title="Permit needed">!</i>' : '') + (cat ? catBadge(cat) : cover ? `<img src="${cover.thumb}" alt="">` : '<span>📍</span>');
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
    if (!p) closeViewer(); else { $('#viewerMeta').innerHTML = photoMetaHtml(p);
      const cap = $('#viewerCaption'); if (document.activeElement !== cap && cap.dataset.pid === p.id && !captionTimer) { cap.value = p.caption || ''; autoGrow(cap); } if (p.driveId) ensureFull(viewerIndex); }
  }
}

// ===================== Spot sheet =====================
function openSpot(id, fly = true) {
  currentSpotId = id;
  closeList(); closeLayers();
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
  const sc = catOf(s);
  $('#spotTags').innerHTML = (sc ? `<span class="tag" style="background:${CATEGORIES[sc].color}">${CATEGORIES[sc].badge} ${CATEGORIES[sc].label}</span>` : '') +
    (s.permit ? `<span class="tag" style="background:${PERMIT_FLAG.color}">! Permit needed</span>` : '');
  $('#spotArea').innerHTML = areaHtml(s);
  if (!areaIsCurrent(s)) ensureArea(s);
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
      ${p.caption ? `<span class="thumb-cap">${esc(p.caption)}</span>` : ''}
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
      ...Object.entries(CATEGORIES).map(([k, c]) => ({ label: s.category === k ? `Unmark as ${c.label.toLowerCase()}` : `Mark as ${c.label.toLowerCase()}`, value: 'cat:' + k })),
      { label: s.permit ? 'Unmark permit needed' : 'Mark permit needed', value: 'permit' },
      { label: 'Move pin', value: 'move' },
      { label: 'Delete spot', value: 'delete', cls: 'danger' },
      { label: 'Close', value: null },
    ]
  });
  if (r.value === 'rename') {
    const n = await dialog({ title: 'Rename spot', input: s.name, buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, cls: 'primary' }] });
    if (n.value && n.text) userCol('spots').doc(s.id).update({ name: n.text, updatedAt: nowIso() });
  } else if (r.value === 'permit') {
    const on = !s.permit;
    userCol('spots').doc(s.id).update({ permit: on, updatedAt: nowIso() }).catch(e => toast('Not saved: ' + e.code, 5000));
    toast(on ? 'Marked: permit needed. Add the details in Notes.' : 'Permit flag removed');
  } else if (typeof r.value === 'string' && r.value.startsWith('cat:')) {
    const k = r.value.slice(4), on = s.category !== k, lbl = CATEGORIES[k].label.toLowerCase();
    userCol('spots').doc(s.id).update({ category: on ? k : null, updatedAt: nowIso() })
      .catch(e => toast('Not saved: ' + e.code, 5000));
    toast(on ? `Marked as ${lbl}` : `No longer marked as ${lbl}`);
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
  } else {
    $('#placeText').textContent = 'Drag the map to put the pin on the spot';
    if (lastFix && Date.now() - lastFix.t < 15000) map.easeTo({ center: [lastFix.lng, lastFix.lat], zoom: Math.max(map.getZoom(), 18) });
  }
  document.body.classList.add('placing');
}
function stopPlacing() { placing = null; document.body.classList.remove('placing'); }
async function confirmPlacing() {
  const c = map.getCenter(), p = placing;
  stopPlacing();
  if (!p) return;
  if (p.mode === 'move') {
    await userCol('spots').doc(p.spotId).update({ lat: c.lat, lng: c.lng, area: null, updatedAt: nowIso() }).catch(e => toast('Move failed: ' + e.code, 5000));
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

async function createSpot(lat, lng, nameHint = null) {
  const guess = nameHint || await suggestName(lat, lng);
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
    return c.toDataURL('image/jpeg', 0.82);
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
  let lat = meta.lat, lng = meta.lng, locSource = 'photo', locAcc = null;
  if (lat == null) {
    if (targetSpotId && spots.get(targetSpotId)) {
      const s = spots.get(targetSpotId); lat = s.lat; lng = s.lng; locSource = 'spot';
    } else {
      try {
        const p = await preciseFixWithToast('this photo');
        lat = p.lat; lng = p.lng; locSource = 'device'; locAcc = Math.round(p.acc);
        if (p.acc > OK_ACC) toast(`Location is only accurate to about ${Math.round(p.acc)} m here. Check the pin and use ⋯ → Move pin if needed.`, 7000);
      }
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
    spotId, thumb, takenAt, lat, lng, locSource, locAcc,
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
  const srcAcc = p.locSource === 'device' && p.locAcc ? ` (±${p.locAcc} m)` : '';
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
    <div class="meta-row"><span>📍</span><div><b>${esc(s ? s.name : '')}</b><br><small>${fmtCoord(p.lat, p.lng)} · ${esc(src)}${srcAcc}</small></div></div>
    <div class="meta-row"><span>🕒</span><div>${esc(fmtDate(p.takenAt))}</div></div>
    ${cam}
    <div class="meta-row ${p.driveStatus === 'done' ? '' : 'muted'}"><span>${p.driveStatus === 'done' ? '☁️' : '⏳'}</span><div>${p.driveStatus === 'done' ? 'Saved to Google Drive' : 'Waiting to save to Google Drive (kept on this device)'}</div></div>`;
}

// Carousel viewer: swipe/arrow through every photo of the spot, full-size originals.
let viewerList = [], viewerIndex = 0, viewerScrollTimer = null;
const fullUrls = new Map();     // pid -> object URL of the original
const fullState = new Map();    // pid -> 'loading' | 'full' | 'needs-drive' | 'not-uploaded' | 'unsupported' | 'error'
function openPhoto(pid) {
  const p = photos.get(pid); if (!p) return;
  viewerList = spotPhotos(p.spotId).map(x => x.id);
  viewerIndex = Math.max(0, viewerList.indexOf(pid));
  // Called straight from the tap, so Google's sign-in popup is allowed if Drive needs reconnecting.
  const needsDrive = viewerList.some(id => { const q = photos.get(id); return q && q.driveId && !fullUrls.has(id); });
  if (needsDrive && !hasDriveToken()) {
    requestDriveToken().then(() => { viewerList.forEach((id, i) => { if (fullState.get(id) === 'needs-drive') fullState.delete(id); }); ensureFull(viewerIndex); flushUploads(); })
      .catch(() => { /* stays on preview; the slide offers a reconnect button */ });
  }
  const track = $('#viewerTrack');
  track.innerHTML = viewerList.map((id, i) => {
    const q = photos.get(id);
    return `<div class="slide" data-i="${i}" data-pid="${id}"><img src="${fullUrls.get(id) || q.thumb}" alt="" draggable="false"><span class="slide-state"></span></div>`;
  }).join('');
  const v = $('#viewer');
  v.classList.remove('hidden');
  v.classList.toggle('single', viewerList.length < 2);
  requestAnimationFrame(() => { track.scrollLeft = viewerIndex * track.clientWidth; showSlide(viewerIndex); });
}
function showSlide(i) {
  viewerIndex = Math.min(Math.max(i, 0), viewerList.length - 1);
  const pid = viewerList[viewerIndex], p = photos.get(pid);
  const v = $('#viewer'); v.dataset.pid = pid;
  $('#viewerCount').textContent = viewerList.length > 1 ? `${viewerIndex + 1} / ${viewerList.length}` : '';
  $('#viewerPrev').disabled = viewerIndex === 0;
  $('#viewerNext').disabled = viewerIndex === viewerList.length - 1;
  if (p) $('#viewerMeta').innerHTML = photoMetaHtml(p);
  flushCaption();
  const cap = $('#viewerCaption');
  cap.value = (p && p.caption) || ''; cap.dataset.pid = pid;
  autoGrow(cap);
  // load this photo first, then its neighbours, so swiping is instant
  ensureFull(viewerIndex).then(() => { ensureFull(viewerIndex + 1); ensureFull(viewerIndex - 1); });
  pruneFull();
}
function goSlide(i) {
  const track = $('#viewerTrack');
  i = Math.min(Math.max(i, 0), viewerList.length - 1);
  track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
}
function onTrackScroll() {
  clearTimeout(viewerScrollTimer);
  viewerScrollTimer = setTimeout(() => {
    const track = $('#viewerTrack');
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (i !== viewerIndex) showSlide(i);
  }, 90);
}
function slideEl(pid) { return $(`#viewerTrack .slide[data-pid="${pid}"]`); }
function setSlideState(pid, state, html = '') {
  fullState.set(pid, state);
  const el = slideEl(pid); if (!el) return;
  el.dataset.state = state;
  el.querySelector('.slide-state').innerHTML = html;
}
async function ensureFull(i) {
  const pid = viewerList[i]; if (!pid) return;
  const p = photos.get(pid); if (!p) return;
  const st = fullState.get(pid);
  if (st === 'loading' || st === 'unsupported') return;
  if (fullUrls.has(pid)) { const el = slideEl(pid); if (el) { el.querySelector('img').src = fullUrls.get(pid); el.dataset.state = 'full'; el.querySelector('.slide-state').innerHTML = ''; } return; }
  setSlideState(pid, 'loading', '<span class="ss-pill">Loading full size…</span>');
  try {
    const blob = await getFullImage(p);
    if (!blob) {
      if (!p.driveId) setSlideState(pid, 'not-uploaded', '<span class="ss-pill">Preview only. The full-size original is still waiting to upload from the device you added it on.</span>');
      else setSlideState(pid, 'needs-drive', '<button class="btn small primary ss-connect">Connect Google Drive for full size</button>');
      return;
    }
    const url = URL.createObjectURL(blob);
    const ok = await new Promise(res => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = url; });
    if (!ok) { URL.revokeObjectURL(url); setSlideState(pid, 'unsupported', '<span class="ss-pill">This browser can’t display the original’s format (e.g. HEIC). Showing the preview.</span>'); return; }
    fullUrls.set(pid, url);
    const el = slideEl(pid);
    if (el) el.querySelector('img').src = url;
    setSlideState(pid, 'full');
  } catch (e) {
    if (e.status === 401) setSlideState(pid, 'needs-drive', '<button class="btn small primary ss-connect">Reconnect Google Drive for full size</button>');
    else setSlideState(pid, 'error', '<span class="ss-pill">Couldn’t load the full size (offline?). Showing the preview.</span>');
  }
}
function pruneFull() {
  // keep memory low on phones: only hold originals near the current slide
  for (const [pid, url] of fullUrls) {
    const i = viewerList.indexOf(pid);
    if (i === -1 || Math.abs(i - viewerIndex) > 2) {
      URL.revokeObjectURL(url); fullUrls.delete(pid); fullState.delete(pid);
      const el = slideEl(pid); if (el) { const p = photos.get(pid); if (p) el.querySelector('img').src = p.thumb; el.dataset.state = ''; }
    }
  }
}
// ---- captions (saved per photo, auto-saves as you type) ----
let captionTimer = null;
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
function onCaptionInput() {
  const t = $('#viewerCaption'); autoGrow(t);
  clearTimeout(captionTimer);
  captionTimer = setTimeout(flushCaption, 700);
}
function flushCaption() {
  if (!captionTimer) return;
  clearTimeout(captionTimer); captionTimer = null;
  const t = $('#viewerCaption'), pid = t.dataset.pid, p = photos.get(pid);
  if (!p) return;
  const caption = t.value.trim();
  if ((p.caption || '') === caption) return;
  p.caption = caption;
  userCol('photos').doc(pid).update({ caption, updatedAt: nowIso() }).catch(e => toast('Caption not saved: ' + e.code, 5000));
  if (currentSpotId) renderSpotSheet();
}
function closeViewer() {
  flushCaption();
  const v = $('#viewer'); v.classList.add('hidden'); delete v.dataset.pid;
  for (const url of fullUrls.values()) URL.revokeObjectURL(url);
  fullUrls.clear(); fullState.clear();
  $('#viewerTrack').innerHTML = '';
  viewerList = [];
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
function openList() { closeSpot(); closeLayers(); closeSearch(); fillAreaSelect(); renderList(); $('#listSheet').classList.remove('hidden'); }
function closeList() { $('#listSheet').classList.add('hidden'); }
function renderList() {
  const q = $('#listSearch').value.trim().toLowerCase();
  const all = [...spots.values()];
  $('#listFilters').innerHTML =
    `<button class="chip-filter ${listFilter === 'all' ? 'on' : ''}" data-f="all">All <small>${all.length}</small></button>` +
    Object.entries(CATEGORIES).map(([k, c]) =>
      `<button class="chip-filter ${listFilter === k ? 'on' : ''}" data-f="${k}">${catBadge(k, 'p-mini')} ${c.plural} <small>${all.filter(s => s.category === k).length}</small></button>`).join('') +
    `<button class="chip-filter ${listFilter === 'permit' ? 'on' : ''}" data-f="permit">${catBadge('permit', 'p-mini')} Permit needed <small>${all.filter(s => s.permit).length}</small></button>`;
  const arr = all
    .filter(s => !hiddenByFilter(s))
    .filter(s => !q || s.name.toLowerCase().includes(q) || (s.notes || '').toLowerCase().includes(q) || areaShort(s).toLowerCase().includes(q) || spotPhotos(s.id).some(ph => (ph.caption || '').toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#listItems').innerHTML = arr.map(s => {
    const ph = spotPhotos(s.id);
    const cat = catOf(s);
    const where = areaShort(s);
    return `<button class="list-row" data-id="${s.id}">
      ${cat ? `<span class="ph-empty ph-cat" style="background:${CATEGORIES[cat].color}">${CATEGORIES[cat].badge}</span>` : ph[0] ? `<img src="${ph[0].thumb}" alt="">` : '<span class="ph-empty">📍</span>'}
      <span class="lr-text"><b>${s.permit ? '<span class="p-mini" style="background:#e5484d">!</span> ' : ''}${esc(s.name)}</b><small>${where ? esc(where) + ' · ' : ''}${ph.length} photo${ph.length === 1 ? '' : 's'}${s.notes ? ' · ' + esc(s.notes.split('\n')[0].slice(0, 60)) : ''}</small></span>
    </button>`;
  }).join('') || `<p class="empty">${areaFilter && listFilter === 'all' ? `No spots in ${esc(areaFilter.name)} yet.` : listFilter !== 'all' ? `No spots marked “${filterInfo(listFilter).label.toLowerCase()}” yet. Open a spot, tap ⋯ → Mark ${listFilter === 'permit' ? 'permit needed' : 'as ' + filterInfo(listFilter).label.toLowerCase()}.` : spots.size ? 'No matches.' : 'No spots yet. Tap “Add photo” when you’re at a location.'}</p>`;
}

function setListFilter(f) {
  listFilter = (CATEGORIES[f] || f === 'permit') ? f : 'all';
  applyFilters();
  if (listFilter !== 'all') {
    const ps = [...spots.values()].filter(x => !hiddenByFilter(x));
    if (ps.length === 1) map.easeTo({ center: [ps[0].lng, ps[0].lat], zoom: Math.max(map.getZoom(), 14) });
    else if (ps.length > 1) { const b = new maplibregl.LngLatBounds(); ps.forEach(x => b.extend([x.lng, x.lat])); map.fitBounds(b, { padding: { top: 90, bottom: 140, left: 50, right: 70 }, maxZoom: 15 }); }
  }
}
function applyFilters() {
  const pill = $('#filterPill');
  const parts = [];
  if (areaFilter) parts.push(esc(areaFilter.name));
  if (listFilter !== 'all') parts.push(`${catBadge(listFilter, 'p-mini')} ${filterInfo(listFilter).plural}`);
  if (parts.length) { pill.innerHTML = parts.join(' · ') + ' only ✕'; pill.classList.remove('hidden'); }
  else pill.classList.add('hidden');
  for (const [id, m] of markers) m.getElement().classList.toggle('filtered-out', hiddenByFilter(spots.get(id)));
  if (!$('#listSheet').classList.contains('hidden')) renderList();
}
function clearAllFilters() {
  listFilter = 'all';
  setAreaFilter(null);
}

// ===================== Area (municipality) filter =====================
const AREA_COUNTY = 'Monterey County';
let areaChoices = null;           // [{key, name, kind:'city'|'community', layer}]
let countyFeature = null;
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInGeom(lng, lat, g) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some(rings => pointInRing(lng, lat, rings[0]) && !rings.slice(1).some(h => pointInRing(lng, lat, h)));
}
const areaCache = new Map(); // spotId|areaKey -> bool
function inArea(s) {
  if (!areaFilter || !s) return true;
  const k = s.id + '|' + areaFilter.key + '|' + s.lat + '|' + s.lng;
  if (!areaCache.has(k)) areaCache.set(k, areaFilter.feature.features.some(f => pointInGeom(s.lng, s.lat, f.geometry)));
  return areaCache.get(k);
}
async function tigerQuery(layer, params) {
  const p = new URLSearchParams(Object.assign({ f: 'json' }, params));
  const j = await (await fetch(`${TIGER_URL}/${layer}/query?${p}`)).json();
  if (j.error) throw new Error(j.error.message || 'boundary lookup failed');
  return j;
}
async function loadAreaChoices() {
  if (areaChoices) return areaChoices;
  const cj = await (await fetch(`${TIGER_URL}/82/query?` + new URLSearchParams({ where: `NAME='${AREA_COUNTY}' AND STATE='06'`, outFields: 'NAME', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.002', f: 'geojson' }))).json();
  countyFeature = cj.features && cj.features[0];
  if (!countyFeature) throw new Error('county not found');
  const xs = [], ys = [];
  JSON.stringify(countyFeature.geometry.coordinates).replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, (_, x, y) => { xs.push(+x); ys.push(+y); });
  const env = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].join(',');
  const base = { where: "STATE='06'", geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'BASENAME,GEOID,INTPTLAT,INTPTLON', returnGeometry: 'false' };
  const [pl, cdp] = await Promise.all([tigerQuery(28, base), tigerQuery(30, base)]);
  const keep = (j, kind, layer) => (j.features || []).map(f => f.attributes)
    .filter(a => pointInGeom(+a.INTPTLON, +a.INTPTLAT, countyFeature.geometry))
    .map(a => ({ key: a.GEOID, name: a.BASENAME, kind, layer }));
  areaChoices = [...keep(pl, 'city', 28), ...keep(cdp, 'community', 30)].sort((a, b) => a.name.localeCompare(b.name));
  return areaChoices;
}
async function fillAreaSelect() {
  const sel = $('#areaSelect');
  if (sel.dataset.filled) { sel.value = areaFilter ? areaFilter.key : ''; return; }
  sel.innerHTML = '<option value="">Loading areas…</option>';
  try {
    const ch = await loadAreaChoices();
    const opt = c => `<option value="${c.key}">${esc(c.name)}</option>`;
    sel.innerHTML = `<option value="">All areas</option>` +
      `<optgroup label="Cities in ${AREA_COUNTY}">${ch.filter(c => c.kind === 'city').map(opt).join('')}</optgroup>` +
      `<optgroup label="Unincorporated communities">${ch.filter(c => c.kind === 'community').map(opt).join('')}</optgroup>`;
    sel.dataset.filled = '1';
    sel.value = areaFilter ? areaFilter.key : '';
  } catch (e) {
    sel.innerHTML = '<option value="">Areas unavailable (offline?)</option>';
  }
}
async function onAreaSelect() {
  const key = $('#areaSelect').value;
  if (!key) { setAreaFilter(null); return; }
  const c = (areaChoices || []).find(x => x.key === key); if (!c) return;
  try {
    toast(`Loading ${c.name}…`, 2000);
    const fc = await (await fetch(`${TIGER_URL}/${c.layer}/query?` + new URLSearchParams({ where: `GEOID='${c.key}'`, outFields: 'BASENAME', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.0002', f: 'geojson' }))).json();
    if (!fc.features || !fc.features.length) throw new Error('no boundary');
    setAreaFilter({ key: c.key, name: c.name, kind: c.kind, feature: fc });
  } catch (e) { toast(`Couldn't load ${c.name}'s boundary right now`, 4000); $('#areaSelect').value = areaFilter ? areaFilter.key : ''; }
}
function setAreaFilter(af) {
  areaFilter = af;
  areaCache.clear();
  if (!overlaysReady) setupOverlays();
  const src = map && map.getSource('ov-area');
  if (src) src.setData(af ? af.feature : { type: 'FeatureCollection', features: [] });
  const sel = $('#areaSelect'); if (sel && sel.dataset.filled) sel.value = af ? af.key : '';
  applyFilters();
  if (af) {
    const xs = [], ys = [];
    JSON.stringify(af.feature.features.map(f => f.geometry.coordinates)).replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, (_, x, y) => { xs.push(+x); ys.push(+y); });
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 100, bottom: 160, left: 40, right: 60 }, maxZoom: 15 });
  }
}

// ===================== Address search =====================
let searchTimer = null, searchCtl = null, lastSearchAt = 0, searchResults = [], searchMarker = null, searchHit = null;
function openSearch() {
  closeSpot(); closeList(); closeLayers();
  $('#searchBar').classList.remove('hidden');
  setTimeout(() => $('#searchInput').focus(), 50);
}
function closeSearch(clearPin = true) {
  $('#searchBar').classList.add('hidden');
  $('#searchResults').innerHTML = '';
  if (clearPin) clearSearchPin();
}
function clearSearchPin() {
  if (searchMarker) { searchMarker.remove(); searchMarker = null; }
  searchHit = null;
  $('#searchCard').classList.add('hidden');
}
function parseCoords(q) {
  const m = q.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) ? { lat, lng } : null;
}
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('#searchInput').value.trim();
  if (q.length < 3) { $('#searchResults').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 700);
}
async function runSearch(q) {
  const box = $('#searchResults');
  const c = parseCoords(q);
  if (c) {
    searchResults = [{ name: 'Coordinates', detail: fmtCoord(c.lat, c.lng), lat: c.lat, lng: c.lng }];
    box.innerHTML = renderSearchResults(); return;
  }
  // OpenStreetMap's free geocoder allows about 1 request per second, so wait if needed.
  const wait = Math.max(0, 1100 - (Date.now() - lastSearchAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  if ($('#searchInput').value.trim() !== q) return; // user kept typing
  lastSearchAt = Date.now();
  if (searchCtl) searchCtl.abort();
  searchCtl = new AbortController();
  box.innerHTML = '<p class="sr-msg">Searching…</p>';
  const b = map.getBounds();
  const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '6', countrycodes: 'us', q,
    viewbox: [b.getWest() - 0.5, b.getNorth() + 0.5, b.getEast() + 0.5, b.getSouth() - 0.5].map(n => n.toFixed(3)).join(',') });
  try {
    const j = await (await fetch('https://nominatim.openstreetmap.org/search?' + params, { headers: { 'Accept-Language': 'en' }, signal: searchCtl.signal })).json();
    searchResults = j.map(r => {
      const a = r.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const name = r.name || street || r.display_name.split(',')[0];
      const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
      return { name, detail: [street && street !== name ? street : '', town, a.state].filter(Boolean).join(', '), lat: +r.lat, lng: +r.lon };
    });
    box.innerHTML = searchResults.length ? renderSearchResults() : '<p class="sr-msg">No matches. Try adding the town, e.g. “Ocean Ave, Carmel”.</p>';
  } catch (e) {
    if (e.name !== 'AbortError') box.innerHTML = '<p class="sr-msg">Search isn’t available right now (offline?).</p>';
  }
}
function renderSearchResults() {
  return searchResults.map((r, i) => `<button class="sr-row" data-i="${i}"><b>${esc(r.name)}</b><small>${esc(r.detail)}</small></button>`).join('');
}
function pickSearchResult(i) {
  const r = searchResults[i]; if (!r) return;
  closeSearch(false);
  clearSearchPin();
  searchHit = r;
  const el = document.createElement('div'); el.className = 'search-pin';
  searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([r.lng, r.lat]).addTo(map);
  map.flyTo({ center: [r.lng, r.lat], zoom: 17, offset: [0, -60], duration: 1200 });
  $('#searchCardName').textContent = r.name;
  $('#searchCardDetail').textContent = r.detail || fmtCoord(r.lat, r.lng);
  $('#searchCard').classList.remove('hidden');
}
async function saveSearchHit() {
  const r = searchHit; if (!r) return;
  clearSearchPin();
  const id = await createSpot(r.lat, r.lng, r.name !== 'Coordinates' ? r.name : null);
  if (id) openSpot(id, false);
}
function adjustSearchHit() {
  const r = searchHit; if (!r) return;
  clearSearchPin();
  map.jumpTo({ center: [r.lng, r.lat] });
  startPlacing({ mode: 'new' });
}

// ===================== Overlays: public land + boundaries =====================
// CPAD "Units": parcels merged into one outline per park/preserve per owning agency (whole areas, not parcels).
const CPAD_URL = 'https://services1.arcgis.com/4ZKi1B1zTblbwgWB/ArcGIS/rest/services/cpad_2024a_unitsgdb/FeatureServer/0';
const TIGER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';
// Four groups, chosen by who you'd ask about a shoot permit.
const LAND_GROUPS = {
  federal:   { label: 'Federal',   color: '#ff7a45' }, // national forest, BLM, national monument, military…
  state:     { label: 'State',     color: '#ffe63b' }, // State Parks, Fish & Wildlife, other state agencies
  municipal: { label: 'Municipal', color: '#4fc3f7' }, // city, county, and special districts (e.g. regional parks)
  private:   { label: 'Private',   color: '#f48fb1' }, // land trusts, nonprofits, private conservation land
};
const LEGACY_GROUP = { county: 'municipal', city: 'municipal', district: 'municipal', nonprofit: 'private' };
const groupKey = g => LAND_GROUPS[g] ? g : (LEGACY_GROUP[g] || 'private');
function landGroup(layer, lev) {
  const L = String(layer || ''), V = String(lev || '');
  if (/^US |Federal|National Park/i.test(L) || V === 'Federal') return 'federal';
  if (/State|California Department/i.test(L) || V === 'State') return 'state';
  if (L === 'County' || V === 'County' || L === 'City' || V === 'City' || /Special District/i.test(L) || /Special District/i.test(V)) return 'municipal';
  return 'private';
}
const OVERLAYS = {
  land:     { label: 'Public & protected land', url: CPAD_URL, fields: 'UNIT_NAME,AGNCY_NAME,AGNCY_LEV,LAYER,ACCESS_TYP', minZoom: 10 },
  cities:   { label: 'City limits',             url: TIGER_URL + '/28', fields: 'BASENAME,NAME', minZoom: 8 },
  cdps:     { label: 'Unincorporated communities', url: TIGER_URL + '/30', fields: 'BASENAME,NAME', minZoom: 8 },
  counties: { label: 'County lines',            url: TIGER_URL + '/82', fields: 'BASENAME,NAME', minZoom: 6 },
};
let overlayOn = { land: false, cities: false, cdps: false, counties: false };
try { Object.assign(overlayOn, JSON.parse(localStorage.getItem('pg_overlays') || '{}')); } catch {}
const overlayCtl = {};   // key -> AbortController
let overlayTimer = null, overlaysReady = false;

function setupOverlays() {
  // Only needs the style itself parsed, not every tile (map.isStyleLoaded() waits for tiles too).
  if (overlaysReady || !(map.style && map.style._loaded)) return;
  const empty = { type: 'FeatureCollection', features: [] };
  try {
    for (const k of Object.keys(OVERLAYS)) if (!map.getSource('ov-' + k)) map.addSource('ov-' + k, { type: 'geojson', data: empty });
  } catch (e) { console.warn('overlay setup deferred', e); return; }
  const colorExpr = ['match', ['get', 'grp'], ...Object.entries(LAND_GROUPS).flatMap(([k, v]) => [k, v.color]), LAND_GROUPS.private.color];
  map.addLayer({ id: 'ov-land-fill', type: 'fill', source: 'ov-land', paint: { 'fill-color': colorExpr, 'fill-opacity': 0.2 } });
  map.addLayer({ id: 'ov-land-line', type: 'line', source: 'ov-land', paint: { 'line-color': colorExpr, 'line-width': 1.6, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'ov-counties', type: 'line', source: 'ov-counties', paint: { 'line-color': '#ff5252', 'line-width': 3, 'line-dasharray': [4, 2] } });
  map.addLayer({ id: 'ov-cdps', type: 'line', source: 'ov-cdps', paint: { 'line-color': '#ffffff', 'line-width': 1.8, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'ov-cities', type: 'line', source: 'ov-cities', paint: { 'line-color': '#ffffff', 'line-width': 2.6 } });
  if (!map.getSource('ov-area')) map.addSource('ov-area', { type: 'geojson', data: areaFilter ? areaFilter.feature : empty });
  map.addLayer({ id: 'ov-area-fill', type: 'fill', source: 'ov-area', paint: { 'fill-color': '#ffe63b', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'ov-area-line', type: 'line', source: 'ov-area', paint: { 'line-color': '#ffe63b', 'line-width': 4 } });
  overlaysReady = true;
  applyOverlayVisibility();
  refreshOverlays();
  try { setBaseLayer(localStorage.getItem('pg_base') || 'satellite'); } catch { renderLayersPanel(); }
}

function overlayLayerIds(k) { return k === 'land' ? ['ov-land-fill', 'ov-land-line'] : ['ov-' + k]; }
function applyOverlayVisibility() {
  if (!overlaysReady) return;
  for (const k of Object.keys(OVERLAYS))
    overlayLayerIds(k).forEach(id => map.setLayoutProperty(id, 'visibility', overlayOn[k] ? 'visible' : 'none'));
}
function toggleOverlay(k) {
  if (!overlaysReady) setupOverlays();
  overlayOn[k] = !overlayOn[k];
  try { localStorage.setItem('pg_overlays', JSON.stringify(overlayOn)); } catch {}
  applyOverlayVisibility();
  renderLayersPanel();
  if (overlayOn[k]) {
    if (map.getZoom() < OVERLAYS[k].minZoom) toast(`Zoom in to see ${OVERLAYS[k].label.toLowerCase()}`);
    refreshOverlays([k]);
  }
}
function scheduleOverlayRefresh() { clearTimeout(overlayTimer); overlayTimer = setTimeout(() => refreshOverlays(), 350); }

async function refreshOverlays(keys) {
  if (!overlaysReady) return;
  const b = map.getBounds(), z = map.getZoom();
  const env = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(n => n.toFixed(5)).join(',');
  const tol = (360 / (512 * Math.pow(2, z))) * 1.5; // ~1.5px simplification
  for (const k of keys || Object.keys(OVERLAYS)) {
    const o = OVERLAYS[k];
    if (!overlayOn[k] || z < o.minZoom) continue;
    if (overlayCtl[k]) overlayCtl[k].abort();
    const ctl = overlayCtl[k] = new AbortController();
    const url = `${o.url}/query?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=${o.fields}&returnGeometry=true&outSR=4326&maxAllowableOffset=${tol.toFixed(7)}&resultRecordCount=2000&f=geojson`;
    try {
      const gj = await (await fetch(url, { signal: ctl.signal })).json();
      if (!gj || !gj.features) throw new Error((gj && gj.error && gj.error.message) || 'bad response');
      if (k === 'land') gj.features.forEach(f => { f.properties.grp = landGroup(f.properties.LAYER, f.properties.AGNCY_LEV); });
      map.getSource('ov-' + k).setData(gj);
    } catch (e) {
      if (e.name !== 'AbortError') { console.warn('overlay', k, e); toast(`Couldn't load ${o.label.toLowerCase()} right now`, 4000); }
    }
  }
}

function renderLayersPanel() {
  const el = $('#layersBody'); if (!el) return;
  const sw = (k) => `<button class="ov-row ${overlayOn[k] ? 'on' : ''}" data-ov="${k}"><span class="ov-check">${overlayOn[k] ? '✓' : ''}</span><span>${esc(OVERLAYS[k].label)}</span>${k === 'cities' ? '<i class="ln ln-city"></i>' : k === 'cdps' ? '<i class="ln ln-cdp"></i>' : k === 'counties' ? '<i class="ln ln-county"></i>' : ''}</button>`;
  el.innerHTML = `
    <div class="seg">
      <button data-base="satellite" class="${baseLayer === 'satellite' ? 'on' : ''}">🛰 Satellite</button>
      <button data-base="streets" class="${baseLayer === 'streets' ? 'on' : ''}">🗺 Streets</button>
    </div>
    <div class="field-label">Who owns the land</div>
    ${sw('land')}
    <div class="legend ${overlayOn.land ? '' : 'dim'}">${Object.values(LAND_GROUPS).map(g => `<span><i style="background:${g.color}"></i>${esc(g.label)}</span>`).join('')}</div>
    <div class="field-label">Boundaries</div>
    ${sw('cities')}${sw('cdps')}${sw('counties')}
    <p class="fine">Tap anywhere on the map to see what land and area you're in. Lines come from the California Protected Areas Database and the U.S. Census, for reference only, not legal property boundaries.</p>`;
}
function openLayers() { if (!overlaysReady) setupOverlays(); closeSpot(); closeList(); closeSearch(); renderLayersPanel(); $('#layersSheet').classList.remove('hidden'); }
function closeLayers() { $('#layersSheet').classList.add('hidden'); }

// --- identify what's at a point (used for map taps and spot labels) ---
async function arcIdentify(url, fields, lng, lat) {
  const u = `${url}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${fields}&returnGeometry=false&f=json`;
  const j = await (await fetch(u)).json();
  if (j.error) throw new Error(j.error.message || 'identify failed');
  return (j.features || []).map(f => f.attributes);
}
async function identifyPoint(lat, lng) {
  const [land, city, cdp, county] = await Promise.all([
    arcIdentify(CPAD_URL, 'UNIT_NAME,AGNCY_NAME,AGNCY_LEV,LAYER,ACCESS_TYP', lng, lat),
    arcIdentify(TIGER_URL + '/28', 'BASENAME', lng, lat),
    arcIdentify(TIGER_URL + '/30', 'BASENAME', lng, lat),
    arcIdentify(TIGER_URL + '/82', 'BASENAME', lng, lat),
  ]);
  const seen = new Set();
  const lands = land.filter(a => { const key = a.UNIT_NAME + '|' + a.AGNCY_NAME; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(a => ({ name: a.UNIT_NAME || 'Protected land', owner: a.AGNCY_NAME || '', grp: landGroup(a.LAYER, a.AGNCY_LEV), access: a.ACCESS_TYP || '' }));
  return {
    v: 1,
    land: lands,
    city: city[0] ? city[0].BASENAME : null,
    community: cdp[0] ? cdp[0].BASENAME : null,
    county: county[0] ? county[0].BASENAME + ' County' : null,
    checkedAt: nowIso(),
  };
}
function areaPlace(a) {
  if (!a) return '';
  if (a.city) return a.city + (a.county ? ', ' + a.county : '');
  if (a.community) return a.community + ' (unincorporated' + (a.county ? ' ' + a.county : '') + ')';
  return a.county ? 'Unincorporated ' + a.county : '';
}
function areaShort(s) {
  const a = s.area; if (!a) return '';
  if (a.land && a.land[0]) return a.land[0].name;
  return a.city || a.community || (a.county ? 'Unincorp. ' + a.county : '');
}
function landLineHtml(l) {
  const g = LAND_GROUPS[groupKey(l.grp)];
  return `<div class="area-land"><i style="background:${g.color}"></i><span><b>${esc(l.name)}</b><br><small><b style="color:${g.color}">${g.label} land</b> · ${esc(l.owner)}${l.access ? ' · ' + esc(l.access) : ''}</small></span></div>`;
}

// ===================== Permit guide (researched Oct 2026; always confirm with the agency) =====================
// Notes are for paid/commercial shoots. Matched against the land manager (CPAD owner/name) and the city/community/county.
const PERMIT_CHECKED = 'Oct 2026';
const PERMIT_RULES = [
  { id: 'point-lobos', when: a => a.land.some(l => /Point Lobos/i.test(l.name)),
    title: 'Point Lobos State Natural Reserve',
    text: 'No film or photo productions from Memorial Day weekend through Labor Day weekend. Outside that window, it follows the State Parks permit rules below. Local contact: Monterey Area State Parks, 831-624-3407.',
    link: 'https://www.filmmonterey.org/permit/state-of-california' },
  { id: 'state-parks', when: a => a.land.some(l => /Parks and Recreation/i.test(l.owner)),
    title: 'California State Parks: permit required',
    text: 'Commercial photography, including paid portrait and wedding sessions, needs a State Parks permit. Get initial approval from the park’s local rangers, then the permit is issued through the California Film Commission. A "simple" shoot (handheld gear and props, small crew, during park hours) is the lower-fee type. No retroactive permits.',
    link: 'https://www.filmmonterey.org/permit/state-of-california' },
  { id: 'cdfw', when: a => a.land.some(l => /Fish and Wildlife/i.test(l.owner) && !/^U\.?S/i.test(l.owner)),
    title: 'CA Dept. of Fish & Wildlife land: ask first',
    text: 'Ecological reserves and wildlife areas have their own access rules, and some are closed to the public. Contact CDFW before shooting here.',
    link: 'https://wildlife.ca.gov/' },
  { id: 'federal', when: a => a.land.some(l => groupKey(l.grp) === 'federal'),
    title: 'Federal land: small shoots usually permit-free',
    text: 'Under the 2025 EXPLORE Act, shoots with 5 or fewer people need no permit or fee if they use handheld gear only, don’t disturb the land or other visitors, and stay out of closed or very busy areas. 6–8 people need a free "de minimis" authorization. 9 or more people, or any set or staging, needs a permit.',
    link: 'https://www.fs.usda.gov/r05/lospadres/permits/' },
  { id: 'los-padres', when: a => a.land.some(l => /Los Padres/i.test(l.name)),
    title: 'Los Padres National Forest extras',
    text: 'Permits aren’t issued for weekends or holidays. At Pfeiffer Beach from March 15 to September 15: 8 or fewer people, handheld gear only, no staging.',
    link: 'https://www.fs.usda.gov/r05/lospadres/permits/' },
  { id: 'mprpd', when: a => a.land.some(l => /Regional Park District/i.test(l.owner)),
    title: 'Monterey Peninsula Regional Park District: ask first',
    text: 'District parks (e.g. Garland Ranch) are public land with their own rules. Contact the District before a commercial shoot: 831-372-3196.',
    link: 'https://www.mprpd.org/' },
  { id: 'county-parks', when: a => a.land.some(l => /Monterey, County of/i.test(l.owner) && /Park/i.test(l.name)),
    title: 'Monterey County Parks: use fee',
    text: 'Filming and photography in county parks (Jacks Peak, Toro, San Lorenzo, etc.) need an application through Monterey County Parks. Fees run $250–$1,500 per day depending on the park, and a damage deposit may apply.',
    link: 'https://filmmonterey.org/permit/monterey-county/' },
  { id: 'land-trust', when: a => a.land.some(l => groupKey(l.grp) === 'private'),
    title: 'Private conservation land: owner’s permission',
    text: 'This land is owned by a land trust, nonprofit, or private owner. Get the owner’s permission before shooting. Many land-trust properties are closed to the public.',
    link: null },
];
const CITY_PERMITS = {
  'Carmel-by-the-Sea': { text: 'City still-photography permit: $280, apply 2 weeks ahead. Events on Carmel Beach need a beach permit ($428, south of 10th Ave only, and you can’t cordon off the beach). Whether a small portrait session needs a permit isn’t spelled out. Ask Community Activities: 831-620-2020.', link: 'https://ci.carmel.ca.us/event-permits' },
  'Monterey':          { text: 'City film/photo permit: $350–$1,000 per day depending on scope. Harbor/wharf areas go through the Harbormaster (831-646-3950). Special Events & Film Permits: 831-646-3770.', link: 'https://filmmonterey.org/permit/individual-city/' },
  'Pacific Grove':     { text: 'Film permit through Pacific Grove Police (application on the city website). Fees depend on city resources used. Contact: 831-648-3143.', link: 'https://www.cityofpacificgrove.org/' },
  'Seaside':           { text: 'Special Event application ($134) plus a Film Permit application ($1,029). Road closures need 90 days’ notice.', link: 'https://www.ci.seaside.ca.us/426/Forms-Documents' },
  'Marina':            { text: 'Film permit $262 plus a City of Marina business license. Apply at least 3 weeks ahead with a project description.', link: 'https://www.cityofmarina.org/870/Film-Office' },
  'Salinas':           { text: 'Permits through Recreation & Parks (831-758-7453). Fees depend on city resources used.', link: 'https://filmmonterey.org/permit/individual-city/' },
};
function permitNotes(a) {
  if (!a) return [];
  const out = PERMIT_RULES.filter(r => r.when(a)).map(r => ({ title: r.title, text: r.text, link: r.link }));
  const onPublicNonCity = a.land.some(l => groupKey(l.grp) !== 'municipal');
  if (a.community && /Del Monte Forest|Pebble Beach/i.test(a.community) && !onPublicNonCity) {
    out.push({ title: 'Pebble Beach / 17-Mile Drive: private', text: 'Pebble Beach is a private community. Commercial shoots need Pebble Beach Company approval: send a written description with dates and times at least 3 weeks ahead. Weekends and summer are hard to get, and fees apply. Contact: 831-648-7859.', link: 'https://www.filmmonterey.org/permit/other-local' });
  } else if (a.city && !onPublicNonCity) {
    const c = CITY_PERMITS[a.city];
    out.push(c ? { title: `City of ${a.city}`, text: c.text, link: c.link }
               : { title: `City of ${a.city}`, text: 'Contact the City Manager’s office about filming or photo permits. Most smaller Monterey County cities follow the California Film Commission’s model permit process.', link: 'https://filmmonterey.org/permit/individual-city/' });
  } else if (!a.city && /Monterey County/i.test(a.county || '') && !a.land.length) {
    out.push({ title: 'Unincorporated Monterey County', text: 'Shoots on county roads or county public property need a county film permit through the Sheriff’s Office ($103, 831-755-3704), and county roads may also need an encroachment permit. On private property, you just need the owner’s permission.', link: 'https://filmmonterey.org/permit/monterey-county/' });
  }
  return out;
}
function permitHtml(a) {
  const notes = permitNotes(a);
  if (!notes.length) return '';
  return `<details class="permit-box"><summary>Permit guide <small>${notes.length} note${notes.length === 1 ? '' : 's'}</small></summary>` +
    notes.map(n => `<div class="permit-note"><b>${esc(n.title)}</b><p>${esc(n.text)}</p>${n.link ? `<a href="${n.link}" target="_blank" rel="noopener">Official info ↗</a>` : ''}</div>`).join('') +
    `<p class="fine">Summarized ${PERMIT_CHECKED} for paid shoots. Rules change, so confirm with the agency before you book.</p></details>`;
}

function areaIsCurrent(s) { return !!(s.area && s.area.v === 1); }
function areaHtml(s) {
  const a = s.area;
  if (!a) return '<span class="muted">Checking land & area…</span>';
  return (a.land && a.land.length ? a.land.map(landLineHtml).join('') : '<div class="area-land"><i class="none"></i><span>Not on public or protected land</span></div>') +
    `<div class="area-place">${esc(areaPlace(a))}</div>` + permitHtml(a);
}
const areaInFlight = new Set();
async function ensureArea(s) {
  if (!s || areaInFlight.has(s.id)) return;
  areaInFlight.add(s.id);
  try {
    const area = await identifyPoint(s.lat, s.lng);
    await userCol('spots').doc(s.id).update({ area }); // no updatedAt bump: derived data
  } catch (e) {
    console.warn('area', s.id, e);
    if (currentSpotId === s.id) $('#spotArea').innerHTML = '<span class="muted">Couldn\'t look up land & area (offline?)</span>';
  } finally { areaInFlight.delete(s.id); }
}
let areaSweepRunning = false;
async function sweepAreas() {
  if (areaSweepRunning) return; areaSweepRunning = true;
  try {
    for (const s of [...spots.values()]) {
      if (!user) break;
      if (!areaIsCurrent(s)) { await ensureArea(s); await new Promise(r => setTimeout(r, 250)); }
    }
  } finally { areaSweepRunning = false; }
}

// --- tap the map to identify ---
let idPopup = null;
async function onMapClick(e) {
  if (placing) return;
  if (!Object.values(overlayOn).some(Boolean)) return; // only when an overlay is showing
  const { lng, lat } = e.lngLat;
  if (idPopup) idPopup.remove();
  idPopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'id-popup' })
    .setLngLat([lng, lat]).setHTML('<div class="muted">Looking up…</div>').addTo(map);
  const pop = idPopup;
  try {
    const a = await identifyPoint(lat, lng);
    if (pop !== idPopup) return;
    pop.setHTML((a.land.length ? a.land.map(landLineHtml).join('') : '<div class="area-land"><i class="none"></i><span>Not on public or protected land</span></div>') +
      `<div class="area-place">${esc(areaPlace(a))}</div>` + permitHtml(a));
  } catch (err) { if (pop === idPopup) pop.setHTML('<div class="muted">Couldn\'t look this up right now.</div>'); }
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
  $('#btnLayer').onclick = openLayers;
  $('#layersClose').onclick = closeLayers;
  $('#layersBody').onclick = e => {
    const ov = e.target.closest('[data-ov]'); if (ov) return toggleOverlay(ov.dataset.ov);
    const b = e.target.closest('[data-base]'); if (b) return setBaseLayer(b.dataset.base);
  };
  $('#listFilters').onclick = e => { const b = e.target.closest('[data-f]'); if (b) setListFilter(b.dataset.f); };
  $('#filterPill').onclick = clearAllFilters;
  $('#areaSelect').onchange = onAreaSelect;
  $('#btnSearch').onclick = openSearch;
  $('#searchClose').onclick = () => closeSearch();
  $('#searchInput').oninput = onSearchInput;
  $('#searchInput').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); const q = e.target.value.trim(); if (q) runSearch(q); }
    if (e.key === 'Escape') closeSearch();
  };
  $('#searchResults').onclick = e => { const b = e.target.closest('.sr-row'); if (b) pickSearchResult(+b.dataset.i); };
  $('#searchSave').onclick = saveSearchHit;
  $('#searchAdjust').onclick = adjustSearchHit;
  $('#searchDismiss').onclick = clearSearchPin;
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
  $('#viewerTrack').addEventListener('scroll', onTrackScroll, { passive: true });
  $('#viewerTrack').onclick = e => {
    if (!e.target.closest('.ss-connect')) return;
    requestDriveToken().then(() => { for (const [k, st] of fullState) if (st === 'needs-drive') fullState.delete(k); ensureFull(viewerIndex).then(() => { ensureFull(viewerIndex + 1); ensureFull(viewerIndex - 1); }); flushUploads(); })
      .catch(err => toast('Google Drive connect failed: ' + err.message, 6000));
  };
  $('#viewerCaption').addEventListener('input', onCaptionInput);
  $('#viewerCaption').addEventListener('blur', flushCaption);
  $('#viewerCaption').addEventListener('keydown', e => e.stopPropagation()); // arrow keys edit text, not change photo
  $('#viewerPrev').onclick = () => goSlide(viewerIndex - 1);
  $('#viewerNext').onclick = () => goSlide(viewerIndex + 1);
  document.addEventListener('keydown', e => {
    if ($('#viewer').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') goSlide(viewerIndex - 1);
    else if (e.key === 'ArrowRight') goSlide(viewerIndex + 1);
    else if (e.key === 'Escape') closeViewer();
  });
  window.addEventListener('resize', () => { if (!$('#viewer').classList.contains('hidden')) $('#viewerTrack').scrollLeft = viewerIndex * $('#viewerTrack').clientWidth; });
  $('#bannerBtn').onclick = onBannerTap;
  window.addEventListener('online', () => flushUploads());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLocationWatch();
    else { updateBanner(); flushUploads(); if (map) startLocationWatch(); }
  });
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
