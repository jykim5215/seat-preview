# HANDOFF.md — CGV 좌석 시야 미리보기

> 이 문서는 자기완결적이다. Claude Code와 사용자의 대화를 보지 못한 상태에서 이 파일 하나만 읽고 작업을 이어받을 수 있도록 쓴다.
> 진행 상황이 바뀔 때마다 §6 "현재 상태"를 갱신한다.

---

## 1. 프로젝트 개요와 목표

CGV 예매 좌석을 고르면 **그 좌석에서 스크린이 실제로 어떻게 보이는지**를 물리적으로 정확하게 렌더링해 보여주는 데스크톱용 웹 애플리케이션.

- 화면 구성: **왼쪽 = 시야 미리보기(3D 뷰포트), 오른쪽 = 극장/상영관/좌석 선택 패널.** 좌우 배치 고정.
- 선택 흐름: 지역 → 극장 → 상영관(IMAX관, 1관, SCREENX, 4DX 등) → 회차/좌석. 실제 CGV 예매 구조를 따른다.
- 스크린에 띄우는 영화는 「오디세이」 포스터 (`assets/poster-odyssey.jpg`, 사용자가 직접 배치).
- 핵심 가치는 UI가 아니라 **스크린의 실제 크기·위치·곡률과 좌석의 3차원 좌표를 근거로 시야를 계산하는 렌더링 정확도**.

작업 폴더: 이 저장소 루트 (`좌석 미리보기/` — 위치 무관, 상대 경로로 동작)

## 2. 사용자 요구사항 (원문 의도 보존, 임의 변경 금지)

### 2.1 기술 제약 (타협 불가)
- **로컬 서버 금지.** `index.html` 더블클릭 → `file://`로 바로 뜨고 완전 동작해야 한다.
- 빌드 도구·번들러·npm 런타임 의존 금지. 순수 HTML + CSS + JS.
- `file://`에서 ES module은 CORS로 막힘 → **모든 JS는 클래식 `<script>`(비모듈)로 분할 로드하거나 인라인.** 실제 `file://`에서 열어 확인하며 진행.
- `fetch()`로 JSON 읽기도 `file://`에서 막힘 → `data/theaters.json`(사람 편집용 원본)과 `data/theaters.js`(전역 변수 할당, 앱이 로드)를 이중 유지. 변환 스크립트 `tools/build-data.js`(Node 1회 실행용)로 동기화.
- three.js는 `vendor/three.min.js` 로컬 동봉. **CDN 참조 금지.**
- 대상: 최신 Chrome/Edge 데스크톱, 최소 1280×800. 모바일 미대응.
- 외부 네트워크 요청은 **업데이트 확인용 GitHub API 호출 단 하나**만 허용.

### 2.2 렌더링 물리 모델 (앱의 심장 — 단일 진리원)
- 단위 미터, 오른손 좌표계. 원점 = 스크린 하단 중앙이 최전열 바닥 레벨에 투영된 지점. +X = 관객 기준 오른쪽, +Y = 위, +Z = 스크린 → 관객석 방향(좌석은 모두 z > 0).
- 상영관 파라미터: `screen { widthM, heightM, bottomHeightM, curvatureRadiusM(null=평면), tiltDeg, maskingRatios }`, `auditorium { floorProfile(flat|sloped|stepped), rowRiseM, rowPitchM, seatPitchM, firstRowZM, firstRowFloorYM, eyeHeightM(기본 1.15) }`.
- 좌석: `{ id, rowLabel, colNumber, xM(통로 반영 실측 좌표), zM, floorYM, section, grade }`.
- **카메라 = `(seat.xM, seat.floorYM + eyeHeightM, seat.zM)`**, 시선 = 스크린 유효 영상 영역 기하 중심.
- 계측값 7종을 항상 표시: 스크린까지 거리(m), 수평 시야각(°, THX 36°/SMPTE 30° 기준선), 수직 시야각(°), 시선 올림각(°, 35° 초과 경고), 좌우 이탈각(°, 15° 초과 경고), 화면 채움률(입체각 비율), 종합 등급(5단계, 수식·가중치 주석 명시).
- 계산은 `src/geometry/metrics.js` 단일 파일. 렌더러와 계측 패널이 **같은 함수**를 사용(이중 구현 금지). 각 함수에 단위·근거 주석.
- 화면비 마스킹: IMAX 1.43 / IMAX 1.90 / 2.39 스코프 / 1.85 플랫. 포맷 선택 시 점등 영역과 계측값이 함께 바뀐다. 마스킹 영역은 검은색이 아닌 미세 발광 짙은 회색(`#0b0b0c` 수준).
- 사실성 요소: 앞좌석 등받이·앞사람 머리 실루엣, 커튼/흡음벽/천장/통로 유도등, 스크린 발 환경광, 곡면 스크린 측면 왜곡, 스크린 게인/핫스팟.

### 2.3 렌더러 인터페이스 계약 (Claude Code 확정, Codex 구현)
`src/render/renderer.js`가 전역 `window.SeatPreviewRenderer`로 아래 6개 메서드를 정확히 제공한다. 플랫폼은 이 6개 외 아무것도 호출하지 않는다.

```js
window.SeatPreviewRenderer = {
  init(canvas) {},        // HTMLCanvasElement
  setScene(scene) {},     // PreviewScene — 상영관 변경 시 씬 전체 교체
  setSeat(seat) {},       // SeatSpec — 좌석만 변경 시 카메라만 이동(씬 재구축 금지), 260ms 이내 보간
  resize(width, height) {},
  capture() {},           // 현재 프레임 PNG dataURL 반환
  dispose() {}
};
```

`PreviewScene = { screen, auditorium, seats, activeSeat, format, posterImage, options: { showOccupants, ambient, fovMode } }` (타입 상세는 `CODEX_PROMPT.md` §5 참조).

- 계측값 계산은 렌더러 밖(`metrics.js`). 렌더러는 그림만 그린다.
- 스텁 렌더러 `src/render/renderer.stub.js`: `renderer.js`가 없으면 자동 폴백. 앱은 스텁만으로도 끝까지 동작해야 한다(단순 원근 사각형 + 포스터 텍스처 수준, 그러나 계약을 완전히 만족).
- **3D 렌더러 본체는 Claude Code 세션에서 만들지 않는다. Codex가 `CODEX_PROMPT.md` 하나만 읽고 `renderer.js` 단일 파일로 완성한다.**

### 2.4 데이터
- CGV 실제 데이터 수집: 지역/극장 목록, 상영관 명칭, 좌석 배치(열 라벨·열당 좌석 수·통로 위치·등급 구역·총 좌석 수), 상영 포맷.
- **수집 방식은 사용자 승인 필요**: 브라우저 자동화 도구를 쓸지, 사용자가 DOM을 직접 복사해 줄지. 로그인된 CGV 세션을 자동화로 건드리기 전 반드시 승인. 자동 로그인·비밀번호 입력 절대 금지.
- 스크린 실측 치수는 CGV 비공개 → 공개 실측치가 있는 관(예: 용산아이파크몰 IMAX LASER)은 `sourceNote`와 함께 사용, 나머지는 `estimateScreenGeometry()`로 명시적 추정. 데이터에 `"geometrySource": "measured" | "estimated"` 필수, UI에도 "추정" 표기. **추측을 실측인 척 금지.**
- 저작권: CGV 로고·이미지·포스터를 배포 패키지에 복제 금지. 사실 데이터(좌석 배치)만 사용. 포스터 자동 다운로드 금지 — 파일 없으면 동일 종횡비 절차적 플레이스홀더 폴백.
- 스키마: `data/theaters.json` — `{ schemaVersion, regions[{ id, name, theaters[{ id, name, screens[{ id, name, formats, totalSeats, geometrySource, sourceNote, screen{...}, auditorium{...}, rows[{ label, seats[{ n, xM, grade, aisleAfter }] }] }] }] }] }`. 좌석 `xM`은 통로(기본 폭 1.1 m 상수) 반영 실제 미터 좌표. 좌석 번호 → 좌표 변환기는 `src/data/layout.js`.

### 2.5 UI — "AI가 만든 티" 절대 금지
톤: 암실 톤 무채색. 주인공은 왼쪽 시야 화면, 나머지는 조용한 계기판.

금지(하나라도 어기면 다시): 그라디언트 배경 일체, glassmorphism/`backdrop-filter: blur`/반투명 카드, 장식용 box-shadow·glow·네온, 8px 초과 border-radius(기본 2~4px), UI 내 이모지(아이콘은 1px 스트로크 SVG만), 히어로 섹션·중앙정렬 큰 제목·마케팅 카피, 불필요한 카드 그리드, pulse/bounce/무한 애니메이션, 다크모드 토글, 강조색 2개 이상.

준수: 시스템 폰트 스택(`-apple-system, "Segoe UI", "Malgun Gothic", sans-serif`), 본문 13px/라벨 11px, 굵기 400·600만. 색상 `#0a0a0b`(배경) `#141416`(패널) `#1e1e21`(경계) `#8a8a8f`(보조) `#e8e8ea`(본문), 강조는 선택 좌석 하나에만 CGV 레드 `#d40000` 계열. 경계는 1px 실선. 전환 `opacity`/`transform`만 120ms 이하(좌석 카메라 이동만 260ms ease-out 예외). 밀도 우선 — 한 화면에서 극장 선택·좌석 선택·수치 읽기 완결. 오른쪽 패널은 지역/극장/상영관 접히는 목록 하나 + 그 아래 좌석 배치도(스크린 위, 좌석 아래, 열 라벨 양쪽). 키보드: 방향키 좌석 이동, Enter 확정, 이동 즉시 시야 갱신(킬러 동작).

- 본 구현 전 `mockups/style-a.html`, `style-b.html`, `style-c.html` 3개 목업을 만들어 사용자가 고를 때까지 대기. A=암실 계기판, B=상영관 도면, C=예매창 정직 버전. 동일 더미 데이터·동일 시야 스틸로 비교 가능하게.

### 2.6 패키징·아이콘·업데이트
- 아이콘: 영화관 좌석에 앉아 스크린을 보는 사람 뒷모습 실루엣, 단색 한 겹 + 밝은 스크린 사각형. 그라디언트·그림자·3D·둥근 배지 금지. SVG 원본 → `.ico`(16/32/48/256). 16px에서 뭉개지지 않을 것.
- 바로가기: 바탕화면 원클릭 실행, 위 `.ico` 사용, 상대 경로 처리, 생성·재생성 방법 README 기재.
- 자체 업데이트: `version.json`(semantic versioning, 코드 수정 시마다 갱신). 하단 상태줄의 "업데이트 확인" → GitHub Releases API로 최신 버전·changelog 비교 → 새 버전이면 changelog 표시 후 **사용자 승인 하에** 교체. 실패 시 조용한 한 줄 메시지, 앱은 계속 사용 가능. 토큰·자격증명 하드코딩 금지(공개 저장소 공개 API만). **GitHub 저장소가 없으면 어디 만들지 사용자에게 먼저 질문, push·release 전 확인.**
- 배포 zip: 코드 수정 시마다 갱신. 개인정보(계정·쿠키·로컬 절대경로) 포함 여부 점검. 작업 보고 시마다 끝에 (1) 개선한 보안 취약점(없으면 "없음"), (2) HANDOFF.md 갱신 부분을 각 한 줄로 기재.

## 3. 기술 방향

- 스택: 순수 HTML/CSS/JS(클래식 스크립트), three.js 로컬 동봉(`vendor/three.min.js`). 빌드 없음, 서버 없음.
- 상태 관리: 전역 네임스페이스(예: `window.SeatPreviewApp`) 아래 단순 상태 객체 + 이벤트 콜백. 프레임워크 없음.
- 파일 구조(예정):

```
좌석 미리보기/
├─ index.html
├─ version.json                  { "version": "0.1.0", "changelog": "..." }
├─ HANDOFF.md
├─ CODEX_PROMPT.md
├─ README.md
├─ assets/
│  ├─ icon.svg / icon.ico
│  └─ poster-odyssey.jpg         (사용자가 직접 배치; 없으면 절차적 플레이스홀더)
├─ vendor/three.min.js
├─ data/
│  ├─ theaters.json              편집용 원본
│  └─ theaters.js                앱이 읽는 형태 (전역 변수 할당)
├─ src/
│  ├─ app.js                     부트스트랩·상태
│  ├─ ui/                        패널·좌석배치도·계측 표시
│  ├─ data/layout.js             좌석번호 → 미터 좌표 (통로 폭 1.1 m 상수)
│  ├─ geometry/metrics.js        계측 7종 계산 (단일 진리원)
│  ├─ render/renderer.stub.js    저품질 폴백 (계약 완전 만족)
│  └─ render/renderer.js         ← Codex 산출물이 들어올 자리
├─ tools/build-data.js           theaters.json → theaters.js 변환 (Node 1회 실행)
├─ mockups/style-a.html / style-b.html / style-c.html
└─ 좌석 미리보기.lnk / 실행.bat
```

- 스크립트 로드 순서(index.html): `vendor/three.min.js` → `data/theaters.js` → `src/geometry/metrics.js` → `src/data/layout.js` → `src/render/renderer.stub.js` → `src/render/renderer.js`(있으면 — `onerror`로 없음을 감지해 스텁 유지) → `src/ui/*.js` → `src/app.js`.
- GitHub 저장소: **github.com/jykim5215/seat-preview** (공개). GitHub Pages: https://jykim5215.github.io/seat-preview/ . 배포 제외 파일: CLAUDE_CODE_PROMPT.md·*.lnk·dist/ (.gitignore).
- 버전 관리: `version.json` semantic versioning. 릴리즈마다 배포 zip 첨부.

## 4. 구현 계획 (순서와 근거)

1. ~~HANDOFF.md 작성~~ (이 문서)
2. `CODEX_PROMPT.md` 작성 — 렌더러 외주 프롬프트. 물리 모델·인터페이스 계약 전문 복붙, 샘플 상영관 데이터 첨부, 검수 항목·검증 기준 포함. 자기완결적.
3. UI 스타일 목업 3개(`mockups/`) → 사용자 선택 대기. **선택 전 본 구현 금지.**
4. 데이터 수집 — 방식(브라우저 자동화 vs 사용자 직접 복사)을 사용자에게 질문 후 진행. `data/theaters.json` 구축 + `tools/build-data.js` + `estimateScreenGeometry()`.
5. 플랫폼 구현 — 셸·상태·접히는 선택 목록·좌석 배치도·계측 패널·키보드 내비게이션. 렌더러는 스텁으로 연결.
6. 패키징 — 아이콘 SVG/ICO, 바로가기, version.json, 자체 업데이트 UI, README, 배포 zip.

주요 설계 결정:
- 렌더러를 인터페이스 계약 + 스텁으로 분리한 이유: 렌더러 본체는 Codex가 구현하기로 사용자가 결정. 플랫폼과 렌더러가 6-메서드 계약으로만 결합하면 병렬 작업과 교체가 안전하다.
- JSON을 JS 파일로 이중화한 이유: `file://`에서 `fetch()` 불가. 사람이 편집하는 소스(JSON)와 앱 로드용(JS)을 분리하고 변환 스크립트로 동기화한다.
- 계측 계산을 `metrics.js` 한 곳에 모은 이유: 렌더러와 패널의 수치 불일치를 원천 차단(사용자 요구: 이중 구현 금지).

## 5. 제약 조건 요약

- 로컬 서버 없이 `file://` 더블클릭 구동 (§2.1)
- 개인정보 제거·보안 점검을 배포 zip마다 수행, 보고 시 취약점 개선 사항 명기
- 원클릭 바로가기 + 주제 관련 아이콘
- GitHub 릴리즈 기반 자체 업데이트 (외부 요청은 이 API 하나만)
- CGV 로그인 세션 자동화 전 사용자 승인 필수, 자동 로그인 금지
- CGV 저작물 복제 금지, 포스터 자동 다운로드 금지
- UI 금지 목록(§2.5) 위반 시 재작업
- 렌더러 본체는 Codex 담당 — Claude Code는 계약·스텁·CODEX_PROMPT.md까지만

## 6. 현재 상태 (2026-08-13 갱신)

- **v0.1.0 — 플랫폼 완성, 스텁 렌더러로 전체 동작. 남은 것은 Codex 의 3D 본 렌더러.**
- 사용자 결정 사항:
  - UI 스타일: **B안 (상영관 도면)** 채택 — index.html 에 구현됨.
  - 데이터 수집: 사용자 크롬 세션 사용 승인 → CGV 공개 예매 API 읽기 전용 수집 완료.
- 완료:
  - 데이터: 지역 9·극장 178 전체 목록 + 좌석 배치 18개 관 3,384석
    (용산아이파크몰 IMAX·SCREENX·4DX·박찬욱관·1관·15관 + 춘천 전 12관).
    `data/raw-cgv-collected.json`(수집 원본) → `tools/import-cgv-raw.js` → `theaters.json` → `tools/build-data.js` → `theaters.js`.
  - 플랫폼 전부: metrics.js(계측 7종)·estimate.js·layout.js·renderer.stub.js(계약 만족 Canvas 2D)·UI 3모듈·app.js·index.html.
    file:// 더블클릭 실행 검증 완료 (키보드 이동·포맷 전환·마스킹·계측 갱신 확인).
  - 패키징: icon.svg → icon.ico(tools/build-icon.js), 바탕화면 바로가기(tools/make-shortcut.ps1), 실행.bat, version.json, README.md, 배포 zip.
- 해석해서 바꾼 것 (이유 포함):
  - **회차 선택 제외**: 회차는 시야 계산과 무관한 휘발성 데이터라 포맷 선택으로 대체. (§1 의 "회차/좌석 순" 요구를 시야 시뮬레이터 목적에 맞게 축소)
  - 좌석 xM 은 임포트 시 확정(그리드×0.28 m), zM/floorYM 은 앱 로드 시 layout.js 가 계산 — 추정 파라미터 수정 시 데이터 재생성이 필요 없게 하기 위함.
  - 배치 미수집 극장(172곳)은 목록에 표시하되 선택 불가("미수집") — 추측 배치를 만들지 않기 위함.
- 다음 할 일:
  1. **Codex 에 CODEX_PROMPT.md 전달 → src/render/renderer.js 구현** (파일 하나, 계약 §5 유지). 넣으면 자동으로 스텁 대체.
  2. GitHub 저장소 위치 확정 (사용자 답변 대기) → src/app.js 의 GITHUB_REPO 채우고 v0.1.0 릴리즈 + zip 첨부.
  3. (선택) 사용자가 assets/poster-odyssey.jpg 배치.
  4. (선택) 추가 극장 좌석 수집 — raw-cgv-collected.json 에 추가 후 임포트 2단계 재실행.
- GitHub 업로드: **완료** — github.com/jykim5215/seat-preview (공개), Release v0.1.0 + 배포 zip 첨부, GitHub Pages 웹 버전 https://jykim5215.github.io/seat-preview/ 서비스 중.
- 앱 내 업데이트 확인: **구현·검증 완료** (실제 릴리즈와 비교해 "최신 버전입니다 (v0.1.0)" 확인).
- 포스터: 사용자 제공 이미지를 assets/poster-odyssey.jpg 로 로컬 배치 완료. 저작권 자료라 .gitignore 로 공개 저장소·배포 zip 에서 제외 — 웹 버전은 플레이스홀더 폴백.
