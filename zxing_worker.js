/* zxing_worker.js (classic Worker)
 *
 * 同一ディレクトリに以下がある前提：
 * - index.js
 * - zxing_reader.wasm
 * - zxing_worker.js（このファイル）
 *
 * index.js は zxing-wasm（IIFE reader）で、読み込み後 `ZXingWASM` を提供する想定。
 */

let ready = false;

try {
  // ローカルの IIFE 本体をロード
  importScripts('./ZXingReader.js');

  // ここでZXingWASMが生えている想定
  if (!self.ZXingWASM || typeof self.ZXingWASM.readBarcodesFromImageData !== 'function') {
    throw new Error('ZXingWASM が見つかりません（index.js が reader IIFE か確認してください）');
  }

  ready = true;
  self.postMessage({ type: 'ready' });
} catch (e) {
  self.postMessage({ type: 'fatal', error: (e && e.message) ? e.message : String(e) });
}

self.onmessage = async (ev) => {
  if (!ready) return;

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

    const results = await self.ZXingWASM.readBarcodesFromImageData(img, opts);

    const t1 = performance.now();
    const found = Array.isArray(results) && results.length > 0;

    // ★修正箇所：WASMのGetterプロパティが欠落しないよう、明示的に書き出してコピーする
    const packed = (results || []).map(r => ({
      ...r, // 列挙可能なプロパティはそのまま
      text: r.text,
      format: r.format,
      position: r.position,
      // 独自WASMの出力に対応するため、考えられるプロパティを明示的に指定
      management16: r.management16, 
      extra: r.extra,
      extras: r.extras,
      metadata: r.metadata,
      bytes: r.bytes ? Array.from(r.bytes) : null, // ArrayBufferはそのまま送れないので配列化
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