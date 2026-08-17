/**
 * tools/build-data.js — data/theaters.json → data/theaters.js 동기화
 *
 * file:// 환경에서는 fetch()로 JSON을 읽을 수 없으므로,
 * 앱은 전역 변수 할당 형태의 theaters.js 를 <script>로 로드한다.
 * theaters.json 이 사람이 편집하는 원본이며, 수정 후 이 스크립트를 1회 실행한다.
 *
 * 실행: node tools/build-data.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = path.join(ROOT, "data", "theaters.json");
const dst = path.join(ROOT, "data", "theaters.js");

const json = fs.readFileSync(src, "utf8");
// 원본 JSON 은 사람이 읽도록 들여쓰지만, 앱이 로드하는 JS 는 3사 전체 인덱스라 크다.
// 로드 비용을 줄이려고 들여쓰기를 걷어내고 한 줄로 내보낸다.
const compact = JSON.stringify(JSON.parse(json));

const banner = "/* 자동 생성 파일 — 직접 편집 금지. 원본: data/theaters.json, 재생성: node tools/build-data.js */\n";
fs.writeFileSync(dst, banner + "window.THEATER_DATA = " + compact + ";\n", "utf8");
console.log("theaters.js 생성 완료 (" + Buffer.byteLength(compact, "utf8") + " bytes)");
