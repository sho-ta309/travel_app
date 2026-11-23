// ===== 旅行記録アプリ（React 18 / Leaflet / exifr） =====
const { useState, useEffect, useRef, useMemo } = React;

const STORAGE_KEY = 'travel-log-records';
const TRIP_KEY = 'travel-log-trips';

// ---------- アプリ内ダイアログ（ブラウザ標準の confirm / prompt / alert の代わり） ----------
const Dialog = (() => {
  let setter = null;
  const open = cfg => new Promise(resolve => { if (!setter) { resolve(null); return; } setter({ ...cfg, resolve }); });
  return {
    bind: fn => { setter = fn; },
    confirm: (message, o = {}) => open({ kind: 'confirm', message, ...o }),
    prompt: (message, value = '', o = {}) => open({ kind: 'prompt', message, value, ...o }),
    alert: message => open({ kind: 'alert', message })
  };
})();
function DialogHost() {
  const [d, setD] = useState(null);
  const [val, setVal] = useState('');
  useEffect(() => { Dialog.bind(cfg => { setVal(cfg.value || ''); setD(cfg); }); return () => Dialog.bind(null); }, []);
  if (!d) return null;
  const cancelVal = d.kind === 'prompt' ? null : d.kind === 'confirm' ? false : true;
  const close = r => { d.resolve(r); setD(null); };
  return ReactDOM.createPortal(
    <div className="dlgBack" onClick={() => close(cancelVal)}>
      <form className="dlg" onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Escape') close(cancelVal); }}
            onSubmit={e => { e.preventDefault(); close(d.kind === 'prompt' ? val : true); }}>
        <p className="dlgMsg">{d.message}</p>
        {d.kind === 'prompt' && <input autoFocus value={val} onChange={e => setVal(e.target.value)} />}
        <div className="dlgBtns">
          {d.kind !== 'alert' && <button type="button" className="ghost" onClick={() => close(cancelVal)}>キャンセル</button>}
          <button type="submit" className={d.danger ? 'danger' : ''} autoFocus={d.kind !== 'prompt'}>{d.okText || 'OK'}</button>
        </div>
      </form>
    </div>, document.body);
}

// ---------- 効果音 ----------
const Sound = (() => {
  const KEY = 'travel-log-sound';
  let ctx = null;
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch (e) {}

  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(c, freq, at, dur, type, vol, freq2) {
    const t0 = c.currentTime + at;
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  const SOUNDS = {
    click:   c => tone(c, 880, 0, 0.06, 'sine', 0.12),
    pin:     c => tone(c, 660, 0, 0.09, 'triangle', 0.15),
    select:  c => { tone(c, 740, 0, 0.07, 'triangle', 0.15); tone(c, 988, 0.06, 0.1, 'triangle', 0.15); },
    save:    c => { tone(c, 660, 0, 0.1, 'sine', 0.15); tone(c, 880, 0.09, 0.16, 'sine', 0.15); },
    delete:  c => tone(c, 300, 0, 0.14, 'triangle', 0.15),
    open:    c => tone(c, 520, 0, 0.16, 'sine', 0.14, 900),
    close:   c => tone(c, 900, 0, 0.14, 'sine', 0.12, 520),
    move:    c => tone(c, 300, 0, 0.35, 'triangle', 0.1, 760),
    correct: c => [523, 659, 784].forEach((f, i) => tone(c, f, i * 0.1, 0.22, 'sine', 0.18)),
    wrong:   c => { tone(c, 220, 0, 0.18, 'sawtooth', 0.1); tone(c, 165, 0.17, 0.3, 'sawtooth', 0.1); },
    finish:  c => [523, 659, 784, 1047].forEach((f, i) => tone(c, f, 0.12 + i * 0.12, 0.3, 'triangle', 0.16))
  };
  return {
    get enabled() { return enabled; },
    setEnabled(v) { enabled = v; try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch (e) {} },
    play(name) {
      if (!enabled) return;
      try { const c = getCtx(); if (c && SOUNDS[name]) SOUNDS[name](c); } catch (e) {}
    }
  };
})();

document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button, input[type="checkbox"], input[type="radio"], .leaflet-control-layers-toggle, .leaflet-control-zoom a');
  if (b && !b.disabled && !b.closest('[data-silent]')) Sound.play('click');
});

// ---------- 地図の種類切り替え ----------
const MapTypes = L.Control.extend({
  options: { position: 'bottomleft' },
  initialize: function (layers, first, opts) { L.Util.setOptions(this, opts); this._layers = layers; this._first = first; },
  onAdd: function (map) {
    const box = L.DomUtil.create('div', 'mapTypeBox');
    L.DomEvent.disableClickPropagation(box);
    const btn = L.DomUtil.create('button', 'mapTypeBtn', box);
    btn.type = 'button'; btn.setAttribute('aria-label', '地図の種類を切り替える');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3 2 8l10 5 10-5-10-5zM2 12l10 5 10-5M2 16l10 5 10-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    const list = L.DomUtil.create('div', 'mapTypeList', box);
    list.hidden = true;
    const items = [];
    const select = name => {
      Object.entries(this._layers).forEach(([n, l]) => { if (n === name) l.addTo(map); else map.removeLayer(l); });
      items.forEach(it => it.classList.toggle('on', it.textContent === name));
      list.hidden = true;
    };
    Object.keys(this._layers).forEach(name => {
      const it = L.DomUtil.create('button', 'mapTypeItem', list);
      it.type = 'button'; it.textContent = name; it.onclick = () => select(name);
      items.push(it);
    });
    btn.onclick = () => { list.hidden = !list.hidden; };
    const first = Object.keys(this._layers).find(n => this._layers[n] === this._first);
    items.forEach(it => it.classList.toggle('on', it.textContent === first));
    return box;
  }
});

const PIN = L.divIcon({ className: 'pin', html: '<span></span>', iconSize: [24, 32], iconAnchor: [12, 30], popupAnchor: [0, -28], tooltipAnchor: [12, -14] });
const PIN_TEMP = L.divIcon({ className: 'pin temp', html: '<span></span>', iconSize: [24, 32], iconAnchor: [12, 30], popupAnchor: [0, -28], tooltipAnchor: [12, -14] });

function validLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(lat === 0 && lng === 0);
}
function toDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function toTimeStr(d) {
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function loadTrips() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRIP_KEY) || 'null');
    if (saved && saved.trips && saved.trips.length) return saved;
  } catch (e) {}
  const first = { id: Date.now(), name: '最初の旅行' };
  return { trips: [first], currentTripId: first.id };
}
function loadRecords(trips) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) {}
  return list
    .filter(r => validLatLng(r.lat, r.lng))
    .map(r => trips.some(t => t.id === r.tripId) ? r : { ...r, tripId: trips[0].id });
}

// ---------- 高画質の保管庫 (IndexedDB) ----------
const PhotoDB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open('travel-log-photos', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('full');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
    return dbp;
  }
  function run(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction('full', mode);
      const req = fn(tx.objectStore('full'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    })).catch(() => undefined);
  }
  return {
    put: (id, blob) => run('readwrite', st => st.put(blob, id)),
    get: id => run('readonly', st => st.get(id)),
    delete: id => run('readwrite', st => st.delete(id)),
    clear: () => run('readwrite', st => st.clear())
  };
})();
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

function readPhoto(file, thumbW = 800) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = v => { img.onload = img.onerror = null; img.src = ''; URL.revokeObjectURL(url); resolve(v); };
    img.onload = async () => {
      if (!img.width) { done(null); return; }
      const make = (scale, quality, asBlob) => new Promise(res => {
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const finish = out => { c.width = c.height = 0; res(out); };
        if (asBlob) c.toBlob(b => finish(b), 'image/jpeg', quality);
        else finish(c.toDataURL('image/jpeg', quality));
      });
      const thumb = await make(Math.min(1, thumbW / img.width), 0.7, false);
      const full = await make(Math.min(1, 2048 / Math.max(img.width, img.height)), 0.88, true);
      done({ thumb, full });
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

function orderRecords(list) {
  const idx = new Map(list.map((r, i) => [r.id, i]));
  const sorted = list.slice().sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') ||
    (a.time ? 0 : 1) - (b.time ? 0 : 1) ||
    (a.time || '').localeCompare(b.time || '') ||
    idx.get(a.id) - idx.get(b.id));
  let n = 0;
  return sorted.map(r => ({ ...r, n: r.time ? ++n : null }));
}
function numPin(n, active) {
  return L.divIcon({ className: 'pin num' + (active ? ' active' : ''), html: '<span><em>' + n + '</em></span>',
                     iconSize: [24, 32], iconAnchor: [12, 30], popupAnchor: [0, -28], tooltipAnchor: [12, -14] });
}
function matchRecord(r, kw, trips) {
  const words = (kw || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = trips.find(x => x.id === r.tripId);
  const hay = [r.title, r.memo, r.question, r.date, r.time, t && t.name].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
const LAST_BACKUP = 'travel-log-lastbackup';
function daysSinceBackup() {
  const t = Number(localStorage.getItem(LAST_BACKUP) || 0);
  return t ? Math.floor((Date.now() - t) / 86400000) : null;
}
function useHQ(record) {
  const id = record ? (record.pk !== undefined ? record.pk : record.id) : null;
  const [hq, setHq] = useState({ id: null, src: null });
  useEffect(() => {
    if (id === null) return;
    let alive = true, url = null;
    PhotoDB.get(id).then(b => { if (alive && b) { url = URL.createObjectURL(b); setHq({ id, src: url }); } });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return hq.id === id && hq.src ? hq.src : (record ? record.photo : null);
}

// 高画質の画像を遅延ロードして表示するコンポーネント（クイズやギャラリーで使用）
function HQImage({ record, className, alt, onClick, style }) {
  const src = useHQ(record);
  return <img src={src} className={className} alt={alt || ''} onClick={onClick} loading="lazy" decoding="async" style={style} />;
}

function getPhotos(r) { return r.photos || (r.photo ? [{ t: r.photo, k: r.id }] : []); }

const STATS_KEY = 'travel-log-quizstats';
function loadStats() {
  try { const st = JSON.parse(localStorage.getItem(STATS_KEY) || 'null'); if (st && st.rec) return st; } catch (e) {}
  return { rec: {}, runs: [] };
}
function recordRun(qs, results, score) {
  const st = loadStats();
  qs.forEach((q, i) => (q.type === 'place' ? q.answers : [q.record]).forEach(r => {
    const o = st.rec[r.id] || { r: 0, w: 0 };
    st.rec[r.id] = results[i] ? { r: o.r + 1, w: o.w } : { r: o.r, w: o.w + 1 };
  }));
  st.runs = [...st.runs, { t: Date.now(), score, total: qs.length }].slice(-50);
  try { localStorage.setItem(STATS_KEY, JSON.stringify(st)); } catch (e) {}
}
const isWeak = (st, id) => !!st.rec[id] && st.rec[id].w > st.rec[id].r;
function prio(items, preds) {
  const ps = preds.filter(Boolean);
  const score = x => ps.reduce((sum, p, i) => sum + (p(x) ? (1 << (ps.length - 1 - i)) : 0), 0);
  return shuffle(items).sort((a, b) => score(b) - score(a));
}

async function readPhotoInfo(file) {
  let gps = null, taken = null;
  try {
    if (typeof exifr !== 'undefined') {
      gps = await exifr.gps(file);
      const tags = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
      taken = tags && (tags.DateTimeOriginal || tags.CreateDate);
    }
  } catch (e) {}
  const good = !!gps && validLatLng(gps.latitude, gps.longitude);
  const hasDate = taken instanceof Date;
  const d = hasDate ? taken : new Date(file.lastModified);
  return {
    lat: good ? gps.latitude : null,
    lng: good ? gps.longitude : null,
    date: toDateStr(d), time: hasDate ? toTimeStr(d) : '', ts: d.getTime(), dateFromExif: hasDate
  };
}

function makePopup(r, onPhoto) {
  const div = document.createElement('div');
  div.innerHTML = '<b></b><br><small></small><p></p>';
  div.querySelector('b').textContent = (r.n ? r.n + '. ' : '') + r.title;
  div.querySelector('small').textContent = r.date + (r.time ? ' ' + r.time : '');
  div.querySelector('p').textContent = r.memo;
  if (r.photo) {
    const img = document.createElement('img');
    img.src = r.photo; img.className = 'popPhoto'; img.title = 'タップで拡大';
    if (onPhoto) img.addEventListener('click', () => onPhoto(r));
    div.appendChild(img);
  }
  return div;
}

function SearchBar({ onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [msg, setMsg] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setMsg('検索中...'); setResults([]);
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ja&limit=5&q='
                              + encodeURIComponent(q));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      setResults(list);
      setMsg(list.length ? '' : '見つかりませんでした。');
    } catch (err) {
      setMsg('検索できませんでした。時間をおいて試してください。');
    }
  }

  return (
    <div className="searchBar">
      <form className="searchForm" onSubmit={handleSubmit}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="場所を検索（例：京都駅）" />
        <button type="submit">検索</button>
      </form>
      {msg && <div className="result">{msg}</div>}
      <div className="results">
        {results.map(p => (
          <div key={p.place_id} className="result" onClick={() => { onPick(p); setResults([]); }}>
            {p.display_name}
          </div>
        ))}
      </div>
    </div>
  );
}

function MapView({ records, tripId, fitKey, selected, onSelect, focus, onPhoto }) {
  const divRef = useRef(null), mapRef = useRef(null), groupRef = useRef(null), lineRef = useRef(null);
  const markersRef = useRef({}), tempRef = useRef(null);

  useEffect(() => {
    const map = L.map(divRef.current).setView([36, 138], 5);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 21 });
    const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { maxNativeZoom: 18, maxZoom: 21 });
    osm.addTo(map);
    new MapTypes({ 'OpenStreetMap': osm, '航空写真': photo }, osm).addTo(map);
    groupRef.current = (L.markerClusterGroup ? L.markerClusterGroup({
      maxClusterRadius: 45, disableClusteringAtZoom: 16, showCoverageOnHover: false,
      iconCreateFunction: c => L.divIcon({ html: '<span>' + c.getChildCount() + '</span>', className: 'clusterIcon', iconSize: [38, 38] })
    }) : L.layerGroup()).addTo(map);
    lineRef.current = L.layerGroup().addTo(map);
    map.on('click', e => { Sound.play('pin'); onSelect(e.latlng); });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(divRef.current);
    return () => { ro.disconnect(); map.remove(); };
  }, []);

  useEffect(() => {
    groupRef.current.clearLayers();
    lineRef.current.clearLayers();
    markersRef.current = {};
    records.forEach(r => {
      if (!validLatLng(r.lat, r.lng)) return;
      const m = L.marker([r.lat, r.lng], { icon: r.n ? numPin(r.n) : PIN }).bindPopup(() => makePopup(r, onPhoto), { maxWidth: 150 });
      m.on('click', () => Sound.play('select'));
      groupRef.current.addLayer(m);
      markersRef.current[r.id] = m;
    });
    const byDay = {};
    records.filter(r => r.n && validLatLng(r.lat, r.lng)).forEach(r => (byDay[r.date] = byDay[r.date] || []).push([r.lat, r.lng]));
    Object.values(byDay).forEach(pts => {
      if (pts.length > 1) lineRef.current.addLayer(L.polyline(pts, { color: '#b08a52', weight: 3, opacity: .85, dashArray: '6 8', interactive: false }));
    });
  }, [records]);

  useEffect(() => {
    const pts = records.filter(r => validLatLng(r.lat, r.lng)).map(r => [r.lat, r.lng]);
    if (!pts.length) return;
    try { mapRef.current.fitBounds(pts, { maxZoom: 15, padding: [40, 40] }); } catch (e) {}
  }, [tripId, fitKey]);

  useEffect(() => {
    if (tempRef.current) { mapRef.current.removeLayer(tempRef.current); tempRef.current = null; }
    if (selected) {
      tempRef.current = L.marker(selected, { icon: PIN_TEMP }).addTo(mapRef.current)
        .bindTooltip('クリックで取り消し').on('click', () => { Sound.play('delete'); onSelect(null); });
    }
  }, [selected]);

  useEffect(() => {
    if (!focus) return;
    const m = markersRef.current[focus.id];
    if (!m) return;
    const map = mapRef.current, target = m.getLatLng();
    const showMarker = mk => groupRef.current.zoomToShowLayer ? groupRef.current.zoomToShowLayer(mk, () => mk.openPopup()) : mk.openPopup();
    const zoom = Math.max(map.getZoom(), 16);
    if (map.getCenter().distanceTo(target) < 5 && map.getZoom() === zoom) { Sound.play('select'); showMarker(m); return; }
    map.once('moveend', () => showMarker(m));
    Sound.play('move');
    map.flyTo(target, zoom, { duration: 1.5 });
  }, [focus]);

  function handlePick(p) {
    Sound.play('move');
    const map = mapRef.current;
    if (p.boundingbox) {
      const bb = p.boundingbox.map(Number);
      map.flyToBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17, duration: 1.5 });
    } else {
      map.flyTo([Number(p.lat), Number(p.lon)], 17, { duration: 1.5 });
    }
    onSelect(L.latLng(Number(p.lat), Number(p.lon)));
  }

  return (
    <div className="mapWrap">
      <SearchBar onPick={handlePick} />
      <div className="map" ref={divRef}></div>
    </div>
  );
}

function RecordForm({ selected, onAdd, editing, onUpdate, onCancel, trips }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [question, setQuestion] = useState('');
  const [time, setTime] = useState('');
  const [tripId, setTripId] = useState(null);
  const [kept, setKept] = useState([]);
  const [msg, setMsg] = useState('地図をクリックして場所を選んでください');
  const fileRef = useRef(null), formRef = useRef(null);

  useEffect(() => {
    if (fileRef.current) fileRef.current.value = '';
    if (editing) {
      setTitle(editing.title); setDate(editing.date); setMemo(editing.memo || '');
      setQuestion(editing.question || ''); setTime(editing.time || '');
      setTripId(editing.tripId); setKept(getPhotos(editing));
      setMsg('編集中：場所を変えるときは、地図をクリックしてください');
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTitle(''); setDate(''); setMemo(''); setQuestion(''); setTime(''); setKept([]);
      setMsg(m => m.startsWith('編集中') ? '' : m);
    }
  }, [editing]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!editing && !selected) { setMsg('先に地図をクリックしてください！'); return; }
    const added = [], fulls = [];
    for (const f of Array.from(fileRef.current.files)) {
      const pr = await readPhoto(f, 800);
      if (!pr) continue;
      const k = Date.now() + '-' + added.length + '-' + Math.random().toString(36).slice(2, 6);
      added.push({ t: pr.thumb, k }); fulls.push({ k, blob: pr.full });
    }
    if (editing) {
      const photos = [...kept, ...added];
      const removeKeys = getPhotos(editing).filter(p => !kept.some(x => x.k === p.k)).map(p => p.k);
      const changes = { title, date, time, memo, question, tripId, photos, photo: photos[0] ? photos[0].t : null, _fulls: fulls, _removeKeys: removeKeys };
      if (selected) { changes.lat = selected.lat; changes.lng = selected.lng; }
      onUpdate(editing.id, changes);
      return;
    }
    onAdd({ id: Date.now(), title, date, time, memo, question, lat: selected.lat, lng: selected.lng,
            photos: added, photo: added[0] ? added[0].t : null, _fulls: fulls });
    setTitle(''); setDate(''); setMemo(''); setQuestion(''); setTime('');
    fileRef.current.value = '';
    setMsg('');
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      <label>写真のタイトル <input value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label>日付 <input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
      <label>時刻（任意） <input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
      <label>メモ <textarea rows="2" value={memo} onChange={e => setMemo(e.target.value)} /></label>
      <label>クイズの質問（任意）
        <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="例：お昼ご飯は？" />
      </label>
      {editing && trips && (
        <label>この記録の旅行
          <select value={tripId || ''} onChange={e => setTripId(Number(e.target.value))}>
            {trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {editing && kept.length > 0 && (
        <div>
          <small>今の写真（×で外します）</small>
          <div className="keptRow">
            {kept.map(p => (
              <span className="keptThumb" key={p.k}>
                <img src={p.t} alt="" />
                <button type="button" aria-label="この写真を外す" onClick={() => setKept(kept.filter(x => x.k !== p.k))}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <label>{editing ? '写真を追加する（複数選べます）' : '写真（複数選べます）'}
        <input type="file" accept="image/*" multiple ref={fileRef} />
      </label>
      <button type="submit">{editing ? '更新する' : 'この場所を記録する'}</button>
      {editing && <button type="button" className="ghost" onClick={onCancel}>編集をやめる</button>}
      <div className="msg">{msg}</div>
    </form>
  );
}

function BulkImport({ onAdd, selected }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState({});

  async function handleFiles(e) {
    let files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
    e.target.value = '';
    if (!files.length) return;
    const MAX = 20;
    if (files.length > MAX) {
      Dialog.alert('一度に読み込めるのは' + MAX + '枚までです。最初の' + MAX + '枚を読み込みます');
      files = files.slice(0, MAX);
    }
    setBusy(true);
    try {
      const list = [];
      for (const f of files) {
        const info = await readPhotoInfo(f);
        const pr = await readPhoto(f, 480);
        list.push({ key: f.name + f.size + f.lastModified, title: f.name.replace(/\.[^.]+$/, ''), photo: pr ? pr.thumb : null, full: pr ? pr.full : null, ...info });
        await new Promise(r => setTimeout(r, 80));
      }
      list.sort((a, b) => a.ts - b.ts);
      setItems(list);
    } catch (err) { Dialog.alert('写真の読み込み中に問題が起きました：' + err.message); } finally { setBusy(false); }
  }

  const ok = items.filter(i => validLatLng(i.lat, i.lng) && i.photo);
  const noGps = items.filter(i => !validLatLng(i.lat, i.lng) && i.photo);
  const broken = items.filter(i => !i.photo).length;
  const chosen = noGps.filter(i => pick[i.key]);

  function toRecords(list, lat, lng) {
    return list.map((i, n) => ({
      id: Date.now() + n, title: i.title, date: i.date, time: i.time || '', memo: '',
      lat: lat !== undefined ? lat : i.lat, lng: lng !== undefined ? lng : i.lng, photo: i.photo, _full: i.full
    }));
  }
  function importAll() { onAdd(toRecords(ok)); setItems(items.filter(i => !ok.includes(i))); }
  function importToSelected() {
    onAdd(toRecords(chosen, selected.lat, selected.lng));
    setItems(items.filter(i => !chosen.includes(i)));
    setPick({});
  }

  return (
    <div>
      <h2>写真をまとめて追加</h2>
      <label>写真を選ぶ（複数選択できます）
        <input type="file" accept="image/*" multiple onChange={handleFiles} />
      </label>
      <label>フォルダごと選ぶ（パソコン推奨）
        <input type="file" webkitdirectory="" multiple onChange={handleFiles} />
      </label>
      {busy && <div className="msg">読み込み中...</div>}
      {items.map(i => (
        <div className="record" key={i.key} style={{ cursor: 'default' }}>
          {i.photo ? <img src={i.photo} /> : <div className="msg">読み込めない形式です</div>}
          <input value={i.title} onChange={e => setItems(items.map(x => x.key === i.key ? { ...x, title: e.target.value } : x))} />
          <small>{i.date}{i.time ? ' ' + i.time : ''}{i.dateFromExif ? '（撮影日時）' : '（ファイルの更新日）'}</small><br />
          <small className={validLatLng(i.lat, i.lng) ? 'tag ok' : 'tag ng'}>{validLatLng(i.lat, i.lng) ? '位置情報あり' : '位置情報なし'}</small>
          {!validLatLng(i.lat, i.lng) && i.photo && (
            <label className="pickRow">
              <input type="checkbox" checked={!!pick[i.key]} onChange={e => setPick({ ...pick, [i.key]: e.target.checked })} />
              この写真の場所を設定する
            </label>
          )}
        </div>
      ))}
      {ok.length > 0 && <button onClick={importAll}>位置情報のある{ok.length}件を記録する</button>}
      {noGps.length > 0 && (
        <div className="pickBar">
          <div className="pickInfo">位置情報のない写真：{noGps.length}件（選択中 {chosen.length}件）</div>
          <div className="pickBtns">
            <button className="ghost" onClick={() => setPick(Object.fromEntries(noGps.map(i => [i.key, true])))}>すべて選ぶ</button>
            <button className="ghost" onClick={() => setPick({})}>選択を外す</button>
          </div>
          {chosen.length === 0
            ? <div className="msg">場所を設定する写真を選んでください。1枚ずつ設定するときは、1枚だけ選んで、地図で場所を選び、記録します。</div>
            : selected
              ? <button onClick={importToSelected}>選んだ{chosen.length}件を、地図で選んだ場所に記録する</button>
              : <div className="msg">選んだ{chosen.length}件の場所を、地図をクリック（または検索）して選んでください</div>}
        </div>
      )}
      {broken > 0 && <div className="msg">{broken}件は、読み込めない形式のため登録できません</div>}
      {items.length > 0 && <button className="ghost" onClick={() => { setItems([]); setPick({}); }}>一覧を閉じる</button>}
    </div>
  );
}

function Lightbox({ record, tripName, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { Sound.play('open'); return () => Sound.play('close'); }, []);
  const photos = getPhotos(record);
  const [pi, setPi] = useState(0);
  const cur = photos[Math.min(pi, photos.length - 1)] || { t: record.photo, k: record.id };
  const [src, setSrc] = useState(cur.t);
  const [hq, setHq] = useState(null);
  useEffect(() => {
    setSrc(cur.t); setHq(null);
    let alive = true, url = null;
    PhotoDB.get(cur.k).then(blob => {
      if (!alive) return;
      if (blob) { url = URL.createObjectURL(blob); setSrc(url); setHq(true); } else setHq(false);
    });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [cur.k]);
  return ReactDOM.createPortal(
    <div className="lightbox" onClick={e => { e.stopPropagation(); onClose(); }}>
      <figure className="lightboxBody" onClick={e => e.stopPropagation()}>
        <button className="lightboxClose" aria-label="閉じる" onClick={e => { e.stopPropagation(); onClose(); }}>×</button>
        <img src={src} alt={record.title} />
        {photos.length > 1 && (<>
          <button className="lbNav prev" aria-label="前の写真" onClick={e => { e.stopPropagation(); setPi((pi + photos.length - 1) % photos.length); }}>‹</button>
          <button className="lbNav next" aria-label="次の写真" onClick={e => { e.stopPropagation(); setPi((pi + 1) % photos.length); }}>›</button>
          <span className="lbCount">{Math.min(pi, photos.length - 1) + 1} / {photos.length}</span>
        </>)}
        <figcaption>
          <b>{record.title}</b>
          <small>{record.date}{record.time ? ' ' + record.time : ''}{tripName ? ' ／ ' + tripName : ''}</small>
          {record.question && <small>問：{record.question}</small>}
          {record.memo && <p>{record.memo}</p>}
          {hq === false && <small>この写真は、保存時の画質で表示しています</small>}
        </figcaption>
      </figure>
    </div>,
    document.body
  );
}

function RecordCard({ record, isEditing, isViewOnly, onFocus, onEdit, onDelete }) {
  const [zoom, setZoom] = useState(false);
  const [gone, setGone] = useState(false);
  async function remove(e) {
    e.stopPropagation();
    if (!(await Dialog.confirm('「' + record.title + '」を削除しますか？', { danger: true, okText: '削除する' }))) return;
    setGone(true);
    setTimeout(() => onDelete(record.id), 280);
  }
  return (
    <div className={'record' + (isEditing ? ' editing' : '') + (gone ? ' gone' : '')} onClick={() => onFocus(record.id)}>
      {zoom && <Lightbox record={record} onClose={() => setZoom(false)} />}
      <div className="recordRow">
        {record.n && <span className="recordNo">{record.n}</span>}
        {record.photo && <img className="thumb" src={record.photo} alt="" loading="lazy" decoding="async"
             onClick={e => { e.stopPropagation(); setZoom(true); }} />}
        <div className="recordBody">
          <b>{record.title}</b>
          <small>{record.date}{record.time ? ' ' + record.time : ''}{getPhotos(record).length > 1 ? '　写真' + getPhotos(record).length + '枚' : ''}</small>
          {record.question && <small className="qline">問：{record.question}</small>}
          {!isViewOnly && <div>
            <button className="edit" onClick={e => { e.stopPropagation(); onEdit(record.id); }}>編集</button>
            <button className="del" onClick={remove}>削除</button>
          </div>}
        </div>
      </div>
    </div>
  );
}

function Marquee({ items, reverse, onPick }) {
  const base = [];
  while (base.length < 10) base.push(...items);
  return (
    <div className={'marquee' + (reverse ? ' rev' : '')}>
      <div className="marqueeTrack">
        {[...base, ...base].map((r, i) => (
          <img key={i} className="bubble" src={r.photo} alt={r.title} loading="lazy" decoding="async" onClick={() => onPick(r)} />
        ))}
      </div>
    </div>
  );
}

function Home({ trips, records, onGo, onReset, isViewOnly, onSetViewOnly }) {
  const photoCount = records.filter(r => r.photo).length;
  const days = daysSinceBackup();
  const [view, setView] = useState(null);
  const bubbles = useMemo(() => shuffle(records.filter(r => r.photo)).slice(0, 8), [records]);
  const trip = view && trips.find(t => t.id === view.tripId);
  return (
    <div className="screen home">
      {bubbles.length > 0 && <Marquee items={bubbles} reverse onPick={setView} />}
      <div className="inner">
        <div className="homeEyebrow">TRAVEL JOURNAL</div>
        <h1>自分だけの旅行記録</h1>
        <p className="homeLead">旅の思い出を残して思い出そう。</p>
        <div className="homeStats">
          <div><b>{trips.length}</b><span>旅行</span></div>
          <div><b>{records.length}</b><span>記録</span></div>
          <div><b>{photoCount}</b><span>写真</span></div>
        </div>
        {isViewOnly && (
          <div className="msg" style={{textAlign:"center",marginBottom:12}}>
            ※ 現在、閲覧専用モードです。編集はできません。<br/>
            <button className="ghost" style={{marginTop: 8}} onClick={() => onSetViewOnly(false)}>編集モードに戻る</button>
          </div>
        )}
        <button className="homeBtn" onClick={() => onGo('register')}>
          <span className="homeBtnTitle">{isViewOnly ? '旅行の記録を見る' : '旅行を記録する'}</span><small>{isViewOnly ? '地図と写真で旅の記録を閲覧します' : '地図と写真で旅の記録を登録・編集'}</small>
        </button>
        <button className="homeBtn" disabled={photoCount < 2} onClick={() => onGo('quiz')}>
          <span className="homeBtnTitle">旅行の記憶クイズに挑戦</span>
          <small>{photoCount < 2 ? '写真つきの記録が2件以上になると遊べます' : '写真を選んで、旅の思い出を取り戻そう'}</small>
        </button>
        <button className="homeBtn" disabled={photoCount < 1} onClick={() => onGo('gallery')}>
          <span className="homeBtnTitle">旅の写真をスライドショーで見る</span><small>旅ごとの写真の振り返り</small>
        </button>
        <button className="homeBtn" disabled={isViewOnly} onClick={() => onGo('data')}>
          <span className="homeBtnTitle">データの保存・共有</span>
          <small>{days === null ? 'まだバックアップがありません。ファイルに書き出して保管しましょう' : days >= 30 ? days + '日前にバックアップしました。そろそろ書き出しましょう' : '最後のバックアップ：' + (days === 0 ? '今日' : days + '日前')}</small>
        </button>
      </div>
      <div className="resetRow">{!isViewOnly && <button className="ghost danger" onClick={onReset}>すべての記録をリセット</button>}</div>
      {bubbles.length > 0 && <Marquee items={bubbles.slice().reverse()} onPick={setView} />}
      {view && <Lightbox record={view} tripName={trip ? trip.name : ''} onClose={() => setView(null)} />}
    </div>
  );
}

const HIT_M = 2000;
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function tripHeader(trips, tripId) {
  const t = trips.find(x => x.id === tripId);
  return t ? '旅行：' + t.name : '';
}
function timeGroups(records, style) {
  const map = {};
  records.forEach(r => {
    if (!r.time || !validLatLng(r.lat, r.lng)) return;
    const slot = style === 'hour' ? r.time.slice(0, 2) : r.time;
    const key = r.tripId + '|' + r.date + '|' + slot;
    if (!map[key]) map[key] = { tripId: r.tripId, date: r.date, slot, records: [] };
    map[key].records.push(r);
  });
  return Object.values(map);
}
function slotLabel(g, style) { return style === 'hour' ? Number(g.slot) + '時台' : g.slot + ' ごろ'; }

function makeQuestions(pool, allPhotos, count, trips, favCustom, weak) {
  const base = prio(pool, [weak, favCustom ? r => r.question : null]);
  return base.slice(0, count).map(r => {
    const others = allPhotos.filter(x => x.id !== r.id && x.photo !== r.photo);
    const same = shuffle(others.filter(x => x.tripId === r.tripId));
    const diff = shuffle(others.filter(x => x.tripId !== r.tripId));
    return {
      type: 'photo', record: r,
      header: tripHeader(trips, r.tripId) + ' ／ ' + r.date + (r.question ? ' ／ ' + r.title : ''),
      text: r.question || '「' + r.title + '」の写真はどれでしょう？',
      choices: shuffle([r, ...[...same, ...diff].slice(0, 3)])
    };
  });
}
function makePlaceQuestions(groups, trips, count, style, weak) {
  return prio(groups, [weak && (g => g.records.some(weak))]).slice(0, count).map(g => ({
    type: 'place', answers: g.records, circle: hintCircle(g.records[0]),
    header: tripHeader(trips, g.tripId),
    text: g.date + ' の ' + slotLabel(g, style) + 'はどこにいた？'
  }));
}
function makeTimePhotoQuestions(groups, allPhotos, trips, count, style, weak) {
  return prio(groups, [weak && (g => g.records.some(weak))]).slice(0, count).map(g => {
    const ids = g.records.map(r => r.id);
    const correct = shuffle(g.records.filter(r => r.photo))[0];
    const others = allPhotos.filter(x => !ids.includes(x.id) && x.photo !== correct.photo);
    const same = shuffle(others.filter(x => x.tripId === g.tripId));
    const diff = shuffle(others.filter(x => x.tripId !== g.tripId));
    return {
      type: 'photo', record: correct,
      header: tripHeader(trips, g.tripId),
      text: g.date + ' の ' + slotLabel(g, style) + '、いた場所の写真はどれ？',
      choices: shuffle([correct, ...[...same, ...diff].slice(0, 3)])
    };
  });
}
function fmtDist(d) { return d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'; }
function nearestDist(guess, answers) { return Math.min(...answers.map(a => guess.distanceTo(L.latLng(a.lat, a.lng)))); }
function makeCustomPlaceQuestions(pool, trips, count) {
  return shuffle(pool).slice(0, count).map(r => ({
    type: 'place', custom: true, answers: [r], circle: hintCircle(r),
    header: tripHeader(trips, r.tripId) + ' ／ ' + r.date,
    text: r.question + '（答えの場所を、地図で選んでください）'
  }));
}
function hintCircle(r) {
  const ang = Math.random() * 2 * Math.PI, off = 2000 * (0.4 + 0.6 * Math.random());
  return {
    lat: r.lat + (off * Math.cos(ang)) / 111320,
    lng: r.lng + (off * Math.sin(ang)) / (111320 * Math.cos(r.lat * Math.PI / 180)),
    r: 4000
  };
}
function makeHints(q) {
  const out = [];
  if (q.type === 'place') {
    const memo = q.answers.find(x => x.memo), pic = q.answers.find(x => x.photo);
    if (memo) out.push({ kind: 'text', label: 'メモ', text: memo.memo });
    out.push({ kind: 'circle', label: '場所の範囲' });
    if (pic) out.push({ kind: 'photo', label: '写真', record: pic });
    out.push({ kind: 'text', label: '場所の名前', text: q.answers.map(x => x.title).join('、') });
  } else {
    const r = q.record, seen = q.text + q.header;
    if (r.time && !seen.includes(r.time)) out.push({ kind: 'text', label: '時刻', text: r.time });
    if (r.memo) out.push({ kind: 'text', label: 'メモ', text: r.memo });
    if (!seen.includes(r.title)) out.push({ kind: 'text', label: 'タイトル', text: r.title });
    if (q.choices.length >= 3) out.push({ kind: 'fifty', label: '選択肢を減らす' });
  }
  return out;
}

function GuessMap({ guess, onGuess, revealed, answers, startPts, hintCircle }) {
  const divRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null), hintRef = useRef(null);
  const onGuessRef = useRef(onGuess);
  onGuessRef.current = onGuess;

  useEffect(() => {
    const map = L.map(divRef.current).setView([36, 138], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 21 }).addTo(map);
    hintRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    if (startPts.length) map.fitBounds(startPts, { padding: [30, 30], maxZoom: 12 });
    map.on('click', e => { Sound.play('pin'); onGuessRef.current(e.latlng); });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  const ansKey = JSON.stringify(answers.map(a => [a.lat, a.lng]));
  useEffect(() => {
    const g = layerRef.current;
    g.clearLayers();
    if (guess) {
      L.circleMarker(guess, { radius: 9, color: '#14213d', fillOpacity: 0.8 }).addTo(g).bindTooltip('あなたの答え', { permanent: revealed });
    }
    if (revealed && guess) {
      const pts = answers.map(a => L.latLng(a.lat, a.lng));
      pts.forEach(pt => L.circleMarker(pt, { radius: 9, color: '#2f6b4f', fillOpacity: 0.8 }).addTo(g).bindTooltip('正解の場所', { permanent: true }));
      const near = pts.reduce((a, b) => guess.distanceTo(a) <= guess.distanceTo(b) ? a : b);
      L.polyline([guess, near], { color: '#888', dashArray: '6' }).addTo(g);
      mapRef.current.fitBounds([guess, ...pts], { padding: [60, 60], maxZoom: 16 });
    }
  }, [guess, revealed, ansKey]);

  const hintKey = hintCircle ? hintCircle.lat + ',' + hintCircle.lng : '';
  useEffect(() => {
    const g = hintRef.current;
    g.clearLayers();
    if (!hintCircle) return;
    const c = L.circle([hintCircle.lat, hintCircle.lng], { radius: hintCircle.r, color: '#b08a52', weight: 2, dashArray: '6 6', fillOpacity: 0.12, interactive: false }).addTo(g);
    mapRef.current.flyToBounds(c.getBounds(), { padding: [30, 30], duration: 0.8 });
  }, [hintKey]);

  function flyTo(p) {
    Sound.play('move');
    const map = mapRef.current;
    if (p.boundingbox) {
      const bb = p.boundingbox.map(Number);
      map.flyToBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 16, duration: 1 });
    } else {
      map.flyTo([Number(p.lat), Number(p.lon)], 14, { duration: 1 });
    }
  }
  return <><div ref={divRef} style={{ position: 'absolute', inset: 0 }}></div><SearchBar onPick={flyTo} /></>;
}

function ResultMap({ points, active }) {
  const divRef = useRef(null), mapRef = useRef(null), markersRef = useRef([]);
  useEffect(() => {
    const map = L.map(divRef.current).setView([36, 138], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 21 }).addTo(map);
    const latlngs = [];
    points.forEach(pt => {
      const tip = document.createElement('span');
      tip.textContent = pt.n + '. ' + pt.title;
      const m = L.marker([pt.lat, pt.lng], { icon: numPin(pt.n) }).addTo(map).bindTooltip(tip);
      markersRef.current.push({ n: pt.n, m });
      latlngs.push([pt.lat, pt.lng]);
    });
    if (latlngs.length) map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(divRef.current);
    return () => { ro.disconnect(); map.remove(); };
  }, []);

  useEffect(() => {
    if (!active) return;
    Sound.play('move');
    const map = mapRef.current;
    const hit = markersRef.current.filter(x => x.n === active.n);
    markersRef.current.forEach(x => {
      const on = x.n === active.n;
      x.m.setIcon(numPin(x.n, on));
      x.m.setZIndexOffset(on ? 1000 : 0);
    });
    divRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (hit.length === 1) { map.flyTo(hit[0].m.getLatLng(), Math.max(map.getZoom(), 15), { duration: 1 }); hit[0].m.openTooltip(); }
    else if (hit.length > 1) map.flyToBounds(hit.map(x => x.m.getLatLng()), { padding: [50, 50], maxZoom: 16, duration: 1 });
  }, [active]);

  return <div className="guessMap"><div ref={divRef} style={{ position: 'absolute', inset: 0 }}></div></div>;
}

function Quiz({ records, trips, currentTripId, onExit }) {
  const [phase, setPhase] = useState('setup');
  const [kinds, setKinds] = useState({ photo: true, place: true, timePhoto: true });
  const [timeStyle, setTimeStyle] = useState('hour');
  const [tripSel, setTripSel] = useState('all');
  const [count, setCount] = useState(5);
  const [favCustom, setFavCustom] = useState(true);
  const [qs, setQs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const [guess, setGuess] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState(0);
  const [results, setResults] = useState([]);
  const [hintLevel, setHintLevel] = useState(0);
  const [hintLog, setHintLog] = useState([]);
  const [stats, setStats] = useState(loadStats);
  const [review, setReview] = useState(false);
  useEffect(() => { if (phase === 'result') { recordRun(qs, results, score); setStats(loadStats()); } }, [phase]);
  const [active, setActive] = useState(null);
  const [lb, setLb] = useState(null);

  const inTrip = r => tripSel === 'all' || String(r.tripId) === tripSel;
  const withPhoto = records.filter(r => r.photo);
  const photoPool = withPhoto.filter(inTrip);
  const weakCount = records.filter(r => inTrip(r) && isWeak(stats, r.id)).length;
  const myQ = records.filter(r => inTrip(r) && r.question);
  const customPlace = myQ.filter(r => !r.photo && validLatLng(r.lat, r.lng));
  const groups = timeGroups(records.filter(inTrip), timeStyle);
  const tpGroups = groups.filter(g => {
    const n = g.records.filter(r => r.photo).length;
    return n > 0 && withPhoto.length > n;
  });
  const usePhoto = kinds.photo && withPhoto.length >= 2;
  const available = (usePhoto ? photoPool.length : 0) + (kinds.place ? groups.length : 0) + (kinds.timePhoto ? tpGroups.length : 0) + (kinds.photo ? customPlace.length : 0);

  function start() {
    let list = [];
    if (usePhoto) list = list.concat(makeQuestions(photoPool, withPhoto, count, trips, favCustom, review ? (r => isWeak(stats, r.id)) : null));
    if (kinds.photo) list = list.concat(makeCustomPlaceQuestions(customPlace, trips, count));
    if (kinds.place) list = list.concat(makePlaceQuestions(groups, trips, count, timeStyle, review ? (r => isWeak(stats, r.id)) : null));
    if (kinds.timePhoto) list = list.concat(makeTimePhotoQuestions(tpGroups, withPhoto, trips, count, timeStyle, review ? (r => isWeak(stats, r.id)) : null));
    const mine = list.filter(x => (favCustom && (x.custom || (x.type === 'photo' && x.record.question))) ||
      (review && (x.type === 'place' ? x.answers : [x.record]).some(r => isWeak(stats, r.id))));
    const others = shuffle(list.filter(x => !mine.includes(x)));
    setQs(shuffle([...shuffle(mine), ...others].slice(0, count)));
    setIdx(0); setPicked(null); setGuess(null); setRevealed(false); setScore(0); setResults([]); setHintLog([]); setHintLevel(0); setActive(null); setPhase('play');
  }
  function answer(c) {
    if (picked) return;
    setPicked(c.id);
    const ok = c.id === qs[idx].record.id;
    Sound.play(ok ? 'correct' : 'wrong');
    setResults(r => [...r, ok]);
    setHintLog(h => [...h, hintLevel]);
    if (ok) setScore(s => s + 1);
  }
  function submitGuess() {
    if (!guess || revealed) return;
    setRevealed(true);
    const hit = nearestDist(guess, qs[idx].answers) <= HIT_M;
    Sound.play(hit ? 'correct' : 'wrong');
    setResults(r => [...r, hit]);
    setHintLog(h => [...h, hintLevel]);
    if (hit) setScore(s => s + 1);
  }
  function next() {
    if (idx + 1 >= qs.length) {
      if (score >= qs.length / 2) Sound.play('finish');
      setPhase('result'); return;
    }
    setIdx(idx + 1); setPicked(null); setGuess(null); setRevealed(false); setHintLevel(0);
  }

  if (phase === 'setup') return (
    <div className="screen"><div className="inner">
      <button className="ghost" onClick={onExit}>‹ タイトルへ</button>
      <h2>旅の記憶クイズ</h2>
      
      <label>問題を出題する旅行（「すべての旅行」で全部を混ぜて出題します）
        <select value={tripSel} onChange={e => setTripSel(e.target.value)}>
          <option value="all">すべての旅行（混ぜる）</option>
          {trips.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
        </select>
      </label>
      
      <label>問題数
        <select value={count} onChange={e => setCount(Number(e.target.value))}>
          {[3, 5, 10].map(n => <option key={n} value={n}>{n}問</option>)}
        </select>
      </label>

      <details className="acc">
        <summary>詳細設定（出題範囲・難易度など）</summary>
        <div className="accBody">
          <div style={{ marginTop: 10, fontSize: 13 }}>問題の種類（複数選ぶと混ぜて出題します）</div>
          {[['photo', '質問・タイトルから写真を選ぶ'],
            ['place', '時間からその時に居た場所を"地図"で選ぶ'],
            ['timePhoto', '時間からその時にいた場所の"写真"を選ぶ']].map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={kinds[k]} style={{ width: 'auto' }}
                     onChange={e => setKinds({ ...kinds, [k]: e.target.checked })} /> {label}
            </label>
          ))}
          {(kinds.place || kinds.timePhoto) && (
            <label>時間の聞き方
              <select value={timeStyle} onChange={e => setTimeStyle(e.target.value)}>
                <option value="hour">（大まかな時間  例:12時台）</option>
                <option value="exact"> 細かな時刻 （例：12:30頃）</option>
              </select>
            </label>
          )}

          <div className="dataCard" style={{ marginTop: 12 }}>
            成績：{stats.runs.length}回挑戦
            {stats.runs.length > 0 && '／平均正答率 ' + Math.round(stats.runs.reduce((a, r) => a + r.score / r.total, 0) / stats.runs.length * 100) + '%'}
            <div>間違いの多い記録：{weakCount}件</div>
            {stats.runs.length > 0 && (
              <button className="ghost" style={{ marginTop: 8 }} onClick={async () => {
                if (await Dialog.confirm('クイズの成績をすべて消します。よろしいですか？', { danger: true, okText: '消す' })) { localStorage.removeItem(STATS_KEY); setStats(loadStats()); }
              }}>成績を消す</button>
            )}
          </div>
          <label>
            <input type="checkbox" checked={review} style={{ width: 'auto' }} onChange={e => setReview(e.target.checked)} /> 間違えた記録を優先して出題する（復習）
          </label>
          <label>
            <input type="checkbox" checked={favCustom} style={{ width: 'auto' }} onChange={e => setFavCustom(e.target.checked)} /> 自分で作った質問を、優先して出題する
          </label>
          <p style={{ fontSize: 12, color: '#666', margin: '2px 0 0' }}>
            自作の質問つきの記録：{myQ.length}件（うち写真なし{customPlace.length}件は、地図で場所を選ぶ問題になります）
          </p>
          <p style={{ fontSize: 13 }}>
            出題できる数：写真（質問・タイトル）{photoPool.length} ／ 時間から場所 {groups.length} ／ 時間から写真 {tpGroups.length}
          </p>
        </div>
      </details>

      {kinds.photo && withPhoto.length < 2 && <p className="msg">写真の問題には、写真つきの記録が2件以上必要です</p>}
      {(kinds.place || kinds.timePhoto) && groups.length === 0 &&
        <p className="msg">時間の問題には、「時刻」を入れた記録が必要です（記録の「編集」で入れられます）</p>}
      <button onClick={start} disabled={available < 1}>スタート</button>
      <p style={{ fontSize: 12, color: '#666' }}>
        ヒント：記録するとき「クイズの質問」（例：お昼ご飯は？）を書くと、写真の問題でその質問が出ます。
      </p>
    </div></div>
  );

  if (phase === 'play') {
    const q = qs[idx];
    const hints = makeHints(q);
    const answered = q.type === 'place' ? revealed : !!picked;
    const shown = hints.slice(0, hintLevel);
    const fiftyOn = shown.some(h => h.kind === 'fifty');
    const circleOn = shown.some(h => h.kind === 'circle');
    const elimIds = q.type === 'photo' ? q.choices.filter(c => c.id !== q.record.id).slice(0, 2).map(c => c.id) : [];
    const hintUI = (
      <div className="hintArea">
        <button className="hintBtn" disabled={answered || hintLevel >= hints.length} onClick={() => setHintLevel(l => l + 1)}>
          {hintLevel >= hints.length ? 'ヒントは、すべて表示しました' : 'ヒントを見る（あと' + (hints.length - hintLevel) + '回）'}
        </button>
        {shown.map((h, i) => (
          <div className="hintItem" key={i}>
            <span className="hintLabel">ヒント{i + 1}：{h.label}</span>
            {h.kind === 'text' && <span>{h.text}</span>}
            {h.kind === 'photo' && <HQImage className="hintPhoto" record={h.record} alt="" />}
            {h.kind === 'circle' && <span>地図の円の中に、答えがあります</span>}
            {h.kind === 'fifty' && <span>違う写真を、2枚薄くしました</span>}
          </div>
        ))}
      </div>
    );
    const bar = <div className="quizHeader">第{idx + 1}問 / {qs.length}　正解 {score}</div>;

    if (q.type === 'place') {
      const d = revealed && guess ? nearestDist(guess, q.answers) : 0;
      const pic = q.answers.find(a => a.photo);
      const memo = q.answers.find(a => a.memo);
      return (
        <div className="screen"><div className="inner fade" key={idx}>
          {bar}
          <div className="quizHeader">{q.header}</div>
          <div className="quizQ">{q.text}</div>
          {hintUI}
          <div className="guessMap">
            <GuessMap key={idx} hintCircle={circleOn ? q.circle : null} guess={guess} revealed={revealed} answers={q.answers}
                      startPts={[...groups.flatMap(g => g.records.map(x => [x.lat, x.lng])), ...customPlace.map(x => [x.lat, x.lng])]}
                      onGuess={g => { if (!revealed) setGuess(g); }} />
          </div>
          {!revealed && (
            <button data-silent="1" onClick={submitGuess} disabled={!guess}>
              {guess ? 'ここで回答する' : '地図をタップして、場所を選んでください'}
            </button>
          )}
          {revealed && (
            <div className={'fb ' + (d <= HIT_M ? 'ok' : 'ng')}>
              <b>{d <= HIT_M ? '正解です！' : d <= HIT_M * 5 ? 'おしい！もう少し！' : '残念…違います。'}</b>
              <div>正解の場所まで {fmtDist(d)}（{fmtDist(HIT_M)}以内で正解）</div>
              {q.answers.map(a => <div key={a.id}>{a.time} ／ {a.title}</div>)}
              {memo && <div style={{ fontSize: 13 }}>{memo.memo}</div>}
              {pic && <HQImage record={pic} style={{ width: '100%', borderRadius: 6, marginTop: 6 }} />}
              <button onClick={next}>{idx + 1 >= qs.length ? '結果を見る' : '次の問題へ'}</button>
            </div>
          )}
        </div></div>
      );
    }

    const r = q.record;
    return (
      <div className="screen"><div className="inner fade" key={idx}>
        {bar}
        <div className="quizHeader">{q.header}</div>
        <div className="quizQ">{q.text}</div>
          {hintUI}
        <div className="quizGrid">
          {q.choices.map(c => {
            let cls = 'choice';
            if (picked) {
              if (c.id === r.id) cls += ' correct';
              else if (c.id === picked) cls += ' wrong';
            }
            const out = fiftyOn && elimIds.includes(c.id);
            if (out) cls += ' out';
            return <button key={c.id} disabled={out} className={cls} data-silent="1" onClick={() => answer(c)}><HQImage record={c} /></button>;
          })}
        </div>
        {picked && (
          <div className={'fb ' + (picked === r.id ? 'ok' : 'ng')}>
            <b>{picked === r.id ? '正解です' : '不正解です'}</b>
            <div>{r.date}{r.time ? ' ' + r.time : ''} ／ {r.title}</div>
            {r.memo && <div style={{ fontSize: 13 }}>{r.memo}</div>}
            <button onClick={next}>{idx + 1 >= qs.length ? '結果を見る' : '次の問題へ'}</button>
          </div>
        )}
      </div></div>
    );
  }

  const rows = qs.map((q, i) => ({ n: i + 1, q, ok: results[i], hints: hintLog[i] || 0, recs: q.type === 'place' ? q.answers : [q.record] }));
  const points = rows.flatMap(row => row.recs.filter(r => validLatLng(r.lat, r.lng)).map(r => ({ n: row.n, lat: r.lat, lng: r.lng, title: r.title })));
  return (
    <div className="screen"><div className="inner fade">
      <h2>結果</h2>
      <p className="score">{score} / {qs.length} 問正解</p>
      <p>{score === qs.length ? '全問正解！良い旅行になりましたね！' : score >= qs.length / 2 ? 'その調子！もっと記憶を掘り返してみよう！' : 'その旅行、意味ありました？覚えてない旅行は意味がなくなっちゃうよ。'}</p>
      <h3 className="subhead">正解の場所</h3>
      <ResultMap points={points} active={active} />
      <h3 className="subhead">問題と、正解の写真（問題をタップすると、地図で強調します）</h3>
      {rows.map(row => {
        const r = row.recs.find(x => x.photo) || row.recs[0];
        return (
          <div className={'resultRow' + (active && active.n === row.n ? ' active' : '')} key={row.n}
               onClick={() => setActive({ n: row.n, t: Date.now() })}>
            <span className="resultNo">{row.n}</span>
            {r.photo
              ? <HQImage record={r} className="thumb" alt="写真を大きく表示" onClick={e => { e.stopPropagation(); setLb(r); }} />
              : <span className="thumb blank" />}
            <div className="resultBody">
              <div className={'resultMark ' + (row.ok ? 'ok' : 'ng')}>{row.ok ? '正解' : '不正解'}
                {row.hints > 0 && <span className="hintTag">ヒント{row.hints}回</span>}</div>
              <div className="resultQ">{row.q.text}</div>
              <small>{row.recs.map(x => x.title).join('、')} ／ {r.date}{r.time ? ' ' + r.time : ''}</small>
            </div>
          </div>
        );
      })}
      <div className="resultActions">
        <button className="bigBtn" onClick={start}>もう一度挑戦（問題を作り直す）</button>
        <div className="resultActions2">
          <button className="bigBtn ghost" onClick={() => setPhase('setup')}>設定に戻る</button>
          <button className="bigBtn ghost" onClick={onExit}>タイトル画面に戻る</button>
        </div>
      </div>
      {lb && <Lightbox record={lb} tripName={(trips.find(t => t.id === lb.tripId) || {}).name || ''} onClose={() => setLb(null)} />}
    </div></div>
  );
}

function DataScreen({ trips, records, onImport, onExit }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('merge');
  const [exportReadOnly, setExportReadOnly] = useState(false);
  const [usage, setUsage] = useState('');
  const days = daysSinceBackup();
  const recBytes = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size;

  useEffect(() => {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(e => setUsage('この端末での使用量：約' + (e.usage / 1048576).toFixed(1) + ' MB')).catch(() => {});
    }
  }, []);

  async function exportFile(full) {
    setBusy(true); setMsg('書き出し中…（写真が多いと、時間がかかります）');
    try {
      const statsToExport = exportReadOnly ? { rec: {}, runs: [] } : loadStats();
      const parts = ['{"app":"travel-log","version":2,"metadata":{"mode":' + JSON.stringify(exportReadOnly ? "readOnly" : "edit") + '},"exportedAt":' + JSON.stringify(new Date().toISOString())
        + ',"trips":' + JSON.stringify(trips) + ',"records":' + JSON.stringify(records) + ',"stats":' + JSON.stringify(statsToExport) + ',"fulls":{'];
      let first = true;
      if (full) {
        for (const r of records) for (const p of getPhotos(r)) {
          const blob = await PhotoDB.get(p.k);
          if (!blob) continue;
          parts.push((first ? '' : ',') + JSON.stringify(String(p.k)) + ':' + JSON.stringify(await blobToDataURL(blob)));
          first = false;
        }
      }
      parts.push('}}');
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'travel-log-' + toDateStr(new Date()) + (full ? '-full' : '') + (exportReadOnly ? '-shared' : '') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      
      if (!exportReadOnly) {
        localStorage.setItem(LAST_BACKUP, String(Date.now()));
      }
      setMsg(exportReadOnly ? '共有用の閲覧専用ファイルを書き出しました。' : '書き出しました。ダウンロードされたファイルを、大切に保管してください。');
    } catch (e) { setMsg('書き出せませんでした：' + (e.message || e)); }
    setBusy(false);
  }

  async function importFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (mode === 'replace' && !(await Dialog.confirm('今の記録をすべて消して、ファイルの内容に置き換えます。よろしいですか？', { danger: true, okText: '置き換える' }))) return;
    setBusy(true); setMsg('読み込み中…');
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'travel-log' || !Array.isArray(data.records)) throw new Error('このアプリのバックアップファイルではありません');
      
      const asReadOnly = (data.metadata && data.metadata.mode === 'readOnly') || mode === 'force_view';
      const n = await onImport(data, mode);
      setMsg(asReadOnly ? '閲覧専用モードとしてデータを取り込みました。' : n + '件の記録を取り込みました。');
    } catch (err) { setMsg('取り込めませんでした：' + (err.message || err)); }
    setBusy(false);
  }

  return (
    <div className="screen"><div className="inner fade">
      <button className="ghost" onClick={onExit}>‹ タイトルへ</button>
      <h2>データの保存・共有</h2>
      <p className="dataNote">記録は、このブラウザの中だけに保存されています。ブラウザの不具合やデータの削除に備えて、ファイルに書き出して保管しておきましょう。</p>
      <div className="dataCard">
        <div>記録 {records.length}件 ／ 旅行 {trips.length}件</div>
        <div>記録データ：約{(recBytes / 1048576).toFixed(2)} MB（上限の目安：約5MB）</div>
        {usage && <div>{usage}</div>}
        <div>最後のバックアップ：{days === null ? 'まだありません' : days === 0 ? '今日' : days + '日前'}</div>
      </div>
      <h3 className="subhead">書き出す（バックアップ・共有用）</h3>
      <label className="inlineCheck" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={exportReadOnly} onChange={e => setExportReadOnly(e.target.checked)} /> 閲覧専用（共有用）ファイルとして書き出す
      </label>
      <button disabled={busy} onClick={() => exportFile(true)}>高画質の写真も含めて書き出す（推奨）</button>
      <button className="ghost fullw" disabled={busy} onClick={() => exportFile(false)}>軽量版で書き出す</button>
      
      <h3 className="subhead">取り込む（復元・ほかの人の記録を追加）</h3>
      <label>取り込み方
        <select value={mode} onChange={e => setMode(e.target.value)}>
          <option value="merge">今の記録に追加する（同じ記録は重複しません）</option>
          <option value="replace">今の記録を消して、置き換える（復元用）</option>
          <option value="force_view">閲覧モードとして取り込む（今の記録に追加されます）</option>
        </select>
      </label>
      <label>バックアップファイルの選択（.json）
        <input type="file" accept=".json,application/json" disabled={busy} onChange={importFile} />
      </label>
      {msg && <div className="dataMsg">{msg}</div>}
      <h3 className="subhead">記録を共有するには</h3>
      <p className="dataNote">「閲覧専用（共有用）として書き出す」にチェックを入れてファイルを保存し、そのファイルを相手に送ります。相手が取り込むと、自動的に閲覧モードで開かれます。</p>
    </div></div>
  );
}

function Gallery({ records, trips, currentTripId, onExit }) {
  const [tripSel, setTripSel] = useState(String(currentTripId));
  const [kw, setKw] = useState('');
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [sec, setSec] = useState(4);
  const [viewMode, setViewMode] = useState('slide'); // 'slide' | 'grid'
  const touchX = useRef(0);
  
  const list = useMemo(() => orderRecords(records.filter(r =>
    r.photo && (tripSel === 'all' || String(r.tripId) === tripSel) && matchRecord(r, kw, trips))).flatMap(r => getPhotos(r).map((p, j) => ({ ...r, photo: p.t, pk: p.k, sub: j }))), [records, tripSel, kw]);
  const n = list.length;
  const cur = n ? list[Math.min(idx, n - 1)] : null;
  const src = useHQ(cur);
  const trip = cur && trips.find(t => t.id === cur.tripId);
  const go = d => setIdx(i => (i + d + n) % n);

  useEffect(() => { setIdx(0); }, [tripSel, kw]);
  useEffect(() => {
    if (!playing || n < 2 || viewMode === 'grid') return;
    const t = setInterval(() => setIdx(i => (i + 1) % n), sec * 1000);
    return () => clearInterval(t);
  }, [playing, n, sec, viewMode]);
  useEffect(() => {
    const onKey = e => { if (n && viewMode === 'slide') { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n, viewMode]);

  return (
    <div className="screen"><div className="inner wide fade">
      <button className="ghost" onClick={onExit}>‹ タイトルへ</button>
      <h2>旅の写真</h2>
      <div className="galleryTools">
        <select value={tripSel} onChange={e => setTripSel(e.target.value)}>
          <option value="all">すべての旅行</option>
          {trips.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
        </select>
        <input type="search" value={kw} onChange={e => setKw(e.target.value)} placeholder="キーワードで絞り込み" />
        <div className="viewToggle">
          <button className={viewMode === 'slide' ? 'on' : ''} onClick={() => setViewMode('slide')}>スライド</button>
          <button className={viewMode === 'grid' ? 'on' : ''} onClick={() => setViewMode('grid')}>一覧</button>
        </div>
      </div>
      
      {n === 0 ? <p className="msg">条件に合う、写真つきの記録がありません</p> : viewMode === 'grid' ? (
        <div className="albumGrid">
          {list.map((r, i) => (
            <HQImage key={r.id + '-' + r.sub} record={r} className="albumImg" onClick={() => { setIdx(i); setViewMode('slide'); setPlaying(false); }} />
          ))}
        </div>
      ) : (
        <>
          <div className="slideStage" onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
               onTouchEnd={e => { const d = e.changedTouches[0].clientX - touchX.current; if (Math.abs(d) > 50) go(d < 0 ? 1 : -1); }}>
            <img key={cur.id + '-' + cur.sub} className="slideImg" src={src} alt={cur.title} />
            <button className="slideNav prev" aria-label="前の写真" onClick={() => go(-1)}>‹</button>
            <button className="slideNav next" aria-label="次の写真" onClick={() => go(1)}>›</button>
            <div className="slideCap">
              <b>{cur.n ? cur.n + '. ' : ''}{cur.title}</b>
              <span>{cur.date}{cur.time ? ' ' + cur.time : ''}{trip ? ' ／ ' + trip.name : ''}</span>
              {cur.memo && <p>{cur.memo}</p>}
            </div>
          </div>
          <div className="slideBar">
            <button className="ghost" onClick={() => setPlaying(p => !p)}>{playing ? '一時停止' : '再生'}</button>
            <span>{Math.min(idx, n - 1) + 1} / {n}</span>
            <select value={sec} onChange={e => setSec(Number(e.target.value))}>
              {[2, 3, 4, 6, 10].map(v => <option key={v} value={v}>{v}秒ごと</option>)}
            </select>
          </div>
          <div className="thumbGrid">
            {list.map((r, i) => (
              <img key={r.id + '-' + r.sub} className={'gthumb' + (i === idx ? ' on' : '')} src={r.photo} alt={r.title}
                   onClick={() => { setIdx(i); setPlaying(false); }} />
            ))}
          </div>
        </>
      )}
    </div></div>
  );
}

function SheetHandle({ targetRef }) {
  const drag = useRef(null);
  const snaps = () => { const H = window.innerHeight; return [76, H * 0.48, Math.max(H * 0.6, Math.min(H * 0.86, H - 150))]; };
  function down(e) {
    drag.current = { y: e.clientY, h: targetRef.current.offsetHeight };
    targetRef.current.style.transition = 'none';
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag.current) return;
    const sn = snaps();
    const h = Math.min(sn[2], Math.max(sn[0], drag.current.h + drag.current.y - e.clientY));
    targetRef.current.style.height = h + 'px';
  }
  function up(e) {
    if (!drag.current) return;
    const el = targetRef.current, moved = Math.abs(drag.current.y - e.clientY), startH = drag.current.h;
    drag.current = null;
    el.style.transition = '';
    const sn = snaps(), cur = el.offsetHeight;
    let target = sn.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a);
    if (moved < 6) target = target === sn[1] ? sn[2] : sn[1];
    el.style.height = target + 'px';
    if (Math.abs(target - startH) > 20) Sound.play('move');
  }
  return (
    <div className="sheetHandle" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
         aria-label="操作バーを上下にスライド"><span /></div>
  );
}

function App() {
  const [tripData, setTripData] = useState(loadTrips);
  const [records, setRecords] = useState(() => loadRecords(tripData.trips));
  const [selected, setSelected] = useState(null);
  const [focus, setFocus] = useState(null);
  const [fitKey, setFitKey] = useState(0);
  const [screen, setScreen] = useState('home');
  const [tab, setTab] = useState('list');
  const [mapPhoto, setMapPhoto] = useState(null);
  const sidebarRef = useRef(null);
  const [kw, setKw] = useState('');
  const [allTrips, setAllTrips] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // 閲覧モードの状態管理（localStorageで保持）
  const [isViewOnly, setIsViewOnly] = useState(() => localStorage.getItem('travel-log-viewonly') === 'true');
  
  useEffect(() => {
    localStorage.setItem('travel-log-viewonly', isViewOnly);
  }, [isViewOnly]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
    catch (e) { Dialog.alert('保存できませんでした（容量オーバーかもしれません）'); }
  }, [records]);
  useEffect(() => { localStorage.setItem(TRIP_KEY, JSON.stringify(tripData)); }, [tripData]);

  const currentId = tripData.currentTripId;
  const current = useMemo(() => records.filter(r => r.tripId === currentId), [records, currentId]);
  const ordered = useMemo(() => orderRecords(current), [current]);
  const searching = kw.trim() !== '';
  const shown = useMemo(() => searching ? ordered.filter(r => matchRecord(r, kw, tripData.trips)) : ordered, [ordered, kw, tripData.trips]);
  const otherHits = useMemo(() => searching && allTrips
    ? records.filter(r => r.tripId !== currentId && matchRecord(r, kw, tripData.trips)).sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    : [], [records, kw, allTrips, currentId, tripData.trips]);
  const tripHits = searching ? tripData.trips.filter(t => t.id !== currentId && kw.trim().toLowerCase().split(/\s+/).every(w => t.name.toLowerCase().includes(w))) : [];
  const editing = records.find(r => r.id === editingId) || null;

  if (screen === 'home') return <><Home trips={tripData.trips} records={records} onGo={setScreen} onReset={resetAll} isViewOnly={isViewOnly} onSetViewOnly={setIsViewOnly} /></>;
  if (screen === 'data') return <DataScreen trips={tripData.trips} records={records} onImport={importData} onExit={() => setScreen('home')} />;
  if (screen === 'gallery') return <Gallery records={records} trips={tripData.trips} currentTripId={currentId} onExit={() => setScreen('home')} />;
  if (screen === 'quiz') return <><Quiz records={records} trips={tripData.trips} currentTripId={currentId} onExit={() => setScreen('home')} /></>;

  async function importData(data, mode) {
    const asReadOnly = (data.metadata && data.metadata.mode === 'readOnly') || mode === 'force_view';
    const actualMode = mode === 'force_view' ? 'merge' : mode;

    let baseTrips = tripData.trips, baseRecs = records;
    if (actualMode === 'replace') { await PhotoDB.clear(); baseTrips = []; baseRecs = []; }
    const tripIds = new Set(baseTrips.map(t => t.id)), recIds = new Set(baseRecs.map(r => r.id));
    let trips2 = [...baseTrips, ...(Array.isArray(data.trips) ? data.trips : []).filter(t => !tripIds.has(t.id))];
    if (!trips2.length) trips2 = [{ id: Date.now(), name: '最初の旅行' }];
    const fixed = data.records
      .filter(r => validLatLng(r.lat, r.lng) && !recIds.has(r.id))
      .map(r => trips2.some(t => t.id === r.tripId) ? r : { ...r, tripId: trips2[0].id });
    for (const r of fixed) for (const p of getPhotos(r)) {
      const url = data.fulls && data.fulls[p.k];
      if (url) { try { await PhotoDB.put(p.k, await (await fetch(url)).blob()); } catch (e) {} }
    }
    
    if (asReadOnly) {
      setIsViewOnly(true);
    }
    
    setRecords([...baseRecs, ...fixed]);
    setTripData({ trips: trips2, currentTripId: trips2.some(t => t.id === tripData.currentTripId) ? tripData.currentTripId : trips2[0].id });
    if (actualMode === 'replace' && data.stats && data.stats.rec) { try { localStorage.setItem(STATS_KEY, JSON.stringify(data.stats)); } catch (e) {} }
    return fixed.length;
  }
  function switchTrip(id) { setEditingId(null); setTripData(td => ({ ...td, currentTripId: id })); }
  function openFromOther(r) { switchTrip(r.tripId); setFocus({ id: r.id }); }
  function addRecord(r) {
    Sound.play('save');
    const { _full, _fulls, ...rec } = r;
    if (_full) PhotoDB.put(rec.id, _full);
    (_fulls || []).forEach(f => PhotoDB.put(f.k, f.blob));
    setRecords(prev => [...prev, { ...rec, tripId: currentId }]);
    setSelected(null);
  }
  function addRecords(list) {
    Sound.play('save');
    const recs = list.map(r => { const { _full, ...rec } = r; if (_full) PhotoDB.put(rec.id, _full); return { ...rec, tripId: currentId }; });
    setRecords(prev => [...prev, ...recs]);
    setFitKey(k => k + 1);
    setSelected(null);
  }
  function updateRecord(id, changes) {
    Sound.play('save');
    const { _full, _fulls, _removeKeys, ...ch } = changes;
    if (_full) PhotoDB.put(id, _full);
    (_fulls || []).forEach(f => PhotoDB.put(f.k, f.blob));
    (_removeKeys || []).forEach(k => PhotoDB.delete(k));
    setRecords(prev => prev.map(r => r.id === id ? { ...r, ...ch } : r));
    setEditingId(null); setSelected(null);
    setTab('list');
    if (ch.tripId && ch.tripId !== currentId) { setTripData(td => ({ ...td, currentTripId: ch.tripId })); setFocus({ id }); }
  }
  function expandSheet() {
    const el = sidebarRef.current;
    if (el && window.matchMedia('(max-width: 700px)').matches && el.offsetHeight < window.innerHeight * 0.45) el.style.height = Math.round(window.innerHeight * 0.6) + 'px';
  }
  function startEdit(id) { expandSheet(); setSelected(null); setEditingId(id); setFocus({ id }); setTab('add'); }
  function cancelEdit() { setEditingId(null); setSelected(null); setTab('list'); }
  function selectPlace(latlng) { if (isViewOnly) return; setSelected(latlng); if (latlng) setTab('add'); }
  function deleteRecord(id) {
    Sound.play('delete');
    const rec = records.find(r => r.id === id);
    (rec ? getPhotos(rec) : []).forEach(p => PhotoDB.delete(p.k));
    PhotoDB.delete(id);
    setRecords(prev => prev.filter(r => r.id !== id));
    if (editingId === id) setEditingId(null);
  }
  async function renameTrip() {
    const t = tripData.trips.find(x => x.id === currentId);
    const name = await Dialog.prompt('旅行の名前を変更します。', t.name);
    if (name && name.trim()) setTripData(td => ({ ...td, trips: td.trips.map(x => x.id === currentId ? { ...x, name: name.trim() } : x) }));
  }
  async function deleteTrip() {
    const t = tripData.trips.find(x => x.id === currentId);
    if (tripData.trips.length <= 1) { await Dialog.alert('最後の1つの旅行は、削除できません。'); return; }
    const mine = records.filter(r => r.tripId === currentId);
    if (!(await Dialog.confirm('旅行「' + t.name + '」と、その中の記録' + mine.length + '件を削除します。元に戻せません。', { danger: true, okText: '削除する' }))) return;
    mine.forEach(r => getPhotos(r).forEach(p => PhotoDB.delete(p.k)));
    const rest = tripData.trips.filter(x => x.id !== currentId);
    setRecords(prev => prev.filter(r => r.tripId !== currentId));
    setTripData({ trips: rest, currentTripId: rest[0].id });
    setEditingId(null); setSelected(null); setKw('');
  }
  async function resetAll() {
    if (!(await Dialog.confirm('すべての記録（旅行・写真・クイズの成績）を削除して、最初の状態に戻します。元に戻せません。', { danger: true, okText: '続ける' }))) return;
    const word = await Dialog.prompt('確認のため、「リセット」と入力してください。');
    if (word === null) return;
    if (word.trim() !== 'リセット') { await Dialog.alert('入力が違うため、リセットを中止しました。'); return; }
    await PhotoDB.clear();
    localStorage.removeItem(STATS_KEY); localStorage.removeItem(LAST_BACKUP);
    const first = { id: Date.now(), name: '最初の旅行' };
    setTripData({ trips: [first], currentTripId: first.id });
    setRecords([]);
    setEditingId(null); setSelected(null); setKw('');
    await Dialog.alert('リセットしました。');
  }
  async function addTrip() {
    const name = await Dialog.prompt('旅行の名前（例：2026年 京都旅行）');
    if (!name) return;
    const trip = { id: Date.now(), name };
    setEditingId(null);
    setTripData({ trips: [...tripData.trips, trip], currentTripId: trip.id });
  }

  return (
    <>
      <div className="sidebar" ref={sidebarRef}>
        <SheetHandle targetRef={sidebarRef} />
        <div className="sidebarBody">
        <button type="button" onClick={() => { setEditingId(null); setSelected(null); setScreen('home'); }} className="ghost">‹ タイトルへ</button>
        <h1>旅行記録 <small style={{ fontSize: 11, color: '#999' }}>v28</small></h1>
        <label>旅行を選択
          <select value={currentId} onChange={e => { setEditingId(null); setTripData({ ...tripData, currentTripId: Number(e.target.value) }); }}>
            {tripData.trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        
        {!isViewOnly && <button onClick={addTrip}>＋ 新しい旅行</button>}
        {!isViewOnly && <div className="tripTools">
          <button className="ghost" onClick={renameTrip}>名前を変更</button>
          <button className="ghost danger" onClick={deleteTrip}>この旅行を削除</button>
        </div>}

        {isViewOnly ? (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected="true" className="tab on">記録一覧<span className="count">{current.length}</span></button>
          </div>
        ) : (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'add'} className={'tab' + (tab === 'add' ? ' on' : '')} onClick={() => setTab('add')}>新規追加</button>
            <button role="tab" aria-selected={tab === 'list'} className={'tab' + (tab === 'list' ? ' on' : '')} onClick={() => setTab('list')}>記録一覧<span className="count">{current.length}</span></button>
          </div>
        )}

        <div className="tabPane" hidden={tab !== 'add' || isViewOnly}>
          <RecordForm selected={selected} onAdd={addRecord} trips={tripData.trips}
                      editing={editing} onUpdate={updateRecord} onCancel={cancelEdit} />
          <BulkImport onAdd={addRecords} selected={selected} />
        </div>

        <div className="tabPane" hidden={tab !== 'list'}>
          <div className="searchRow">
            <input type="search" value={kw} onChange={e => setKw(e.target.value)} placeholder="メモ・タイトル・日付などで探す" />
            <label className="inlineCheck">
              <input type="checkbox" checked={allTrips} onChange={e => setAllTrips(e.target.checked)} />すべての旅行から探す
            </label>
            {searching && <div className="searchCount">この旅行：{shown.length}件{allTrips ? ' ／ ほかの旅行：' + otherHits.length + '件' : ''}</div>}
            {tripHits.map(t => <button key={t.id} className="chip" onClick={() => switchTrip(t.id)}>旅行「{t.name}」を開く</button>)}
          </div>
          {searching && shown.length === 0 && <div className="empty">該当する記録がありません</div>}
          {current.length === 0 && (
            <div className="empty">
              まだ記録がありません。
              {!isViewOnly && <button className="ghost" onClick={() => setTab('add')}>新規追加へ</button>}
            </div>
          )}
          {shown.map((r, i) => (
            <React.Fragment key={r.id}>
              {(i === 0 || shown[i - 1].date !== r.date) && <div className="dayLabel">{r.date}</div>}
              <RecordCard record={r} isViewOnly={isViewOnly} isEditing={r.id === editingId}
                        onFocus={id => setFocus({ id })} onEdit={startEdit} onDelete={deleteRecord} />
            </React.Fragment>
          ))}
          {searching && allTrips && otherHits.length > 0 && (
            <>
              <div className="dayLabel">ほかの旅行の記録</div>
              {otherHits.map(r => (
                <div className="hitRow" key={r.id} onClick={() => openFromOther(r)}>
                  {r.photo && <img className="thumb" src={r.photo} alt="" />}
                  <div><b>{r.title}</b><small>{(tripData.trips.find(t => t.id === r.tripId) || {}).name} ／ {r.date}</small></div>
                </div>
              ))}
            </>
          )}
        </div>
        <p style={{ fontSize: 11, color: '#888' }}>場所の検索・地図：© OpenStreetMap</p>
        </div>
      </div>
      <MapView records={shown} onPhoto={setMapPhoto} tripId={currentId} fitKey={fitKey}
               selected={selected} onSelect={selectPlace} focus={focus} />
      {mapPhoto && <Lightbox record={mapPhoto} tripName={(tripData.trips.find(t => t.id === mapPhoto.tripId) || {}).name || ''} onClose={() => setMapPhoto(null)} />}
    </>
  );
}

function SoundToggle() {
  const [on, setOn] = useState(Sound.enabled);
  function toggle() {
    const v = !on;
    setOn(v); Sound.setEnabled(v);
    if (v) Sound.play('click');
  }
  return (
    <button data-silent="1" className="soundBtn" onClick={toggle} aria-label="効果音のオン／オフ" title={on ? '効果音：オン' : '効果音：オフ'}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor" />
        {on
          ? <path d="M15.5 8.5a5 5 0 010 7M18 6a9 9 0 010 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          : <path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16 }}>
          <h2>エラーが発生しました</h2>
          <p style={{ color: '#c0392b', wordBreak: 'break-all' }}>{String(this.state.error.message || this.state.error)}</p>
          <button onClick={() => location.reload()}>再読み込み</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /><SoundToggle /><DialogHost /></ErrorBoundary>);
