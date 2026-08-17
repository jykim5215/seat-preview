# 좌석 시야 미리보기 — CGV · 메가박스 · 롯데시네마

CGV · 메가박스 · 롯데시네마 예매 좌석을 고르면 **그 좌석에서 스크린이 실제로 어떻게 보이는지**를 물리 계산으로 렌더링하는 데스크톱 웹앱.
로컬 서버 없이 동작한다 — `index.html` 을 더블클릭하면 끝.

## 실행

- `index.html` 더블클릭, 또는 `실행.bat`, 또는 바탕화면의 "좌석 시야 미리보기" 바로가기
- 대상: 최신 Chrome/Edge, 데스크톱 1280×800 이상

## 조작

| 입력 | 동작 |
|---|---|
| 오른쪽 패널 클릭 | 브랜드 → 지역 → 극장 → 상영관 선택 (대표 상영 포맷 자동 적용) |
| 좌석도 클릭 / 방향키 | 좌석 이동 — 왼쪽 시야가 즉시 갱신 |
| Enter | 좌석 확정 (하단 상태줄에 요약) |
| SEAT VIEW / ROOM VIEW / V | 실제 좌석 60° 시야와 극장 구조 90° 시야 전환 |
| BEST SEAT / R | 현재 상영관에서 계측 점수가 높은 추천 좌석으로 이동 |
| 관객 | 앞좌석 관객 실루엣 표시/숨김 |
| AMBIENT | 스크린 빛에 의한 객석 환경광 조절 |
| FOV | 수평 카메라 시야각 45~90° 조절 |
| PNG SAVE / P | 현재 렌더링 화면을 PNG로 저장 |

## 데이터

3사 전체 **426개 극장 · 2,798개 상영관 · 364,255석** (각 사 예매 좌석도 실데이터).

| 브랜드 | 지역 | 극장 | 배치 수집 상영관 | 좌석 | 출입구 좌표 | 수집일 |
|---|---|---|---|---|---|---|
| CGV | 9 | 178 | 1,196 (미수집 11) | 157,837 | 미공개 | 2026-08-13 |
| 메가박스 | 8 | 115 | 730 | 84,603 | 1,452곳 | 2026-08-17 |
| 롯데시네마 | 8 | 133 | 872 | 121,815 | 1,064곳 | 2026-08-17 |

- 좌석 데이터는 극장별 파일(`data/sites/{siteNo}.js`)로 분리되어 선택 시 지연 로딩된다.
  siteNo 는 브랜드로 구분한다 — CGV `0056` · 메가박스 `mb1372` · 롯데시네마 `lc1013`.
- 세 사업자의 좌표계가 서로 다르므로(CGV 그리드 · 메가박스 행열 그리드 · 롯데시네마 픽셀)
  임포터가 좌석 간격의 최빈값으로 피치를 역산해 **하나의 그리드(1단위 0.28 m)** 로 정규화한다.
- **출입구**: 메가박스(`gateTyCd`)와 롯데시네마(`Enterences`)는 예매 좌석도가 출입구 좌표를 함께
  주므로 그 위치 그대로 렌더링한다. 종류 코드는 유도표지 화살표 방향이라 벽면 판정에는 쓰지 않고
  좌석 블록 대비 좌표로 앞/뒤·좌/우를 정한다. CGV 는 좌표 미공개라 소방 기준 표준 배치를 쓴다.
- **스크린 실측치**: 세 사업자 모두 관별 치수를 대체로 공개하지 않는다. 공개 수치가 확인되는
  용산 IMAX(31×22.4 m)만 "실측"이고 나머지는 좌석 배치 + 특별관 종류 기반 **추정**
  (`src/data/estimate.js`, UI 에 "추정" 표기).
  홍보 문구로 도는 수치라도 수집한 좌석 배치와 어긋나면 실측으로 올리지 않는다.
- **특별관**: IMAX · SCREENX · 4DX / 돌비 시네마 · MX4D · LED · 부티크 · 리클라이너 · 컴포트 /
  수퍼플렉스 · 광음시네마 · 수퍼LED · 샤롯데 를 종류별로 구분해 스크린 폭 비율·종횡비·최전열
  거리·열 피치를 다르게 추정한다.
- 상영관을 선택하면 스크린 비율과 특별관 종류에 맞는 대표 포맷이 자동 적용된다.
- 업로드된 영화 장면 60개는 권역별 후보군으로 나뉘며, 같은 상영관에는 항상 같은 장면이 표시된다.
  브랜드마다 지역 구분이 달라 후보군은 지역 id 가 아니라 지역 *이름* 으로 고른다.
- SCREENX 관은 좌우 벽면 투사(`sideProjection`)가 자동으로 렌더·계측에 반영된다.
- 파이프라인:
  `tools/collect-megabox.js` · `tools/collect-lotte.js`(공개 API 읽기 전용 수집)
  → `data/raw-*.json` → `node tools/import-raw.js` → `data/theaters.json`(인덱스, 편집용) +
  `data/sites/*.js` → `node tools/build-data.js` → `data/theaters.js`

### 수집 다시 하기

```bash
node tools/collect-megabox.js      # 기본: 내일 날짜 상영 회차 기준
node tools/collect-lotte.js
node tools/import-raw.js && node tools/build-data.js
```

두 수집기는 로그인·쿠키 없이 공개 예매 API 를 읽기만 하며(예매·결제 행위 없음), 동시 요청 4개로
제한한다. 이미 좌석도를 받은 상영관은 건너뛰므로 중단 후 다시 실행해도 이어서 수집한다.
수집일에 상영 회차가 없는 관은 좌석도를 받을 수 없어 다른 날짜로 재실행하면 채워진다.

## 포스터

루트에 포함된 영화 장면은 `src/data/scenes.js`의 권역별 후보군을 통해 자동 선택된다.
장면 파일이 누락되면 밝은 2.39:1 플레이스홀더로 폴백한다.

## 렌더러

- 기본: `src/render/renderer.js` (three.js r147) — 곡면·기울기·화면 마스킹, 좌석/관객 인스턴싱, SCREENX 측면 투사, 객석 환경광을 렌더링한다.
- 폴백: WebGL을 사용할 수 없거나 `renderer.js`가 없으면 `src/render/renderer.stub.js` Canvas 2D 렌더러가 같은 인터페이스로 동작한다.
- 화면 위 요약은 좌석 등급과 권장 시야 충족 여부를 즉시 보여 주며, 하단 도크에서 렌더링 조건을 바꿔 비교할 수 있다.

## 바로가기 재생성

폴더를 옮겼다면:

```bash
powershell -ExecutionPolicy Bypass -File tools/make-shortcut.ps1
```

아이콘 재생성: `node tools/build-icon.js` (`assets/icon.svg` → `icon.ico`)

## 업데이트

하단 상태줄 "CHECK UPDATE" — [jykim5215/seat-preview](https://github.com/jykim5215/seat-preview) Releases 최신 버전과 비교 (공개 API, 인증 없음).
버전은 `version.json` + `src/app.js` 의 `APP_VERSION` 을 항상 함께 올린다.

## 웹 버전

로컬 실행과 동일한 앱이 GitHub Pages 로도 서비스된다:
**https://jykim5215.github.io/seat-preview/**

## 폴더 구조

```
index.html            앱 진입점 (더블클릭 실행)
version.json          semantic versioning
HANDOFF.md            Codex/Claude 교대용 핸드오프 브리프
CODEX_PROMPT.md       3D 렌더러 외주 프롬프트 (자기완결)
assets/               icon.svg·icon.ico·(poster-odyssey.jpg)
vendor/three.min.js   three.js r147 로컬 동봉
data/                 theaters.json(원본)·theaters.js(앱용)·raw-{cgv,megabox,lotte}-*.json
data/sites/           극장별 좌석·출입구 (지연 로딩)
src/geometry/         metrics.js — 계측 7종 단일 진리원
src/data/             layout.js(좌표·출입구 변환)·estimate.js(기하 추정)·scenes.js
src/render/           renderer.stub.js·renderer.js
src/ui/               panel.js·seatmap.js·metricsblock.js
tools/                collect-megabox.js·collect-lotte.js·import-raw.js·build-data.js·
                      build-icon.js·make-shortcut.ps1
mockups/              스타일 후보 3안 (B안 채택)
```
