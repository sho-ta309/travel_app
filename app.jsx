// ===== 旅行記録アプリ（React 18 / Leaflet / exifr） =====
const { useState, useEffect, useRef, useMemo } = React;

const STORAGE_KEY = 'travel-log-records';
const TRIP_KEY = 'travel-log-trips';

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
    date: toDateStr(d), ts: d.getTime(), dateFromExif: hasDate
  };
}

// 地図のポップアップの中身
function makePopup(r) {
  const div = document.createElement('div');
  div.innerHTML = '<b></b><br><small></small><p></p>';
  div.querySelector('b').textContent = r.title;
  div.querySelector('small').textContent = r.date;
  div.querySelector('p').textContent = r.memo;
  if (r.photo) {
    const img = document.createElement('img');
    img.src = r.photo; img.style.width = '120px';
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
    map.on('click', e => onSelect(e.latlng));
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // 記録が変わったら：ピンを作り直す（ポップアップは開いたときに作る）
  useEffect(() => {
    groupRef.current.clearLayers();
    markersRef.current = {};
    records.forEach(r => {
      if (!validLatLng(r.lat, r.lng)) return;
      const m = L.marker([r.lat, r.lng]).bindPopup(() => makePopup(r), { maxWidth: 150 });
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
      tempRef.current = L.marker(selected).addTo(mapRef.current)
        .bindTooltip('クリックで取り消し').on('click', () => onSelect(null));
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
  const [msg, setMsg] = useState('地図をクリックして場所を選んでください');
  const fileRef = useRef(null), formRef = useRef(null);

  // 編集の対象が変わったら、フォームに今の内容を入れる
  useEffect(() => {
    if (fileRef.current) fileRef.current.value = '';
    setRemovePhoto(false);
    if (editing) {
      setTitle(editing.title); setDate(editing.date); setMemo(editing.memo || '');
      setQuestion(editing.question || '');
      setMsg('編集中：場所を変えるときは、地図をクリックしてください');
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTitle(''); setDate(''); setMemo(''); setQuestion('');
      setMsg(m => m.startsWith('編集中') ? '' : m);
    }
  }, [editing]);

  async function handleSubmit(e) {
    e.preventDefault();
    const file = fileRef.current.files[0];

    if (editing) {   // 編集：変えたところだけ上書き
      const changes = { title, date, memo, question };
      if (file) changes.photo = await readAndResize(file);
      else if (removePhoto) changes.photo = null;
      if (selected) { changes.lat = selected.lat; changes.lng = selected.lng; }
      onUpdate(editing.id, changes);
      return;
    }

    if (!selected) { setMsg('先に地図をクリックしてください！'); return; }
    const photo = file ? await readAndResize(file) : null;
    onAdd({ id: Date.now(), title, date, memo, question, lat: selected.lat, lng: selected.lng, photo });
    setTitle(''); setDate(''); setMemo(''); setQuestion('');
    fileRef.current.value = '';
    setMsg('');
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      <label>タイトル <input value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label>日付 <input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
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
      {editing && <button type="button" style={{ background: '#888' }} onClick={onCancel}>編集をやめる</button>}
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
    const MAX = 8;   // 一度に読み込む上限（スマホのメモリ対策）
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
      id: Date.now() + n, title: i.title, date: i.date, memo: '',
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
      <label>ファイルから選ぶ（Android向け）
        <input type="file" multiple onChange={handleFiles} />
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
          <small>{i.date}{i.dateFromExif ? '（撮影日）' : '（ファイルの更新日）'}</small><br />
          <small>{validLatLng(i.lat, i.lng) ? '📍 位置情報あり' : '⚠ 位置情報なし'}</small>
        </div>
      ))}

      {ok.length > 0 && <button onClick={importAll}>位置情報のある{ok.length}件を記録する</button>}
      {noGps.length > 0 && (selected
        ? <button onClick={importToSelected}>位置情報のない{noGps.length}件を、地図で選んだ場所に記録する</button>
        : <div className="msg">位置情報のない{noGps.length}件は、地図をクリック（または検索）して場所を選ぶと、その場所にまとめて登録できます</div>)}
      {broken > 0 && <div className="msg">{broken}件は、読み込めない形式のため登録できません</div>}
      {items.length > 0 && <button style={{ background: '#888' }} onClick={() => setItems([])}>一覧を閉じる</button>}
    </div>
  );
}

// ---------- 部品：記録1件のカード ----------
function RecordCard({ record, isEditing, onFocus, onEdit, onDelete }) {
  return (
    <div className="record" onClick={() => onFocus(record.id)}
         style={isEditing ? { outline: '2px solid #2a7de1' } : undefined}>
      <b>{record.title}</b> <small>{record.date}</small><br />
      {record.question && <small>❓ {record.question}<br /></small>}
      <button className="edit" onClick={e => { e.stopPropagation(); onEdit(record.id); }}>編集</button>
      <button className="del" onClick={e => {
        e.stopPropagation();
        if (confirm('「' + record.title + '」を削除しますか？')) onDelete(record.id);
      }}>削除</button>
      {record.photo && <img src={record.photo} loading="lazy" decoding="async" />}
    </div>
  );
}

// ---------- タイトル画面・クイズ画面の見た目（CSS） ----------
// ※ style.css に移してもかまいません
const EXTRA_CSS = `
.screen { flex: 1; overflow-y: auto; padding: 20px 14px; background: #f0f6ff; }
.screen .inner { max-width: 560px; margin: 0 auto; }
.homeBtn { display: block; text-align: left; padding: 18px; margin-top: 14px; font-size: 18px; border-radius: 12px; background: #2a7de1; }
.homeBtn small { display: block; font-size: 12px; margin-top: 4px; font-weight: normal; }
.homeBtn.quiz { background: #e67e22; }
.homeBtn:disabled { background: #aaa; cursor: not-allowed; }
.quizHeader { font-size: 13px; color: #666; margin-top: 4px; }
.quizQ { font-size: 20px; font-weight: bold; margin: 8px 0 14px; }
.quizGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.choice { padding: 0; margin: 0; background: #fff; border: 4px solid #ddd; border-radius: 10px; overflow: hidden; cursor: pointer; }
.choice img { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: cover; }
.choice.correct { border-color: #27ae60; }
.choice.wrong { border-color: #c0392b; opacity: .7; }
.fb { margin-top: 14px; padding: 10px; border-radius: 8px; background: #fff; }
.fb.ok b { color: #27ae60; } .fb.ng b { color: #c0392b; }
`;

// ---------- 画面：タイトル（登録・クイズを選ぶ） ----------
function Home({ trips, records, onGo }) {
  const photoCount = records.filter(r => r.photo).length;
  return (
    <div className="screen"><div className="inner">
      <h1 style={{ fontSize: 28 }}>🧳 旅行記録</h1>
      <p>旅の思い出を、残して、思い出そう。<br />
        <small>旅行 {trips.length}件 ／ 記録 {records.length}件 ／ 写真 {photoCount}枚</small></p>
      <button className="homeBtn" onClick={() => onGo('register')}>
        📍 記録する<small>地図と写真で、旅の記録を登録・編集</small>
      </button>
      <button className="homeBtn quiz" disabled={photoCount < 2} onClick={() => onGo('quiz')}>
        🎯 クイズに挑戦
        <small>{photoCount < 2 ? '写真つきの記録が2件以上になると遊べます' : '写真を選んで、旅の思い出を取り戻そう'}</small>
      </button>
    </div></div>
  );
}

// ---------- クイズの問題を作る ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// pool：出題する記録 / allPhotos：写真つきの全記録（不正解の選択肢の材料）
function makeQuestions(pool, allPhotos, count) {
  return shuffle(pool).slice(0, count).map(r => {
    const others = allPhotos.filter(x => x.id !== r.id && x.photo !== r.photo);
    const same = shuffle(others.filter(x => x.tripId === r.tripId));   // 同じ旅行の写真を優先
    const diff = shuffle(others.filter(x => x.tripId !== r.tripId));
    return {
      record: r,
      header: r.date + (r.question ? ' ／ ' + r.title : ''),
      text: r.question || '「' + r.title + '」の写真はどれ？',
      choices: shuffle([r, ...[...same, ...diff].slice(0, 3)])
    };
  });
}

// ---------- 画面：クイズ ----------
function Quiz({ records, trips, currentTripId, onExit }) {
  const [phase, setPhase] = useState('setup');   // setup → play → result
  const [tripSel, setTripSel] = useState(String(currentTripId));   // 'all' か旅行のid
  const [count, setCount] = useState(5);
  const [qs, setQs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(null);    // 選んだ記録のid
  const [score, setScore] = useState(0);

  const withPhoto = records.filter(r => r.photo);
  const pool = tripSel === 'all' ? withPhoto : withPhoto.filter(r => String(r.tripId) === tripSel);
  const grayBtn = { background: '#888' };

  function start() {
    setQs(makeQuestions(pool, withPhoto, Math.min(count, pool.length)));
    setIdx(0); setPicked(null); setScore(0); setPhase('play');
  }
  function answer(c) {
    if (picked) return;   // 答えた後は押せない
    setPicked(c.id);
    if (c.id === qs[idx].record.id) setScore(s => s + 1);
  }
  function next() {
    if (idx + 1 >= qs.length) setPhase('result');
    else { setIdx(idx + 1); setPicked(null); }
  }

  if (phase === 'setup') return (
    <div className="screen"><div className="inner">
      <button style={{ ...grayBtn, width: 'auto' }} onClick={onExit}>← タイトルへ</button>
      <h2>旅の記憶クイズ</h2>
      <label>今回出題する旅行
        <select value={tripSel} onChange={e => setTripSel(e.target.value)}>
          <option value="all">すべての旅行</option>
          {trips.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
        </select>
      </label>
      <label>問題数
        <select value={count} onChange={e => setCount(Number(e.target.value))}>
          {[3, 5, 10].map(n => <option key={n} value={n}>{n}問</option>)}
        </select>
      </label>
      <p style={{ fontSize: 13 }}>出題できる写真：{pool.length}枚
        {withPhoto.length < 2 && '（写真つきの記録が2件以上必要です）'}</p>
      <button onClick={start} disabled={pool.length < 1 || withPhoto.length < 2}>スタート</button>
      <p style={{ fontSize: 12, color: '#666' }}>
        ヒント：記録するとき「クイズの質問」（例：お昼ご飯は？）を書くと、その質問が出題されます。
      </p>
    </div></div>
  );

  if (phase === 'play') {
    const q = qs[idx], correctId = q.record.id;
    return (
      <div className="screen"><div className="inner">
        <div className="quizHeader">第{idx + 1}問 / {qs.length}　正解 {score}</div>
        <div className="quizHeader">{q.header}</div>
        <div className="quizQ">{q.text}</div>
        <div className="quizGrid">
          {q.choices.map(c => {
            let cls = 'choice';
            if (picked) {
              if (c.id === correctId) cls += ' correct';
              else if (c.id === picked) cls += ' wrong';
            }
            return <button key={c.id} className={cls} onClick={() => answer(c)}><img src={c.photo} /></button>;
          })}
        </div>
        {picked && (
          <div className={'fb ' + (picked === correctId ? 'ok' : 'ng')}>
            <b>{picked === correctId ? '正解！いいですね！' : '違います。残念…'}</b>
            <div>{q.record.date} ／ {q.record.title}</div>
            {q.record.memo && <div style={{ fontSize: 13 }}>{q.record.memo}</div>}
            <button onClick={next}>{idx + 1 >= qs.length ? '結果を見る' : '次の問題へ'}</button>
          </div>
        )}
      </div></div>
    );
  }

  return (
    <div className="screen"><div className="inner">
      <h2>結果</h2>
      <p style={{ fontSize: 28 }}>{score} / {qs.length} 問正解！</p>
      <p>{score === qs.length ? '全問正解！いい旅行になりましたね！もっとたくさんの旅をしよう！' : score >= qs.length / 2 ? '時には写真を見返そう！思い出は一生の宝物だよ。' : 'その旅行、本当に行った意味ありました...？記憶に残っていない旅行は旅行ではないよ。'}</p>
      <button onClick={start}>もう一度（問題を作り直す）</button>
      <button style={grayBtn} onClick={() => setPhase('setup')}>設定に戻る</button>
      <button style={grayBtn} onClick={onExit}>タイトルへ</button>
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
    return <><style>{EXTRA_CSS}</style><Home trips={tripData.trips} records={records} onGo={setScreen} /></>;
  }
  if (screen === 'quiz') {
    return (
      <>
        <style>{EXTRA_CSS}</style>
        <Quiz records={records} trips={tripData.trips} currentTripId={currentId} onExit={() => setScreen('home')} />
      </>
    );
  }

  function addRecord(r) {
    setRecords(prev => [...prev, { ...r, tripId: currentId }]);
    setSelected(null);
  }
  function addRecords(list) {
    setRecords(prev => [...prev, ...list.map(r => ({ ...r, tripId: currentId }))]);
    setFitKey(k => k + 1);
    setSelected(null);
  }
  function updateRecord(id, changes) {
    setRecords(prev => prev.map(r => r.id === id ? { ...r, ...changes } : r));
    setEditingId(null); setSelected(null);
  }
  function startEdit(id) { setSelected(null); setEditingId(id); setFocus({ id }); }
  function cancelEdit() { setEditingId(null); setSelected(null); }
  function deleteRecord(id) {
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
                style={{ background: '#888', marginTop: 0 }}>← タイトルへ</button>
        <h1>旅行記録 <small style={{ fontSize: 11, color: '#999' }}>v11</small></h1>
        <label>旅行を選ぶ
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

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
