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
JSON.parse(json); // 유효성 검증 (실패 시 예외로 중단)

const banner = "/* 자동 생성 파일 — 직접 편집 금지. 원본: data/theaters.json, 재생성: node tools/build-data.js */\n";
fs.writeFileSync(dst, banner + "window.THEATER_DATA = " + json.trim() + ";\n", "utf8");
console.log("theaters.js 생성 완료 (" + Buffer.byteLength(json, "utf8") + " bytes)");
