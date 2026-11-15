/* Scanner-Kern: Dokumenterkennung, Entzerrung, Bildverbesserung, PDF-Erzeugung, Dropbox-Helfer.
 * Benötigt OpenCV.js (lokal mitgeliefert). Keine weiteren Abhängigkeiten. */
(function (root) {
  'use strict';

  var cv = null;
  var A4_RATIO = Math.SQRT2;
  var Core = {};

  // ---------------------------------------------------------------- OpenCV laden
  Core.setCV = function (c) { cv = c; };

  Core.loadCV = async function (src) {
    if (cv) return cv;
    if (typeof document !== 'undefined' && !(root.cv && (root.cv.Mat || typeof root.cv.then === 'function'))) {
      await new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = res;
        s.onerror = function () { rej(new Error('opencv.js konnte nicht geladen werden')); };
        document.head.appendChild(s);
      });
    }
    var c = root.cv;
    if (c && typeof c.then === 'function') c = await c;
    if (!c || !c.Mat) throw new Error('OpenCV ist nicht verfügbar');
    cv = c;
    return cv;
  };

  // ---------------------------------------------------------------- Geometrie
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function polyArea(p) {
    var s = 0;
    for (var i = 0; i < p.length; i++) {
      var a = p[i], b = p[(i + 1) % p.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  // Sortiert 4 Punkte im Uhrzeigersinn, beginnend oben links: [tl, tr, br, bl]
  function orderCorners(p) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += p[i].x / 4; cy += p[i].y / 4; }
    var s = p.map(function (q) { return { x: q.x, y: q.y, a: Math.atan2(q.y - cy, q.x - cx) }; })
      .sort(function (a, b) { return a.a - b.a; });
    var start = 0, best = Infinity;
    for (i = 0; i < 4; i++) {
      var v = s[i].x + s[i].y;
      if (v < best) { best = v; start = i; }
    }
    var out = [];
    for (i = 0; i < 4; i++) { var q = s[(start + i) % 4]; out.push({ x: q.x, y: q.y }); }
    return out;
  }

  function isConvexQuad(p) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
      var cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cr === 0) return false;
      var s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  function maxAngleDeviation(p) {
    var worst = 0;
    for (var i = 0; i < 4; i++) {
      var a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
      var v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
      var cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
      var ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      worst = Math.max(worst, Math.abs(ang - 90));
    }
    return worst;
  }

  Core.geometry = { dist: dist, polyArea: polyArea, orderCorners: orderCorners, isConvexQuad: isConvexQuad };

  // ---------------------------------------------------------------- Dokumenterkennung
  function matPoints(m) {
    var pts = [];
    for (var i = 0; i < m.rows; i++) pts.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] });
    return pts;
  }

  function quadFromContour(cnt, imgArea) {
    var hull = new cv.Mat();
    try {
      cv.convexHull(cnt, hull, false, true);
      if (hull.rows < 4) return null;
      var peri = cv.arcLength(hull, true);
      var hullArea = cv.contourArea(hull);
      if (hullArea < 0.1 * imgArea) return null;
      var quad = null, fromRect = false;
      for (var e = 0.01; e <= 0.1001; e += 0.005) {
        var ap = new cv.Mat();
        cv.approxPolyDP(hull, ap, e * peri, true);
        var n = ap.rows;
        if (n === 4) quad = matPoints(ap);
        ap.delete();
        if (n <= 4) break;
      }
      if (!quad) {
        // Fallback: kleinstes umschließendes Rechteck, wenn die Hülle fast rechteckig ist
        var r = cv.minAreaRect(hull);
        var rp = cv.RotatedRect.points(r);
        var rq = rp.map(function (q) { return { x: q.x, y: q.y }; });
        var ra = polyArea(rq);
        if (ra > 0 && hullArea / ra > 0.88) { quad = rq; fromRect = true; }
      }
      if (!quad) return null;
      quad = orderCorners(quad);
      if (!isConvexQuad(quad)) return null;
      var qa = polyArea(quad);
      if (qa < 0.1 * imgArea || qa > 0.985 * imgArea) return null;
      if (!fromRect && hullArea / qa < 0.9 && qa / hullArea < 0.9) return null;
      var dev = maxAngleDeviation(quad);
      if (dev > 50) return null;
      var score = (qa / imgArea) * (1 - 0.5 * Math.min(1, dev / 50)) * (fromRect ? 0.9 : 1);
      return { corners: quad, score: score };
    } finally {
      hull.delete();
    }
  }

  // Anteil der Randpunkte des Vierecks, an denen im Bild tatsächlich eine Kante liegt
  function edgeCoverage(support, q) {
    var W = support.cols, H = support.rows, hit = 0, tot = 0, N = 50;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      for (var j = 0; j < N; j++) {
        var t = 0.05 + 0.9 * j / (N - 1);
        var x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
        if (x <= 2 || y <= 2 || x >= W - 3 || y >= H - 3) continue; // am Bildrand gibt es keine Kante
        tot++;
        if (support.ucharAt(y, x)) hit++;
      }
    }
    return tot < 20 ? 0.5 : hit / tot;
  }

  function collect(bin, imgArea, out, tag) {
    var contours = new cv.MatVector(), hier = new cv.Mat();
    try {
      cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        try {
          if (cv.contourArea(c) < 0.08 * imgArea) continue;
          var q = quadFromContour(c, imgArea);
          if (q) { q.source = tag; out.push(q); }
        } finally { c.delete(); }
      }
    } finally { contours.delete(); hier.delete(); }
  }

  /**
   * Sucht das Dokument im Bild.
   * @param src cv.Mat (RGBA oder RGB)
   * @returns {corners:[tl,tr,br,bl] in Pixeln von src, score} oder null
   */
  Core.detectQuad = function (src, dbg) {
    var small = new cv.Mat(), gray = new cv.Mat(), blur = new cv.Mat();
    var edges = new cv.Mat(), bin = new cv.Mat(), edgesLo = new cv.Mat(), support = new cv.Mat(), k3 = null, k5 = null, k9 = null;
    try {
      var maxDim = 520;
      var s = Math.min(1, maxDim / Math.max(src.cols, src.rows));
      cv.resize(src, small, new cv.Size(Math.max(8, Math.round(src.cols * s)), Math.max(8, Math.round(src.rows * s))), 0, 0, cv.INTER_AREA);
      cv.cvtColor(small, gray, small.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      var imgArea = blur.cols * blur.rows;
      var cands = [];

      // Strategie A: Kanten
      k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      k5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.Canny(blur, edges, 35, 110);
      cv.Canny(blur, edgesLo, 12, 36);
      cv.dilate(edgesLo, support, k5);        // Kantenkarte zur Überprüfung der Kandidaten
      cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 2);
      cv.erode(edges, edges, k3, new cv.Point(-1, -1), 2);
      collect(edges, imgArea, cands, 'edges');

      // Strategie B: helles Papier gegen dunkleren Hintergrund (Otsu)
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k9);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k3, new cv.Point(-1, -1), 2);
      collect(bin, imgArea, cands, 'otsu');

      if (!cands.length) return null;
      cands.forEach(function (c) {
        c.coverage = edgeCoverage(support, c.corners);
        c.score *= 0.25 + 0.75 * c.coverage;
      });
      cands.sort(function (a, b) { return b.score - a.score; });
      var best = cands[0];
      // leicht nach innen ziehen: lieber einen Hauch Papier verlieren als dunklen Rand zeigen
      var cx = 0, cy = 0, i;
      for (i = 0; i < 4; i++) { cx += best.corners[i].x / 4; cy += best.corners[i].y / 4; }
      var diag = Math.hypot(blur.cols, blur.rows), inset = 0.0025 * diag;
      var pts = best.corners.map(function (p) {
        var dx = cx - p.x, dy = cy - p.y, l = Math.hypot(dx, dy) || 1;
        return { x: (p.x + dx / l * inset) / s, y: (p.y + dy / l * inset) / s };
      });
      var res = { corners: pts, score: best.score, source: best.source };
      if (dbg) res.cands = cands.map(function (c) { return { s: c.score, src: c.source, cov: c.coverage, c: c.corners.map(function (p) { return [Math.round(p.x / s), Math.round(p.y / s)]; }) }; });
      return res;
    } finally {
      small.delete(); gray.delete(); blur.delete(); edges.delete(); bin.delete(); edgesLo.delete(); support.delete();
      if (k3) k3.delete();
      if (k5) k5.delete();
      if (k9) k9.delete();
    }
  };


  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /**
   * Seitenverhältnis (Breite/Höhe) eines Rechtecks aus seinem perspektivischen Abbild
   * (Zhang & He, "Whiteboard scanning"); Hauptpunkt = Bildmitte, quadratische Pixel.
   * corners = [tl, tr, br, bl] in Pixeln. Liefert null, wenn nicht schätzbar (z. B. frontale Aufnahme).
   */
  function estimateAspect(c, W, H) {
    var m1 = [c[0].x, c[0].y, 1], m2 = [c[1].x, c[1].y, 1], m4 = [c[2].x, c[2].y, 1], m3 = [c[3].x, c[3].y, 1];
    var u0 = W / 2, v0 = H / 2;
    var d2 = dot3(cross3(m2, m4), m3), d3 = dot3(cross3(m3, m4), m2);
    if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
    var k2 = dot3(cross3(m1, m4), m3) / d2, k3 = dot3(cross3(m1, m4), m2) / d3;
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    if (Math.abs(n2[2]) < 1e-6 || Math.abs(n3[2]) < 1e-6) return null; // keine Perspektive -> normale Schätzung
    var f2 = -1 / (n2[2] * n3[2]) * ((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0));
    if (!(f2 > 0) || !isFinite(f2)) return null;
    var f = Math.sqrt(f2), md = Math.max(W, H);
    if (f < 0.25 * md || f > 40 * md) return null;   // unplausible Brennweite
    function len(n) { var x = (n[0] - u0 * n[2]) / f, y = (n[1] - v0 * n[2]) / f; return Math.hypot(x, y, n[2]); }
    var r = len(n2) / len(n3);
    return (isFinite(r) && r > 0.2 && r < 5) ? r : null;
  }
  Core.estimateAspect = estimateAspect;

  // ---------------------------------------------------------------- Entzerrung
  /**
   * @param src cv.Mat (RGBA/RGB), corners in Pixeln von src [tl,tr,br,bl]
   * @param opts {targetLong, snapA4}
   * @returns neues cv.Mat (RGB, 8UC3)
   */
  Core.warp = function (src, corners, opts) {
    opts = opts || {};
    var targetLong = opts.targetLong || 2200;
    var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
    var lenW = Math.max(dist(tl, tr), dist(bl, br));
    var lenH = Math.max(dist(tl, bl), dist(tr, br));
    // Echtes Seitenverhältnis aus der Perspektive schätzen (Kamera mit Bildmitte als Hauptpunkt);
    // sonst bei starker Neigung wird aus einem Hochformat leicht ein Querformat.
    var ratio = lenW / Math.max(1, lenH), estimated = false;
    var est = estimateAspect(corners, src.cols, src.rows);
    if (est) { ratio = est; estimated = true; }
    var snapped = false;
    if (opts.snapA4 !== false) {
      var sr = Math.max(ratio, 1 / ratio);
      if (Math.abs(sr - A4_RATIO) / A4_RATIO < 0.08) { ratio = ratio >= 1 ? A4_RATIO : 1 / A4_RATIO; snapped = true; }
    }
    var W = Math.max(lenW, lenH * ratio), H = W / ratio;
    Core.lastWarpInfo = { ratio: ratio, estimated: estimated, snapped: snapped };
    var long = Math.max(W, H);
    var outLong = Math.min(targetLong, Math.round(long * 1.25));
    var f = outLong / long;
    var outW = Math.max(16, Math.round(W * f)), outH = Math.max(16, Math.round(H * f));

    var work = src, pre = null, ps = 1;
    if (f < 0.8) {
      // vorab sanft verkleinern (INTER_AREA), damit beim Entzerren kein Aliasing entsteht
      ps = Math.min(1, f * 1.3);
      pre = new cv.Mat();
      cv.resize(src, pre, new cv.Size(Math.round(src.cols * ps), Math.round(src.rows * ps)), 0, 0, cv.INTER_AREA);
      work = pre;
    }
    var rgb = new cv.Mat(), srcTri = null, dstTri = null, M = null, dst = new cv.Mat();
    try {
      if (work.channels() === 4) cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB); else work.copyTo(rgb);
      srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x * ps, tl.y * ps, tr.x * ps, tr.y * ps, br.x * ps, br.y * ps, bl.x * ps, bl.y * ps]);
      dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1]);
      M = cv.getPerspectiveTransform(srcTri, dstTri);
      cv.warpPerspective(rgb, dst, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
      return dst;
    } catch (e) {
      dst.delete();
      throw e;
    } finally {
      rgb.delete();
      if (pre) pre.delete();
      if (srcTri) srcTri.delete();
      if (dstTri) dstTri.delete();
      if (M) M.delete();
    }
  };

  // ---------------------------------------------------------------- Bildverbesserung
  function makeLut(whitePoint, gamma) {
    var d = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var v = Math.min(1, i / whitePoint);
      d[i] = Math.round(255 * Math.pow(v, gamma));
    }
    var lut = new cv.Mat(1, 256, cv.CV_8UC1);
    lut.data.set(d);
    return lut;
  }

  // Ausleuchtung ausgleichen: Papier -> weiß, Text bleibt dunkel, Farben bleiben erhalten
  function normalizeIllumination(img) {
    var w = img.cols, h = img.rows;
    var small = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat(), k = null;
    try {
      cv.resize(img, small, new cv.Size(Math.max(8, Math.round(w / 4)), Math.max(8, Math.round(h / 4))), 0, 0, cv.INTER_AREA);
      k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
      cv.dilate(small, small, k);           // dünne dunkle Schrift verschwindet
      cv.medianBlur(small, small, 21);      // Hintergrund = Papierhelligkeit
      // Große dunkle Flächen (Logos, Balken) nicht als "Hintergrund" werten: Untergrenze relativ zum Papierwert
      var g = new cv.Mat(), hist = new cv.Mat(), floorMat = null, mv = new cv.MatVector();
      try {
        cv.cvtColor(small, g, cv.COLOR_RGB2GRAY);
        var cnt = g.rows * g.cols, acc = 0, p90 = 255, d = g.data;
        var h256 = new Uint32Array(256);
        for (var q = 0; q < d.length; q++) h256[d[q]]++;
        for (var v = 0; v < 256; v++) { acc += h256[v]; if (acc >= 0.9 * cnt) { p90 = v; break; } }
        floorMat = new cv.Mat(small.rows, small.cols, small.type(), new cv.Scalar(p90 * 0.5, p90 * 0.5, p90 * 0.5, 0));
        cv.max(small, floorMat, small);
      } finally { g.delete(); hist.delete(); mv.delete(); if (floorMat) floorMat.delete(); }
      cv.resize(small, bg, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
      cv.divide(img, bg, out, 255, -1);
      return out;
    } catch (e) { out.delete(); throw e; }
    finally { small.delete(); bg.delete(); if (k) k.delete(); }
  }

  function sharpen(img, amount) {
    var blur = new cv.Mat();
    try {
      cv.GaussianBlur(img, blur, new cv.Size(0, 0), 1.2);
      cv.addWeighted(img, 1 + amount, blur, -amount, 0, img);
    } finally { blur.delete(); }
  }

  /**
   * @param img cv.Mat RGB (wird nicht verändert)
   * @param mode 'doc' | 'gray' | 'bw' | 'orig'
   * @returns neues cv.Mat RGB 8UC3
   */
  Core.enhance = function (img, mode) {
    if (mode === 'orig') return img.clone();
    var norm = normalizeIllumination(img);
    var lut = makeLut(236, 1.35);
    var keepNorm = false;
    try {
      cv.LUT(norm, lut, norm);
      if (mode === 'doc') {
        sharpen(norm, 0.6);
        keepNorm = true;
        return norm;
      }
      var gray = new cv.Mat(), out = new cv.Mat();
      try {
        cv.cvtColor(norm, gray, cv.COLOR_RGB2GRAY);
        if (mode === 'bw') {
          var side = Math.max(15, (Math.round(Math.min(gray.cols, gray.rows) / 50) | 1));
          cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
          cv.adaptiveThreshold(gray, gray, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, side, 14);
        } else {
          sharpen(gray, 0.6);
        }
        cv.cvtColor(gray, out, cv.COLOR_GRAY2RGB);
        return out;
      } catch (e) { out.delete(); throw e; }
      finally { gray.delete(); }
    } finally {
      lut.delete();
      if (!keepNorm) norm.delete();
    }
  };

  Core.rotate = function (img, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg === 0) return img.clone();
    var out = new cv.Mat();
    cv.rotate(img, out, deg === 90 ? cv.ROTATE_90_CLOCKWISE : deg === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE);
    return out;
  };


  // ---------------------------------------------------------------- Canvas-Komfortfunktionen
  Core.getCV = function () { return cv; };

  function matFromCanvas(canvas) {
    var ctx = canvas.getContext('2d');
    return cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  function canvasFromRgb(mat) {
    var rgba = new cv.Mat();
    try {
      cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
      var c = document.createElement('canvas');
      c.width = rgba.cols; c.height = rgba.rows;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows), 0, 0);
      return c;
    } finally { rgba.delete(); }
  }

  /** Erkennung auf einem Canvas; Ergebnis normalisiert (0..1) oder null. */
  Core.detectCanvas = function (canvas) {
    var m = matFromCanvas(canvas);
    try {
      var d = Core.detectQuad(m);
      if (!d) return null;
      return {
        corners: d.corners.map(function (p) { return { x: p.x / canvas.width, y: p.y / canvas.height }; }),
        score: d.score
      };
    } finally { m.delete(); }
  };

  /** Entzerren + verbessern + drehen. cornersNorm: [tl,tr,br,bl] in 0..1. Liefert ein neues Canvas. */
  Core.renderCanvas = function (srcCanvas, cornersNorm, opts) {
    opts = opts || {};
    var m = matFromCanvas(srcCanvas), w = null, e = null, r = null;
    try {
      var px = cornersNorm.map(function (p) { return { x: p.x * srcCanvas.width, y: p.y * srcCanvas.height }; });
      w = Core.warp(m, px, opts);
      e = Core.enhance(w, opts.mode || 'doc');
      r = Core.rotate(e, opts.rot || 0);
      return canvasFromRgb(r);
    } finally {
      m.delete();
      if (w) w.delete();
      if (e) e.delete();
      if (r) r.delete();
    }
  };

  // ---------------------------------------------------------------- PDF
  var A4W = 595.276, A4H = 841.89;

  function pageSize(w, h) {
    var long = Math.max(w, h), short = Math.min(w, h);
    var r = long / short;
    var landscape = w > h;
    if (Math.abs(r - A4_RATIO) / A4_RATIO < 0.03) return landscape ? [A4H, A4W] : [A4W, A4H];
    var s = A4H / long;
    return [w * s, h * s];
  }

  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

  function pdfTextString(s) {
    var hex = 'FEFF';
    for (var i = 0; i < s.length; i++) hex += ('0000' + s.charCodeAt(i).toString(16)).slice(-4);
    return '<' + hex.toUpperCase() + '>';
  }

  /**
   * @param pages [{jpeg:Uint8Array, w:Number, h:Number}]
   * @param meta {title}
   * @returns Uint8Array (PDF)
   */
  Core.buildPdf = function (pages, meta) {
    meta = meta || {};
    var enc = new TextEncoder();
    var chunks = [], offset = 0, offsets = [];
    function push(d) {
      var u = typeof d === 'string' ? enc.encode(d) : d;
      chunks.push(u);
      offset += u.length;
    }
    function begin(n) { offsets[n] = offset; push(n + ' 0 obj\n'); }
    function end() { push('\nendobj\n'); }

    var n = pages.length;
    var total = 3 + 3 * n; // 0 (frei), 1 Catalog, 2 Pages, 3 Info, dann je Seite 3 Objekte
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    begin(1); push('<< /Type /Catalog /Pages 2 0 R >>'); end();
    var kids = [];
    for (var i = 0; i < n; i++) kids.push((4 + 3 * i) + ' 0 R');
    begin(2); push('<< /Type /Pages /Count ' + n + ' /Kids [' + kids.join(' ') + '] >>'); end();

    var d = new Date();
    function p2(x) { return ('0' + x).slice(-2); }
    var cd = 'D:' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    begin(3);
    push('<< /Producer (Dokumentenscanner) /CreationDate (' + cd + ')' + (meta.title ? ' /Title ' + pdfTextString(meta.title) : '') + ' >>');
    end();

    for (var j = 0; j < n; j++) {
      var pg = pages[j];
      var sz = pageSize(pg.w, pg.h);
      var pw = fmt(sz[0]), ph = fmt(sz[1]);
      var pObj = 4 + 3 * j, iObj = 5 + 3 * j, cObj = 6 + 3 * j;
      begin(pObj);
      push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 ' + iObj + ' 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ' + cObj + ' 0 R >>');
      end();
      begin(iObj);
      push('<< /Type /XObject /Subtype /Image /Width ' + pg.w + ' /Height ' + pg.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
      push(pg.jpeg);
      push('\nendstream');
      end();
      var content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
      begin(cObj);
      push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      end();
    }

    var xref = offset;
    var x = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (var o = 1; o <= total; o++) x += ('0000000000' + offsets[o]).slice(-10) + ' 00000 n \n';
    push(x);
    push('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    var all = new Uint8Array(offset), pos = 0;
    for (var c = 0; c < chunks.length; c++) { all.set(chunks[c], pos); pos += chunks[c].length; }
    return all;
  };

  // ---------------------------------------------------------------- Dropbox
  var DBX = {
    authorize: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    upload: 'https://content.dropboxapi.com/2/files/upload'
  };
  Core.DBX = DBX;

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  Core.makePkce = async function () {
    var rnd = new Uint8Array(48);
    crypto.getRandomValues(rnd);
    var verifier = b64url(rnd);
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: b64url(new Uint8Array(digest)) };
  };

  Core.randomState = function () {
    var r = new Uint8Array(16);
    crypto.getRandomValues(r);
    return b64url(r);
  };

  Core.buildAuthUrl = function (o) {
    var q = new URLSearchParams({
      client_id: o.appKey,
      response_type: 'code',
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      redirect_uri: o.redirectUri,
      state: o.state
    });
    return DBX.authorize + '?' + q.toString();
  };

  async function tokenRequest(params) {
    var res = await fetch(DBX.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    var js = null;
    try { js = await res.json(); } catch (e) { /* ignorieren */ }
    if (!res.ok || !js || !js.access_token) {
      var msg = js && (js.error_description || js.error) || ('HTTP ' + res.status);
      var err = new Error('Dropbox-Anmeldung fehlgeschlagen: ' + msg);
      err.status = res.status;
      throw err;
    }
    return js;
  }

  Core.exchangeCode = function (o) {
    return tokenRequest({
      grant_type: 'authorization_code', code: o.code, client_id: o.appKey,
      code_verifier: o.verifier, redirect_uri: o.redirectUri
    });
  };

  Core.refreshAccess = function (o) {
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.appKey });
  };

  // Dropbox-API-Arg muss reines ASCII sein: Nicht-ASCII-Zeichen als \uXXXX
  Core.apiArg = function (obj) {
    return JSON.stringify(obj).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  };

  Core.safeFileName = function (name) {
    var n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    return n || 'Scan';
  };

  Core.dropboxPath = function (folder, fileName) {
    var f = String(folder || '').replace(/\\/g, '/').split('/').map(function (s) { return s.trim(); }).filter(Boolean).join('/');
    return (f ? '/' + f : '') + '/' + fileName;
  };

  Core.uploadFile = async function (accessToken, path, bytes) {
    var res = await fetch(DBX.upload, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Dropbox-API-Arg': Core.apiArg({ path: path, mode: 'add', autorename: true, mute: false }),
        'Content-Type': 'application/octet-stream'
      },
      body: bytes
    });
    var txt = await res.text();
    var js = null;
    try { js = JSON.parse(txt); } catch (e) { /* ignorieren */ }
    if (!res.ok) {
      var err = new Error('Upload fehlgeschlagen (' + res.status + '): ' + ((js && (js.error_summary || js.error)) || txt.slice(0, 200)));
      err.status = res.status;
      throw err;
    }
    return js;
  };

  root.ScanCore = Core;
  if (typeof module === 'object' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
