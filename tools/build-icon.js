/**
 * tools/build-icon.js — assets/icon.svg 과 동일한 도형을 절차적으로 래스터라이즈해
 * 멀티 사이즈(16/32/48/256) 32bpp ICO 생성. 외부 의존성 없음 (Node 내장만).
 *
 * 실행: node tools/build-icon.js  →  assets/icon.ico
 */
"use strict";
const fs = require("fs");
const path = require("path");

/* icon.svg 의 도형 (64×64 기준 좌표) */
const LIGHT = [0xea, 0xe8, 0xe8, 255]; // #e8e8ea (BGRA 순서로 기록)
const DARK = [0x16, 0x14, 0x14, 255];  // #141416

function sampleShape(x, y) { // 64-단위 좌표 → 색 또는 null
  // 좌석(모서리 반경 8 라운드 상단 사각형): 실루엣 우선
  if (x >= 14 && x <= 50 && y >= 34 && y <= 64) {
    if (y >= 42) return DARK;
    if (x >= 22 && x <= 42) return DARK;
    const cx = x < 32 ? 22 : 42;
    if ((x - cx) ** 2 + (y - 42) ** 2 <= 64) return DARK;
  }
  // 머리
  if ((x - 32) ** 2 + (y - 31) ** 2 <= 100) return DARK;
  // 스크린
  if (x >= 7 && x <= 57 && y >= 6 && y <= 21) return LIGHT;
  return null;
}

/** size×size RGBA(BGRA) 버퍼, 4×4 슈퍼샘플링 안티앨리어싱 */
function raster(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4, unit = 64 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let b = 0, g = 0, r = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleShape((px + (sx + 0.5) / SS) * unit, (py + (sy + 0.5) / SS) * unit);
          if (c) { b += c[0]; g += c[1]; r += c[2]; a += 255; }
        }
      }
      const n = SS * SS, i = (py * size + px) * 4;
      if (a > 0) {
        // 프리멀티 아님 — ICO 32bpp 는 straight alpha
        buf[i] = Math.round(b / (a / 255)); buf[i + 1] = Math.round(g / (a / 255)); buf[i + 2] = Math.round(r / (a / 255));
        buf[i + 3] = Math.round(a / n);
      }
    }
  }
  return buf;
}

function icoEntry(size) {
  const px = raster(size);
  const rowAnd = Math.ceil(size / 32) * 4;         // 1bpp AND 마스크 (32bit 패딩)
  const img = Buffer.alloc(40 + px.length + rowAnd * size);
  img.writeUInt32LE(40, 0);                        // BITMAPINFOHEADER
  img.writeInt32LE(size, 4);
  img.writeInt32LE(size * 2, 8);                   // XOR+AND 이중 높이
  img.writeUInt16LE(1, 12);
  img.writeUInt16LE(32, 14);
  img.writeUInt32LE(px.length + rowAnd * size, 20);
  for (let y = 0; y < size; y++)                   // 하단부터 (bottom-up)
    px.copy(img, 40 + y * size * 4, (size - 1 - y) * size * 4, (size - y) * size * 4);
  return img;                                       // AND 마스크는 0 (알파 사용)
}

const sizes = [16, 32, 48, 256];
const entries = sizes.map(icoEntry);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);                        // type: icon
header.writeUInt16LE(sizes.length, 4);
let off = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header[e] = s === 256 ? 0 : s;
  header[e + 1] = s === 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(entries[i].length, e + 8);
  header.writeUInt32LE(off, e + 12);
  off += entries[i].length;
});
const out = Buffer.concat([header, ...entries]);
fs.writeFileSync(path.join(__dirname, "..", "assets", "icon.ico"), out);
console.log("icon.ico 생성: " + out.length + " bytes (" + sizes.join("/") + "px)");
