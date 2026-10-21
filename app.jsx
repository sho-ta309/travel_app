// useState などは「フック」と呼ばれる、Reactの基本の道具
  const { useState, useEffect, useRef, useMemo } = React;

  // 保存キーは今までと同じ → 以前の記録がそのまま引き継がれる
  const STORAGE_KEY = 'travel-log-records';
  const TRIP_KEY = 'travel-log-trips';

  function loadTrips() {
    const saved = JSON.parse(localStorage.getItem(TRIP_KEY) || 'null');
    if (saved) return saved;
    const first = { id: Date.now(), name: '最初の旅行' };
    return { trips: [first], currentTripId: first.id };
  }
  // 緯度・経度が、正しい数値かを調べる
  function validLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function loadRecords(trips) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) {}
    return list
      .filter(r => validLatLng(r.lat, r.lng))   // 座標が壊れた記録は、除外する
      .map(r => trips.some(t => t.id === r.tripId) ? r : { ...r, tripId: trips[0].id });
  }

  function readAndResize(file, maxW = 800) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = value => {
        img.onload = img.onerror = null;
        img.src = '';                 // 画像のメモリを手放す
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
        c.width = c.height = 0;       // キャンバスのメモリも解放する
        done(data);
      };
      img.onerror = () => done(null);
      img.src = url;
    });
  }

    // 日付を「2026-10-20」の形にする
  function toDateStr(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 写真に埋め込まれた位置情報と撮影日を読み取る
  async function readPhotoInfo(file) {
    let gps = null, taken = null;
    try { gps = await exifr.gps(file); } catch (e) {}   // 位置情報（無ければ null）
    try {
      const tags = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
      taken = tags && (tags.DateTimeOriginal || tags.CreateDate);
    } catch (e) {}
    const hasDate = taken instanceof Date;
    const d = hasDate ? taken : new Date(file.lastModified);   // 無ければファイルの更新日
    const good = gps && validLatLng(gps.latitude, gps.longitude);
    return {
      lat: good ? gps.latitude : null,
      lng: good ? gps.longitude : null,
      date: toDateStr(d),
      ts: d.getTime(),
      dateFromExif: hasDate
    };
  }

  // 地図のポップアップの中身を作る
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

  // ===== 部品：検索バー =====
  // 検索結果を押したら、親（MapView）から渡された onPick を呼ぶ
  function SearchBar({ onPick }) {
    const [q, setQ] = useState('');
    const [results, setResults] = useState([]);
    const [msg, setMsg] = useState('');

    async function handleSubmit(e) {
      e.preventDefault();
      if (!q.trim()) return;
      setMsg('検索中...');
      setResults([]);
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ja&limit=5&q='
                  + encodeURIComponent(q);
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const list = await res.json();
        setResults(list);
        setMsg(list.length ? '' : '見つかりませんでした。別の言葉で試してください');
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

  // ===== 部品1：地図 =====
  // Leaflet はReactの外のライブラリ。そこで useRef で地図を持っておき、
  // useEffect の中で「状態が変わったら地図を更新する」処理を書く。
  function MapView({ records, tripId, fitKey, selected, onSelect, focus }) {
    const divRef = useRef(null);       // 地図を入れる <div>
    const mapRef = useRef(null);       // 地図そのもの
    const groupRef = useRef(null);     // ピンをまとめるグループ
    const markersRef = useRef({});     // 記録id → ピン
    const tempRef = useRef(null);      // 選択中の仮ピン

    // 最初の1回だけ：地図を作る（[] は「最初の1回だけ」の意味）
    useEffect(() => {
      const map = L.map(divRef.current).setView([36, 138], 5);
      const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxNativeZoom: 19,maxZoom: 21,  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'});
      const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { attribution: '&copy; 国土地理院', maxNativeZoom: 18, maxZoom: 21});
      const world = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri',maxNativeZoom: 18, maxZoom: 21 });
      osm.addTo(map);
      L.control.layers({
        'OpenStreetMap': osm,
        '航空写真（日本）': photo,
        '衛星写真（世界）': world
      }).addTo(map);
      groupRef.current = L.layerGroup().addTo(map);
      map.on('click', e => onSelect(e.latlng));
      mapRef.current = map;
      return () => map.remove();
    }, []);

    useEffect(() => {
      groupRef.current.clearLayers();
      markersRef.current = {};
      records.forEach(r => {
        if (!validLatLng(r.lat, r.lng)) return;   // 壊れた座標は、飛ばす
        // 関数を渡すと、ポップアップを開いたときに、中身（写真）が作られる
        const m = L.marker([r.lat, r.lng]).bindPopup(() => makePopup(r), { maxWidth: 150 });
        groupRef.current.addLayer(m);
        markersRef.current[r.id] = m;
      });
    }, [records]);

    // 旅行が切り替わったら：その旅行の記録が全部見える位置へ移動
    useEffect(() => {
      if (records.length) {
        mapRef.current.fitBounds(records.map(r => [r.lat, r.lng]), { maxZoom: 13, padding: [40, 40] });
      }
    }, [tripId, fitKey]);

    // selected が変わったら：仮ピンを付け替える
    useEffect(() => {
      if (tempRef.current) { mapRef.current.removeLayer(tempRef.current); tempRef.current = null; }
      if (selected) {
        tempRef.current = L.marker(selected).addTo(mapRef.current)
        .bindTooltip('クリックで取り消し')     // ピンの上にマウスを置くと表示
        .on('click', () => onSelect(null));     // クリックしたら、選択を取り消す
      }
    }, [selected]);

        // 一覧のカードが押されたら：滑らかに移動して、着いたらポップアップを開く
    useEffect(() => {
      if (!focus) return;
      const m = markersRef.current[focus.id];
      if (!m) return;

      const map = mapRef.current;
      const target = m.getLatLng();
      const zoom = Math.max(map.getZoom(), 13);   // すでに拡大していれば、その倍率を保つ

      // すでにその場所にいる場合は、移動せずに、ポップアップだけ開く
      const alreadyThere = map.getCenter().distanceTo(target) < 5 && map.getZoom() === zoom;
      if (alreadyThere) { m.openPopup(); return; }

      // 移動が終わったとき（moveend）に、1回だけポップアップを開く
      map.once('moveend', () => m.openPopup());
      map.flyTo(target, zoom, { duration: 1.5 });   // duration：移動にかける秒数
    }, [focus]);

    // 検索結果を選んだとき：その場所へ地図を動かして、仮ピンを立てる
  function handlePick(p) {
    const bb = p.boundingbox.map(Number);   // [南, 北, 西, 東]
    mapRef.current.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 16 });
    onSelect(L.latLng(Number(p.lat), Number(p.lon)));
  }

    return (
    <div className="mapWrap">
      <SearchBar onPick={handlePick} />
      <div className="map" ref={divRef}></div>
    </div>
  );
  }

  // ===== 部品2：入力フォーム =====
  // 入力中の文字は、この部品の中だけの状態（useState）で持つ
    function RecordForm({ selected, onAdd, editing, onUpdate, onCancel }) {
    const [title, setTitle] = useState('');
    const [date, setDate] = useState('');
    const [memo, setMemo] = useState('');
    const [removePhoto, setRemovePhoto] = useState(false);
    const [msg, setMsg] = useState('地図をクリックして場所を選んでください');
    const fileRef = useRef(null);
    const formRef = useRef(null);

    // 編集の対象が変わったとき：フォームに今の内容を入れる（終わったら空に戻す）
    useEffect(() => {
      if (fileRef.current) fileRef.current.value = '';
      setRemovePhoto(false);
      if (editing) {
        setTitle(editing.title);
        setDate(editing.date);
        setMemo(editing.memo || '');
        setMsg('編集中：場所を変えるときは、地図をクリックしてください');
        // フォームが画面の外にあっても、見える位置までスクロールする
        formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        setTitle(''); setDate(''); setMemo('');
        setMsg(m => m.startsWith('編集中') ? '' : m);
      }
    }, [editing]);

    async function handleSubmit(e) {
      e.preventDefault();
      const file = fileRef.current.files[0];

      // ---- 編集モード：既存の記録を更新する ----
      if (editing) {
        const changes = { title, date, memo };
        if (file) changes.photo = await readAndResize(file);   // 新しい写真を選んだときだけ差し替え
        else if (removePhoto) changes.photo = null;            // 「写真を外す」にチェックしたとき
        if (selected) { changes.lat = selected.lat; changes.lng = selected.lng; }   // 地図をクリックし直したときだけ場所を変更
        onUpdate(editing.id, changes);
        return;
      }

      // ---- 通常モード：新しい記録を追加する ----
      if (!selected) { setMsg('先に地図をクリックしてください！'); return; }
      const photo = file ? await readAndResize(file) : null;
      onAdd({ id: Date.now(), title, date, memo, lat: selected.lat, lng: selected.lng, photo });
      setTitle(''); setDate(''); setMemo('');
      fileRef.current.value = '';
      setMsg('');
    }

    return (
      <form ref={formRef} onSubmit={handleSubmit}>
        <label>タイトル <input value={title} onChange={e => setTitle(e.target.value)} required /></label>
        <label>日付 <input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
        <label>メモ <textarea rows="2" value={memo} onChange={e => setMemo(e.target.value)} /></label>

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

    // ===== 部品：写真のまとめて追加 =====
  function BulkImport({ onAdd }) {
    const [items, setItems] = useState([]);   // 読み込んだ写真（確認用の一覧）
    const [busy, setBusy] = useState(false);

    async function handleFiles(e) {
      let files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
      e.target.value = '';
      if (!files.length) return;

      const MAX = 8;   // 一度に読み込む上限（動いたら、少しずつ増やす）
      if (files.length > MAX) {
        alert('一度に読み込めるのは' + MAX + '枚までです。最初の' + MAX + '枚を読み込みます');
        files = files.slice(0, MAX);
      }

      setBusy(true);
      try {
        const list = [];
        for (const f of files) {
          const info = await readPhotoInfo(f);
          const photo = await readAndResize(f, 480);   // スマホでは小さめにして、メモリと容量を節約
          list.push({
            key: f.name + f.size + f.lastModified,
            title: f.name.replace(/\.[^.]+$/, ''),
            photo, ...info
          });
          await new Promise(r => setTimeout(r, 80));   // ブラウザに、メモリを片付ける時間を与える
        }
        list.sort((a, b) => a.ts - b.ts);
        setItems(list);
      } catch (err) {
        alert('写真の読み込み中に問題が起きました：' + err.message);
      } finally {
        setBusy(false);
      }
    }

    // 位置情報があり、写真も読めたものだけを記録できる
    const ok = items.filter(i => validLatLng(i.lat, i.lng) && i.photo);
    const ng = items.length - ok.length;

    function importAll() {
      onAdd(ok.map((i, n) => ({
        id: Date.now() + n,
        title: i.title, date: i.date, memo: '',
        lat: i.lat, lng: i.lng, photo: i.photo
      })));
      setItems(items.filter(i => !ok.includes(i)));   // 登録できなかったものだけ残す
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
        {busy && <div className="msg">読み込み中...（写真が多いと時間がかかります）</div>}

        {items.map(i => (
          <div className="record" key={i.key} style={{ cursor: 'default' }}>
            {i.photo ? <img src={i.photo} /> : <div className="msg">読み込めない形式です</div>}
            <input value={i.title}
                   onChange={e => setItems(items.map(x => x.key === i.key ? { ...x, title: e.target.value } : x))} />
            <small>{i.date}{i.dateFromExif ? '（撮影日）' : '（ファイルの更新日）'}</small><br />
            <small>{i.lat !== null ? '📍 位置情報あり' : '⚠ 位置情報なし'}</small>
          </div>
        ))}

        {ok.length > 0 && <button onClick={importAll}>位置情報のある{ok.length}件を記録する</button>}
        {ng > 0 && <div className="msg">位置情報のない（または読めない）{ng}件は、「記録を追加」のフォームで、1件ずつ登録してください</div>}
        {items.length > 0 && <button style={{ background: '#888' }} onClick={() => setItems([])}>一覧を閉じる</button>}
      </div>
    );
  }

  // ===== 部品3：記録1件のカード =====
  function RecordCard({ record, isEditing, onFocus, onEdit, onDelete }) {
    return (
      <div className="record" onClick={() => onFocus(record.id)}
           style={isEditing ? { outline: '2px solid #2a7de1' } : undefined}>
        <b>{record.title}</b> <small>{record.date}</small><br />
        <button className="edit" onClick={e => { e.stopPropagation(); onEdit(record.id); }}>編集</button>
        <button className="del" onClick={e => {
          e.stopPropagation();   // カード全体のクリックを動かさない
          if (confirm('「' + record.title + '」を削除しますか？')) onDelete(record.id);
        }}>削除</button>
        {record.photo && <img src={record.photo} />}
      </div>
    );
  }

  // ===== 親の部品：アプリ全体 =====
  // データ（状態）はここで持ち、子の部品には props（引数のようなもの）で渡す
  function App() {
    const [tripData, setTripData] = useState(loadTrips);
    const [records, setRecords] = useState(() => loadRecords(tripData.trips));
    const [selected, setSelected] = useState(null);   // 地図でクリックした場所
    const [focus, setFocus] = useState(null);
    const [fitKey, setFitKey] = useState(0);   // 追加したあと、地図を動かすための合図
    const [editingId, setEditingId] = useState(null);   // 編集中の記録のid（なければ null）

    // 状態が変わったら、自動で保存（save() を手動で呼ぶ必要がなくなる）
    useEffect(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
      catch (e) { alert('保存できませんでした（容量オーバーかもしれません）'); }
    }, [records]);
    useEffect(() => {
      localStorage.setItem(TRIP_KEY, JSON.stringify(tripData));
    }, [tripData]);

    // 今の旅行の記録だけ（records か旅行が変わったときだけ計算し直す）
    const currentId = tripData.currentTripId;
    const current = useMemo(() => records.filter(r => r.tripId === currentId), [records, currentId]);
    const editing = records.find(r => r.id === editingId) || null;   // find：条件に合う最初の1件

    function addRecord(r) {
      setRecords([...records, { ...r, tripId: currentId }]);
      setSelected(null);
    }
        // 複数の記録を、まとめて追加する
    function addRecords(list) {
      setRecords(prev => [...prev, ...list.map(r => ({ ...r, tripId: currentId }))]);
      setFitKey(k => k + 1);
    }
    // 記録を更新する：id が一致する記録だけ、changes の内容で上書きする
    function updateRecord(id, changes) {
      setRecords(prev => prev.map(r => r.id === id ? { ...r, ...changes } : r));
      setEditingId(null);
      setSelected(null);
    }
    function startEdit(id) {
      setSelected(null);
      setEditingId(id);
      setFocus({ id });      // その記録の場所へ、地図が移動する
    }
    function cancelEdit() {
      setEditingId(null);
      setSelected(null);
    }
    function deleteRecord(id) {
      setRecords(prev => prev.filter(r => r.id !== id));
      if (editingId === id) setEditingId(null);
    }
    function addTrip() {
      const name = prompt('旅行の名前（例：2026 京都）');
      if (!name) return;
      const trip = { id: Date.now(), name };
      setTripData({ trips: [...tripData.trips, trip], currentTripId: trip.id });
    }

    // 画面（JSX）：状態から画面を作る。render() を呼ぶ必要はない
    return (
      <>
        <div className="sidebar">
          <h1>旅行記録 <small style={{ fontSize: 11, color: '#999' }}>v4</small></h1>
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
          <BulkImport onAdd={addRecords} />

          <h2>記録一覧（{current.length}件）</h2>
          {current.map(r => (
            <RecordCard key={r.id} record={r}
                        isEditing={r.id === editingId}
                        onFocus={id => setFocus({ id })}
                        onEdit={startEdit}
                        onDelete={deleteRecord} />
          ))}
        </div>
        <MapView records={current} tripId={currentId} fitKey={fitKey} selected={selected} onSelect={setSelected} focus={focus} />
      </>
    );
  }

  // ===== エラーが起きたとき、真っ白にせず、内容を表示する =====
  // （エラーを受け止める部品は、今のところ class で書く決まりです）
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

  ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary><App /></ErrorBoundary>
  );
