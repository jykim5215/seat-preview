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
    return new T.Vector3(
      finite(seat && seat.xM, 0),
      finite(seat && seat.floorYM, 0) + finite(auditorium && auditorium.eyeHeightM, 1.15),
      finite(seat && seat.zM, 8)
    );
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
        if (colors) {
          var c = colors(fx, fy, p);
          colorValues.push(c, c, c);
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
    if (colors) geometry.setAttribute("color", new T.Float32BufferAttribute(colorValues, 3));
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
      metalness: 0
    }));
  }

  function addScreen(screen, lit, posterTexture, posterImage) {
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

    var crop = cropBox(posterImage, lit.w / lit.h);
    var yBottom = lit.centerY - lit.h / 2;
    var yTop = lit.centerY + lit.h / 2;
    var litGeometry = makeScreenPatch(
      screen, -lit.w / 2, lit.w / 2, yBottom, yTop,
      segments, 2, crop, 0.004,
      function () { return 1; }
    );
    var litMaterial = rememberMaterial(new T.MeshBasicMaterial({
      // 극장 스크린의 차가운 무광 반사 특성: 원본 이미지를 그대로 발광판처럼 보이지 않게 한다.
      color: posterTexture ? 0xffffff : 0x777780,
      map: posterTexture,
      vertexColors: true,
      side: T.FrontSide,
      toneMapped: false
    }));
    var litMesh = addMesh(litGeometry, litMaterial);
    litMesh.renderOrder = 2;
    gainGeometry = litGeometry;

    // Keep a single projection surface. Nearly coplanar transparent overlays
    // produced z-fighting and dark seams on integrated GPUs.
    return { crop: crop, yBottom: yBottom, yTop: yTop };
  }

  function addScreenX(screen, lit, posterTexture, crop, yBottom, yTop) {
    if (!posterTexture || sceneData.format !== "SCREENX" || !screen.sideProjection) return;
    // The source asset is a front-screen still, not a native three-camera
    // ScreenX master. Use a broader edge sample and stop before the viewer so
    // it reads as a wall projection instead of a stretched near-plane.
    var sideLength = Math.max(0.1, finite(screen.sideLenM, 12) * 0.82);
    var edgeFraction = (crop.u1 - crop.u0) * 0.32;
    var sides = [-1, 1];

    var sideMaterial = rememberMaterial(new T.ShaderMaterial({
      uniforms: {
        map: { value: posterTexture },
        liftColor: { value: new T.Color(0.010, 0.014, 0.022) }
      },
      vertexShader: [
        "attribute float sideShade;",
        "varying vec2 vSideUv;",
        "varying float vSideShade;",
        "void main() {",
        "  vSideUv = uv;",
        "  vSideShade = sideShade;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform sampler2D map;",
        "uniform vec3 liftColor;",
        "varying vec2 vSideUv;",
        "varying float vSideShade;",
        "void main() {",
        "  vec3 source = texture2D(map, vSideUv).rgb;",
        "  vec3 linearSource = pow(source, vec3(2.2));",
        "  float sourcePeak = max(max(linearSource.r, linearSource.g), linearSource.b);",
        "  vec3 projected = linearSource + liftColor * (1.0 - sourcePeak);",
        "  gl_FragColor = vec4(projected * vSideShade, 1.0);",
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
      var positions = [];
      var uvs = [];
      var shades = [];
      var indices = [];

      for (var iz = 0; iz <= segments; iz++) {
        var f = iz / segments;
        var zOffset = sideLength * f;
        var u;
        if (sign < 0) u = crop.u0 + edgeFraction * f;
        else u = crop.u1 - edgeFraction * f;
        var eased = f * f * (3 - 2 * f);
        var brightness = 0.78 - 0.58 * eased;
        positions.push(startBottom.x, startBottom.y, startBottom.z + zOffset);
        positions.push(startTop.x, startTop.y, startTop.z + zOffset);
        uvs.push(u, crop.v0, u, crop.v1);
        shades.push(brightness, brightness);
      }
      for (iz = 0; iz < segments; iz++) {
        var a = iz * 2;
        if (sign < 0) indices.push(a, a + 3, a + 1, a, a + 2, a + 3);
        else indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }

      var geometry = rememberGeometry(new T.BufferGeometry());
      geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute("sideShade", new T.Float32BufferAttribute(shades, 1));
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
    var floorMaterial = makeDarkMaterial(0x15151a, 0.88);
    var wallMaterial = makeDarkMaterial(0x111116, 0.98);
    var ceilingMaterial = makeDarkMaterial(0x0b0b0f, 1);
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

    // 스크린 양옆 커튼과 세로 주름.
    var screenHalf = finite(screen.widthM, 10) / 2;
    var screenTop = finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5);
    var curtainMaterial = makeDarkMaterial(0x17151b, 1);
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
        pleat.scale.set(0.06, screenTop + 0.7, 0.18);
      }
    });

    // 스크린 앞 바닥의 5% 수준 반사광.
    var reflectionLength = Math.max(1, Math.min(maxZ * 0.35, finite(auditorium.firstRowZM, 7) * 0.88));
    var reflectionGeometry = rememberGeometry(new T.PlaneGeometry(finite(screen.widthM, 10) * 0.86, reflectionLength));
    var reflectionMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: lightColor,
      transparent: true,
      opacity: 0.045 * ambientScale,
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
    if (text.indexOf("SWEET") >= 0 || text.indexOf("커플") >= 0) return { w: 0.68, h: 0.78, z: 0.20 };
    if (text.indexOf("리클") >= 0 || text.indexOf("RECLIN") >= 0) return { w: 0.64, h: 0.64, z: 0.24 };
    return { w: 0.54, h: 0.70, z: 0.16 };
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
    var chairMaterial = makeDarkMaterial(0x24242b, 0.76);
    var chairs = new T.InstancedMesh(chairGeometry, chairMaterial, seats.length);
    var matrix = new T.Matrix4();
    var quaternion = new T.Quaternion();
    var position = new T.Vector3();
    var scale = new T.Vector3();
    var i;

    for (i = 0; i < seats.length; i++) {
      var seat = seats[i];
      var shape = gradeShape(seat.grade);
      position.set(
        finite(seat.xM, 0),
        finite(seat.floorYM, 0) + 0.30 + shape.h / 2,
        finite(seat.zM, 0) + 0.12
      );
      scale.set(shape.w, shape.h, shape.z);
      matrix.compose(position, quaternion, scale);
      chairs.setMatrixAt(i, matrix);
    }
    chairs.instanceMatrix.needsUpdate = true;
    chairs.frustumCulled = false;
    sceneRoot.add(chairs);

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
      var z = finite(seat.zM, 0) - 0.01;
      position.set(x, floorY + 1.14, z);
      scale.set(0.115 * multiplier, 0.125 * multiplier, 0.105 * multiplier);
      matrix.compose(position, quaternion, scale);
      heads.setMatrixAt(index, matrix);
      position.set(x, floorY + 1.005, z + 0.005);
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

  function makeExitTexture() {
    var signCanvas = document.createElement("canvas");
    signCanvas.width = 384;
    signCanvas.height = 160;
    var context = signCanvas.getContext("2d");
    context.fillStyle = "#1d5b28";
    context.fillRect(0, 0, 384, 160);
    context.strokeStyle = "rgba(207,233,207,.72)";
    context.lineWidth = 4;
    context.strokeRect(5, 5, 374, 150);
    context.strokeStyle = "#cfe9cf";
    context.fillStyle = "#cfe9cf";
    context.lineCap = "round";
    context.lineJoin = "round";

    // ISO 7010 E002를 작은 크기에서도 식별할 수 있게 단순화한 문과 달리는 사람.
    context.lineWidth = 8;
    context.strokeRect(264, 23, 82, 110);
    context.fillRect(329, 72, 10, 10);
    context.beginPath();
    context.arc(132, 41, 17, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 18;
    context.beginPath();
    context.moveTo(128, 67);
    context.lineTo(163, 99);
    context.stroke();
    context.lineWidth = 14;
    context.beginPath();
    context.moveTo(140, 73);
    context.lineTo(183, 59);
    context.moveTo(126, 74);
    context.lineTo(87, 94);
    context.moveTo(162, 98);
    context.lineTo(199, 132);
    context.moveTo(162, 98);
    context.lineTo(120, 131);
    context.stroke();
    context.beginPath();
    context.moveTo(211, 80);
    context.lineTo(245, 80);
    context.lineTo(231, 67);
    context.moveTo(245, 80);
    context.lineTo(231, 93);
    context.stroke();

    var texture = rememberTexture(new T.CanvasTexture(signCanvas));
    texture.minFilter = T.LinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = false;
    if ("colorSpace" in texture && T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
    else if (T.sRGBEncoding) texture.encoding = T.sRGBEncoding;
    return texture;
  }

  function addExits(screen, dimensions) {
    var texture = makeExitTexture();
    var signMaterial = rememberMaterial(new T.MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      toneMapped: false,
      side: T.DoubleSide
    }));
    var glowMaterial = rememberMaterial(new T.MeshBasicMaterial({
      color: 0x24703a,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      toneMapped: false
    }));
    var doorMaterial = makeDarkMaterial(0x030304, 0.96);
    var frameMaterial = rememberMaterial(new T.MeshBasicMaterial({ color: 0x030304 }));
    var box = unitBoxGeometry();
    var signGeometry = rememberGeometry(new T.PlaneGeometry(0.92, 0.38));
    var glowGeometry = rememberGeometry(new T.PlaneGeometry(1.16, 0.58));
    var screenHalf = finite(screen.widthM, 10) / 2;
    var roomHalf = dimensions.roomWidth / 2;
    // Curved screens project their near edges wider than their chord. Keep the
    // doors near the side walls so they are not hidden behind the screen arc.
    var frontX = roomHalf - 0.82;

    function frontExit(x) {
      var recess = addMesh(box, frameMaterial);
      recess.position.set(x, 1.18, 0.50);
      recess.scale.set(1.34, 2.48, 0.16);
      var door = addMesh(box, doorMaterial);
      door.position.set(x, 1.08, 0.64);
      door.scale.set(1.04, 2.12, 0.08);
      // 문을 덮는 판이 아니라 실제 문틀처럼 네 개의 가는 바를 둔다.
      [[-0.56, 1.08, 0.055, 2.20], [0.56, 1.08, 0.055, 2.20],
       [0, 2.16, 0.62, 0.055], [0, 0.03, 0.62, 0.055]].forEach(function (part) {
        var frame = addMesh(box, frameMaterial);
        frame.position.set(x + part[0], part[1], 0.692);
        frame.scale.set(part[2] * 2, part[3], 0.025);
      });
      var glow = addMesh(glowGeometry, glowMaterial);
      glow.position.set(x, 2.48, 0.704);
      glow.renderOrder = 7;
      var sign = addMesh(signGeometry, signMaterial);
      sign.position.set(x, 2.48, 0.716);
      sign.scale.set(1.22, 1.22, 1.22);
      sign.renderOrder = 8;
      var signLight = new T.PointLight(0x4b9257, 0.075, 2.8, 2);
      signLight.position.set(x, 2.42, 0.88);
      sceneRoot.add(signLight);
    }

    frontExit(-frontX);
    frontExit(frontX);

    var rearZ = Math.max(2, dimensions.maxSeatZ - 0.55);
    var floorY = nearestFloorY(dimensions.rows, rearZ);
    [-1, 1].forEach(function (side) {
      var x = side * (dimensions.roomWidth / 2 - 0.07);
      var door = addMesh(box, doorMaterial);
      door.position.set(x, floorY + 1.05, rearZ);
      door.scale.set(0.09, 2.1, 1.05);
      var sign = addMesh(signGeometry, signMaterial);
      sign.position.set(x - side * 0.055, floorY + 2.42, rearZ);
      sign.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      sign.renderOrder = 8;
      var glow = addMesh(glowGeometry, glowMaterial);
      glow.position.set(x - side * 0.045, floorY + 2.42, rearZ);
      glow.rotation.y = sign.rotation.y;
      glow.renderOrder = 7;
    });
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
    var geometry = rememberGeometry(new T.SphereGeometry(0.045, 6, 4));
    var material = rememberMaterial(new T.MeshBasicMaterial({ color: 0x315b2d, toneMapped: true }));
    var lights = new T.InstancedMesh(geometry, material, positions.length);
    var matrix = new T.Matrix4();
    for (var i = 0; i < positions.length; i++) {
      matrix.makeTranslation(positions[i].x, positions[i].y, positions[i].z);
      lights.setMatrixAt(i, matrix);
    }
    lights.instanceMatrix.needsUpdate = true;
    lights.frustumCulled = false;
    sceneRoot.add(lights);

    // 모든 표식마다 광원을 만들지 않고 대표 지점만 약하게 밝혀 내장 GPU 부하를 제한한다.
    for (i = 0; i < positions.length; i += Math.max(2, Math.floor(positions.length / 6))) {
      var point = new T.PointLight(0x426b3b, 0.055, 1.8, 2);
      point.position.set(positions[i].x, positions[i].y + 0.04, positions[i].z);
      sceneRoot.add(point);
    }
  }

  function addLighting(screen, dimensions, posterSample, ambientScale) {
    var ambient = new T.AmbientLight(0x626273, 0.075 + 0.075 * ambientScale);
    sceneRoot.add(ambient);

    var color = new T.Color(
      clamp(posterSample.r, 0.25, 1),
      clamp(posterSample.g, 0.25, 1),
      clamp(posterSample.b, 0.25, 1)
    );
    color.lerp(new T.Color(0xffffff), 0.48);
    var intensity = (0.22 + 0.42 * posterSample.luma) * ambientScale;
    var light = new T.SpotLight(color, intensity, dimensions.maxZ * 1.7, 1.12, 0.88, 1.4);
    light.position.copy(screenPoint(screen, 0, finite(screen.bottomHeightM, 0) + finite(screen.heightM, 5) * 0.48, 0.30));
    light.target.position.set(0, Math.max(0.5, dimensions.maxFloorY * 0.55), dimensions.maxZ * 0.64);
    light.castShadow = false;
    sceneRoot.add(light);
    sceneRoot.add(light.target);
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
    var roomHalf = Math.max(finite(screen.widthM, 10) / 2 + 3.4, maxSeatX + 1.7);
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
    var colors = gainGeometry.getAttribute("color");
    if (!positions || !normals || !colors) return;
    var view = new T.Vector3();
    var normal = new T.Vector3();
    var point = new T.Vector3();
    for (var i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      normal.fromBufferAttribute(normals, i).normalize();
      view.copy(camera.position).sub(point).normalize();
      var cosine = clamp(normal.dot(view), 0, 1);
      var gain = 0.70 + 0.30 * Math.pow(cosine, 0.65);
      colors.setXYZ(i, gain, gain, gain);
    }
    colors.needsUpdate = true;
  }

  function lookAtLitCenter() {
    if (!camera) return;
    camera.up.set(0, 1, 0);
    camera.lookAt(litCenter);
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
    renderer.toneMappingExposure = 1.12;
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
    camera.near = 0.035;
    camera.far = Math.max(120, dimensions.maxZ * 4, dimensions.ceilingY * 5);
    camera.position.copy(eyeOf(nextScene.activeSeat, auditorium));
    camera.updateProjectionMatrix();

    var posterSample = averagePoster(nextScene.posterImage);
    var posterTexture = makePosterTexture(nextScene.posterImage);
    var screenParts = addScreen(screen, lit, posterTexture, nextScene.posterImage);
    addScreenX(screen, lit, posterTexture, screenParts.crop, screenParts.yBottom, screenParts.yTop);
    var lightColor = addLighting(screen, dimensions, posterSample, ambientScale);
    addAuditorium(screen, auditorium, seats, dimensions, lightColor, ambientScale);
    addSeats(seats, nextScene.activeSeat, options.showOccupants !== false);
    addExits(screen, dimensions);
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
      to: eyeOf(seat, sceneData.auditorium),
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
