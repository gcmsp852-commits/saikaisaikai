/**
 * zxing_worker.js - デバッグ強化版
 */

let ready = false;
let helpOutput = '';

self.Module = {
  noInitialRun: true,
  print(text) {
    self._stdout = (self._stdout || '') + text + '\n';
  },
  printErr(text) {
    self._stderr = (self._stderr || '') + text + '\n';
  },
  onRuntimeInitialized() {
    // --help を実行して引数仕様を取得
    self._stdout = '';
    self._stderr = '';
    try { self.Module.callMain(['--help']); } catch (_) {}
    helpOutput = self._stdout + self._stderr;
    
    ready = true;
    self.postMessage({ type: 'ready', helpOutput });
  },
  onAbort(what) {
    self.postMessage({ type: 'fatal', error: 'WASM abort: ' + what });
  },
};

try {
  importScripts('./ZXingReader.js');
} catch (e) {
  self.postMessage({ type: 'fatal', error: 'importScripts 失敗: ' + (e.message || String(e)) });
}

self.onmessage = async (ev) => {
  if (!ready) return;
  const msg = ev.data || {};
  if (msg.type !== 'req') return;

  const id = msg.id;
  const t0 = performance.now();

  try {
    const width  = msg.width  | 0;
    const height = msg.height | 0;
    const buf    = msg.data;

    if (!(buf instanceof ArrayBuffer)) throw new Error('data is not ArrayBuffer');

    const FS = self.Module.FS;
    if (!FS) throw new Error('Module.FS が見つかりません');

    // --- PNM (PPM) 形式で書き込む（ZXing CLI との相性が良い） ---
    // PPM は「P6\n幅 高さ\n255\n + RGB バイナリ」というシンプルなフォーマット
    const ppmPath  = '/tmp/input.ppm';
    const pngPath  = '/tmp/input.png';

    const rgba = new Uint8ClampedArray(buf);

    // PPM を試みる
    const ppmBytes = buildPPM(rgba, width, height);
    FS.writeFile(ppmPath, ppmBytes);

    // PNG も用意する
    const pngBytes = await rgbaToPng(rgba, width, height);
    FS.writeFile(pngPath, pngBytes);

    // --- 複数の引数パターンを順番に試す ---
    const candidates = [
      // パターン1: ファイルパスのみ（最もシンプル）
      [ppmPath],
      [pngPath],
      // パターン2: --format 付き
      ['--format=QRCode', ppmPath],
      ['--format=QRCode', pngPath],
      // パターン3: -f 短縮形
      ['-f', 'QRCode', ppmPath],
      // パターン4: --barcode-format
      ['--barcode-format=QRCode', ppmPath],
    ];

    let rawOutput = '';
    let results   = [];

    for (const args of candidates) {
      self._stdout = '';
      self._stderr = '';
      try { self.Module.callMain(args); } catch (_) {}
      const out = self._stdout || '';
      const err = self._stderr || '';
      
      // 何らかの出力があれば採用
      if (out.trim() && !out.includes('Usage') && !out.includes('usage') && !out.includes('Error')) {
        rawOutput = out;
        results   = parseOutput(out);
        if (results.length > 0) break;
      }
      rawOutput = out || err; // デバッグ用に最後の出力を保持
    }

    try { FS.unlink(ppmPath); } catch (_) {}
    try { FS.unlink(pngPath); } catch (_) {}

    const t1 = performance.now();

    self.postMessage({
      type: 'resp', id, ok: true,
      payload: {
        found: results.length > 0,
        results,
        ms: t1 - t0,
        rawOutput,
        helpOutput, // デバッグ: --help の出力も返す
      },
    });

  } catch (e) {
    self.postMessage({
      type: 'resp', id, ok: false,
      error: e.message || String(e),
      payload: { ms: performance.now() - t0, helpOutput },
    });
  }
};

// PPM (P6) ビルダー ─ ヘッダ + RGB バイナリ
function buildPPM(rgba, width, height) {
  const header    = `P6\n${width} ${height}\n255\n`;
  const headerBuf = new TextEncoder().encode(header);
  const rgbBuf    = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgbBuf[i*3]   = rgba[i*4];
    rgbBuf[i*3+1] = rgba[i*4+1];
    rgbBuf[i*3+2] = rgba[i*4+2];
  }
  const out = new Uint8Array(headerBuf.length + rgbBuf.length);
  out.set(headerBuf);
  out.set(rgbBuf, headerBuf.length);
  return out;
}

// stdout テキスト → 結果オブジェクト配列
function parseOutput(text) {
  if (!text || !text.trim()) return [];
  const results = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m1 = line.match(/^Text:\s*"?(.+?)"?\s*$/);
    const m2 = line.match(/^(?:Format|Symbology):\s*(.+?)\s*$/);
    const m3 = line.match(/^[-=]{4,}/);
    if (m1) { if (!cur) cur = {}; cur.text = m1[1]; }
    else if (m2) { if (!cur) cur = {}; cur.format = m2[1]; }
    else if (m3 && cur) { results.push(cur); cur = null; }
  }
  if (cur && cur.text) results.push(cur);
  // 解析できなくても生テキストがあれば返す
  if (!results.length && text.trim())
    results.push({ format: 'Unknown', text: text.trim() });
  return results;
}

// RGBA → PNG
async function rgbaToPng(rgba, width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  return buildMinimalPng(rgba, width, height);
}

function buildMinimalPng(rgba, width, height) {
  const ct = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    ct[i] = c;
  }
  const crc32   = b => { let c=0xffffffff; for(const x of b) c=ct[(c^x)&0xff]^(c>>>8); return(c^0xffffffff)>>>0; };
  const adler32 = b => { let s1=1,s2=0; for(const x of b){s1=(s1+x)%65521;s2=(s2+s1)%65521;} return(s2<<16)|s1; };
  const ihdr=new Uint8Array(13); const dv=new DataView(ihdr.buffer);
  dv.setUint32(0,width); dv.setUint32(4,height); ihdr[8]=8; ihdr[9]=2;
  const raw=new Uint8Array(height*(1+width*3));
  for(let y=0;y<height;y++){
    raw[y*(1+width*3)]=0;
    for(let x=0;x<width;x++){
      const s=(y*width+x)*4,d=y*(1+width*3)+1+x*3;
      raw[d]=rgba[s];raw[d+1]=rgba[s+1];raw[d+2]=rgba[s+2];
    }
  }
  const M=65535,B=Math.ceil(raw.length/M);
  const df=new Uint8Array(2+raw.length+B*5+4); let pos=0;
  df[pos++]=0x78;df[pos++]=0x01;
  for(let i=0;i<B;i++){
    const s=i*M,e=Math.min(s+M,raw.length),l=e-s;
    df[pos++]=i===B-1?1:0;df[pos++]=l&0xff;df[pos++]=(l>>8)&0xff;df[pos++]=~l&0xff;df[pos++]=(~l>>8)&0xff;
    df.set(raw.subarray(s,e),pos);pos+=l;
  }
  const a=adler32(raw);
  df[pos++]=(a>>24)&0xff;df[pos++]=(a>>16)&0xff;df[pos++]=(a>>8)&0xff;df[pos++]=a&0xff;
  const deflate=df.subarray(0,pos);
  const chunk=(t,d)=>{
    const tb=new TextEncoder().encode(t),cb=new Uint8Array(tb.length+d.length);
    cb.set(tb);cb.set(d,tb.length);
    const lb=new Uint8Array(4),rb=new Uint8Array(4);
    new DataView(lb.buffer).setUint32(0,d.length);new DataView(rb.buffer).setUint32(0,crc32(cb));
    return[lb,tb,d,rb];
  };
  const sig=new Uint8Array([137,80,78,71,13,10,26,10]);
  const parts=[sig,...chunk('IHDR',ihdr),...chunk('IDAT',deflate),...chunk('IEND',new Uint8Array(0))];
  const out=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));
  let off=0; for(const p of parts){out.set(p,off);off+=p.length;}
  return out;
}