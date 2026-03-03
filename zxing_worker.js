let ready = false;
let detector = null;

function initDetector() {
  if (typeof BarcodeDetector === 'undefined') {
    throw new Error('このブラウザは BarcodeDetector API に対応していません。');
  }
  detector = new BarcodeDetector({ formats: ['qr_code'] });
  ready = true;
}

function parseManagement16(rawText) {
  // JavaScript実装だけではQRの誤り訂正後コードワード列に直接アクセスできないため、
  // アプリ側で管理部を埋め込む簡易形式にも対応しておく。
  // 例: "HELLO|MGMT16:0xA1B2" / "HELLO|MGMT16:1010101010101010"
  if (typeof rawText !== 'string') return null;
  const m = rawText.match(/\|MGMT16:(0x[0-9a-fA-F]{1,4}|[01]{16}|\d{1,5}|[0-9a-fA-F]{1,4})\s*$/);
  if (!m) return null;
  return m[1];
}

async function decodeQrFromRgba(rgba, width, height) {
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(imageData, 0, 0);
  const bitmap = canvas.transferToImageBitmap();

  const out = await detector.detect(bitmap);
  bitmap.close?.();

  if (!out || out.length === 0) {
    return { found: false, results: [] };
  }

  const results = out.map((item) => {
    const points = (item.cornerPoints || []).map((p) => ({ x: p.x, y: p.y }));
    return {
      format: 'QRCode',
      text: item.rawValue || '',
      position: {
        topLeft: points[0] || null,
        topRight: points[1] || null,
        bottomRight: points[2] || null,
        bottomLeft: points[3] || null,
      },
      management16: parseManagement16(item.rawValue || ''),
      extra: {
        note: '管理部16bitをQRビット列から直接抽出するには、デコード器内部(コードワード/ビットストリーム)にアクセス可能な実装が必要です。',
      },
    };
  });

  return { found: true, results };
}

try {
  initDetector();
  self.postMessage({ type: 'ready', engine: 'BarcodeDetector' });
} catch (e) {
  self.postMessage({ type: 'fatal', error: e.message || String(e) });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (!ready || msg.type !== 'req') return;

  const id = msg.id;
  const t0 = performance.now();

  try {
    const width = msg.width | 0;
    const height = msg.height | 0;
    const buf = msg.data;

    if (!(buf instanceof ArrayBuffer)) {
      throw new Error('data is not ArrayBuffer');
    }

    const payload = await decodeQrFromRgba(buf, width, height);
    payload.ms = performance.now() - t0;

    self.postMessage({ type: 'resp', id, ok: true, payload });
  } catch (e) {
    self.postMessage({
      type: 'resp',
      id,
      ok: false,
      error: e.message || String(e),
      payload: { ms: performance.now() - t0 },
    });
  }
};
