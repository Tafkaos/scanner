/* Oberfläche und Ablauf des Dokumentenscanners */
(function () {
  'use strict';
  var Core = window.ScanCore;
  function $(id) { return document.getElementById(id); }

  var QUALITY = { small: { long: 1600, q: 0.62 }, std: { long: 2200, q: 0.75 }, high: { long: 3000, q: 0.85 } };
  var S = { appKey: '', folder: '', quality: 'std', mode: 'doc', snap: true, auto: false };
  var pages = [];
  var uid = 0;

  // ------------------------------------------------------------ Speicher
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignorieren */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignorieren */ } }
  Object.assign(S, lsGet('scan.settings') || {});
  function saveSettings() { lsSet('scan.settings', S); }

  // ------------------------------------------------------------ Hilfen
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }

  function toBlob(canvas, q) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) { b ? res(b) : rej(new Error('Bild konnte nicht kodiert werden')); }, 'image/jpeg', q);
    });
  }

  async function decodeBlob(blob, maxDim) {
    var bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    var s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  function thumbOf(canvas, max) {
    var s = Math.min(1, max / Math.max(canvas.width, canvas.height));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s));
    c.height = Math.max(1, Math.round(canvas.height * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  // ------------------------------------------------------------ OpenCV + Arbeitsschlange
  var cvOk = false;
  var cvReady = Core.loadCV('opencv.js').then(function () {
    cvOk = true;
    $('status').textContent = '';
  }).catch(function (e) {
    $('status').textContent = 'Bildverarbeitung konnte nicht geladen werden: ' + e.message + ' – bitte Seite neu laden.';
    throw e;
  });
  cvReady.catch(function () { /* Fehler wird im Status gezeigt */ });
  $('status').textContent = 'Bildverarbeitung wird geladen …';

  var chain = Promise.resolve();
  var working = 0;
  function enqueue(fn) {
    working++;
    var p = chain.then(fn);
    chain = p.then(function () { working--; }, function () { working--; });
    return p;
  }

  // ------------------------------------------------------------ Seiten
  function defaultCorners() {
    var m = 0.03;
    return [{ x: m, y: m }, { x: 1 - m, y: m }, { x: 1 - m, y: 1 - m }, { x: m, y: 1 - m }];
  }

  async function renderPage(page, longOverride) {
    await cvReady;
    var q = QUALITY[S.quality] || QUALITY.std;
    var src = await decodeBlob(page.src, 4096);
    var out = Core.renderCanvas(src, page.corners, {
      mode: page.mode, rot: page.rot, targetLong: longOverride || q.long, snapA4: S.snap
    });
    src.width = src.height = 0;
    return { canvas: out, q: q.q };
  }

  async function finishPage(page) {
    var r = await renderPage(page);
    var blob = await toBlob(r.canvas, r.q);
    page.thumb = thumbOf(r.canvas, 360);
    page.result = { blob: blob, w: r.canvas.width, h: r.canvas.height };
    r.canvas.width = r.canvas.height = 0;
    page.busy = false;
  }

  function addImage(blob) {
    var page = { id: ++uid, src: blob, corners: null, mode: S.mode, rot: 0, result: null, thumb: null, busy: true, error: null };
    pages.push(page);
    updateCount();
    renderPages();
    return enqueue(async function () {
      try {
        await cvReady;
        var probe = await decodeBlob(blob, 900);
        var det = Core.detectCanvas(probe);
        probe.width = probe.height = 0;
        if (det) { page.corners = det.corners; page.detected = true; }
        else { page.corners = defaultCorners(); page.detected = false; toast('Kein Dokument erkannt – Ecken bitte prüfen (Seite antippen).', 4000); }
        await finishPage(page);
      } catch (e) {
        page.busy = false;
        page.error = e.message || String(e);
        toast('Fehler bei der Verarbeitung: ' + page.error, 5000);
      }
      renderPages();
    }).then(function () { return page; });
  }

  function updateCount() { $('count').textContent = pages.length; }

  // ------------------------------------------------------------ Ansichten
  var current = 'cam';
  function show(v) {
    current = v;
    ['cam', 'pages', 'edit'].forEach(function (n) { $('view-' + n).classList.toggle('active', n === v); });
    if (v === 'cam') startCam(); else stopCam();
    if (v === 'pages') renderPages();
  }

  function renderPages() {
    var g = $('grid');
    g.innerHTML = '';
    $('empty').hidden = pages.length > 0;
    $('pages-title').textContent = pages.length + (pages.length === 1 ? ' Seite' : ' Seiten');
    pages.forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'card' + (p.busy ? ' busy' : '');
      var img = document.createElement('img');
      img.alt = 'Seite ' + (i + 1);
      if (p.thumb) img.src = p.thumb;
      img.onclick = function () { if (!p.busy) openEditor(p); };
      var n = document.createElement('span'); n.className = 'num'; n.textContent = i + 1;
      var o = document.createElement('div'); o.className = 'ord';
      var l = document.createElement('button'); l.textContent = '◀'; l.disabled = i === 0; l.setAttribute('aria-label', 'Nach vorne');
      var r = document.createElement('button'); r.textContent = '▶'; r.disabled = i === pages.length - 1; r.setAttribute('aria-label', 'Nach hinten');
      l.onclick = function () { move(i, -1); };
      r.onclick = function () { move(i, 1); };
      o.appendChild(l); o.appendChild(r);
      d.appendChild(img); d.appendChild(n); d.appendChild(o);
      if (p.error) { var er = document.createElement('div'); er.className = 'mut'; er.style.padding = '4px 8px'; er.textContent = '⚠ ' + p.error; d.appendChild(er); }
      g.appendChild(d);
    });
    var ok = pages.length > 0 && pages.every(function (p) { return !p.busy; });
    $('btn-share').disabled = !ok;
    $('btn-upload').disabled = !ok;
    var t = lsGet('scan.dbx');
    $('dbx-line').textContent = t && t.refresh ? 'Dropbox verbunden' + (S.folder ? ' – Ordner: ' + S.folder : '') : 'Dropbox noch nicht verbunden (⚙︎ in der Kameraansicht)';
  }

  function move(i, d) {
    var j = i + d;
    if (j < 0 || j >= pages.length) return;
    var t = pages[i]; pages[i] = pages[j]; pages[j] = t;
    renderPages();
  }

  // ------------------------------------------------------------ Kamera
  var stream = null, track = null, imageCapture = null, camTimer = null, camOn = false;
  var capturing = false, torchOn = false;
  var video = $('video'), overlay = $('overlay'), probe = document.createElement('canvas');
  var lastQuad = null, stableSince = 0, armed = true, lostSince = 0, quadAtShot = null;

  function setHint(t) { $('hint-text').textContent = t; }

  async function startCam() {
    if (stream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (!navigator.mediaDevices) showCamProblem('Kamerazugriff wird hier nicht unterstützt (HTTPS nötig). „Kamera-App“ unten funktioniert trotzdem.');
      return;
    }
    $('cam-start').hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false
      });
    } catch (e) {
      stream = null;
      showCamProblem(e && e.name === 'NotAllowedError'
        ? 'Kamerazugriff wurde nicht erlaubt. In den Browser-Einstellungen erlauben oder „Kamera-App“ nutzen.'
        : 'Kamera konnte nicht gestartet werden (' + (e && e.name || 'Fehler') + ').');
      return;
    }
    if (current !== 'cam') { stopCam(); return; }
    video.srcObject = stream;
    try { await video.play(); } catch (e) { showCamProblem('Zum Starten der Kamera bitte tippen.'); return; }
    track = stream.getVideoTracks()[0];
    var caps = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { /* ignorieren */ }
    $('btn-torch').hidden = !caps.torch;
    try { if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* ignorieren */ }
    imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
    camOn = true;
    setHint('Dokument ins Bild halten');
    loop();
  }

  function showCamProblem(msg) {
    $('cam-msg').textContent = msg;
    $('cam-start').hidden = false;
    setHint('');
  }

  function stopCam() {
    camOn = false;
    clearTimeout(camTimer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; track = null; imageCapture = null; torchOn = false;
    video.srcObject = null;
    lastQuad = null;
  }

  function drawOverlay(quad, state) {
    var cw = overlay.clientWidth, ch = overlay.clientHeight, dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(cw * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    var ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!quad) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    var sc = Math.min(cw / vw, ch / vh), ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
    var pts = quad.map(function (p) { return { x: ox + p.x * vw * sc, y: oy + p.y * vh * sc }; });
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath();
    ctx.fillStyle = state === 'stable' ? 'rgba(34,197,94,.22)' : 'rgba(59,130,246,.18)';
    ctx.strokeStyle = state === 'stable' ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 3;
    ctx.fill(); ctx.stroke();
  }

  function quadMove(a, b) {
    var m = 0;
    for (var i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
    return m;
  }

  function loop() {
    if (!camOn) return;
    camTimer = setTimeout(loop, 220);
    if (!cvOk || working > 0 || capturing || video.readyState < 2 || !video.videoWidth) return;
    var vw = video.videoWidth, vh = video.videoHeight, s = 480 / Math.max(vw, vh);
    probe.width = Math.round(vw * s); probe.height = Math.round(vh * s);
    probe.getContext('2d').drawImage(video, 0, 0, probe.width, probe.height);
    var det = null;
    try { det = Core.detectCanvas(probe); } catch (e) { /* nächster Versuch */ }
    var now = Date.now();
    if (!det) {
      lastQuad = null; stableSince = 0;
      if (!lostSince) lostSince = now;
      if (now - lostSince > 700) armed = true;
      drawOverlay(null);
      setHint('Kein Dokument erkannt');
      return;
    }
    lostSince = 0;
    var q = det.corners;
    if (quadAtShot && !armed && quadMove(q, quadAtShot) > 0.15) armed = true;
    var moving = lastQuad ? quadMove(q, lastQuad) : 1;
    if (moving < 0.012) { if (!stableSince) stableSince = now; } else stableSince = 0;
    lastQuad = q;
    var stable = stableSince && now - stableSince > 500;
    drawOverlay(q, stable ? 'stable' : 'moving');
    if (S.auto) {
      if (!armed) setHint('Nächste Seite hinlegen');
      else if (stable) {
        var left = 1100 - (now - stableSince);
        if (left <= 0) { quadAtShot = q; armed = false; capture(); return; }
        setHint('Ruhig halten …');
      } else setHint('Dokument erkannt');
    } else setHint(stable ? 'Dokument erkannt – Auslöser drücken' : 'Dokument erkannt');
  }

  function flash() {
    var f = $('flash');
    f.style.transition = 'none'; f.style.opacity = '0.8';
    requestAnimationFrame(function () { f.style.transition = 'opacity .25s'; f.style.opacity = '0'; });
  }

  async function capture() {
    if (capturing || !camOn) return;
    capturing = true;
    flash();
    try {
      var blob = null;
      if (imageCapture) {
        try { blob = await imageCapture.takePhoto(); } catch (e) { blob = null; }
      }
      if (!blob) {
        var c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        blob = await toBlob(c, 0.92);
        c.width = c.height = 0;
      }
      addImage(blob);
      toast('Seite ' + pages.length + ' aufgenommen', 1200);
    } catch (e) {
      toast('Aufnahme fehlgeschlagen: ' + (e.message || e), 4000);
    } finally { capturing = false; }
  }

  // ------------------------------------------------------------ Editor
  var ed = { page: null, img: null, corners: null, mode: 'doc', rot: 0, drag: -1, preview: null, scale: 1 };
  var ec = $('edit-canvas');

  async function openEditor(page) {
    ed.page = page;
    ed.corners = page.corners.map(function (p) { return { x: p.x, y: p.y }; });
    ed.mode = page.mode; ed.rot = page.rot; ed.preview = null;
    ed.img = await decodeBlob(page.src, 1400);
    $('ed-preview').textContent = 'Vorschau';
    show('edit');
    layoutEditor();
    markModes();
  }

  function layoutEditor() {
    if (!ed.img) return;
    ec.width = ed.img.width; ec.height = ed.img.height;
    drawEditor();
  }

  function markModes() {
    document.querySelectorAll('#view-edit [data-mode]').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === ed.mode); });
  }

  function drawEditor() {
    var ctx = ec.getContext('2d');
    if (ed.preview) {
      ec.width = ed.preview.width; ec.height = ed.preview.height;
      ctx.drawImage(ed.preview, 0, 0);
      return;
    }
    if (ec.width !== ed.img.width) { ec.width = ed.img.width; ec.height = ed.img.height; }
    var w = ec.width, h = ec.height;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(ed.img, 0, 0);
    var pts = ed.corners.map(function (p) { return { x: p.x * w, y: p.y * h }; });
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = Math.max(2, w / 300);
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath(); ctx.stroke();
    var r = Math.max(10, w / 45);
    pts.forEach(function (p) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(59,130,246,.35)'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, w / 350); ctx.stroke();
    });
  }

  function editPoint(ev) {
    var r = ec.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, pxScale: r.width };
  }

  ec.addEventListener('pointerdown', function (ev) {
    if (ed.preview) return;
    var p = editPoint(ev), best = -1, bd = 0.09;
    ed.corners.forEach(function (c, i) {
      var d = Math.hypot(c.x - p.x, (c.y - p.y) * (ec.height / ec.width));
      if (d < bd) { bd = d; best = i; }
    });
    ed.drag = best;
    if (best >= 0) { ec.setPointerCapture(ev.pointerId); ev.preventDefault(); }
  });
  ec.addEventListener('pointermove', function (ev) {
    if (ed.drag < 0) return;
    var p = editPoint(ev);
    ed.corners[ed.drag] = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
    drawEditor();
  });
  function endDrag() { ed.drag = -1; }
  ec.addEventListener('pointerup', endDrag);
  ec.addEventListener('pointercancel', endDrag);

  document.querySelectorAll('#view-edit [data-mode]').forEach(function (b) {
    b.onclick = function () { ed.mode = b.dataset.mode; markModes(); if (ed.preview) togglePreview(true); };
  });
  $('ed-rot-l').onclick = function () { ed.rot = (ed.rot + 270) % 360; if (ed.preview) togglePreview(true); };
  $('ed-rot-r').onclick = function () { ed.rot = (ed.rot + 90) % 360; if (ed.preview) togglePreview(true); };
  $('ed-full').onclick = function () { ed.corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; leavePreview(); drawEditor(); };
  $('ed-detect').onclick = async function () {
    leavePreview();
    await cvReady;
    var d = Core.detectCanvas(ed.img);
    if (d) { ed.corners = d.corners; drawEditor(); toast('Dokument neu erkannt', 1500); }
    else toast('Kein Dokument gefunden – Ecken bitte von Hand ziehen.', 3000);
  };
  function leavePreview() { ed.preview = null; $('ed-preview').textContent = 'Vorschau'; }
  async function togglePreview(force) {
    if (ed.preview && !force) { leavePreview(); drawEditor(); return; }
    $('ed-preview').textContent = 'Bearbeiten';
    var tmp = { src: ed.page.src, corners: ed.corners, mode: ed.mode, rot: ed.rot };
    try {
      var r = await enqueue(function () { return renderPage(tmp, 1300); });
      ed.preview = r.canvas;
      drawEditor();
    } catch (e) { toast('Vorschau fehlgeschlagen: ' + e.message, 4000); leavePreview(); }
  }
  $('ed-preview').onclick = function () { togglePreview(false); };
  $('ed-cancel').onclick = function () { ed.img = null; ed.preview = null; show('pages'); };
  $('ed-delete').onclick = function () {
    var i = pages.indexOf(ed.page);
    if (i >= 0) pages.splice(i, 1);
    updateCount(); ed.img = null; ed.preview = null; show('pages');
  };
  $('ed-ok').onclick = function () {
    var p = ed.page;
    p.corners = ed.corners; p.mode = ed.mode; p.rot = ed.rot; p.busy = true; p.error = null;
    ed.img = null; ed.preview = null;
    show('pages');
    enqueue(function () { return finishPage(p); })
      .catch(function (e) { p.busy = false; p.error = e.message; toast('Fehler: ' + e.message, 4000); })
      .then(renderPages);
  };

  // ------------------------------------------------------------ PDF
  function defaultName() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return 'Scan ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes());
  }

  async function buildPdfBytes(title) {
    await chain;
    var list = [];
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (!p.result) throw new Error('Seite ' + (i + 1) + ' ist nicht fertig verarbeitet');
      list.push({ jpeg: new Uint8Array(await p.result.blob.arrayBuffer()), w: p.result.w, h: p.result.h });
    }
    return Core.buildPdf(list, { title: title });
  }

  function pdfName() {
    var n = Core.safeFileName($('pdf-name').value || defaultName());
    return n.replace(/\.pdf$/i, '');
  }

  async function sharePdf() {
    var btn = $('btn-share'); btn.disabled = true;
    try {
      var name = pdfName();
      var bytes = await buildPdfBytes(name);
      var file = new File([bytes], name + '.pdf', { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
      var url = URL.createObjectURL(file);
      var a = document.createElement('a');
      a.href = url; a.download = name + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      toast('PDF gespeichert (' + Math.round(bytes.length / 1024) + ' KB)', 3000);
    } catch (e) { toast('Fehler: ' + e.message, 5000); }
    finally { renderPages(); }
  }

  // ------------------------------------------------------------ Dropbox
  async function accessToken(force) {
    var t = lsGet('scan.dbx');
    if (!t || !t.refresh) throw new Error('Dropbox ist nicht verbunden (⚙︎ Einstellungen).');
    if (!force && t.access && t.exp > Date.now() + 60000) return t.access;
    var r = await Core.refreshAccess({ appKey: t.appKey, refreshToken: t.refresh });
    t.access = r.access_token; t.exp = Date.now() + (r.expires_in || 14400) * 1000;
    lsSet('scan.dbx', t);
    return t.access;
  }

  async function uploadToDropbox() {
    var btn = $('btn-upload');
    var t = lsGet('scan.dbx');
    if (!t || !t.refresh) {
      toast('Dropbox ist noch nicht verbunden. Bitte zuerst unter ⚙︎ verbinden.', 4000);
      openSettings();
      return;
    }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Lade hoch …';
    try {
      var name = pdfName();
      var bytes = await buildPdfBytes(name);
      var path = Core.dropboxPath(S.folder, name + '.pdf');
      var tok = await accessToken(false), res;
      try { res = await Core.uploadFile(tok, path, bytes); }
      catch (e) {
        if (e.status === 401) { tok = await accessToken(true); res = await Core.uploadFile(tok, path, bytes); }
        else throw e;
      }
      toast('Hochgeladen: ' + (res.path_display || path) + ' (' + Math.round(bytes.length / 1024) + ' KB)', 6000);
      window.__lastUpload = res;
    } catch (e) {
      toast('Upload fehlgeschlagen: ' + (e.message || e), 7000);
    } finally { btn.textContent = old; renderPages(); }
  }

  function redirectUri() { return location.origin + location.pathname; }

  async function connectDropbox() {
    S.appKey = $('s-key').value.trim();
    S.folder = $('s-folder').value.trim();
    saveSettings();
    if (!S.appKey) { toast('Bitte zuerst den App-Key eintragen.', 3000); return; }
    var pk = await Core.makePkce(), state = Core.randomState();
    lsSet('scan.pkce', { verifier: pk.verifier, state: state, appKey: S.appKey, redirectUri: redirectUri(), t: Date.now() });
    location.href = Core.buildAuthUrl({ appKey: S.appKey, redirectUri: redirectUri(), challenge: pk.challenge, state: state });
  }

  async function handleRedirect() {
    var qs = new URLSearchParams(location.search);
    if (!qs.has('code') && !qs.has('error')) return;
    var pk = lsGet('scan.pkce');
    history.replaceState(null, '', location.pathname);
    lsDel('scan.pkce');
    if (qs.has('error')) { toast('Dropbox: ' + (qs.get('error_description') || qs.get('error')), 6000); return; }
    if (!pk || pk.state !== qs.get('state')) { toast('Dropbox-Anmeldung ungültig (State). Bitte erneut verbinden.', 6000); return; }
    try {
      var r = await Core.exchangeCode({ appKey: pk.appKey, code: qs.get('code'), verifier: pk.verifier, redirectUri: pk.redirectUri });
      lsSet('scan.dbx', { appKey: pk.appKey, refresh: r.refresh_token, access: r.access_token, exp: Date.now() + (r.expires_in || 14400) * 1000 });
      toast('Dropbox verbunden', 3000);
      openSettings();
    } catch (e) { toast(e.message, 7000); }
  }

  // ------------------------------------------------------------ Einstellungen
  function openSettings() {
    $('s-key').value = S.appKey || '';
    $('s-folder').value = S.folder || '';
    $('s-quality').value = S.quality;
    $('s-snap').checked = !!S.snap;
    $('s-redirect').textContent = redirectUri();
    refreshSettingsState();
    var d = $('dlg');
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }
  function refreshSettingsState() {
    var t = lsGet('scan.dbx');
    $('s-state').textContent = t && t.refresh ? '✔ Verbunden. PDFs werden direkt in Dropbox abgelegt.' : 'Nicht verbunden.';
    $('s-disconnect').hidden = !(t && t.refresh);
  }
  function closeSettings() {
    S.appKey = $('s-key').value.trim();
    S.folder = $('s-folder').value.trim();
    S.quality = $('s-quality').value;
    S.snap = $('s-snap').checked;
    saveSettings();
    var d = $('dlg');
    if (d.close) d.close(); else d.removeAttribute('open');
    renderPages();
  }
  $('s-close').onclick = closeSettings;
  $('dlg').addEventListener('cancel', function () { setTimeout(closeSettings, 0); });
  $('s-connect').onclick = connectDropbox;
  $('s-disconnect').onclick = function () { lsDel('scan.dbx'); refreshSettingsState(); renderPages(); toast('Dropbox getrennt', 2000); };
  $('btn-settings').onclick = openSettings;

  // ------------------------------------------------------------ Verdrahtung
  $('shutter').onclick = capture;
  $('btn-done').onclick = function () { show('pages'); };
  $('btn-back-cam').onclick = function () { show('cam'); };
  $('btn-clear').onclick = function () {
    if (!pages.length) return;
    if (!window.confirm('Alle ' + pages.length + ' Seiten verwerfen?')) return;
    pages = []; updateCount(); renderPages();
  };
  $('btn-share').onclick = sharePdf;
  $('btn-upload').onclick = uploadToDropbox;
  $('btn-cam-start').onclick = function () { stopCam(); startCam(); };
  $('btn-native-alt').onclick = function () { $('file-native').click(); };
  $('btn-import').onclick = function () { $('file-import').click(); };
  $('btn-native').onclick = function () { $('file-native').click(); };
  function onFiles(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = '';
    if (!files.length) return;
    files.forEach(function (f) { addImage(f); });
    toast(files.length + (files.length === 1 ? ' Bild wird verarbeitet …' : ' Bilder werden verarbeitet …'), 1800);
  }
  $('file-import').onchange = onFiles;
  $('file-native').onchange = onFiles;
  $('mode').value = S.mode;
  $('mode').onchange = function () { S.mode = $('mode').value; saveSettings(); };
  function syncAuto() { $('btn-auto').classList.toggle('on', !!S.auto); $('btn-auto').setAttribute('aria-pressed', S.auto ? 'true' : 'false'); }
  $('btn-auto').onclick = function () { S.auto = !S.auto; armed = true; syncAuto(); saveSettings(); toast(S.auto ? 'Automatisch: Foto, sobald das Blatt ruhig liegt' : 'Automatik aus', 2200); };
  syncAuto();
  $('btn-torch').onclick = async function () {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('btn-torch').classList.toggle('on', torchOn); }
    catch (e) { torchOn = false; toast('Licht nicht verfügbar', 2000); }
  };
  $('pdf-name').value = defaultName();
  window.addEventListener('resize', function () { if (current === 'edit') drawEditor(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (current === 'cam') stopCam(); }
    else if (current === 'cam') startCam();
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ }); });
  }

  // Testzugang (ohne Wirkung für die normale Nutzung)
  window.__scan = { pages: function () { return pages; }, addImage: addImage, settings: S, enqueue: enqueue, buildPdfBytes: buildPdfBytes, show: show, cvReady: cvReady };

  handleRedirect().then(function () { if (current === 'cam') startCam(); });
})();
