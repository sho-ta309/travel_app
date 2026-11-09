// ===== 旅行記録アプリ（React 18 / Leaflet / exifr） =====
const { useState, useEffect, useRef, useMemo } = React;

const STORAGE_KEY = 'travel-log-records';
const TRIP_KEY = 'travel-log-trips';

// ---------- 効果音（音声ファイルは使わず、ブラウザで音を作ります） ----------
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
    if (ctx.state === 'suspended') ctx.resume();   // スマホでは、最初の操作のあとに音が出せるようになる
    return ctx;
  }
  // 1つの音：周波数(Hz)、開始までの秒数、長さ(秒)、波形、音量(0〜1)
  function tone(c, freq, at, dur, type, vol) {
    const t0 = c.currentTime + at;
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);   // なめらかに消す（プチッという雑音を防ぐ）
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  // 音の一覧：好みに合わせて、数字を変えられます
  const SOUNDS = {
    click:   c => tone(c, 880, 0, 0.06, 'sine', 0.12),
    pin:     c => tone(c, 660, 0, 0.09, 'triangle', 0.15),
    select:  c => { tone(c, 740, 0, 0.07, 'triangle', 0.15); tone(c, 988, 0.06, 0.1, 'triangle', 0.15); },
    save:    c => { tone(c, 660, 0, 0.1, 'sine', 0.15); tone(c, 880, 0.09, 0.16, 'sine', 0.15); },
    delete:  c => tone(c, 300, 0, 0.14, 'triangle', 0.15),
    correct: c => [523, 659, 784].forEach((f, i) => tone(c, f, i * 0.1, 0.22, 'sine', 0.18)),
    wrong:   c => { tone(c, 220, 0, 0.18, 'sawtooth', 0.1); tone(c, 165, 0.17, 0.3, 'sawtooth', 0.1); },
    finish:  c => [523, 659, 784, 1047].forEach((f, i) => tone(c, f, 0.12 + i * 0.12, 0.3, 'triangle', 0.16))
  };
  return {
    get enabled() { return enabled; },
    setEnabled(v) { enabled = v; try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch (e) {} },
    play(name) {
      if (!enabled) return;
      try { const c = getCtx(); if (c && SOUNDS[name]) SOUNDS[name](c); } catch (e) {}   // 音が出せなくても、アプリは止めない
    }
  };
})();

// ボタンを押したときの音（ボタンに data-silent を付けると、この音は鳴らさない）
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button');
  if (b && !b.disabled && !b.closest('[data-silent]')) Sound.play('click');
});

// ---------- 地図のピン（見た目は style.css の .pin） ----------
const PIN = L.divIcon({ className: 'pin', html: '<span></span>', iconSize: [24, 32], iconAnchor: [12, 30], popupAnchor: [0, -28], tooltipAnchor: [12, -14] });
const PIN_TEMP = L.divIcon({ className: 'pin temp', html: '<span></span>', iconSize: [24, 32], iconAnchor: [12, 30], popupAnchor: [0, -28], tooltipAnchor: [12, -14] });

// ---------- 共通の道具 ----------
// 緯度・経度が正しい数値か（0,0 は「位置情報が空」のときの値なので除外）
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
    .filter(r => validLatLng(r.lat, r.lng))   // 座標が壊れた記録は除外
    .map(r => trips.some(t => t.id === r.tripId) ? r : { ...r, tripId: trips[0].id });
}

// 写真を縮小して文字列にする（使い終わったらメモリを解放）
function readAndResize(file, maxW = 800) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = value => {
      img.onload = img.onerror = null;
      img.src = '';
      URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onload = () => {
      if (!img.width) { done(null); return; }
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.7);
      c.width = c.height = 0;
      done(data);
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

// 写真から位置情報と撮影日を読み取る（取れなければ位置は null）
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
  const d = hasDate ? taken : new Date(file.lastModified);   // 撮影日がなければファイルの更新日
  return {
    lat: good ? gps.latitude : null,
    lng: good ? gps.longitude : null,
    date: toDateStr(d), time: hasDate ? toTimeStr(d) : '', ts: d.getTime(), dateFromExif: hasDate
  };
}

// 地図のポップアップの中身
function makePopup(r) {
  const div = document.createElement('div');
  div.innerHTML = '<b></b><br><small></small><p></p>';
  div.querySelector('b').textContent = r.title;
  div.querySelector('small').textContent = r.date + (r.time ? ' ' + r.time : '');
  div.querySelector('p').textContent = r.memo;
  if (r.photo) {
    const img = document.createElement('img');
    img.src = r.photo; img.className = 'popPhoto';
    div.appendChild(img);
  }
  return div;
}

// ---------- 部品：検索バー（OpenStreetMap の Nominatim） ----------
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
      setMsg(list.length ? '' : '見つかりませんでした。「市名 町名」のように試してください');
    } catch (err) {
      setMsg('検索できませんでした。時間をおいて、もう一度試してください');
    }
  }

  return (
    <div className="searchBar">
      <form className="searchForm" onSubmit={handleSubmit}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="場所を検索（例：京都駅、清水寺）" />
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

// ---------- 部品：地図 ----------
function MapView({ records, tripId, fitKey, selected, onSelect, focus }) {
  const divRef = useRef(null), mapRef = useRef(null), groupRef = useRef(null);
  const markersRef = useRef({}), tempRef = useRef(null);

  // 最初の1回だけ：地図を作る
  useEffect(() => {
    const map = L.map(divRef.current).setView([36, 138], 5);
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 21,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    });
    const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
      attribution: '&copy; 国土地理院', maxNativeZoom: 18, maxZoom: 21
    });
    const world = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri', maxNativeZoom: 18, maxZoom: 21
    });
    osm.addTo(map);
    L.control.layers({ 'OpenStreetMap': osm, '航空写真（日本）': photo, '衛星写真（世界）': world }).addTo(map);
    groupRef.current = L.layerGroup().addTo(map);
    map.on('click', e => { Sound.play('pin'); onSelect(e.latlng); });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // 記録が変わったら：ピンを作り直す（ポップアップは開いたときに作る）
  useEffect(() => {
    groupRef.current.clearLayers();
    markersRef.current = {};
    records.forEach(r => {
      if (!validLatLng(r.lat, r.lng)) return;
      const m = L.marker([r.lat, r.lng], { icon: PIN }).bindPopup(() => makePopup(r), { maxWidth: 150 });
      m.on('click', () => Sound.play('select'));   // ピンを押したときの音
      groupRef.current.addLayer(m);
      markersRef.current[r.id] = m;
    });
  }, [records]);

  // 旅行の切り替え・まとめて追加のあと：記録が全部見える位置へ
  useEffect(() => {
    const pts = records.filter(r => validLatLng(r.lat, r.lng)).map(r => [r.lat, r.lng]);
    if (!pts.length) return;
    try { mapRef.current.fitBounds(pts, { maxZoom: 15, padding: [40, 40] }); } catch (e) {}
  }, [tripId, fitKey]);

  // 選んだ場所の仮ピン（クリックで取り消し）
  useEffect(() => {
    if (tempRef.current) { mapRef.current.removeLayer(tempRef.current); tempRef.current = null; }
    if (selected) {
      tempRef.current = L.marker(selected, { icon: PIN_TEMP }).addTo(mapRef.current)
        .bindTooltip('クリックで取り消し').on('click', () => { Sound.play('delete'); onSelect(null); });
    }
  }, [selected]);

  // 一覧のカードが押されたら：滑らかに移動して、着いたらポップアップを開く
  useEffect(() => {
    if (!focus) return;
    const m = markersRef.current[focus.id];
    if (!m) return;
    const map = mapRef.current, target = m.getLatLng();
    const zoom = Math.max(map.getZoom(), 16);
    if (map.getCenter().distanceTo(target) < 5 && map.getZoom() === zoom) { m.openPopup(); return; }
    map.once('moveend', () => m.openPopup());
    map.flyTo(target, zoom, { duration: 1.5 });
  }, [focus]);

  // 検索結果を選んだとき
  function handlePick(p) {
    const map = mapRef.current;
    if (p.boundingbox) {
      const bb = p.boundingbox.map(Number);   // [南, 北, 西, 東]
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

// ---------- 部品：入力フォーム（追加と編集を兼用） ----------
function RecordForm({ selected, onAdd, editing, onUpdate, onCancel }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [removePhoto, setRemovePhoto] = useState(false);
  const [question, setQuestion] = useState('');   // クイズの質問（任意）
  const [time, setTime] = useState('');           // 時刻（任意）
  const [msg, setMsg] = useState('地図をクリックして場所を選んでください');
  const fileRef = useRef(null), formRef = useRef(null);

  // 編集の対象が変わったら、フォームに今の内容を入れる
  useEffect(() => {
    if (fileRef.current) fileRef.current.value = '';
    setRemovePhoto(false);
    if (editing) {
      setTitle(editing.title); setDate(editing.date); setMemo(editing.memo || '');
      setQuestion(editing.question || '');
      setTime(editing.time || '');
      setMsg('編集中：場所を変えるときは、地図をクリックしてください');
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTitle(''); setDate(''); setMemo(''); setQuestion(''); setTime('');
      setMsg(m => m.startsWith('編集中') ? '' : m);
    }
  }, [editing]);

  async function handleSubmit(e) {
    e.preventDefault();
    const file = fileRef.current.files[0];

    if (editing) {   // 編集：変えたところだけ上書き
      const changes = { title, date, time, memo, question };
      if (file) changes.photo = await readAndResize(file);
      else if (removePhoto) changes.photo = null;
      if (selected) { changes.lat = selected.lat; changes.lng = selected.lng; }
      onUpdate(editing.id, changes);
      return;
    }

    if (!selected) { setMsg('先に地図をクリックしてください！'); return; }
    const photo = file ? await readAndResize(file) : null;
    onAdd({ id: Date.now(), title, date, time, memo, question, lat: selected.lat, lng: selected.lng, photo });
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
      {editing && editing.photo && (
        <div>
          <small>今の写真</small>
          <img src={editing.photo} style={{ width: '100%', borderRadius: 4 }} />
          <label>
            <input type="checkbox" checked={removePhoto} style={{ width: 'auto' }}
                   onChange={e => setRemovePhoto(e.target.checked)} /> 写真を外す
          </label>
        </div>
      )}
      <label>{editing ? '写真を差し替える（変えないときは空のまま）' : '写真'}
        <input type="file" accept="image/*" ref={fileRef} />
      </label>
      <button type="submit">{editing ? '更新する' : 'この場所を記録する'}</button>
      {editing && <button type="button" className="ghost" onClick={onCancel}>編集をやめる</button>}
      <div className="msg">{msg}</div>
    </form>
  );
}

// ---------- 部品：写真のまとめて追加 ----------
function BulkImport({ onAdd, selected }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  async function handleFiles(e) {
    let files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
    e.target.value = '';
    if (!files.length) return;
    const MAX = 20;   // 一度に読み込む上限（スマホのメモリ対策）
    if (files.length > MAX) {
      alert('一度に読み込めるのは' + MAX + '枚までです。最初の' + MAX + '枚を読み込みます');
      files = files.slice(0, MAX);
    }
    setBusy(true);
    try {
      const list = [];
      for (const f of files) {
        const info = await readPhotoInfo(f);
        const photo = await readAndResize(f, 480);
        list.push({ key: f.name + f.size + f.lastModified, title: f.name.replace(/\.[^.]+$/, ''), photo, ...info });
        await new Promise(r => setTimeout(r, 80));   // メモリを片付ける時間
      }
      list.sort((a, b) => a.ts - b.ts);
      setItems(list);
    } catch (err) {
      alert('写真の読み込み中に問題が起きました：' + err.message);
    } finally {
      setBusy(false);
    }
  }

  const ok = items.filter(i => validLatLng(i.lat, i.lng) && i.photo);       // 位置情報あり
  const noGps = items.filter(i => !validLatLng(i.lat, i.lng) && i.photo);   // 位置情報なし
  const broken = items.filter(i => !i.photo).length;

  function toRecords(list, lat, lng) {
    return list.map((i, n) => ({
      id: Date.now() + n, title: i.title, date: i.date, time: i.time || '', memo: '',
      lat: lat !== undefined ? lat : i.lat, lng: lng !== undefined ? lng : i.lng, photo: i.photo
    }));
  }
  function importAll() {
    onAdd(toRecords(ok));
    setItems(items.filter(i => !ok.includes(i)));
  }
  function importToSelected() {   // 位置情報のない写真を、地図で選んだ場所へ
    onAdd(toRecords(noGps, selected.lat, selected.lng));
    setItems(items.filter(i => !noGps.includes(i)));
  }

  return (
    <div>
      <h2>写真をまとめて追加</h2>
      <label>写真を選ぶ（複数選択できます）
        <input type="file" accept="image/*" multiple onChange={handleFiles} />
      </label>
      <label>フォルダごと選ぶ（パソコンのみ）
        <input type="file" webkitdirectory="" multiple onChange={handleFiles} />
      </label>
      {busy && <div className="msg">読み込み中...</div>}

      {items.map(i => (
        <div className="record" key={i.key} style={{ cursor: 'default' }}>
          {i.photo ? <img src={i.photo} /> : <div className="msg">読み込めない形式です</div>}
          <input value={i.title}
                 onChange={e => setItems(items.map(x => x.key === i.key ? { ...x, title: e.target.value } : x))} />
          <small>{i.date}{i.time ? ' ' + i.time : ''}{i.dateFromExif ? '（撮影日時）' : '（ファイルの更新日）'}</small><br />
          <small className={validLatLng(i.lat, i.lng) ? 'tag ok' : 'tag ng'}>{validLatLng(i.lat, i.lng) ? '位置情報あり' : '位置情報なし'}</small>
        </div>
      ))}

      {ok.length > 0 && <button onClick={importAll}>位置情報のある{ok.length}件を記録する</button>}
      {noGps.length > 0 && (selected
        ? <button onClick={importToSelected}>位置情報のない{noGps.length}件を、地図で選んだ場所に記録する</button>
        : <div className="msg">位置情報のない{noGps.length}件は、地図をクリック（または検索）して場所を選ぶと、その場所にまとめて登録できます</div>)}
      {broken > 0 && <div className="msg">{broken}件は、読み込めない形式のため登録できません</div>}
      {items.length > 0 && <button className="ghost" onClick={() => setItems([])}>一覧を閉じる</button>}
    </div>
  );
}

// ---------- 部品：記録1件のカード ----------
function RecordCard({ record, isEditing, onFocus, onEdit, onDelete }) {
  const [gone, setGone] = useState(false);   // 削除するとき、先にふわっと消す
  function remove(e) {
    e.stopPropagation();
    if (!confirm('「' + record.title + '」を削除しますか？')) return;
    setGone(true);
    setTimeout(() => onDelete(record.id), 280);
  }
  return (
    <div className={'record' + (isEditing ? ' editing' : '') + (gone ? ' gone' : '')} onClick={() => onFocus(record.id)}>
      <div className="recordRow">
        {record.photo && <img className="thumb" src={record.photo} alt="" loading="lazy" decoding="async" />}
        <div className="recordBody">
          <b>{record.title}</b>
          <small>{record.date}{record.time ? ' ' + record.time : ''}</small>
          {record.question && <small className="qline">問：{record.question}</small>}
          <div>
            <button className="edit" onClick={e => { e.stopPropagation(); onEdit(record.id); }}>編集</button>
            <button className="del" onClick={remove}>削除</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 画面：タイトル（登録・クイズを選ぶ） ----------
// 流れる丸い写真（タイトル画面の飾り）
function Marquee({ photos, reverse }) {
  const base = [];
  while (base.length < 10) base.push(...photos);   // 写真が少ないときは、くり返して幅を埋める
  return (
    <div className={'marquee' + (reverse ? ' rev' : '')} aria-hidden="true">
      <div className="marqueeTrack">
        {[...base, ...base].map((p, i) => <img key={i} className="bubble" src={p} alt="" loading="lazy" decoding="async" />)}
      </div>
    </div>
  );
}

function Home({ trips, records, onGo }) {
  const photoCount = records.filter(r => r.photo).length;
  // 流す写真は最大8枚（スマホのメモリ対策）
  const bubbles = useMemo(() => shuffle(records.filter(r => r.photo).map(r => r.photo)).slice(0, 8), [records]);
  return (
    <div className="screen home">
      {bubbles.length > 0 && <Marquee photos={bubbles} reverse />}
      <div className="inner">
        <div className="homeEyebrow">TRAVEL JOURNAL</div>
        <h1>自分だけの旅行記録</h1>
        <p className="homeLead">旅の思い出を残して思い出そう。</p>
        <div className="homeStats">
          <div><b>{trips.length}</b><span>旅行</span></div>
          <div><b>{records.length}</b><span>記録</span></div>
          <div><b>{photoCount}</b><span>写真</span></div>
        </div>
        <button className="homeBtn" onClick={() => onGo('register')}>
          <span className="homeBtnTitle">旅行を記録する</span><small>地図と写真で、旅の記録を登録・編集</small>
        </button>
        <button className="homeBtn" disabled={photoCount < 2} onClick={() => onGo('quiz')}>
          <span className="homeBtnTitle">旅行の記憶クイズに挑戦</span>
          <small>{photoCount < 2 ? '写真つきの記録が2件以上になると遊べます' : '写真を選んで、旅の思い出を取り戻そう'}</small>
        </button>
      </div>
      {bubbles.length > 0 && <Marquee photos={bubbles.slice().reverse()} />}
    </div>
  );
}

// ---------- クイズの問題を作る ----------
const HIT_M = 5000;   // 「場所を選ぶ」問題：正解の場所から、この距離（m）以内なら正解

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tripHeader(trips, tripId) {
  const t = trips.find(x => x.id === tripId);
  return t ? '旅行：' + t.name : '';
}

// 時刻つきの記録を「旅行・日付・時間帯」ごとにまとめる
// style: 'hour'＝12時台でまとめる / 'exact'＝12:30のように、同じ時刻でまとめる
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

// ① 質問・タイトルから、写真を選ぶ問題
function makeQuestions(pool, allPhotos, count, trips) {
  return shuffle(pool).slice(0, count).map(r => {
    const others = allPhotos.filter(x => x.id !== r.id && x.photo !== r.photo);
    const same = shuffle(others.filter(x => x.tripId === r.tripId));   // 同じ旅行の写真を優先
    const diff = shuffle(others.filter(x => x.tripId !== r.tripId));
    return {
      type: 'photo', record: r,
      header: tripHeader(trips, r.tripId) + ' ／ ' + r.date + (r.question ? ' ／ ' + r.title : ''),
      text: r.question || '「' + r.title + '」の写真はどれでしょう？',
      choices: shuffle([r, ...[...same, ...diff].slice(0, 3)])
    };
  });
}

// ② 時間から、いた場所を地図で選ぶ問題
function makePlaceQuestions(groups, trips, count, style) {
  return shuffle(groups).slice(0, count).map(g => ({
    type: 'place', answers: g.records,
    header: tripHeader(trips, g.tripId),
    text: g.date + ' の ' + slotLabel(g, style) + '、どこにいた？'
  }));
}

// ③ 時間から、いた場所の写真を選ぶ問題
function makeTimePhotoQuestions(groups, allPhotos, trips, count, style) {
  return shuffle(groups).slice(0, count).map(g => {
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
// 答えの場所から、一番近い正解までの距離（正解が複数あるときは、近いほうで判定）
function nearestDist(guess, answers) {
  return Math.min(...answers.map(a => guess.distanceTo(L.latLng(a.lat, a.lng))));
}

// ---------- 部品：答えの場所を選ぶ地図 ----------
function GuessMap({ guess, onGuess, revealed, answers, startPts }) {
  const divRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null);
  const onGuessRef = useRef(onGuess);
  onGuessRef.current = onGuess;   // いつも最新の関数を使えるようにしておく

  useEffect(() => {
    const map = L.map(divRef.current).setView([36, 138], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 21, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
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
      L.circleMarker(guess, { radius: 9, color: '#14213d', fillOpacity: 0.8 })
        .addTo(g).bindTooltip('あなたの答え', { permanent: revealed });
    }
    if (revealed && guess) {
      const pts = answers.map(a => L.latLng(a.lat, a.lng));
      pts.forEach(pt => L.circleMarker(pt, { radius: 9, color: '#2f6b4f', fillOpacity: 0.8 })
        .addTo(g).bindTooltip('正解の場所', { permanent: true }));
      const near = pts.reduce((a, b) => guess.distanceTo(a) <= guess.distanceTo(b) ? a : b);
      L.polyline([guess, near], { color: '#888', dashArray: '6' }).addTo(g);
      mapRef.current.fitBounds([guess, ...pts], { padding: [60, 60], maxZoom: 16 });
    }
  }, [guess, revealed, ansKey]);

  // 検索バーで見つけた場所へ地図を動かすだけ（答えにはならない）
  function flyTo(p) {
    const map = mapRef.current;
    if (p.boundingbox) {
      const bb = p.boundingbox.map(Number);
      map.flyToBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 16, duration: 1 });
    } else {
      map.flyTo([Number(p.lat), Number(p.lon)], 14, { duration: 1 });
    }
  }

  return (
    <>
      <div ref={divRef} style={{ position: 'absolute', inset: 0 }}></div>
      <SearchBar onPick={flyTo} />
    </>
  );
}

// ---------- 画面：クイズ ----------
function Quiz({ records, trips, currentTripId, onExit }) {
  const [phase, setPhase] = useState('setup');   // setup → play → result
  const [kinds, setKinds] = useState({ photo: true, place: true, timePhoto: true });   // 問題の種類（複数選べる）
  const [timeStyle, setTimeStyle] = useState('hour');   // 'hour'＝12時台 / 'exact'＝12:30ごろ
  const [tripSel, setTripSel] = useState('all');        // 'all'＝すべての旅行を混ぜる / 旅行のid
  const [count, setCount] = useState(5);
  const [qs, setQs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);    // 写真問題：選んだ記録のid
  const [guess, setGuess] = useState(null);      // 場所問題：地図で選んだ場所
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState(0);

  const inTrip = r => tripSel === 'all' || String(r.tripId) === tripSel;
  const withPhoto = records.filter(r => r.photo);
  const photoPool = withPhoto.filter(inTrip);
  const groups = timeGroups(records.filter(inTrip), timeStyle);
  // 「時間から写真」：その時間帯に写真があり、ほかに選択肢にできる写真もあるもの
  const tpGroups = groups.filter(g => {
    const n = g.records.filter(r => r.photo).length;
    return n > 0 && withPhoto.length > n;
  });
  const usePhoto = kinds.photo && withPhoto.length >= 2;
  const available = (usePhoto ? photoPool.length : 0) + (kinds.place ? groups.length : 0) + (kinds.timePhoto ? tpGroups.length : 0);

  function start() {
    let list = [];
    if (usePhoto) list = list.concat(makeQuestions(photoPool, withPhoto, count, trips));
    if (kinds.place) list = list.concat(makePlaceQuestions(groups, trips, count, timeStyle));
    if (kinds.timePhoto) list = list.concat(makeTimePhotoQuestions(tpGroups, withPhoto, trips, count, timeStyle));
    setQs(shuffle(list).slice(0, count));   // 種類が混ざるように、シャッフルしてから切り出す
    setIdx(0); setPicked(null); setGuess(null); setRevealed(false); setScore(0); setPhase('play');
  }
  function answer(c) {   // 写真問題
    if (picked) return;
    setPicked(c.id);
    const ok = c.id === qs[idx].record.id;
    Sound.play(ok ? 'correct' : 'wrong');
    if (ok) setScore(s => s + 1);
  }
  function submitGuess() {   // 場所問題
    if (!guess || revealed) return;
    setRevealed(true);
    const hit = nearestDist(guess, qs[idx].answers) <= HIT_M;
    Sound.play(hit ? 'correct' : 'wrong');
    if (hit) setScore(s => s + 1);
  }
  function next() {
    if (idx + 1 >= qs.length) {
      if (score >= qs.length / 2) Sound.play('finish');   // 半分以上正解で、ファンファーレ
      setPhase('result'); return;
    }
    setIdx(idx + 1); setPicked(null); setGuess(null); setRevealed(false);
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
            <option value="hour">（大まかな時間 例:12時台）</option>
            <option value="exact"> 細かな時刻（例：12:30頃）</option>
          </select>
        </label>
      )}

      <label>問題数
        <select value={count} onChange={e => setCount(Number(e.target.value))}>
          {[3, 5, 10].map(n => <option key={n} value={n}>{n}問</option>)}
        </select>
      </label>

      <p style={{ fontSize: 13 }}>
        出題できる数：写真（質問・タイトル）{photoPool.length} ／ 時間から場所 {groups.length} ／ 時間から写真 {tpGroups.length}
      </p>
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
    const bar = <div className="quizHeader">第{idx + 1}問 / {qs.length}　正解 {score}</div>;

    // ---- 時間から、いた場所を選ぶ問題 ----
    if (q.type === 'place') {
      const d = revealed && guess ? nearestDist(guess, q.answers) : 0;
      const pic = q.answers.find(a => a.photo);
      const memo = q.answers.find(a => a.memo);
      return (
        <div className="screen"><div className="inner fade" key={idx}>
          {bar}
          <div className="quizHeader">{q.header}</div>
          <div className="quizQ">{q.text}</div>
          <div className="guessMap">
            <GuessMap key={idx} guess={guess} revealed={revealed} answers={q.answers}
                      startPts={groups.flatMap(g => g.records.map(x => [x.lat, x.lng]))}
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
              {pic && <img src={pic.photo} style={{ width: '100%', borderRadius: 6, marginTop: 6 }} />}
              <button onClick={next}>{idx + 1 >= qs.length ? '結果を見る' : '次の問題へ'}</button>
            </div>
          )}
        </div></div>
      );
    }

    // ---- 写真を選ぶ問題（質問・タイトルから／時間から） ----
    const r = q.record;
    return (
      <div className="screen"><div className="inner fade" key={idx}>
        {bar}
        <div className="quizHeader">{q.header}</div>
        <div className="quizQ">{q.text}</div>
        <div className="quizGrid">
          {q.choices.map(c => {
            let cls = 'choice';
            if (picked) {
              if (c.id === r.id) cls += ' correct';
              else if (c.id === picked) cls += ' wrong';
            }
            return <button key={c.id} className={cls} data-silent="1" onClick={() => answer(c)}><img src={c.photo} /></button>;
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

  return (
    <div className="screen"><div className="inner">
      <h2>結果</h2>
      <p style={{ fontSize: 28 }}>{score} / {qs.length} 問正解</p>
      <p>{score === qs.length ? '全問正解！良い旅行になりましたね！' : score >= qs.length / 2 ? 'その調子！もっと記憶を掘り返してみよう！' : 'その旅行、意味ありました？覚えてない旅行は意味がなくなっちゃうよ。'}</p>
      <button onClick={start}>もう一度挑戦（問題を作り直す）</button>
      <button className="ghost" onClick={() => setPhase('setup')}>設定に戻る</button>
      <button className="ghost" onClick={onExit}>タイトル画面に戻る</button>
    </div></div>
  );
}

// ---------- アプリ全体 ----------
function App() {
  const [tripData, setTripData] = useState(loadTrips);
  const [records, setRecords] = useState(() => loadRecords(tripData.trips));
  const [selected, setSelected] = useState(null);     // 地図で選んだ場所
  const [focus, setFocus] = useState(null);
  const [fitKey, setFitKey] = useState(0);            // まとめて追加のあと地図を動かす合図
  const [screen, setScreen] = useState('home');   // 'home'（タイトル）| 'register'（登録）| 'quiz'（クイズ）
  const [editingId, setEditingId] = useState(null);   // 編集中の記録のid

  // 状態が変わったら自動で保存
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
    catch (e) { alert('保存できませんでした（容量オーバーかもしれません）'); }
  }, [records]);
  useEffect(() => { localStorage.setItem(TRIP_KEY, JSON.stringify(tripData)); }, [tripData]);

  const currentId = tripData.currentTripId;
  const current = useMemo(() => records.filter(r => r.tripId === currentId), [records, currentId]);
  const editing = records.find(r => r.id === editingId) || null;

  // 画面の切り替え：タイトル／クイズのときは、ここで終わり
  if (screen === 'home') {
    return <><Home trips={tripData.trips} records={records} onGo={setScreen} /></>;
  }
  if (screen === 'quiz') {
    return (
      <>
        
        <Quiz records={records} trips={tripData.trips} currentTripId={currentId} onExit={() => setScreen('home')} />
      </>
    );
  }

  function addRecord(r) {
    Sound.play('save');
    setRecords(prev => [...prev, { ...r, tripId: currentId }]);
    setSelected(null);
  }
  function addRecords(list) {
    Sound.play('save');
    setRecords(prev => [...prev, ...list.map(r => ({ ...r, tripId: currentId }))]);
    setFitKey(k => k + 1);
    setSelected(null);
  }
  function updateRecord(id, changes) {
    Sound.play('save');
    setRecords(prev => prev.map(r => r.id === id ? { ...r, ...changes } : r));
    setEditingId(null); setSelected(null);
  }
  function startEdit(id) { setSelected(null); setEditingId(id); setFocus({ id }); }
  function cancelEdit() { setEditingId(null); setSelected(null); }
  function deleteRecord(id) {
    Sound.play('delete');
    setRecords(prev => prev.filter(r => r.id !== id));
    if (editingId === id) setEditingId(null);
  }
  function addTrip() {
    const name = prompt('旅行の名前（例：2026 京都）');
    if (!name) return;
    const trip = { id: Date.now(), name };
    setEditingId(null);
    setTripData({ trips: [...tripData.trips, trip], currentTripId: trip.id });
  }

  return (
    <>
      <div className="sidebar">
        <button type="button" onClick={() => { setEditingId(null); setSelected(null); setScreen('home'); }}
                className="ghost">‹ タイトルへ</button>
        <h1>旅行記録 <small style={{ fontSize: 11, color: '#999' }}>v17</small></h1>
        <label>旅行を選択
          <select value={currentId}
                  onChange={e => { setEditingId(null); setTripData({ ...tripData, currentTripId: Number(e.target.value) }); }}>
            {tripData.trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button onClick={addTrip}>＋ 新しい旅行</button>

        <h2>記録を追加</h2>
        <RecordForm selected={selected} onAdd={addRecord}
                    editing={editing} onUpdate={updateRecord} onCancel={cancelEdit} />
        <BulkImport onAdd={addRecords} selected={selected} />

        <h2>記録一覧（{current.length}件）</h2>
        {current.map(r => (
          <RecordCard key={r.id} record={r} isEditing={r.id === editingId}
                      onFocus={id => setFocus({ id })} onEdit={startEdit} onDelete={deleteRecord} />
        ))}
        <p style={{ fontSize: 11, color: '#888' }}>場所の検索・地図：© OpenStreetMap contributors</p>
      </div>
      <MapView records={current} tripId={currentId} fitKey={fitKey}
               selected={selected} onSelect={setSelected} focus={focus} />
    </>
  );
}

// ---------- 音のオン／オフボタン（画面の右下） ----------
function SoundToggle() {
  const [on, setOn] = useState(Sound.enabled);
  function toggle() {
    const v = !on;
    setOn(v);
    Sound.setEnabled(v);
    if (v) Sound.play('click');   // オンにしたとき、音が出ることをすぐ確認できる
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

// ---------- エラーが起きたとき、真っ白にせず内容を表示 ----------
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16 }}>
          <h2>エラーが発生しました</h2>
          <p style={{ color: '#c0392b', wordBreak: 'break-all' }}>
            {String(this.state.error.message || this.state.error)}
          </p>
          <button onClick={() => location.reload()}>再読み込み</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /><SoundToggle /></ErrorBoundary>);
