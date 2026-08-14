# CODEX_PROMPT.md — 좌석 시야 3D 렌더러 구현 의뢰

> 이 문서는 자기완결적이다. 이 파일 하나만 읽고 `src/render/renderer.js` **단일 파일**을 완성할 수 있어야 한다.
> 이 프로젝트의 다른 대화·문서를 볼 수 없다는 전제로 필요한 모든 사양을 여기에 적었다.

---

## 1. 무엇을 만드는가

CGV 영화관에서 특정 좌석을 골랐을 때 **그 좌석에서 스크린이 실제로 어떻게 보이는지**를 물리적으로 정확하게 렌더링하는 three.js 기반 3D 렌더러.

- 산출물: `src/render/renderer.js` **파일 하나.** 다른 파일 생성 금지.
- 실행 환경: 브라우저에서 `index.html`을 `file://`로 직접 연 상태. **로컬 서버 없음.**
- 따라서 ES module 금지 (`import`/`export` 사용 불가 — `file://`에서 CORS로 막힌다). **클래식 스크립트**로 작성한다.
- three.js는 이미 `vendor/three.min.js`(**r147** UMD 빌드)로 페이지에 로드되어 전역 `THREE`로 접근 가능하다. **CDN 로드 금지, 추가 라이브러리 금지, 빌드 도구 금지.** r147 코어에는 `ACESFilmicToneMapping`, `InstancedMesh`, `CylinderGeometry` 등이 모두 있지만 examples/ 애드온(EffectComposer 등)은 없다.
- 렌더러는 전역 객체 `window.SeatPreviewRenderer` 하나를 정의한다 (인터페이스는 §5).
- 플랫폼 코드(이미 존재)는 이 전역 객체의 6개 메서드만 호출한다. 시그니처를 절대 바꾸지 말 것.

파일 로드 순서: `vendor/three.min.js` → (데이터·계측 스크립트들) → `src/render/renderer.stub.js`(저품질 폴백, 이미 존재) → `src/render/renderer.js`(이 파일). 나중에 로드되는 이 파일이 `window.SeatPreviewRenderer`를 덮어쓰는 구조다. 파일 끝에서 전역 할당만 하면 된다.

---

## 2. 좌표계 (전 프로젝트 공통 — 절대 변경 금지)

- 단위: **미터**. 오른손 좌표계.
- 원점: **스크린 하단 중앙이 바닥(관객석 최전열 바닥 레벨)에 투영된 지점.**
- `+X` = 스크린을 마주 봤을 때 관객 기준 오른쪽
- `+Y` = 위
- `+Z` = 스크린에서 관객석 쪽으로 멀어지는 방향 (즉 좌석은 모두 `z > 0`)

three.js 기본 카메라(-Z를 바라봄)와 자연스럽게 맞는다: 좌석(z>0)에서 스크린(z≈0)을 보면 시선이 대략 -Z 방향이다.

---

## 3. 물리 모델 파라미터

### 3.1 상영관(screen / auditorium) 파라미터

```
screen: {
  widthM,            // 스크린 유효 영상 폭 (m)
  heightM,           // 스크린 유효 영상 높이 (m)
  bottomHeightM,     // 스크린 하단 모서리의 바닥면(원점 레벨) 기준 높이 (m)
  curvatureRadiusM,  // 곡면 스크린 반경 (m). null이면 평면
  tiltDeg,           // 스크린 상단이 관객 쪽으로 기운 각도(+, 도). 대개 0~3
  maskingRatios: {   // 화면비별 실제 점등 영역 (§4)
    "1.43": ..., "1.90": ..., "2.39": ..., "1.85": ...
  },
  sideProjection,    // true 면 SCREENX 관: 좌우 벽면 투사 (§4 참조)
  sideLenM           // SCREENX 측면 투사 길이 (m). sideProjection false 면 null
}
auditorium: {
  floorProfile,      // "flat" | "sloped" | "stepped"
  rowRiseM,          // 열 간 단차(stepped) 또는 열당 상승량(sloped) (m)
  rowPitchM,         // 열 간 앞뒤 간격 (m, 기본 1.0~1.2)
  seatPitchM,        // 좌석 좌우 간격 (m, 기본 0.52~0.60)
  firstRowZM,        // 스크린 면에서 A열 좌석 중심까지 거리 (m)
  firstRowFloorYM,   // A열 바닥 높이 (m, 스크린 하단 기준. 음수 가능)
  eyeHeightM         // 착석 시 눈높이 (m). 기본 1.15
}
```

- 곡면 스크린(`curvatureRadiusM`이 숫자)은 **수직축 실린더의 섹션**이다. 실린더 중심축은 관객석 쪽(+Z), 스크린이 관객을 감싸는 방향으로 오목하다. 호 길이가 `widthM`이 되도록 지오메트리를 만든다.
- `tiltDeg`는 스크린 평면(또는 실린더 섹션 전체)을 하단 모서리를 축으로 상단이 +Z쪽으로 기울인 것.

### 3.2 좌석 파라미터

```
seat: {
  id,            // "F12" 같은 문자열
  rowLabel,      // "F"
  colNumber,     // 12
  xM,            // 열 중심 기준 좌우 오프셋 (m). 통로(aisle) 반영된 실측 좌표
  zM,            // 스크린 면에서의 거리 (m)
  floorYM,       // 이 열의 바닥 높이 (m)
  section,       // "front" | "center" | "rear" | "balcony"
  grade          // "일반석" | "리클라이너" | "SWEETBOX" 등 (CGV 원문 등급명)
}
```

실제 객체에는 플랫폼 내부용 추가 필드(`aisleAfter`, `rowIndex`, `gx`, `gy`, `gw`, `gh` — 좌석도 그리드 좌표)가 더 붙어 있다. **렌더러는 위에 명시된 필드만 사용하고 나머지는 무시한다** (제거하거나 의존하지 말 것).

### 3.3 카메라 (핵심 규칙)

- **카메라 위치 = `(seat.xM, seat.floorYM + auditorium.eyeHeightM, seat.zM)`**
- **시선 방향 = 카메라 → 현재 마스킹 기준 점등 영역(§4)의 기하 중심.** 관객이 스크린 중앙을 자연스럽게 응시한다고 가정한다. 고개를 극단적으로 돌린 상태가 아니다.
- 카메라 up 벡터는 +Y 고정 (머리를 기울이지 않음).
- **FOV: 인간 시야 근사 고정값을 쓰지 말 것.** 캔버스 종횡비와 무관하게 **수평 화각을 고정**한다 (기본 60°, `options.fovMode`로 변경 가능). three.js `PerspectiveCamera.fov`는 수직 화각이므로, `resize()`마다 `fovV = 2·atan(tan(fovH/2) / aspect)`로 환산해 설정한다.

## 4. 화면비 마스킹

스크린 전체가 항상 밝은 게 아니다. 상영 포맷에 따라 점등(영상) 영역이 달라진다.

| 포맷 문자열 (scene.format) | 화면비 | 규칙 |
|---|---|---|
| `"IMAX 1.43"` | 1.43:1 | 스크린 세로 전체 사용 (IMAX관 전용) |
| `"IMAX 1.90"` | 1.90:1 | 일반 IMAX 디지털 |
| `"2.39"` | 2.39:1 | 스코프 — 위아래 마스킹 |
| `"1.85"` | 1.85:1 | 플랫 |
| `"SCREENX"` | 2.39:1 (정면) | 정면은 2.39 와 동일 + **좌우 벽면 투사** (아래) |

**SCREENX 측면 투사** — `screen.sideProjection === true` 인 상영관에서 포맷 `"SCREENX"` 선택 시:
- 정면 스크린 좌/우 모서리에서 객석 쪽(+Z)으로 이어지는 수직 벽면(x = ±widthM/2)에 영상을 투사한다.
- 투사 길이는 `screen.sideLenM` (m). 높이는 정면 점등 영역과 동일 (yB~yT 연속).
- 측면 소스는 포스터 가장자리 15% 를 미러링해 늘인 것으로 근사하고, 정면 대비 **40~50% 감광** (실제 ScreenX 측면은 게인이 낮고 어둡다).
- **측면 투사면과 정면 스크린 사이에 이음 틈·밝기 단차가 보이면 안 된다.** 측면 시작점은 점등 영역 모서리의 실제 3D 위치(곡면·기울기 반영)와 일치시키고, 감광은 모서리에서 벽 끝으로 갈수록 점진적으로(약 15%→55%) 적용한다.
- 이 두 필드는 ScreenX 가 아닌 상영관에서는 `false`/`null` 이다.

점등 영역 계산 규칙 (플랫폼의 `metrics.js`와 동일 로직):
- 스크린 유효 영역(`widthM × heightM`) 안에서, 목표 화면비에 맞는 **최대 내접 사각형**을 스크린 중앙 기준으로 잡는다.
  - `screenAspect = widthM / heightM`, `targetAspect = 포맷 화면비`
  - `targetAspect ≥ screenAspect`이면: 폭 전체 사용, 높이 = `widthM / targetAspect` (위아래 마스킹)
  - `targetAspect < screenAspect`이면: 높이 전체 사용, 폭 = `heightM × targetAspect` (좌우 마스킹)
- `screen.maskingRatios`에 해당 화면비 키가 있으면 그 값을 우선 사용한다. 값 형태: `{ "widthRatio": 0~1, "heightRatio": 0~1, "offsetYRatio": 0 }` (스크린 유효 영역 대비 비율, offsetYRatio는 중앙 기준 세로 오프셋).
- 포스터 텍스처는 **점등 영역에 정확히 맞춰** 매핑한다 (레터박스 없이 채움. 포스터 종횡비가 다르면 중앙 크롭).
- **마스킹된(점등 밖) 스크린 영역은 순흑이 아니라 `#0b0b0c` 수준의 아주 미세하게 빛이 새는 짙은 회색**으로 그린다. 실제 극장 마스킹이 그렇다.
- 곡면 스크린이면 점등 영역·포스터 매핑도 실린더 곡면을 따라간다.

## 5. 인터페이스 계약 (절대 변경 금지)

```js
/**
 * @typedef {Object} ScreenSpec        §3.1의 screen 그대로
 * @typedef {Object} AuditoriumSpec    §3.1의 auditorium 그대로
 * @typedef {Object} SeatSpec          §3.2의 seat 그대로
 *
 * @typedef {Object} PreviewScene
 * @property {ScreenSpec}     screen
 * @property {AuditoriumSpec} auditorium
 * @property {SeatSpec[]}     seats       // 앞좌석/사람 실루엣 배치용 전체 좌석
 * @property {SeatSpec}       activeSeat  // 카메라가 놓이는 좌석
 * @property {string}         format      // "IMAX 1.43" | "IMAX 1.90" | "2.39" | "1.85" | "SCREENX"
 * @property {HTMLImageElement|null} posterImage  // 플랫폼이 항상 로드해서 넘긴다 (포스터 파일이 없으면 플레이스홀더 이미지). null 은 로드 실패 시 뿐 — 그 경우 #55555f 수준의 밝은 회색 단색 화면을 그린다
 * @property {Object}         options
 * @property {boolean}        options.showOccupants  // 앞사람 실루엣 표시 여부
 * @property {number}         options.ambient        // 0~1, 객석 환경광 스케일 (기본 1)
 * @property {number}         options.fovMode        // 수평 화각(도). 기본 60
 */

window.SeatPreviewRenderer = {
  /** @param {HTMLCanvasElement} canvas @returns {void} */
  init(canvas) {},

  /** 씬 전체 교체 (상영관이 바뀔 때) @param {PreviewScene} scene */
  setScene(scene) {},

  /** 좌석만 바뀔 때 — 카메라만 이동. 씬 재구축 금지 @param {SeatSpec} seat */
  setSeat(seat) {},

  /** 캔버스 크기 변경 @param {number} width @param {number} height */
  resize(width, height) {},

  /** 현재 프레임을 PNG dataURL로 @returns {string} */
  capture() {},

  dispose() {}
};
```

추가 계약 사항:
- 플랫폼은 이 6개 메서드 외 어떤 것도 호출하지 않는다. 렌더러도 플랫폼의 다른 전역을 건드리지 않는다 (`THREE`와 자신의 지역 상태만 사용).
- **계측값(시야각 등) 계산은 렌더러의 일이 아니다.** 플랫폼의 `src/geometry/metrics.js`가 담당한다. 렌더러는 그림만 그린다.
- `setScene()`은 이전 씬의 GPU 리소스(지오메트리·머티리얼·텍스처)를 정리하고 새로 만든다.
- `setSeat()`은 **씬을 재구축하지 않고** 카메라 위치·시선만 **260ms 이내 ease-out 보간**으로 이동한다. 연타되면 진행 중 보간을 끊고 새 목표로 이어간다.
- `capture()`는 현재 프레임을 그린 직후의 캔버스를 `toDataURL("image/png")`로 반환한다 (`preserveDrawingBuffer` 또는 capture 시 1회 강제 렌더). **주의**: `file://` 실행 시 포스터 텍스처가 캔버스를 오염(taint)시켜 `toDataURL` 이 SecurityError 를 던질 수 있다 — try/catch 로 감싸 실패 시 빈 문자열 `""` 을 반환하고 크래시하지 않는다.
- `dispose()` 후 GPU 리소스 누수 없음 (renderer.dispose(), 지오메트리·머티리얼·텍스처 dispose 전부).
- `init()` 전에 다른 메서드가 불리면 조용히 no-op. `setScene()` 전에 `setSeat()`이 불려도 크래시 금지.

## 6. 씬에 반드시 넣을 사실성 요소

1. **앞좌석 등받이와 앞사람 머리 실루엣** — 좌석 등급의 실질적 차이는 앞열이 시야 하단을 가리는 정도다. `scene.seats` 전체를 등받이 지오메트리로 배치하되 **인스턴싱(InstancedMesh)** 을 사용한다(수백 석 성능). `options.showOccupants`가 true면 일부 좌석(고정 시드 의사난수로 60% 정도)에 머리·어깨 실루엣을 얹는다. 등받이 상단 높이는 바닥 기준 약 1.0 m, 머리 꼭대기는 약 1.25 m.
2. **스크린 좌우의 커튼/흡음벽, 천장, 통로 유도등** — 어두운 무채색 재질. 유도등은 바닥 통로를 따라 매우 약한 점광.
   추가로 **비상구**: 상영 중 극장에서 실제로 항상 보이는 요소다.
   - 위치는 실제 극장 표준 배치를 따른다: **스크린 양측 전방 출구 2곳 + 객석 후방 측면 출입구(입장 통로) 2곳**. (CGV 는 관별 비상구 좌표를 공개하지 않으므로 다중이용업소 소방 기준의 표준 배치를 반영. 데이터에 좌표가 추가되면 그것을 우선.)
   - 유도등은 **ISO 7010 E002 달리는 사람 픽토그램**(문 + 달리는 사람)이 식별 가능해야 한다. 녹색 자발광 패널(#1d5b28 수준)에 밝은 픽토그램(#cfe9cf 수준). 과하게 밝히지 말 것 — 어두운 객석에서 은은하게 빛나는 정도.
   - 문은 어두운 실루엣 + 문틀 라인.
3. **스크린 밝기가 만드는 환경광** — 객석이 완전 암흑이 아니다. 점등 영역 평균 밝기에 비례하는 약한 광원(스크린 위치에서 객석 방향)으로 근사한다. `options.ambient`로 스케일. **주의**: `file://` 에서는 포스터 픽셀을 `getImageData` 로 읽을 수 없다(캔버스 오염) — 평균 밝기를 읽지 못하면 중간 회색 가정의 고정 근사값을 쓴다.
4. **곡면 스크린의 측면 왜곡** — 실린더 지오메트리를 정확히 만들면 자동으로 얻어진다. 별도 트릭 금지.
5. **스크린 게인/핫스팟** — 시선 방향과 스크린 법선이 가까운 영역이 미세하게 더 밝은 효과. 실린더 법선 n=(−x/R, 0, √(1−(x/R)²)) 기준, 벗어난 각도에 따라 최대 30% 감광. 셰이더 또는 머티리얼 트릭으로 아주 약하게.
6. **마스킹 그림자** — 점등 영역 가장자리를 따라 마스킹 커튼이 드리우는 어두운 띠 (얇게, 실제 극장처럼).
7. **바닥 반사광** — 스크린 앞 바닥(최전열 앞 구역)에 화면 빛이 은은하게 비친다 (알파 5% 수준).
8. **객석 단차의 시야선 근거** — auditorium.rowRiseM 은 플랫폼이 C-value 시야선 기준(엇배열 2열 전방 머리 위 0.12 m 여유)으로 계산해 넘겨준다. 렌더러는 값을 그대로 쓰면 된다 (자체 계산 금지).

## 7. 렌더링 품질 사양

- 톤매핑: `THREE.ACESFilmicToneMapping`. 노출은 스크린 점등 영역이 화면에서 자연스러운 밝기가 되도록 고정값으로 튜닝 (동적 노출 금지).
- 블룸: 아주 약하게(강도 0.15 이하) 또는 생략. 포스트프로세싱 체인을 위해 외부 파일을 추가로 로드할 수 없다는 점에 주의 — `vendor/three.min.js` 코어만으로 해결하거나 생략한다.
- **금지: 과장된 렌즈 플레어, 비네팅, 필름 그레인.** 사진처럼 담담하게. 이것은 시뮬레이터지 영화 예고편이 아니다.
- 60fps 유지 (1280×800 캔버스, 내장 GPU 기준). 렌더 루프는 `requestAnimationFrame`, 탭 비활성 시 자동 정지.
- 안티앨리어싱 활성, `devicePixelRatio` 상한 2.

## 8. 샘플 데이터 — 렌더러가 실제로 받는 `PreviewScene` (CGV 용산아이파크몰 IMAX관, 실데이터)

```js
{
  screen: {
    widthM: 31.0,            // CGV/IMAX 공개 실측치
    heightM: 22.4,
    bottomHeightM: 1.0,
    curvatureRadiusM: 26.0,
    tiltDeg: 2.0,
    maskingRatios: {},
    sideProjection: false,   // 이 관은 SCREENX 아님
    sideLenM: null
  },
  auditorium: {
    floorProfile: "stepped",
    rowRiseM: 0.45,
    rowPitchM: 1.15,
    seatPitchM: 0.56,
    firstRowZM: 8.5,
    firstRowFloorYM: 0.0,
    eyeHeightM: 1.15
  },
  seats: [ // 624석 전체. 발췌 3석 (zM/floorYM 은 플랫폼이 이미 계산해서 채움):
    { id: "A3",  rowLabel: "A", colNumber: 3,  xM: -11.76, zM: 8.5,   floorYM: 0.0,  section: "front",  grade: "일반석" },
    { id: "J23", rowLabel: "J", colNumber: 23, xM: 0.0,    zM: 18.85, floorYM: 4.05, section: "center", grade: "일반석" },
    { id: "P45", rowLabel: "P", colNumber: 45, xM: 13.44,  zM: 25.75, floorYM: 6.75, section: "rear",   grade: "일반석" }
  ],
  activeSeat: /* seats 중 하나 (같은 객체 참조) */,
  format: "IMAX 1.90",
  posterImage: /* HTMLImageElement (3840×2160 등) */,
  options: { showOccupants: true, ambient: 1, fovMode: 60 }
}
```

- 렌더러는 **`scene.seats` 배열(SeatSpec[])만** 사용한다. 원본 데이터 파일(`data/…`)을 직접 읽지 말 것.
- 참고 규모감: 이 관은 A~P 16열, 열당 최대 45석, 좌석 z 범위 8.5~25.75 m, 최후열 바닥 높이 6.75 m.
- SCREENX 예시가 필요하면: 같은 극장 SCREENX관(리클라이너 200석, 10열)은 screen.widthM≈12.2(추정), sideProjection: true, sideLenM≈13.4, format "SCREENX".

## 9. 검증 기준 (구현 후 스스로 확인할 것)

플랫폼의 `metrics.js`는 다음과 같이 수평 시야각을 계산한다 (렌더러 검증용 참고 — 렌더러가 이 값을 계산할 필요는 없다):

```
눈 위치 E = (xM, floorYM + eyeHeightM, zM)
점등 영역 좌/우 끝 모서리의 3D 좌표 L, R (곡면이면 실린더 위의 점)
수평 시야각 = angle(L - E, R - E) 를 수평면(XZ)에 투영해 계산 (도)
```

1. **정중앙 좌석 검증**: 점등 영역 중앙 정면의 좌석에서 `capture()`한 이미지 위에서 점등 영역 좌우 끝이 차지하는 픽셀 폭으로 화각을 역산했을 때, `metrics.js` 계산값과 **±1° 이내**로 일치해야 한다. (수평 화각 60° 고정이므로: `시야각 ≈ 2·atan((픽셀폭/캔버스폭)·tan(30°))`)
2. **기대 결과 서술 검증** — 위 샘플 상영관 기준:
   - **최전열 중앙(A열 중앙, z≈8.5)**: 스크린이 시야를 압도한다. 수평 시야각 100° 이상, 스크린 상단을 보려면 앙각이 50°를 넘어 화면 상단이 프레임 밖으로 잘린다. 점등 영역 하단이 화면 정중앙보다 아래에 있고 앞좌석은 거의 안 보인다.
   - **최후열 중앙(P열 중앙, z≈25.75)**: 스크린 전체가 여유 있게 프레임 안에 들어온다(수평 시야각 60~75°). 앞열 등받이·머리 실루엣이 화면 하단에 보일 수 있으나 stepped 단차(0.45 m) 덕에 점등 영역을 가리지는 않는다.
   - **최측면(아무 열의 1번 좌석)**: 점등 영역이 사다리꼴로 왜곡된다(가까운 쪽 모서리가 더 크게). 곡면 스크린이라 왜곡이 평면보다 완만하지만 좌우 비대칭은 뚜렷해야 한다. 시선이 점등 영역 중심을 향하므로 스크린은 프레임 중앙 부근에 온다.
3. `setSeat()` 연속 호출(방향키 연타 시나리오)에서 프레임 드랍·메모리 증가가 없을 것.
4. `renderer.js`를 지운 상태(스텁 폴백)와 넣은 상태 모두에서 앱이 정상 동작할 것.

## 10. 하지 말아야 할 것 (요약)

- 인터페이스 시그니처 변경, 메서드 추가 요구
- ES module (`import`/`export`), CDN 로드, 추가 라이브러리, 빌드 도구
- 계측값 자체 계산 (플랫폼이 `metrics.js`로 담당)
- 렌즈 플레어·비네팅·필름 그레인·과장된 블룸
- `renderer.js` 외 파일 생성·수정
- 전역 네임스페이스 오염 (`window.SeatPreviewRenderer` 외 전역 추가 금지)
