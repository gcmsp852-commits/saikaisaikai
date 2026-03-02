let ready = false;
let zxingEngine = null;

// ▼ Workerの初期化を非同期（async）で行うように全体を包む
(async function initWorker() {
  try {
    // 1. ファイルを読み込む
    importScripts('./ZXingReader.js');

    // 2. エンジンの「素（ファクトリー関数、またはオブジェクト）」を探す
    let moduleOrFactory = self.ZXingReader || self.ZXingWASM || self.ZXing || self.zxing || self.Module;

    // もし一般的な名前で見つからなければ、自力で探す
    if (!moduleOrFactory) {
      for (const key in self) {
        // ZXingっぽい名前の関数を探す
        if (typeof self[key] === 'function' && key.toLowerCase().includes('zxing')) {
          moduleOrFactory = self[key];
          break;
        }
      }
    }

    if (!moduleOrFactory) {
      throw new Error('ZXingReader.js の中にエンジン本体が見つかりません。');
    }

    // 3. ★超重要：もし「起動スイッチ（関数）」だった場合、実行してWASMのロード完了を待つ
    if (typeof moduleOrFactory === 'function') {
      // WASMファイルの読み込みと準備が終わるまで待機
      zxingEngine = await moduleOrFactory(); 
    } else {
      // すでにオブジェクトとして完成している場合はそのまま使う
      zxingEngine = moduleOrFactory;
    }

    // 4. 解析用のメソッド（命令）が存在するか最終確認
    if (!zxingEngine || typeof zxingEngine.readBarcodesFromImageData !== 'function') {
      // バージョン違いでメソッド名が単数形になっている場合の救済措置
      if (zxingEngine && typeof zxingEngine.readBarcodeFromImageData === 'function') {
        zxingEngine.readBarcodesFromImageData = zxingEngine.readBarcodeFromImageData;
      } else {
        throw new Error('QR解析用のメソッド(readBarcodesFromImageData)が見つかりません。WASMのビルド仕様が異なる可能性があります。');
      }
    }

    // 全ての準備が完了
    ready = true;
    self.postMessage({ type: 'ready' });

  } catch (e) {
    self.postMessage({ type: 'fatal', error: (e && e.message) ? e.message : String(e) });
  }
})();

// ▼ メイン画面（index.html）から画像データが送られてきたときの処理
self.onmessage = async (ev) => {
  if (!ready || !zxingEngine) return;

  const msg = ev.data || {};
  if (msg.type !== 'req') return;

  const id = msg.id;
  const t0 = performance.now();

  try {
    const width = msg.width | 0;
    const height = msg.height | 0;
    const buf = msg.data;

    if (!(buf instanceof ArrayBuffer)) throw new Error('data is not ArrayBuffer');

    const u8 = new Uint8ClampedArray(buf);
    const img = new ImageData(u8, width, height);

    const opts = msg.options || { formats: ["QRCode"], tryHarder: true, tryRotate: true, tryInvert: true };

    // 解析の実行
    const results = await zxingEngine.readBarcodesFromImageData(img, opts);

    const t1 = performance.now();
    const found = Array.isArray(results) && results.length > 0;

    // Getterで隠れたプロパティ（management16など）を明示的に抽出して表のHTMLに送る
    const packed = (results || []).map(r => ({
      ...r,
      text: r.text,
      format: r.format,
      position: r.position,
      management16: r.management16, // ★必須データ
      extra: r.extra,
      extras: r.extras,
      metadata: r.metadata,
      bytes: r.bytes ? Array.from(r.bytes) : null,
    }));

    self.postMessage({
      type: 'resp',
      id,
      ok: true,
      payload: { found, results: packed, ms: (t1 - t0) }
    });
  } catch (e) {
    const t1 = performance.now();
    self.postMessage({
      type: 'resp',
      id,
      ok: false,
      error: (e && e.message) ? e.message : String(e),
      payload: { ms: (t1 - t0) }
    });
  }
};