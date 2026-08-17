/**
 * src/render/renderer.js — three.js 좌석 시야 렌더러
 *
 * 클래식 스크립트로 로드되며, 이 파일 밖에는 어떤 상태도 노출하지 않는다.
 * 좌표와 화면 마스킹은 SeatMetrics와 같은 물리 모델을 사용하지만 계측값은 만들지 않는다.
 */
(function () {
  "use strict";

  var fallback = window.SeatPreviewRenderer;
  var T = window.THREE;
  if (!T) return;

  var FORMAT_RATIOS = {
    "IMAX 1.43": 1.43,
    "IMAX 1.90": 1.90,
    "2.39": 2.39,
    "1.85": 1.85,
    "SCREENX": 2.39
  };
  var DEG = Math.PI / 180;
  var CAMERA_MOVE_MS = 260;

  var canvas = null;
  var renderer = null;
  var threeScene = null;
  var camera = null;
  var sceneData = null;
  var sceneRoot = null;
  var width = 1;
  var height = 1;
  var horizontalFov = 60;
  var litCenter = new T.Vector3();
  var cameraTarget = new T.Vector3();
  var animation = null;
  var raf = 0;
  var dirty = false;
  var fallbackMode = false;
  var visibilityListening = false;

  var geometries = [];
  var materials = [];
  var textures = [];
  var gainGeometry = null;
  var occupantState = null;
  var sceneDimensions = null;

  function finite(value, fallbackValue) {
    value = Number(value);
    return isFinite(value) ? value : fallbackValue;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function rememberGeometry(geometry) {
    geometries.push(geometry);
    return geometry;
  }

  function rememberMaterial(material) {
    materials.push(material);
    return material;
  }

  function rememberTexture(texture) {
    textures.push(texture);
    return texture;
  }

  function disposeSceneResources() {
    if (threeScene && sceneRoot) threeScene.remove(sceneRoot);
    sceneRoot = null;
    gainGeometry = null;
    occupantState = null;
    sceneDimensions = null;

    var seen = [];
    function disposeUnique(items) {
      for (var i = 0; i < items.length; i++) {
        if (!items[i] || seen.indexOf(items[i]) >= 0) continue;
        seen.push(items[i]);
        if (typeof items[i].dispose === "function") items[i].dispose();
      }
    }
    disposeUnique(geometries);
    disposeUnique(materials);
    disposeUnique(textures);
    geometries = [];
    materials = [];
    textures = [];
  }

  function litArea(screen, format) {
    var ratio = FORMAT_RATIOS[format] || 1.85;
    var key = String(format || "").replace("IMAX ", "");
    var masks = screen.maskingRatios || {};
    var specified = masks[key];
    var screenW = Math.max(0.1, finite(screen.widthM, 10));
    var screenH = Math.max(0.1, finite(screen.heightM, 5));
    var w;
    var h;
    var offset = 0;

    if (specified && finite(specified.widthRatio, 0) > 0 && finite(specified.heightRatio, 0) > 0) {
      w = screenW * clamp(finite(specified.widthRatio, 1), 0.01, 1);
      h = screenH * clamp(finite(specified.heightRatio, 1), 0.01, 1);
      offset = screenH * finite(specified.offsetYRatio, 0);
    } else if (ratio >= screenW / screenH) {
      w = screenW;
      h = w / ratio;
    } else {
      h = screenH;
      w = h * ratio;
    }

    return {
      w: w,
      h: h,
      centerY: finite(screen.bottomHeightM, 0) + screenH / 2 + offset
    };
  }

  function curveX(screen, x) {
    var radius = finite(screen.curvatureRadiusM, 0);
    if (radius <= 0) return x;
    return radius * Math.sin(clamp(x / radius, -Math.PI * 0.49, Math.PI * 0.49));
  }

  function curveZ(screen, x) {
    var radius = finite(screen.curvatureRadiusM, 0);
    if (radius <= 0) return 0;
    var angle = clamp(x / radius, -Math.PI * 0.49, Math.PI * 0.49);
    return radius * (1 - Math.cos(angle));
  }

  function screenPoint(screen, x, y, extraZ) {
    var bottom = finite(screen.bottomHeightM, 0);
    var tilt = finite(screen.tiltDeg, 0) * DEG;
    return new T.Vector3(
      curveX(screen, x),
      y,
      curveZ(screen, x) + Math.sin(tilt) * (y - bottom) + (extraZ || 0)
    );
  }

  function setLitCenter(screen, lit) {
    litCenter.copy(screenPoint(screen, 0, lit.centerY, 0));
  }

  function eyeOf(seat, auditorium) {
    var eye = window.SeatMetrics.eyePosition(seat, auditorium);
    return new T.Vector3(eye.x, eye.y, eye.z);
  }

  function eyeForView(seat, auditorium, dimensions, options) {
    if (options && options.viewMode === "room" && dimensions) {
      return new T.Vector3(
        -dimensions.roomWidth * 0.16,
        Math.max(dimensions.maxFloorY + 2.20, dimensions.ceilingY * 0.66),
        dimensions.maxZ - 0.72
      );
    }
    return eyeOf(seat, auditorium);
  }

  function updateProjection() {
    if (!camera) return;
    var aspect = Math.max(0.01, width / Math.max(1, height));
    var halfH = clamp(horizontalFov, 20, 130) * DEG / 2;
    camera.aspect = aspect;
    camera.fov = 2 * Math.atan(Math.tan(halfH) / aspect) / DEG;
    camera.updateProjectionMatrix();
  }

  /** 곡면/기울기 스크린의 직사각형 패치. UV는 이미지 전체 좌표로 직접 넣는다. */
  function makeScreenPatch(screen, x0, x1, y0, y1, segmentsX, segmentsY, uvBox, zOffset, colors) {
    var positions = [];
    var uvs = [];
    var surfaceUvs = [];
    var colorValues = [];
    var indices = [];
    var ix;
    var iy;

    for (iy = 0; iy <= segmentsY; iy++) {
      var fy = iy / segmentsY;
      var y = y0 + (y1 - y0) * fy;
      for (ix = 0; ix <= segmentsX; ix++) {
        var fx = ix / segmentsX;
        var x = x0 + (x1 - x0) * fx;
        var p = screenPoint(screen, x, y, zOffset || 0);
        positions.push(p.x, p.y, p.z);
        uvs.push(
          uvBox.u0 + (uvBox.u1 - uvBox.u0) * fx,
          uvBox.v0 + (uvBox.v1 - uvBox.v0) * fy
        );
        surfaceUvs.push(fx, fy);
        if (colors) {
          var c = colors(fx, fy, p);
          colorValues.push(c);
        }
      }
    }

    for (iy = 0; iy < segmentsY; iy++) {
      for (ix = 0; ix < segmentsX; ix++) {
        var a = iy * (segmentsX + 1) + ix;
        var b = a + 1;
        var c0 = a + segmentsX + 1;
        var d = c0 + 1;
        indices.push(a, b, d, a, d, c0);
      }
    }

    var geometry = rememberGeometry(new T.BufferGeometry());
    geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("surfaceUv", new T.Float32BufferAttribute(surfaceUvs, 2));
    if (colors) geometry.setAttribute("screenGain", new T.Float32BufferAttribute(colorValues, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  function makePosterTexture(image) {
    if (!image) return null;
    var texture = rememberTexture(new T.Texture(image));
    texture.wrapS = T.ClampToEdgeWrapping;
    texture.wrapT = T.ClampToEdgeWrapping;
    texture.minFilter = T.LinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = false;
    if ("colorSpace" in texture && T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
    else if (T.sRGBEncoding) texture.encoding = T.sRGBEncoding;
    texture.needsUpdate = true;
    return texture;
  }

  function cropBox(image, aspect) {
    var iw = finite(image && (image.naturalWidth || image.width), 1);
    var ih = finite(image && (image.naturalHeight || image.height), 1);
    var imageAspect = iw / Math.max(1, ih);
    var box = { u0: 0, u1: 1, v0: 0, v1: 1 };
    if (imageAspect > aspect) {
      var usedW = aspect / imageAspect;
      box.u0 = (1 - usedW) / 2;
      box.u1 = 1 - box.u0;
    } else if (imageAspect < aspect) {
      var usedH = imageAspect / aspect;
      box.v0 = (1 - usedH) / 2;
      box.v1 = 1 - box.v0;
    }
    return box;
  }

  /** 원본 화면비를 자르지 않고 목표 점등 영역 안에 맞춘다. 남는 면은 검은 마스킹으로 유지된다. */
  function containArea(image, lit) {
    var iw = finite(image && (image.naturalWidth || image.width), 1);
    var ih = finite(image && (image.naturalHeight || image.height), 1);
    var imageAspect = iw / Math.max(1, ih);
    var targetAspect = lit.w / Math.max(0.1, lit.h);
    var w = lit.w, h = lit.h;
    if (imageAspect > targetAspect) h = w / imageAspect;
    else if (imageAspect < targetAspect) w = h * imageAspect;
    return { w: w, h: h, crop: { u0: 0, u1: 1, v0: 0, v1: 1 } };
  }

  function panoramaMap(image, centerAspect) {
    var iw = finite(image && (image.naturalWidth || image.width), 3);
    var ih = finite(image && (image.naturalHeight || image.height), 1);
    var imageAspect = iw / Math.max(1, ih);
    // 생성된 3:1 마스터의 가운데 58%를 정면, 양쪽 21%를 측면에 배분한다.
    // 세 영역은 같은 v 범위를 공유하므로 지평선과 피사체 높이가 모서리에서 이어진다.
    var centerU0 = 0.21;
    var centerU1 = 0.79;
    var centerSourceAspect = imageAspect * (centerU1 - centerU0);
    var usedV = clamp(centerSourceAspect / Math.max(0.1, centerAspect), 0.35, 1);
    var v0 = (1 - usedV) / 2;
    return {
      panoramic: true,
      center: { u0: centerU0, u1: centerU1, v0: v0, v1: 1 - v0 },
      leftOuter: 0,
      rightOuter: 1
    };
  }

  function averagePoster(image) {
    var result = { r: 0.52, g: 0.53, b: 0.58, luma: 0.53 };
    if (!image || !document || !document.createElement) return result;
    try {
      var sample = document.createElement("canvas");
      sample.width = 8;
      sample.height = 8;
      var context = sample.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, 8, 8);
      var pixels = context.getImageData(0, 0, 8, 8).data;
      var r = 0;
      var g = 0;
      var b = 0;
      for (var i = 0; i < pixels.length; i += 4) {
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
      }
      var count = pixels.length / 4;
      result.r = r / count / 255;
      result.g = g / count / 255;
      result.b = b / count / 255;
      result.luma = 0.2126 * result.r + 0.7152 * result.g + 0.0722 * result.b;
    } catch (ignore) {
      // file:// 교차 출처 이미지면 읽을 수 없다. 중간 회색 근사를 유지한다.
    }
    return result;
  }

  function addMesh(geometry, material, parent) {
    var mesh = new T.Mesh(geometry, material);
    (parent || sceneRoot).add(mesh);
    return mesh;
  }

  function unitBoxGeometry() {
    return rememberGeometry(new T.BoxGeometry(1, 1, 1));
  }

  function makeDarkMaterial(color, roughness) {
    return rememberMaterial(new T.MeshStandardMaterial({
      color: color,
      roughness: roughness == null ? 0.9 : roughness,
      metalness: 0,
      dithering: true
    }));
  }

  function makeCarpetTexture() {
    var carpetCanvas = document.createElement("canvas");
    carpetCanvas.width = 64;
    carpetCanvas.height = 64;
    var context = carpetCanvas.getContext("2d");
    context.fillStyle = "#242126";
    context.fillRect(0, 0, 64, 64);
    var seed = 9137;
    for (var i = 0; i < 900; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      var x = seed & 63;
      var y = (seed >>> 8) & 63;
      var shade = 22 + ((seed >>> 16) & 15);
      context.fillStyle = "rgba(" + (shade + 8) + "," + shade + "," + (shade + 9) + ",.30)";
      context.fillRect(x, y, 1, 1);
    }
    var texture = rememberTexture(new T.CanvasTexture(carpetCanvas));
    texture.wrapS = T.RepeatWrapping;
    texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(4, 7);
    texture.minFilter = T.LinearMipMapLinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = true;
    if ("colorSpace" in texture && T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
    else if (T.sRGBEncoding) texture.encoding = T.sRGBEncoding;
    return texture;
  }

  function addScreen(screen, lit, posterTexture, posterImage, projectionMap) {
    var fullW = Math.max(0.1, finite(screen.widthM, 10));
    var fullH = Math.max(0.1, finite(screen.heightM, 5));
    var bottom = finite(screen.bottomHeightM, 0);
    var segments = screen.curvatureRadiusM ? 40 : 1;
    var plainUV = { u0: 0, u1: 1, v0: 0, v1: 1 };

    var maskGeometry = makeScreenPatch(
      screen, -fullW / 2, fullW / 2, bottom, bottom + fullH,
      segments, 1, plainUV, 0, null
    );
    // three.js r147의 선형→sRGB 출력 변환 후 실제 #0b0b0c 부근이 되도록 선형값을 낮춘다.
    var maskMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: new T.Color(0.0033, 0.0033, 0.0037),
      toneMapped: false
    }));
    var maskMesh = addMesh(maskGeometry, maskMaterial);
    maskMesh.renderOrder = 1;

    var fitted = projectionMap && projectionMap.center
      ? { w: lit.w, h: lit.h, crop: projectionMap.center }
      : containArea(posterImage, lit);
    var crop = fitted.crop;
    var yBottom = lit.centerY - fitted.h / 2;
    var yTop = lit.centerY + fitted.h / 2;
    var litGeometry = makeScreenPatch(
      screen, -fitted.w / 2, fitted.w / 2, yBottom, yTop,
      segments, 2, crop, 0.004,
      function () { return 1; }
    );
    var litMaterial;
    if (posterTexture) {
      // 한 표면에서 광학 감쇠를 처리해 겹친 평면의 z-fighting과 검은 이음새를 피한다.
      litMaterial = rememberMaterial(new T.ShaderMaterial({
        uniforms: {
          map: { value: posterTexture },
          liftColor: { value: new T.Color(0.0080, 0.0090, 0.0110) }
        },
        vertexShader: [
          "attribute vec2 surfaceUv;",
          "attribute float screenGain;",
          "varying vec2 vMapUv;",
          "varying vec2 vSurfaceUv;",
          "varying float vScreenGain;",
          "void main() {",
          "  vMapUv = uv;",
          "  vSurfaceUv = surfaceUv;",
          "  vScreenGain = screenGain;",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}"
        ].join("\n"),
        fragmentShader: [
          "uniform sampler2D map;",
          "uniform vec3 liftColor;",
          "varying vec2 vMapUv;",
          "varying vec2 vSurfaceUv;",
          "varying float vScreenGain;",
          "vec3 srgbToLinear(vec3 c) {",
          "  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));",
          "}",
          "void main() {",
          "  vec3 source = texture2D(map, vMapUv).rgb;",
          "  vec3 linearSource = srgbToLinear(source);",
          "  float edgeDistance = min(min(vSurfaceUv.x, 1.0 - vSurfaceUv.x), min(vSurfaceUv.y, 1.0 - vSurfaceUv.y));",
          "  float edgeFalloff = smoothstep(0.0, 0.018, edgeDistance);",
          "  float radial = clamp(length((vSurfaceUv - 0.5) * vec2(1.0, 0.76)) / 0.64, 0.0, 1.0);",
          "  float hotspot = 1.0 + 0.045 * (1.0 - radial);",
          "  float sourcePeak = max(max(linearSource.r, linearSource.g), linearSource.b);",
          "  vec3 projected = max(linearSource, liftColor * (1.0 - sourcePeak));",
          "  gl_FragColor = vec4(projected * vScreenGain * hotspot * edgeFalloff * 1.58, 1.0);",
          "  #include <tonemapping_fragment>",
          "  #include <encodings_fragment>",
          "}"
        ].join("\n"),
        side: T.FrontSide,
        toneMapped: true
      }));
    } else {
      litMaterial = rememberMaterial(new T.MeshBasicMaterial({ color: 0x777780, side: T.FrontSide }));
    }
    var litMesh = addMesh(litGeometry, litMaterial);
    litMesh.renderOrder = 2;
    gainGeometry = litGeometry;

    // Keep a single projection surface. Nearly coplanar transparent overlays
    // produced z-fighting and dark seams on integrated GPUs.
    return { crop: crop, yBottom: yBottom, yTop: yTop };
  }

  function addScreenX(screen, lit, posterTexture, crop, yBottom, yTop, projectionMap) {
    if (!posterTexture || sceneData.format !== "SCREENX" || !screen.sideProjection) return;
    var sideLength = Math.max(0.1, finite(screen.sideLenM, 12) * 0.94);
    var edgeFraction = (crop.u1 - crop.u0) * 0.24;
    var sides = [-1, 1];

    var sideMaterial = rememberMaterial(new T.ShaderMaterial({
      uniforms: {
        map: { value: posterTexture },
        liftColor: { value: new T.Color(0.012, 0.016, 0.024) }
      },
      vertexShader: [
        "attribute float sideShade;",
        "attribute vec2 sideCoord;",
        "varying vec2 vSideUv;",
        "varying float vSideShade;",
        "varying vec2 vSideCoord;",
        "void main() {",
        "  vSideUv = uv;",
        "  vSideShade = sideShade;",
        "  vSideCoord = sideCoord;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform sampler2D map;",
        "uniform vec3 liftColor;",
        "varying vec2 vSideUv;",
        "varying float vSideShade;",
        "varying vec2 vSideCoord;",
        "vec3 srgbToLinear(vec3 c) {",
        "  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));",
        "}",
        "void main() {",
        "  vec3 source = texture2D(map, vSideUv).rgb;",
        "  vec3 linearSource = srgbToLinear(source);",
        "  float sourcePeak = max(max(linearSource.r, linearSource.g), linearSource.b);",
        "  vec3 projected = linearSource + liftColor * (1.0 - sourcePeak);",
        "  float verticalBlend = smoothstep(0.0, 0.024, vSideCoord.y) * smoothstep(0.0, 0.024, 1.0 - vSideCoord.y);",
        "  float seamBlend = smoothstep(0.0, 0.035, vSideCoord.x);",
        "  vec3 seamLift = projected * mix(0.985, 1.0, seamBlend);",
        "  gl_FragColor = vec4(seamLift * vSideShade * verticalBlend * 1.49, 1.0);",
        "  #include <tonemapping_fragment>",
        "  #include <encodings_fragment>",
        "}"
      ].join("\n"),
      side: T.DoubleSide,
      toneMapped: true
    }));

    for (var si = 0; si < sides.length; si++) {
      var sign = sides[si];
      var x = sign * lit.w / 2;
      var startBottom = screenPoint(screen, x, yBottom, 0.006);
      var startTop = screenPoint(screen, x, yTop, 0.006);
      var segments = 24;
      var verticalSegments = 6;
      var positions = [];
      var uvs = [];
      var shades = [];
      var sideCoords = [];
      var indices = [];

      for (var iz = 0; iz <= segments; iz++) {
        var f = iz / segments;
        var zOffset = sideLength * f;
        var u;
        if (projectionMap && projectionMap.panoramic) {
          if (sign < 0) u = crop.u0 + (projectionMap.leftOuter - crop.u0) * f;
          else u = crop.u1 + (projectionMap.rightOuter - crop.u1) * f;
        } else if (sign < 0) u = crop.u0 + edgeFraction * f;
        else u = crop.u1 - edgeFraction * f;
        var eased = f * f * (3 - 2 * f);
        var brightness = projectionMap && projectionMap.panoramic ?
          0.97 - 0.18 * eased : 0.94 - 0.34 * eased;
        for (var iy = 0; iy <= verticalSegments; iy++) {
          var fy = iy / verticalSegments;
          positions.push(
            startBottom.x + (startTop.x - startBottom.x) * fy,
            startBottom.y + (startTop.y - startBottom.y) * fy,
            startBottom.z + (startTop.z - startBottom.z) * fy + zOffset
          );
          uvs.push(u, crop.v0 + (crop.v1 - crop.v0) * fy);
          shades.push(brightness);
          sideCoords.push(f, fy);
        }
      }
      for (iz = 0; iz < segments; iz++) {
        for (iy = 0; iy < verticalSegments; iy++) {
          var a = iz * (verticalSegments + 1) + iy;
          var b = a + 1;
          var c = a + verticalSegments + 1;
          var d = c + 1;
          if (sign < 0) indices.push(a, d, b, a, c, d);
          else indices.push(a, b, d, a, d, c);
        }
      }

      var geometry = rememberGeometry(new T.BufferGeometry());
      geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute("sideShade", new T.Float32BufferAttribute(shades, 1));
      geometry.setAttribute("sideCoord", new T.Float32BufferAttribute(sideCoords, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      var mesh = addMesh(geometry, sideMaterial);
      mesh.renderOrder = 2;
    }
  }

  function collectRows(seats) {
    var byZ = {};
    for (var i = 0; i < seats.length; i++) {
      var z = finite(seats[i].zM, 0);
      var key = z.toFixed(3);
      if (!byZ[key]) byZ[key] = { z: z, ySum: 0, count: 0 };
      byZ[key].ySum += finite(seats[i].floorYM, 0);
      byZ[key].count++;
    }
    var rows = [];
    for (var k in byZ) {
      if (Object.prototype.hasOwnProperty.call(byZ, k)) {
        rows.push({ z: byZ[k].z, y: byZ[k].ySum / byZ[k].count });
      }
    }
    rows.sort(function (a, b) { return a.z - b.z; });
    return rows;
  }

  function nearestFloorY(rows, z) {
    if (!rows.length) return 0;
    var best = rows[0];
    var distance = Math.abs(z - best.z);
    for (var i = 1; i < rows.length; i++) {
      var nextDistance = Math.abs(z - rows[i].z);
      if (nextDistance < distance) {
        best = rows[i];
        distance = nextDistance;
      }
    }
    return best.y;
  }

  function addAuditorium(screen, auditorium, seats, dimensions, lightColor, ambientScale) {
    var rows = dimensions.rows;
    var roomWidth = dimensions.roomWidth;
    var roomHalf = roomWidth / 2;
    var maxZ = dimensions.maxZ;
    var ceilingY = dimensions.ceilingY;
    var floorMaterial = rememberMaterial(new T.MeshStandardMaterial({
      color: 0x242126,
      map: makeCarpetTexture(),
      roughness: 0.96,
      metalness: 0,
      dithering: true
    }));
    var wallMaterial = makeDarkMaterial(0x15161a, 0.97);
    var ceilingMaterial = makeDarkMaterial(0x0d0e11, 1);
    var box = unitBoxGeometry();
    var matrix = new T.Matrix4();
    var position = new T.Vector3();
    var quaternion = new T.Quaternion();
    var scale = new T.Vector3();

    // 열별 단차를 실제 floorYM 그대로 반영한 바닥 트레드.
    if (rows.length) {
      var tread = new T.InstancedMesh(box, floorMaterial, rows.length + 1);
      for (var i = 0; i < rows.length; i++) {
        var front = i === 0 ? 0 : (rows[i - 1].z + rows[i].z) / 2;
        var back = i === rows.length - 1 ? maxZ : (rows[i].z + rows[i + 1].z) / 2;
        position.set(0, rows[i].y - 0.04, (front + back) / 2);
        scale.set(roomWidth, 0.08, Math.max(0.05, back - front));
        matrix.compose(position, quaternion, scale);
        tread.setMatrixAt(i, matrix);
      }
      position.set(0, rows[0].y - 0.04, Math.max(0.05, rows[0].z / 4));
      scale.set(roomWidth, 0.08, Math.max(0.1, rows[0].z / 2));
      matrix.compose(position, quaternion, scale);
      tread.setMatrixAt(rows.length, matrix);
      tread.instanceMatrix.needsUpdate = true;
      tread.frustumCulled = false;
      sceneRoot.add(tread);

      var riserCount = 0;
      for (i = 1; i < rows.length; i++) if (Math.abs(rows[i].y - rows[i - 1].y) > 0.005) riserCount++;
      if (riserCount) {
        var risers = new T.InstancedMesh(box, floorMaterial, riserCount);
        var ri = 0;
        for (i = 1; i < rows.length; i++) {
          var rise = rows[i].y - rows[i - 1].y;
          if (Math.abs(rise) <= 0.005) continue;
          var boundary = (rows[i - 1].z + rows[i].z) / 2;
          position.set(0, Math.min(rows[i].y, rows[i - 1].y) + Math.abs(rise) / 2, boundary);
          scale.set(roomWidth, Math.abs(rise), 0.06);
          matrix.compose(position, quaternion, scale);
          risers.setMatrixAt(ri++, matrix);
        }
        risers.instanceMatrix.needsUpdate = true;
        risers.frustumCulled = false;
        sceneRoot.add(risers);
      }
    } else {
      var floor = addMesh(box, floorMaterial);
      floor.position.set(0, -0.04, maxZ / 2);
      floor.scale.set(roomWidth, 0.08, maxZ);
    }

    // 흡음 측벽, 천장, 후벽. DoubleSide 평면 대신 얇은 볼륨으로 안정적으로 보인다.
    var leftWall = addMesh(box, wallMaterial);
    leftWall.position.set(-roomHalf, ceilingY / 2, maxZ / 2);
    leftWall.scale.set(0.12, ceilingY, maxZ + 1);
    var rightWall = addMesh(box, wallMaterial);
    rightWall.position.set(roomHalf, ceilingY / 2, maxZ / 2);
    rightWall.scale.set(0.12, ceilingY, maxZ + 1);
    var ceiling = addMesh(box, ceilingMaterial);
    ceiling.position.set(0, ceilingY, maxZ / 2);
    ceiling.scale.set(roomWidth, 0.10, maxZ + 1);
    var rearWall = addMesh(box, wallMaterial);
    rearWall.position.set(0, ceilingY / 2, maxZ + 0.35);
    rearWall.scale.set(roomWidth, ceilingY, 0.12);

    // 실제 상영관의 흡음 패널, 서라운드 스피커와 천장 급·배기구를 저채도로 구성한다.
    var panelMaterial = makeDarkMaterial(0x202126, 0.98);
    var panelCountPerSide = Math.max(4, Math.floor(maxZ / 2.35));
    var panels = new T.InstancedMesh(box, panelMaterial, panelCountPerSide * 2);
    var panelIndex = 0;
    for (i = 0; i < panelCountPerSide; i++) {
      var panelZ = 1.65 + i * Math.max(1.7, (maxZ - 2.4) / Math.max(1, panelCountPerSide - 1));
      var panelFloor = nearestFloorY(rows, panelZ);
      [-1, 1].forEach(function (side) {
        position.set(side * (roomHalf - 0.105), panelFloor + 1.78 + (i % 2) * 0.05, panelZ);
        scale.set(0.07, 1.34 + (i % 3) * 0.08, 1.30 + (i % 2) * 0.12);
        var panelQuaternion = new T.Quaternion().setFromEuler(new T.Euler(0, side * (i % 2 ? -0.018 : 0.018), 0));
        matrix.compose(position, panelQuaternion, scale);
        panels.setMatrixAt(panelIndex++, matrix);
      });
    }
    panels.instanceMatrix.needsUpdate = true;
    panels.frustumCulled = false;
    sceneRoot.add(panels);

    // 실제 상영관의 패널 조인트와 흡음벽 리듬. 얕은 대각 리브가 평면 벽을
    // 잘게 나누어 화면 반사광에서 재질과 깊이가 읽히게 한다.
    var ribMaterial = makeDarkMaterial(0x0d0e11, 0.78);
    var ribs = new T.InstancedMesh(box, ribMaterial, panelCountPerSide * 4);
    var ribIndex = 0;
    for (i = 0; i < panelCountPerSide; i++) {
      var ribZ = 1.65 + i * Math.max(1.7, (maxZ - 2.4) / Math.max(1, panelCountPerSide - 1));
      var ribFloor = nearestFloorY(rows, ribZ);
      [-1, 1].forEach(function (side) {
        [-1, 1].forEach(function (slope) {
          position.set(side * (roomHalf - 0.052), ribFloor + 1.78, ribZ + slope * 0.26);
          scale.set(0.025, 0.035, 0.92);
          var ribQuaternion = new T.Quaternion().setFromEuler(new T.Euler(slope * 0.56, 0, 0));
          matrix.compose(position, ribQuaternion, scale);
          ribs.setMatrixAt(ribIndex++, matrix);
        });
      });
    }
    ribs.instanceMatrix.needsUpdate = true;
    ribs.frustumCulled = false;
    sceneRoot.add(ribs);

    var dadoMaterial = makeDarkMaterial(0x0b0c0f, 0.88);
    [-1, 1].forEach(function (side) {
      var dado = addMesh(box, dadoMaterial);
      dado.position.set(side * (roomHalf - 0.07), 0.48, maxZ / 2);
      dado.scale.set(0.10, 0.92, maxZ + 0.6);
    });

    var aoMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      toneMapped: false
    }));
    [-1, 1].forEach(function (side) {
      var wallAo = addMesh(box, aoMaterial);
      wallAo.position.set(side * (roomHalf - 0.12), 0.08, maxZ / 2);
      wallAo.scale.set(0.12, 0.16, maxZ + 0.5);
    });

    var beamMaterial = makeDarkMaterial(0x090a0c, 0.86);
    var beamCount = Math.max(3, Math.floor(maxZ / 5));
    var beams = new T.InstancedMesh(box, beamMaterial, beamCount);
    for (i = 0; i < beamCount; i++) {
      var beamZ = 2.5 + i * Math.max(4, (maxZ - 4) / Math.max(1, beamCount - 1));
      position.set(0, ceilingY - 0.13, beamZ);
      scale.set(roomWidth - 0.35, 0.18, 0.22);
      matrix.compose(position, quaternion, scale);
      beams.setMatrixAt(i, matrix);
    }
    beams.instanceMatrix.needsUpdate = true;
    beams.frustumCulled = false;
    sceneRoot.add(beams);

    var speakerMaterial = makeDarkMaterial(0x050506, 0.84);
    var speakerCountPerSide = Math.max(3, Math.floor(maxZ / 4.2));
    var speakers = new T.InstancedMesh(box, speakerMaterial, speakerCountPerSide * 2);
    var speakerIndex = 0;
    for (i = 0; i < speakerCountPerSide; i++) {
      var speakerZ = 3.0 + i * Math.max(3.5, (maxZ - 4.5) / Math.max(1, speakerCountPerSide - 1));
      var speakerFloor = nearestFloorY(rows, speakerZ);
      [-1, 1].forEach(function (side) {
        position.set(side * (roomHalf - 0.22), speakerFloor + 2.35, speakerZ);
        scale.set(0.28, 0.48, 0.34);
        matrix.compose(position, quaternion, scale);
        speakers.setMatrixAt(speakerIndex++, matrix);
      });
    }
    speakers.instanceMatrix.needsUpdate = true;
    speakers.frustumCulled = false;
    sceneRoot.add(speakers);

    var ventMaterial = rememberMaterial(new T.MeshBasicMaterial({ color: 0x15151a, toneMapped: true }));
    var ventRows = Math.max(2, Math.floor(maxZ / 5));
    var vents = new T.InstancedMesh(box, ventMaterial, ventRows * 2);
    var ventIndex = 0;
    for (i = 0; i < ventRows; i++) {
      var ventZ = 2.8 + i * Math.max(4.2, (maxZ - 5) / Math.max(1, ventRows - 1));
      [-1, 1].forEach(function (side) {
        position.set(side * roomWidth * 0.19, ceilingY - 0.075, ventZ);
        scale.set(0.78, 0.04, 1.25);
        matrix.compose(position, quaternion, scale);
        vents.setMatrixAt(ventIndex++, matrix);
      });
    }
    vents.instanceMatrix.needsUpdate = true;
    vents.frustumCulled = false;
    sceneRoot.add(vents);

    var indirectMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x211f27,
      toneMapped: true
    }));
    [-1, 1].forEach(function (side) {
      var indirect = addMesh(box, indirectMaterial);
      indirect.position.set(side * (roomHalf - 0.14), ceilingY - 0.42, maxZ * 0.54);
      indirect.scale.set(0.055, 0.045, maxZ * 0.78);
    });

    // 계단 모서리는 밝은 발광선 대신 고무 노징과 작은 통로 조명으로 읽히게 한다.
    if (rows.length > 1) {
      var nosingMaterial = rememberMaterial(new T.MeshBasicMaterial({ color: 0x38343a, toneMapped: true }));
      var nosings = new T.InstancedMesh(box, nosingMaterial, (rows.length - 1) * 2);
      var nosingIndex = 0;
      for (i = 1; i < rows.length; i++) {
        var nosingZ = (rows[i - 1].z + rows[i].z) / 2 - 0.03;
        [-1, 1].forEach(function (side) {
          position.set(side * (dimensions.maxSeatX + 0.67), rows[i].y + 0.012, nosingZ);
          scale.set(0.52, 0.018, 0.075);
          matrix.compose(position, quaternion, scale);
          nosings.setMatrixAt(nosingIndex++, matrix);
        });
      }
      nosings.instanceMatrix.needsUpdate = true;
      nosings.frustumCulled = false;
      sceneRoot.add(nosings);
    }

    // 스크린 양옆 커튼과 세로 주름.
    var screenHalf = finite(screen.widthM, 10) / 2;
    var screenTop = finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5);
    var curtainMaterial = makeDarkMaterial(0x141419, 0.94);
    var curtainWidth = Math.max(1.2, roomHalf - screenHalf - 0.3);
    [-1, 1].forEach(function (sign) {
      var curtain = addMesh(box, curtainMaterial);
      curtain.position.set(sign * (screenHalf + curtainWidth / 2 + 0.2), screenTop / 2, 0.28);
      curtain.scale.set(curtainWidth, screenTop + 0.8, 0.18);
      for (var p = 0; p < 7; p++) {
        var pleat = addMesh(box, curtainMaterial);
        pleat.position.set(
          sign * (screenHalf + 0.42 + p * Math.max(0.14, curtainWidth / 7)),
          screenTop / 2,
          0.39
        );
        pleat.scale.set(0.045, screenTop + 0.7, 0.22 + (p % 2) * 0.04);
      }
    });

    var prosceniumMaterial = makeDarkMaterial(0x08090b, 0.84);
    var topValance = addMesh(box, prosceniumMaterial);
    topValance.position.set(0, screenTop + 0.35, 0.33);
    topValance.scale.set(Math.min(roomWidth - 0.5, finite(screen.widthM, 10) + 0.75), 0.55, 0.34);
    var screenApron = addMesh(box, prosceniumMaterial);
    screenApron.position.set(0, Math.max(0.08, finite(screen.bottomHeightM, 0) * 0.34), 0.42);
    screenApron.scale.set(Math.min(roomWidth - 0.5, finite(screen.widthM, 10) + 0.62),
      Math.max(0.16, finite(screen.bottomHeightM, 0) * 0.58), 0.28);

    // 스크린 앞 바닥의 5% 수준 반사광.
    var reflectionLength = Math.max(1, Math.min(maxZ * 0.35, finite(auditorium.firstRowZM, 7) * 0.88));
    var reflectionGeometry = rememberGeometry(new T.PlaneGeometry(finite(screen.widthM, 10) * 0.86, reflectionLength));
    var reflectionMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: lightColor,
      transparent: true,
      opacity: 0.105 * ambientScale,
      depthWrite: false,
      side: T.DoubleSide,
      blending: T.AdditiveBlending,
      toneMapped: true
    }));
    var reflection = addMesh(reflectionGeometry, reflectionMaterial);
    reflection.rotation.x = -Math.PI / 2;
    reflection.position.set(0, 0.012, reflectionLength / 2);
    reflection.renderOrder = 0;
  }

  function gradeShape(grade) {
    var text = String(grade || "").toUpperCase();
    if (/빈백|BEAN/.test(text)) return { w: 0.68, h: 0.34, z: 0.28, depth: 1.12, tilt: 30, arms: false, cup: false, recliner: false };
    if (/소파|SOFA/.test(text)) return { w: 0.70, h: 0.44, z: 0.30, depth: 1.08, tilt: 24, arms: true, cup: false, recliner: false };
    if (/스튜디오|STUDIO/.test(text)) return { w: 0.84, h: 0.72, z: 0.28, depth: 0.92, tilt: 16, arms: true, cup: true, recliner: true };
    if (/스위트|SWEET|커플|COUPLE/.test(text)) return { w: 0.82, h: 0.70, z: 0.26, depth: 0.82, tilt: 15, arms: true, cup: true, recliner: true };
    if (/리클|RECLIN/.test(text)) return { w: 0.72, h: 0.66, z: 0.25, depth: 0.78, tilt: 13, arms: true, cup: true, recliner: true };
    return { w: 0.48, h: 0.70, z: 0.16, depth: 0.46, tilt: 6, arms: true, cup: true, recliner: false };
  }

  function seatPalette() {
    if (sceneData && sceneData.brand === "megabox") return { back: 0x24272e, cushion: 0x1a1d22, inset: 0x313641 };
    if (sceneData && sceneData.brand === "lotte") return { back: 0x352126, cushion: 0x291a1e, inset: 0x472b32 };
    return { back: 0x302229, cushion: 0x241b21, inset: 0x3a2931 };
  }

  function seatHash(id) {
    var hash = 2166136261;
    var value = String(id || "");
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function addSeats(seats, activeSeat, showOccupants) {
    if (!seats.length) return;
    var chairGeometry = rememberGeometry(new T.BoxGeometry(1, 1, 1));
    var backGeometry = rememberGeometry(T.CapsuleGeometry ?
      new T.CapsuleGeometry(0.5, 0.4, 4, 8) : new T.BoxGeometry(1, 1, 1));
    var palette = seatPalette();
    var backMaterial = makeDarkMaterial(palette.back, 0.88);
    var cushionMaterial = makeDarkMaterial(palette.cushion, 0.92);
    var armMaterial = makeDarkMaterial(0x111216, 0.72);
    var cupMaterial = makeDarkMaterial(0x050506, 0.58);
    var insetMaterial = makeDarkMaterial(palette.inset, 0.92);
    var baseMaterial = makeDarkMaterial(0x090a0c, 0.66);
    var backs = new T.InstancedMesh(backGeometry, backMaterial, seats.length);
    var cushions = new T.InstancedMesh(chairGeometry, cushionMaterial, seats.length);
    var arms = new T.InstancedMesh(chairGeometry, armMaterial, seats.length * 2);
    var backInsets = new T.InstancedMesh(chairGeometry, insetMaterial, seats.length);
    var headrests = new T.InstancedMesh(backGeometry, insetMaterial, seats.length);
    var bases = new T.InstancedMesh(chairGeometry, baseMaterial, seats.length);
    var footrests = new T.InstancedMesh(chairGeometry, cushionMaterial, seats.length);
    var cupGeometry = rememberGeometry(new T.CylinderGeometry(1, 1, 1, 8, 1, true));
    var cups = new T.InstancedMesh(cupGeometry, cupMaterial, seats.length);
    var shadowGeometry = rememberGeometry(new T.CircleGeometry(0.5, 14));
    var shadowMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      toneMapped: false
    }));
    var contactShadows = new T.InstancedMesh(shadowGeometry, shadowMaterial, seats.length);
    var matrix = new T.Matrix4();
    var quaternion = new T.Quaternion();
    var identityQuaternion = new T.Quaternion();
    var position = new T.Vector3();
    var scale = new T.Vector3();
    var i;

    for (i = 0; i < seats.length; i++) {
      var seat = seats[i];
      var shape = gradeShape(seat.grade);
      var floorY = finite(seat.floorYM, 0);
      var seatZ = finite(seat.zM, 0);
      quaternion.setFromEuler(new T.Euler(shape.tilt * DEG, 0, 0));
      position.set(
        finite(seat.xM, 0),
        floorY + 0.34 + shape.h / 2,
        seatZ + 0.15
      );
      scale.set(shape.w, T.CapsuleGeometry ? shape.h / 1.4 : shape.h, shape.z);
      matrix.compose(position, quaternion, scale);
      backs.setMatrixAt(i, matrix);

      position.set(finite(seat.xM, 0), floorY + 0.34 + shape.h * 0.54,
        seatZ + 0.15 + shape.z * 0.50);
      scale.set(shape.w * 0.72, shape.h * 0.42, 0.022);
      matrix.compose(position, quaternion, scale);
      backInsets.setMatrixAt(i, matrix);

      position.set(finite(seat.xM, 0), floorY + 0.34 + shape.h * 0.86,
        seatZ + 0.16 + shape.z * 0.15);
      scale.set(shape.w * 0.52, shape.h * 0.20, shape.z * 0.66);
      matrix.compose(position, quaternion, scale);
      headrests.setMatrixAt(i, matrix);

      position.set(finite(seat.xM, 0), floorY + 0.39, seatZ - shape.depth * 0.20);
      scale.set(shape.w * 0.94, 0.14, shape.depth);
      matrix.compose(position, identityQuaternion, scale);
      cushions.setMatrixAt(i, matrix);

      for (var side = -1; side <= 1; side += 2) {
        position.set(finite(seat.xM, 0) + side * shape.w * 0.58, floorY + 0.54, seatZ - 0.03);
        scale.set(shape.arms ? 0.075 : 0.0001, shape.arms ? 0.15 : 0.0001, shape.arms ? shape.depth * 0.88 : 0.0001);
        matrix.compose(position, identityQuaternion, scale);
        arms.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), matrix);
      }

      position.set(finite(seat.xM, 0) + shape.w * 0.58, floorY + 0.625, seatZ - shape.depth * 0.24);
      scale.set(shape.cup ? 0.055 : 0.0001, shape.cup ? 0.028 : 0.0001, shape.cup ? 0.055 : 0.0001);
      matrix.compose(position, identityQuaternion, scale);
      cups.setMatrixAt(i, matrix);

      position.set(finite(seat.xM, 0), floorY + 0.17, seatZ + 0.10);
      scale.set(0.14, 0.30, 0.16);
      matrix.compose(position, identityQuaternion, scale);
      bases.setMatrixAt(i, matrix);

      var recliner = shape.recliner;
      position.set(finite(seat.xM, 0), floorY + 0.31, seatZ - shape.depth * 0.82);
      scale.set(recliner ? shape.w * 0.82 : 0.0001, recliner ? 0.10 : 0.0001,
        recliner ? shape.depth * 0.46 : 0.0001);
      matrix.compose(position, identityQuaternion, scale);
      footrests.setMatrixAt(i, matrix);

      var shadowQuaternion = new T.Quaternion().setFromEuler(new T.Euler(-Math.PI / 2, 0, 0));
      position.set(finite(seat.xM, 0), floorY + 0.009, seatZ - 0.02);
      scale.set(shape.w * 1.45, shape.depth * 1.15, 1);
      matrix.compose(position, shadowQuaternion, scale);
      contactShadows.setMatrixAt(i, matrix);
    }
    [contactShadows, backs, backInsets, headrests, cushions, arms, bases, footrests, cups].forEach(function (mesh) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      sceneRoot.add(mesh);
    });

    if (!showOccupants) return;
    var occupied = [];
    for (i = 0; i < seats.length; i++) {
      if (seatHash(seats[i].id) % 10 < 6) occupied.push(seats[i]);
    }
    if (!occupied.length) return;

    var headGeometry = rememberGeometry(new T.SphereGeometry(1, 12, 8));
    var shoulderGeometry = rememberGeometry(new T.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62));
    var occupantMaterial = makeDarkMaterial(0x111116, 0.94);
    var heads = new T.InstancedMesh(headGeometry, occupantMaterial, occupied.length);
    var shoulders = new T.InstancedMesh(shoulderGeometry, occupantMaterial, occupied.length);
    var entries = {};

    function setOccupantAt(index, seat, visible) {
      var multiplier = visible ? 1 : 0.0001;
      var x = finite(seat.xM, 0);
      var floorY = finite(seat.floorYM, 0);
      var eyeProfile = window.SeatMetrics.seatEyeProfile(seat.grade);
      var z = finite(seat.zM, 0) + eyeProfile.backM - 0.01;
      position.set(x, floorY + 1.14 - eyeProfile.dropM, z);
      scale.set(0.115 * multiplier, 0.125 * multiplier, 0.105 * multiplier);
      matrix.compose(position, quaternion, scale);
      heads.setMatrixAt(index, matrix);
      position.set(x, floorY + 1.005 - eyeProfile.dropM, z + 0.005);
      scale.set(0.30 * multiplier, 0.16 * multiplier, 0.14 * multiplier);
      matrix.compose(position, quaternion, scale);
      shoulders.setMatrixAt(index, matrix);
    }

    for (i = 0; i < occupied.length; i++) {
      var isActive = activeSeat && String(occupied[i].id) === String(activeSeat.id);
      setOccupantAt(i, occupied[i], !isActive);
      entries[String(occupied[i].id)] = { index: i, seat: occupied[i] };
    }
    heads.instanceMatrix.needsUpdate = true;
    shoulders.instanceMatrix.needsUpdate = true;
    heads.frustumCulled = false;
    shoulders.frustumCulled = false;
    sceneRoot.add(shoulders);
    sceneRoot.add(heads);
    occupantState = {
      entries: entries,
      heads: heads,
      shoulders: shoulders,
      setAt: setOccupantAt,
      activeId: activeSeat ? String(activeSeat.id) : ""
    };
  }

  function setActiveOccupant(seat) {
    if (!occupantState) return;
    var oldEntry = occupantState.entries[occupantState.activeId];
    if (oldEntry) occupantState.setAt(oldEntry.index, oldEntry.seat, true);
    var newId = seat ? String(seat.id) : "";
    var newEntry = occupantState.entries[newId];
    if (newEntry) occupantState.setAt(newEntry.index, newEntry.seat, false);
    occupantState.activeId = newId;
    occupantState.heads.instanceMatrix.needsUpdate = true;
    occupantState.shoulders.instanceMatrix.needsUpdate = true;
  }

  function makeExitTexture(direction) {
    var signCanvas = document.createElement("canvas");
    signCanvas.width = 512;
    signCanvas.height = 224;
    var context = signCanvas.getContext("2d");
    var safetyGreen = "#087f4a";
    var pictogramWhite = "#f4fff7";
    context.fillStyle = safetyGreen;
    context.fillRect(0, 0, 512, 224);
    context.strokeStyle = pictogramWhite;
    context.lineWidth = 7;
    context.strokeRect(8, 8, 496, 208);
    context.strokeStyle = pictogramWhite;
    context.fillStyle = pictogramWhite;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.save();
    if (direction < 0) {
      context.translate(512, 0);
      context.scale(-1, 1);
    }

    // ISO 7010 E001/E002 비율에 맞춘 문, 달리는 사람, 진행 화살표.
    context.fillRect(390, 31, 70, 162);
    context.fillStyle = safetyGreen;
    context.fillRect(405, 47, 38, 130);
    context.fillStyle = pictogramWhite;
    context.fillRect(438, 103, 8, 9);

    context.beginPath();
    context.arc(205, 55, 19, 0, Math.PI * 2);
    context.fill();

    context.beginPath();
    context.moveTo(195, 81);
    context.lineTo(222, 78);
    context.lineTo(250, 111);
    context.lineTo(236, 137);
    context.lineTo(211, 116);
    context.lineTo(188, 101);
    context.closePath();
    context.fill();

    context.lineWidth = 17;
    context.beginPath();
    context.moveTo(206, 92);
    context.lineTo(159, 112);
    context.moveTo(221, 92);
    context.lineTo(272, 76);
    context.stroke();

    context.lineWidth = 19;
    context.beginPath();
    context.moveTo(232, 132);
    context.lineTo(276, 169);
    context.moveTo(223, 132);
    context.lineTo(178, 176);
    context.stroke();

    if (direction !== 0) {
      context.lineWidth = 15;
      context.beginPath();
      context.moveTo(291, 112);
      context.lineTo(356, 112);
      context.stroke();
      context.beginPath();
      context.moveTo(356, 82);
      context.lineTo(386, 112);
      context.lineTo(356, 142);
      context.closePath();
      context.fill();
    }
    context.restore();

    var texture = rememberTexture(new T.CanvasTexture(signCanvas));
    texture.minFilter = T.LinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = false;
    if ("colorSpace" in texture && T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
    else if (T.sRGBEncoding) texture.encoding = T.sRGBEncoding;
    return texture;
  }

  function addExits(screen, dimensions, format, exits) {
    var leftTexture = makeExitTexture(-1);
    var rightTexture = makeExitTexture(1);
    var straightTexture = makeExitTexture(0);
    var leftSignMaterial = rememberMaterial(new T.MeshBasicMaterial({
      map: leftTexture,
      color: 0xffffff,
      toneMapped: false,
      side: T.DoubleSide
    }));
    var rightSignMaterial = rememberMaterial(new T.MeshBasicMaterial({
      map: rightTexture,
      color: 0xffffff,
      toneMapped: false,
      side: T.DoubleSide
    }));
    var straightSignMaterial = rememberMaterial(new T.MeshBasicMaterial({
      map: straightTexture,
      color: 0xffffff,
      toneMapped: false,
      side: T.DoubleSide
    }));
    var glowMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x24703a,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      toneMapped: false
    }));
    var doorMaterial = makeDarkMaterial(0x0d1117, 0.90);
    var frameMaterial = rememberMaterial(new T.MeshBasicMaterial({ color: 0x050607 }));
    var metalMaterial = makeDarkMaterial(0x565a62, 0.46);
    var housingMaterial = makeDarkMaterial(0x121419, 0.72);
    var box = unitBoxGeometry();
    var signGeometry = rememberGeometry(new T.PlaneGeometry(0.96, 0.42));
    var glowGeometry = rememberGeometry(new T.PlaneGeometry(1.22, 0.62));
    var roomHalf = dimensions.roomWidth / 2;
    // Curved screens project their near edges wider than their chord. Keep the
    // doors near the side walls so they are not hidden behind the screen arc.
    var frontX = roomHalf - 0.66;

    function frontExit(x, direction) {
      var recess = addMesh(box, frameMaterial);
      recess.position.set(x, 1.12, 0.50);
      recess.scale.set(1.16, 2.30, 0.16);
      var door = addMesh(box, doorMaterial);
      door.position.set(x, 1.04, 0.64);
      door.scale.set(0.92, 2.04, 0.08);
      // 문을 덮는 판이 아니라 실제 문틀처럼 네 개의 가는 바를 둔다.
      [[-0.50, 1.04, 0.05, 2.12], [0.50, 1.04, 0.05, 2.12],
       [0, 2.08, 0.55, 0.05], [0, 0.03, 0.55, 0.05]].forEach(function (part) {
        var frame = addMesh(box, frameMaterial);
        frame.position.set(x + part[0], part[1], 0.692);
        frame.scale.set(part[2] * 2, part[3], 0.025);
      });
      var pushBar = addMesh(box, metalMaterial);
      pushBar.position.set(x, 1.02, 0.718);
      pushBar.scale.set(0.68, 0.055, 0.040);
      var kickPlate = addMesh(box, metalMaterial);
      kickPlate.position.set(x, 0.27, 0.710);
      kickPlate.scale.set(0.70, 0.30, 0.025);
      var housing = addMesh(box, housingMaterial);
      housing.position.set(x, 2.36, 0.706);
      housing.scale.set(0.88, 0.40, 0.070);
      var glow = addMesh(glowGeometry, glowMaterial);
      glow.position.set(x, 2.36, 0.742);
      glow.renderOrder = 7;
      var signMaterial = direction === 0 ? straightSignMaterial :
        (direction < 0 ? leftSignMaterial : rightSignMaterial);
      var sign = addMesh(signGeometry, signMaterial);
      sign.position.set(x, 2.36, 0.755);
      sign.renderOrder = 8;
      var signLight = new T.PointLight(0x4b9257, 0.065, 2.8, 2);
      signLight.position.set(x, 2.42, 0.88);
      sceneRoot.add(signLight);

      var thresholdMaterial = rememberMaterial(new T.MeshBasicMaterial({
        color: 0x4e9c62,
        transparent: true,
        opacity: 0.30,
        toneMapped: false
      }));
      var threshold = addMesh(box, thresholdMaterial);
      threshold.position.set(x, 0.022, 0.88);
      threshold.scale.set(0.82, 0.018, 0.20);
    }

    function sideExit(side) {
      // SCREENX projection lives on an inner acoustic surface rather than the
      // structural wall. Put the exit assembly just in front of that surface
      // so the door actually interrupts the projected picture like a real room.
      var projectedHalf = litArea(screen, "SCREENX").w / 2;
      var x = side * (projectedHalf - 0.045);
      var z = 2.05;
      var recess = addMesh(box, frameMaterial);
      recess.position.set(x, 1.16, z);
      recess.scale.set(0.16, 2.38, 1.28);
      var door = addMesh(box, doorMaterial);
      door.position.set(x - side * 0.095, 1.08, z);
      door.scale.set(0.06, 2.08, 1.02);

      [-0.55, 0.55].forEach(function (offset) {
        var verticalFrame = addMesh(box, frameMaterial);
        verticalFrame.position.set(x - side * 0.14, 1.08, z + offset);
        verticalFrame.scale.set(0.035, 2.16, 0.055);
      });
      [0.05, 2.12].forEach(function (y) {
        var horizontalFrame = addMesh(box, frameMaterial);
        horizontalFrame.position.set(x - side * 0.14, y, z);
        horizontalFrame.scale.set(0.035, 0.055, 1.14);
      });
      var pushBar = addMesh(box, metalMaterial);
      pushBar.position.set(x - side * 0.19, 1.04, z);
      pushBar.scale.set(0.035, 0.06, 0.72);
      var kickPlate = addMesh(box, metalMaterial);
      kickPlate.position.set(x - side * 0.18, 0.29, z);
      kickPlate.scale.set(0.035, 0.34, 0.72);

      var housing = addMesh(box, housingMaterial);
      housing.position.set(x - side * 0.14, 2.48, z);
      housing.scale.set(0.095, 0.50, 1.12);
      var sign = addMesh(signGeometry, straightSignMaterial);
      sign.position.set(x - side * 0.205, 2.48, z);
      sign.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      sign.renderOrder = 9;
      var glow = addMesh(glowGeometry, glowMaterial);
      glow.position.set(x - side * 0.19, 2.48, z);
      glow.rotation.y = sign.rotation.y;
      glow.renderOrder = 8;
      var signLight = new T.PointLight(0x55a56a, 0.10, 3.2, 2);
      signLight.position.set(x - side * 0.38, 2.38, z);
      sceneRoot.add(signLight);
    }

    /** 객석 측벽에 붙는 문 — 벽면과 같은 평면이라 얇은 판 + 90° 돌린 유도등.
     *  위 sideExit() 는 SCREENX 투사면 앞에 서는 전방 측면 문이라 별개다. */
    function wallExit(side, z, floorY) {
      var x = side * (dimensions.roomWidth / 2 - 0.07);
      var door = addMesh(box, doorMaterial);
      door.position.set(x, floorY + 1.05, z);
      door.scale.set(0.09, 2.1, 1.05);
      var sign = addMesh(signGeometry, side < 0 ? leftSignMaterial : rightSignMaterial);
      sign.position.set(x - side * 0.055, floorY + 2.42, z);
      sign.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      sign.renderOrder = 8;
      var glow = addMesh(glowGeometry, glowMaterial);
      glow.position.set(x - side * 0.045, floorY + 2.42, z);
      glow.rotation.y = sign.rotation.y;
      glow.renderOrder = 7;
    }

    /* 메가박스·롯데시네마는 예매 좌석도가 출입구 좌표를 함께 준다 — 있으면 그 위치 그대로
     * 두고 표준 배치는 건너뛴다. 데이터가 전방 출구 없다고 하면 없는 것이다. */
    if (exits && exits.length) {
      exits.forEach(function (ex) {
        if (ex.zone === "front") {
          frontExit(clamp(finite(ex.xM, frontX), -frontX, frontX), 0);
        } else {
          var z = clamp(finite(ex.zM, 2), 0.9, dimensions.maxZ - 0.4);
          wallExit(ex.side === "left" ? -1 : 1, z, nearestFloorY(dimensions.rows, z));
        }
      });
      return;
    }

    /* CGV 는 관별 좌표를 공개하지 않으므로 소방 기준 표준 배치.
     * 문 바로 위 표지는 좌우 화살표를 기계적으로 붙이지 않는다. 좌우 방향은
     * 후방 통로 표지에만 사용하고, 전방 최종 출구는 E001/E002 본체로 표시한다. */
    if (format === "SCREENX") {
      sideExit(-1);
      sideExit(1);
    } else {
      frontExit(-frontX, 0);
      frontExit(frontX, 0);
    }

    var rearZ = Math.max(2, dimensions.maxSeatZ - 0.55);
    var rearFloorY = nearestFloorY(dimensions.rows, rearZ);
    wallExit(-1, rearZ, rearFloorY);
    wallExit(1, rearZ, rearFloorY);
  }

  function addAisleLights(dimensions) {
    var rows = dimensions.rows;
    var positions = [];
    var sideX = dimensions.maxSeatX + 0.72;
    var z;
    for (z = 2.4; z < dimensions.maxZ; z += 2.8) {
      positions.push({ x: -sideX, y: nearestFloorY(rows, z) + 0.07, z: z });
      positions.push({ x: sideX, y: nearestFloorY(rows, z) + 0.07, z: z });
    }
    if (!positions.length) return;
    var geometry = rememberGeometry(new T.BoxGeometry(1, 1, 1));
    var material = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x4c8651,
      transparent: true,
      opacity: 0.82,
      toneMapped: false
    }));
    var lights = new T.InstancedMesh(geometry, material, positions.length);
    var matrix = new T.Matrix4();
    var quaternion = new T.Quaternion();
    var scale = new T.Vector3(0.22, 0.018, 0.065);
    var position = new T.Vector3();
    for (var i = 0; i < positions.length; i++) {
      position.set(positions[i].x, positions[i].y, positions[i].z);
      matrix.compose(position, quaternion, scale);
      lights.setMatrixAt(i, matrix);
    }
    lights.instanceMatrix.needsUpdate = true;
    lights.frustumCulled = false;
    sceneRoot.add(lights);

    // 모든 표식마다 광원을 만들지 않고 대표 지점만 약하게 밝혀 내장 GPU 부하를 제한한다.
    for (i = 0; i < positions.length; i += Math.max(2, Math.floor(positions.length / 6))) {
      var point = new T.PointLight(0x4d7d4b, 0.075, 2.1, 2);
      point.position.set(positions[i].x, positions[i].y + 0.04, positions[i].z);
      sceneRoot.add(point);
    }
  }

  function addLighting(screen, dimensions, posterSample, ambientScale) {
    var ambient = new T.AmbientLight(0x696b76, 0.10 + 0.17 * ambientScale);
    sceneRoot.add(ambient);
    var hemisphere = new T.HemisphereLight(0x545869, 0x08090b, 0.08 + 0.10 * ambientScale);
    sceneRoot.add(hemisphere);

    var color = new T.Color(
      clamp(posterSample.r, 0.25, 1),
      clamp(posterSample.g, 0.25, 1),
      clamp(posterSample.b, 0.25, 1)
    );
    color.lerp(new T.Color(0xffffff), 0.42);
    var intensity = (0.46 + 0.82 * posterSample.luma) * ambientScale;
    [-0.34, 0, 0.34].forEach(function (offset, index) {
      var weight = index === 1 ? 0.52 : 0.38;
      var light = new T.SpotLight(color, intensity * weight, dimensions.maxZ * 1.55, 1.02, 0.82, 1.55);
      light.position.copy(screenPoint(screen, finite(screen.widthM, 10) * offset,
        finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5) * 0.50, 0.34));
      light.target.position.set(offset * dimensions.roomWidth * 0.22,
        Math.max(0.48, dimensions.maxFloorY * 0.48), dimensions.maxZ * 0.60);
      light.castShadow = false;
      sceneRoot.add(light);
      sceneRoot.add(light.target);
    });

    if (sceneData && sceneData.format === "SCREENX" && screen.sideProjection) {
      [-1, 1].forEach(function (side) {
        var sideLight = new T.PointLight(color, (0.13 + 0.22 * posterSample.luma) * ambientScale,
          Math.max(7, dimensions.roomWidth * 0.90), 1.65);
        sideLight.position.set(side * finite(screen.widthM, 10) / 2,
          finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5) * 0.45,
          finite(screen.sideLenM, 10) * 0.48);
        sceneRoot.add(sideLight);
      });
    }
    return color;
  }

  function dimensionsOf(screen, seats, auditorium) {
    var maxSeatX = 0;
    var maxSeatZ = Math.max(4, finite(auditorium.firstRowZM, 7));
    var maxFloorY = finite(auditorium.firstRowFloorYM, 0);
    for (var i = 0; i < seats.length; i++) {
      maxSeatX = Math.max(maxSeatX, Math.abs(finite(seats[i].xM, 0)));
      maxSeatZ = Math.max(maxSeatZ, finite(seats[i].zM, 0));
      maxFloorY = Math.max(maxFloorY, finite(seats[i].floorYM, 0));
    }
    var screenX = !!screen.sideProjection;
    var roomHalf = Math.max(finite(screen.widthM, 10) / 2 + (screenX ? 0.85 : 3.4),
      maxSeatX + (screenX ? 1.10 : 1.7));
    var screenTop = finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5);
    return {
      maxSeatX: maxSeatX,
      maxSeatZ: maxSeatZ,
      maxFloorY: maxFloorY,
      maxZ: maxSeatZ + Math.max(2.5, finite(auditorium.rowPitchM, 1.1) * 2),
      roomWidth: roomHalf * 2,
      ceilingY: Math.max(screenTop + 2.2, maxFloorY + 3.25),
      rows: collectRows(seats)
    };
  }

  function updateScreenGain() {
    if (!gainGeometry || !camera) return;
    var positions = gainGeometry.getAttribute("position");
    var normals = gainGeometry.getAttribute("normal");
    var gains = gainGeometry.getAttribute("screenGain");
    if (!positions || !normals || !gains) return;
    var view = new T.Vector3();
    var normal = new T.Vector3();
    var point = new T.Vector3();
    for (var i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      normal.fromBufferAttribute(normals, i).normalize();
      view.copy(camera.position).sub(point).normalize();
      var cosine = clamp(normal.dot(view), 0, 1);
      var gain = 0.70 + 0.30 * Math.pow(cosine, 0.65);
      gains.setX(i, gain);
    }
    gains.needsUpdate = true;
  }

  function lookAtLitCenter() {
    if (!camera) return;
    camera.up.set(0, 1, 0);
    cameraTarget.copy(litCenter);
    if (sceneData && sceneData.options && sceneData.options.viewMode === "room" && sceneDimensions) {
      cameraTarget.set(
        0,
        Math.max(0.82, sceneDimensions.maxFloorY * 0.40 + 0.54),
        sceneDimensions.maxZ * 0.43
      );
    }
    camera.lookAt(cameraTarget);
    camera.updateMatrixWorld();
    updateScreenGain();
  }

  function renderNow() {
    if (!renderer || !threeScene || !camera || !sceneData) return;
    renderer.render(threeScene, camera);
    dirty = false;
  }

  function schedule() {
    dirty = true;
    if (!raf && (!document || !document.hidden)) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (animation && camera) {
      var t = clamp((now - animation.started) / CAMERA_MOVE_MS, 0, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(animation.from, animation.to, eased);
      lookAtLitCenter();
      dirty = true;
      if (t >= 1) animation = null;
    }
    if (dirty) renderNow();
    if (animation || dirty) schedule();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (animation) {
      animation.from.copy(camera.position);
      animation.started = performance.now();
    }
    schedule();
  }

  function init(canvasElement) {
    if (!canvasElement || renderer || fallbackMode) return;
    canvas = canvasElement;
    try {
      renderer = new T.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
      });
    } catch (error) {
      fallbackMode = true;
      renderer = null;
      if (fallback && typeof fallback.init === "function") fallback.init(canvasElement);
      return;
    }

    renderer.setPixelRatio(1); // resize()가 이미 DPR(상한 2)을 반영한 물리 픽셀을 받는다.
    renderer.setClearColor(0x030304, 1);
    renderer.autoClear = true;
    if (T.ACESFilmicToneMapping != null) renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.26;
    if ("outputColorSpace" in renderer && T.SRGBColorSpace) renderer.outputColorSpace = T.SRGBColorSpace;
    else if (T.sRGBEncoding) renderer.outputEncoding = T.sRGBEncoding;

    width = Math.max(1, canvas.width || 1);
    height = Math.max(1, canvas.height || 1);
    renderer.setSize(width, height, false);
    threeScene = new T.Scene();
    threeScene.background = new T.Color(0x030304);
    camera = new T.PerspectiveCamera(50, width / height, 0.035, 200);
    updateProjection();

    if (document && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibilityChange);
      visibilityListening = true;
    }
  }

  function setScene(nextScene) {
    if (fallbackMode) {
      if (fallback && typeof fallback.setScene === "function") fallback.setScene(nextScene);
      return;
    }
    if (!renderer || !nextScene || !nextScene.screen || !nextScene.auditorium || !nextScene.activeSeat) return;

    animation = null;
    disposeSceneResources();
    sceneData = nextScene;
    sceneRoot = new T.Group();
    threeScene.add(sceneRoot);

    var screen = nextScene.screen;
    var auditorium = nextScene.auditorium;
    var seats = Array.isArray(nextScene.seats) ? nextScene.seats : [];
    var options = nextScene.options || {};
    var ambientScale = clamp(finite(options.ambient, 1), 0, 1);
    horizontalFov = clamp(finite(options.fovMode, 60), 20, 130);
    updateProjection();

    var lit = litArea(screen, nextScene.format);
    setLitCenter(screen, lit);
    var dimensions = dimensionsOf(screen, seats, auditorium);
    sceneDimensions = dimensions;
    camera.near = 0.035;
    camera.far = Math.max(120, dimensions.maxZ * 4, dimensions.ceilingY * 5);
    camera.position.copy(eyeForView(nextScene.activeSeat, auditorium, dimensions, options));
    camera.updateProjectionMatrix();

    var panoramaImage = nextScene.format === "SCREENX" ? nextScene.panoramaImage : null;
    var projectionImage = panoramaImage || nextScene.posterImage;
    var posterSample = averagePoster(projectionImage);
    // 장면 자체의 밝기 차이가 지역별 상영관 조도 차이처럼 보이지 않도록 노출 범위를 넓힌다.
    renderer.toneMappingExposure = clamp(1.52 - posterSample.luma * 0.48, 1.08, 1.55);
    var posterTexture = makePosterTexture(projectionImage);
    var projectionMap = panoramaImage ? panoramaMap(panoramaImage, lit.w / lit.h) : null;
    var screenParts = addScreen(screen, lit, posterTexture, projectionImage, projectionMap);
    addScreenX(screen, lit, posterTexture, screenParts.crop, screenParts.yBottom, screenParts.yTop, projectionMap);
    var lightColor = addLighting(screen, dimensions, posterSample, ambientScale);
    addAuditorium(screen, auditorium, seats, dimensions, lightColor, ambientScale);
    addSeats(seats, nextScene.activeSeat, options.showOccupants !== false);
    addExits(screen, dimensions, nextScene.format, nextScene.exits);
    addAisleLights(dimensions);

    lookAtLitCenter();
    schedule();
  }

  function setSeat(seat) {
    if (fallbackMode) {
      if (fallback && typeof fallback.setSeat === "function") fallback.setSeat(seat);
      return;
    }
    if (!renderer || !sceneData || !seat || !camera) return;
    setActiveOccupant(seat);
    sceneData.activeSeat = seat;
    animation = {
      from: camera.position.clone(),
      to: eyeForView(seat, sceneData.auditorium, sceneDimensions, sceneData.options || {}),
      started: performance.now()
    };
    schedule();
  }

  function resize(nextWidth, nextHeight) {
    if (fallbackMode) {
      if (fallback && typeof fallback.resize === "function") fallback.resize(nextWidth, nextHeight);
      return;
    }
    if (!renderer || !canvas) return;
    width = Math.max(1, Math.round(finite(nextWidth, canvas.width || 1)));
    height = Math.max(1, Math.round(finite(nextHeight, canvas.height || 1)));
    renderer.setSize(width, height, false);
    updateProjection();
    schedule();
  }

  function capture() {
    if (fallbackMode) {
      return fallback && typeof fallback.capture === "function" ? fallback.capture() : "";
    }
    if (!renderer || !canvas || !sceneData) return "";
    renderNow();
    try {
      return canvas.toDataURL("image/png");
    } catch (error) {
      return "";
    }
  }

  function dispose() {
    if (fallbackMode) {
      if (fallback && typeof fallback.dispose === "function") fallback.dispose();
      fallbackMode = false;
      canvas = null;
      return;
    }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    animation = null;
    dirty = false;
    if (visibilityListening && document && document.removeEventListener) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      visibilityListening = false;
    }
    disposeSceneResources();
    if (renderer) {
      renderer.dispose();
      if (typeof renderer.forceContextLoss === "function") renderer.forceContextLoss();
    }
    renderer = null;
    threeScene = null;
    camera = null;
    sceneData = null;
    canvas = null;
  }

  window.SeatPreviewRenderer = {
    init: init,
    setScene: setScene,
    setSeat: setSeat,
    resize: resize,
    capture: capture,
    dispose: dispose
  };
})();
