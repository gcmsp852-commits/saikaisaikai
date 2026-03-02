let ready = false;
let zxingEngine = null;

try {
  // ▼ 1. ご指定の「ZXingReader.js」を読み込む
  importScripts('./ZXingReader.js');

  // ▼ 2. ライブラリが作ったエンジンの名前を自動で探す
  zxingEngine = self.zxing || self.ZXing || self.ZXingWASM || self.ZXingReader;

  // ▼ 3. もし見つからなければ、関数の中身を総当たりで探す
  if (!zxingEngine || typeof zxingEngine.readBarcodesFromImageData !== 'function') {
    for (const key in self) {
      if (self[key] && typeof self[key].readBarcodesFromImageData === 'function') {
        zxingEngine = self[key];
        break;
      }
    }
  }

  // それでもダメならエラーを出す
  if (!zxingEngine) {
    throw new Error('QR解析用のエンジンが見つかりません。ZXingReader.jsの中身を確認してください。');
  }

  ready = true;
  self.postMessage({ type: 'ready' });
} catch (e) {
  self.postMessage({ type: 'fatal', error: (e && e.message) ? e.message : String(e) });
}

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

    // ▼ 自動検出したエンジンで解析を実行
    const results = await zxingEngine.readBarcodesFromImageData(img, opts);

    const t1 = performance.now();
    const found = Array.isArray(results) && results.length > 0;

    // ▼ Getterで隠れたプロパティ（management16など）を明示的に抽出して表のHTMLに送る
    const packed = (results || []).map(r => ({
      ...r,
      text: r.text,
      format: r.format,
      position: r.position,
      management16: r.management16, // ★ここが超重要
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