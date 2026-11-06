'use strict';
(function () {
  /* ============================================================
     1. Network lockdown — this app must never talk to a network.
     Every primitive is replaced by a stub that counts the attempt.
     ============================================================ */
  var netAttempts = 0;

  function deny(what) {
    netAttempts += 1;
    var badge = document.getElementById('netCount');
    if (badge) badge.textContent = String(netAttempts);
    return new Error(what + ' is disabled: Redact Local never uses the network.');
  }

  (function lockdown() {
    function lock(name, value) {
      try { Object.defineProperty(window, name, { configurable: true, writable: true, value: value }); } catch (e) { /* ignore */ }
    }
    function Boom(name) {
      return function () { throw deny(name); };
    }
    lock('fetch', function () { return Promise.reject(deny('fetch()')); });
    lock('WebSocket', Boom('WebSocket'));
    lock('EventSource', Boom('EventSource'));
    lock('RTCPeerConnection', Boom('RTCPeerConnection'));
    lock('webkitRTCPeerConnection', Boom('webkitRTCPeerConnection'));
    lock('RTCDataChannel', Boom('RTCDataChannel'));
    lock('Worker', Boom('Worker'));
    try {
      XMLHttpRequest.prototype.open = function () { throw deny('XMLHttpRequest'); };
      XMLHttpRequest.prototype.send = function () { throw deny('XMLHttpRequest'); };
    } catch (e) { /* ignore */ }
    try {
      navigator.sendBeacon = function () { deny('sendBeacon'); return false; };
    } catch (e) { /* ignore */ }
  })();

  /* ============================================================
     2. Constants & state
     ============================================================ */
  var MAX_BYTES = 160 * 1024 * 1024;
  var MAX_VIEW_EDGE = 4096;
  var MIN_REGION = 6;
  var HISTORY_LIMIT = 60;

  var dom = {};
  var ids = [
    'fileInput', 'empty', 'dropcard', 'btnBrowse', 'stage', 'view', 'hud', 'hudText',
    'zoombar', 'zoomLevel', 'btnZoomIn', 'btnZoomOut', 'btnZoomFit', 'btnCompare',
    'btnOpen', 'btnDownloadTop', 'btnDownload', 'btnCopy', 'btnNew', 'btnDelete', 'btnClear',
    'btnUndo', 'btnRedo', 'btnPrivacy', 'btnPrivClose', 'privacyDialog',
    'toolSelect', 'toolBlur', 'toolPixelate', 'toolSolid',
    'strength', 'strengthLabel', 'strengthVal', 'strengthNote',
    'regionList', 'regionCount', 'listEmpty', 'format', 'maxdim', 'quality', 'qualityField',
    'qualityVal', 'exportNote', 'toasts', 'fileInfo', 'fileName', 'fileDims', 'fileSize',
    'netCount', 'hostedNote'
  ];
  ids.forEach(function (id) { dom[id] = document.getElementById(id); });

  var S = {
    bitmap: null,
    w: 0,
    h: 0,
    name: 'image',
    bytes: 0,
    regions: [],
    sel: null,
    seq: 1,
    tool: 'blur',
    strengths: { blur: 24, pixelate: 16 },
    draft: null,
    past: [],
    future: [],
    view: { scale: 1, tx: 0, ty: 0 },
    viewScale: 1,
    compare: false,
    spaceDown: false,
    userZoom: false
  };

  var canvas = dom.view;
  var ctx = canvas.getContext('2d');
  var scene = document.createElement('canvas');
  var sctx = scene.getContext('2d');
  var rafPending = false;
  var drag = null;
  var strengthDirty = false;

  /* ============================================================
     3. Small helpers
     ============================================================ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function icon(name, size) {
    return '<svg width="' + (size || 14) + '" height="' + (size || 14) + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    var ic = kind === 'err' ? 'warn' : (kind === 'warn' ? 'warn' : 'check');
    el.innerHTML = icon(ic) + '<span></span>';
    el.lastChild.textContent = message;
    dom.toasts.appendChild(el);
    window.setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      window.setTimeout(function () { el.remove(); }, 260);
    }, 4200);
  }

  /* ============================================================
     4. Rendering — one code path for preview and export
     ============================================================ */
  function paintRegion(target, r) {
    var x0 = Math.max(0, Math.floor(r.x));
    var y0 = Math.max(0, Math.floor(r.y));
    var x1 = Math.min(S.w, Math.ceil(r.x + r.w));
    var y1 = Math.min(S.h, Math.ceil(r.y + r.h));
    var w = x1 - x0;
    var h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    if (r.mode === 'solid') {
      target.fillStyle = '#000000';
      target.fillRect(x0, y0, w, h);
      return;
    }

    target.save();
    target.beginPath();
    target.rect(x0, y0, w, h);
    target.clip();

    if (r.mode === 'blur') {
      var radius = Math.max(1, r.strength);
      var pad = Math.ceil(radius * 3);
      var sx = Math.max(0, x0 - pad);
      var sy = Math.max(0, y0 - pad);
      var ex = Math.min(S.w, x1 + pad);
      var ey = Math.min(S.h, y1 + pad);
      target.filter = 'blur(' + radius + 'px)';
      target.drawImage(S.bitmap, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
      target.filter = 'none';
    } else {
      var block = Math.max(4, Math.round(r.strength));
      var tw = Math.max(1, Math.ceil(w / block));
      var th = Math.max(1, Math.ceil(h / block));
      var tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      var tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(S.bitmap, x0, y0, w, h, 0, 0, tw, th);
      target.imageSmoothingEnabled = false;
      target.drawImage(tmp, 0, 0, tw, th, x0, y0, tw * block, th * block);
      target.imageSmoothingEnabled = true;
    }
    target.restore();
  }

  function renderSceneTo(target, opts) {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, S.w, S.h);
    if (!S.bitmap) return;
    target.drawImage(S.bitmap, 0, 0);
    if (opts.raw) return;
    for (var i = 0; i < S.regions.length; i++) paintRegion(target, S.regions[i]);
    if (opts.draft && S.draft) paintRegion(target, S.draft);
  }

  function handlePoints(r) {
    var cx = r.x + r.w / 2;
    var cy = r.y + r.h / 2;
    return [
      ['nw', r.x, r.y], ['n', cx, r.y], ['ne', r.x + r.w, r.y],
      ['e', r.x + r.w, cy], ['se', r.x + r.w, r.y + r.h],
      ['s', cx, r.y + r.h], ['sw', r.x, r.y + r.h], ['w', r.x, cy]
    ];
  }

  function drawOverlay() {
    var vs = S.viewScale || 1;
    var zoom = S.view.scale || 1;
    var u = 1 / (vs * zoom); /* one device pixel expressed in image units */

    ctx.save();
    ctx.scale(vs, vs);

    for (var i = 0; i < S.regions.length; i++) {
      var r = S.regions[i];
      if (r.id === S.sel) continue;
      ctx.setLineDash([6 * u, 6 * u]);
      ctx.lineWidth = 1 * u;
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    for (var j = 0; j < S.regions.length; j++) {
      var sel = S.regions[j];
      if (sel.id !== S.sel) continue;
      ctx.setLineDash([]);
      ctx.lineWidth = 1.6 * u;
      ctx.strokeStyle = '#7aa2ff';
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);

      var hs = 4.5 * u;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#3f6fd8';
      ctx.lineWidth = 1.2 * u;
      var pts = handlePoints(sel);
      for (var k = 0; k < pts.length; k++) {
        ctx.beginPath();
        ctx.rect(pts[k][1] - hs, pts[k][2] - hs, hs * 2, hs * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (S.draft) {
      ctx.setLineDash([5 * u, 4 * u]);
      ctx.lineWidth = 1.6 * u;
      ctx.strokeStyle = '#ffb454';
      ctx.strokeRect(S.draft.x, S.draft.y, S.draft.w, S.draft.h);
    }

    ctx.restore();
  }

  function render() {
    if (!S.bitmap) return;
    renderSceneTo(sctx, { raw: S.compare, draft: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scene, 0, 0, canvas.width, canvas.height);
    drawOverlay();
  }

  /* rAF is paused in background tabs, so render synchronously there */
  function scheduleRender() {
    if (rafPending) return;
    if (document.visibilityState === 'hidden') { render(); return; }
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
    });
  }

  /* ============================================================
     5. View transform
     ============================================================ */
  function applyView() {
    canvas.style.transform = 'translate(' + S.view.tx + 'px, ' + S.view.ty + 'px) scale(' + S.view.scale + ')';
    dom.zoomLevel.textContent = Math.round(S.view.scale * 100) + '%';
  }

  function stageSize() {
    var r = dom.stage.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function fitView() {
    if (!S.bitmap) return;
    var st = stageSize();
    if (st.w < 10 || st.h < 10) return;
    var pad = 40;
    var scale = Math.min((st.w - pad * 2) / S.w, (st.h - pad * 2) / S.h);
    scale = Math.max(scale, 0.01);
    S.view.scale = scale;
    S.view.tx = (st.w - S.w * scale) / 2;
    S.view.ty = (st.h - S.h * scale) / 2;
    S.userZoom = false;
    applyView();
  }

  function zoomAt(newScale, clientX, clientY) {
    var st = dom.stage.getBoundingClientRect();
    var next = clamp(newScale, 0.05, 12);
    var ax = clientX - st.left;
    var ay = clientY - st.top;
    var ox = (ax - S.view.tx) / S.view.scale;
    var oy = (ay - S.view.ty) / S.view.scale;
    S.view.scale = next;
    S.view.tx = ax - ox * next;
    S.view.ty = ay - oy * next;
    S.userZoom = true;
    applyView();
    scheduleRender();
  }

  /* ============================================================
     6. Image loading
     ============================================================ */
  function setImage(bitmap, name, bytes) {
    if (S.bitmap && S.bitmap.close) {
      try { S.bitmap.close(); } catch (e) { /* ignore */ }
    }
    S.bitmap = bitmap;
    S.w = bitmap.width;
    S.h = bitmap.height;
    S.name = name || 'image';
    S.bytes = bytes || 0;
    S.regions = [];
    S.sel = null;
    S.draft = null;
    S.past = [];
    S.future = [];
    S.compare = false;
    S.viewScale = Math.min(1, MAX_VIEW_EDGE / Math.max(S.w, S.h));

    canvas.width = Math.max(1, Math.round(S.w * S.viewScale));
    canvas.height = Math.max(1, Math.round(S.h * S.viewScale));
    scene.width = S.w;
    scene.height = S.h;

    dom.empty.hidden = true;
    dom.stage.hidden = false;
    dom.hud.hidden = false;
    dom.zoombar.hidden = false;
    dom.fileInfo.hidden = false;
    dom.fileName.textContent = S.name;
    dom.fileName.title = S.name;
    dom.fileDims.textContent = S.w + ' \u00d7 ' + S.h;
    dom.fileSize.textContent = fmtBytes(S.bytes);

    fitView();
    render();
    updateUI();
  }

  function decodeFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast('That image is larger than 160 MB. Resize it first.', 'err');
      return;
    }
    var name = file.name || 'pasted-image';
    var done = function (bmp) {
      if (!bmp || !bmp.width || !bmp.height) {
        toast('That file could not be decoded as an image.', 'err');
        return;
      }
      setImage(bmp, name, file.size);
      setTool('blur');
      toast('Loaded ' + bmp.width + ' \u00d7 ' + bmp.height + ' — nothing was uploaded.', 'ok');
    };
    var fail = function () { toast('That file could not be decoded as an image.', 'err'); };

    if (window.createImageBitmap && /^image\//.test(file.type || '')) {
      createImageBitmap(file, { imageOrientation: 'from-image' }).then(done, function () {
        createImageBitmap(file).then(done, fail);
      });
    } else if (window.createImageBitmap) {
      createImageBitmap(file).then(done, fail);
    } else {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        done(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        fail();
      };
      img.src = url;
    }
  }

  /* ============================================================
     7. History
     ============================================================ */
  function snapshot() {
    S.past.push(JSON.stringify(S.regions));
    if (S.past.length > HISTORY_LIMIT) S.past.shift();
    S.future.length = 0;
  }

  function restore(list) {
    S.regions = JSON.parse(list);
    if (!S.regions.some(function (r) { return r.id === S.sel; })) S.sel = null;
    sceneChanged();
  }

  function undo() {
    if (!S.past.length) return;
    S.future.push(JSON.stringify(S.regions));
    restore(S.past.pop());
  }

  function redo() {
    if (!S.future.length) return;
    S.past.push(JSON.stringify(S.regions));
    restore(S.future.pop());
  }

  function sceneChanged() {
    updateUI();
    scheduleRender();
  }

  /* ============================================================
     8. Regions
     ============================================================ */
  function currentStrength() {
    if (S.tool === 'blur') return S.strengths.blur;
    if (S.tool === 'pixelate') return S.strengths.pixelate;
    return 0;
  }

  function addRegion(rect) {
    var r = {
      id: S.seq++,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      mode: S.tool === 'select' ? 'blur' : S.tool,
      strength: currentStrength()
    };
    S.regions.push(r);
    S.sel = r.id;
    return r;
  }

  function selectedRegion() {
    for (var i = 0; i < S.regions.length; i++) {
      if (S.regions[i].id === S.sel) return S.regions[i];
    }
    return null;
  }

  function removeSelected() {
    if (S.sel == null) return;
    snapshot();
    S.regions = S.regions.filter(function (r) { return r.id !== S.sel; });
    S.sel = null;
    sceneChanged();
  }

  function clearAll() {
    if (!S.regions.length) return;
    snapshot();
    S.regions = [];
    S.sel = null;
    sceneChanged();
  }

  /* ============================================================
     9. Pointer interaction
     ============================================================ */
  function toImage(ev) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * (S.w / r.width),
      y: (ev.clientY - r.top) * (S.h / r.height)
    };
  }

  function pxTolerance() {
    var r = canvas.getBoundingClientRect();
    return 11 * (S.w / Math.max(1, r.width));
  }

  function hitHandle(region, p, tol) {
    var pts = handlePoints(region);
    for (var i = 0; i < pts.length; i++) {
      if (Math.abs(p.x - pts[i][1]) <= tol && Math.abs(p.y - pts[i][2]) <= tol) return pts[i][0];
    }
    if (p.x >= region.x - tol && p.x <= region.x + region.w + tol &&
        p.y >= region.y - tol && p.y <= region.y + region.h + tol) return 'move';
    return null;
  }

  function regionAt(p) {
    for (var i = S.regions.length - 1; i >= 0; i--) {
      var r = S.regions[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
    }
    return null;
  }

  function setCursor(mode) {
    dom.stage.dataset.cursor = mode;
  }

  function onPointerDown(ev) {
    if (!S.bitmap) return;
    if (ev.button !== undefined && ev.button !== 0 && ev.button !== 1) return;

    if (S.spaceDown || ev.button === 1) {
      drag = { kind: 'pan', cx: ev.clientX, cy: ev.clientY, tx: S.view.tx, ty: S.view.ty };
      setCursor('grabbing');
      ev.preventDefault();
      return;
    }

    var p = toImage(ev);

    if (S.tool === 'select') {
      var sel = selectedRegion();
      if (sel) {
        var h = hitHandle(sel, p, pxTolerance());
        if (h === 'move') {
          snapshot();
          drag = { kind: 'move', id: sel.id, start: { x: sel.x, y: sel.y }, p0: p };
          setCursor('move');
          return;
        }
        if (h) {
          snapshot();
          drag = { kind: 'resize', id: sel.id, handle: h, start: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } };
          return;
        }
      }
      var hit = regionAt(p);
      if (hit) {
        S.sel = hit.id;
        snapshot();
        drag = { kind: 'move', id: hit.id, start: { x: hit.x, y: hit.y }, p0: p };
        setCursor('move');
        sceneChanged();
        return;
      }
      S.sel = null;
      sceneChanged();
      return;
    }

    drag = {
      kind: 'new',
      anchor: { x: clamp(p.x, 0, S.w), y: clamp(p.y, 0, S.h) },
      mode: S.tool,
      strength: currentStrength()
    };
    S.draft = { x: drag.anchor.x, y: drag.anchor.y, w: 0, h: 0, mode: drag.mode, strength: drag.strength };
    ev.preventDefault();
    scheduleRender();
  }

  function onPointerMove(ev) {
    if (!S.bitmap) return;
    if (!drag) {
      if (S.tool === 'select') setCursor('move');
      else setCursor('crosshair');
      return;
    }

    if (drag.kind === 'pan') {
      S.view.tx = drag.tx + (ev.clientX - drag.cx);
      S.view.ty = drag.ty + (ev.clientY - drag.cy);
      applyView();
      return;
    }

    var p = toImage(ev);
    p.x = clamp(p.x, 0, S.w);
    p.y = clamp(p.y, 0, S.h);

    if (drag.kind === 'new' && S.draft) {
      S.draft.x = Math.min(drag.anchor.x, p.x);
      S.draft.y = Math.min(drag.anchor.y, p.y);
      S.draft.w = Math.abs(p.x - drag.anchor.x);
      S.draft.h = Math.abs(p.y - drag.anchor.y);
      scheduleRender();
      return;
    }

    var region = null;
    for (var i = 0; i < S.regions.length; i++) {
      if (S.regions[i].id === drag.id) region = S.regions[i];
    }
    if (!region) return;

    if (drag.kind === 'move') {
      var nx = drag.start.x + (p.x - drag.p0.x);
      var ny = drag.start.y + (p.y - drag.p0.y);
      region.x = clamp(nx, 0, Math.max(0, S.w - region.w));
      region.y = clamp(ny, 0, Math.max(0, S.h - region.h));
    } else if (drag.kind === 'resize') {
      var s = drag.start;
      var left = s.x;
      var top = s.y;
      var right = s.x + s.w;
      var bottom = s.y + s.h;
      var hnd = drag.handle;
      if (hnd.indexOf('w') !== -1) left = Math.min(p.x, right - MIN_REGION);
      if (hnd.indexOf('e') !== -1) right = Math.max(p.x, left + MIN_REGION);
      if (hnd.indexOf('n') !== -1) top = Math.min(p.y, bottom - MIN_REGION);
      if (hnd.indexOf('s') !== -1) bottom = Math.max(p.y, top + MIN_REGION);
      region.x = clamp(left, 0, S.w - MIN_REGION);
      region.y = clamp(top, 0, S.h - MIN_REGION);
      region.w = clamp(right, region.x + MIN_REGION, S.w) - region.x;
      region.h = clamp(bottom, region.y + MIN_REGION, S.h) - region.y;
    }
    scheduleRender();
  }

  function onPointerUp() {
    if (!drag) return;
    var kind = drag.kind;
    drag = null;

    if (kind === 'pan') {
      setCursor(S.tool === 'select' ? 'move' : 'crosshair');
      return;
    }

    if (kind === 'new') {
      var d = S.draft;
      S.draft = null;
      if (d && d.w >= MIN_REGION && d.h >= MIN_REGION) {
        snapshot();
        addRegion(d);
        toastRegion();
      }
      sceneChanged();
      return;
    }

    sceneChanged();
  }

  function toastRegion() {
    var r = selectedRegion();
    if (!r) return;
    var label = r.mode === 'blur' ? 'blur' : (r.mode === 'pixelate' ? 'pixelate' : 'solid');
    dom.hudText.textContent = 'Added ' + label + ' region — adjust or add more';
  }

  /* ============================================================
     10. UI sync
     ============================================================ */
  function setTool(tool) {
    S.tool = tool;
    var map = { select: dom.toolSelect, blur: dom.toolBlur, pixelate: dom.toolPixelate, solid: dom.toolSolid };
    Object.keys(map).forEach(function (k) {
      map[k].setAttribute('aria-pressed', String(k === tool));
    });
    var labels = { select: 'Drag a region to move, handles to resize', blur: 'Drag on the image to blur', pixelate: 'Drag to pixelate', solid: 'Drag to black out' };
    dom.hudText.textContent = labels[tool];
    if (tool !== 'select') S.sel = null;
    updateStrengthUI();
    updateUI();
    scheduleRender();
    setCursor(tool === 'select' ? 'move' : 'crosshair');
  }

  function updateStrengthUI() {
    var sel = selectedRegion();
    var mode = S.tool;
    var value = null;
    var editing = false;

    if (mode === 'select' && sel && sel.mode !== 'solid') {
      mode = sel.mode;
      value = sel.strength;
      editing = true;
    } else if (mode === 'blur') {
      value = S.strengths.blur;
    } else if (mode === 'pixelate') {
      value = S.strengths.pixelate;
    }

    if (value == null) {
      dom.strength.disabled = true;
      dom.strengthLabel.textContent = mode === 'solid' ? 'Solid fill' : 'Strength';
      dom.strengthVal.textContent = mode === 'solid' ? 'opaque' : '\u2014';
      dom.strengthNote.hidden = true;
      return;
    }

    dom.strength.disabled = !S.bitmap;
    if (mode === 'blur') {
      dom.strength.min = '4';
      dom.strength.max = '80';
      dom.strengthLabel.textContent = editing ? 'Selected blur radius' : 'Blur radius';
    } else {
      dom.strength.min = '6';
      dom.strength.max = '60';
      dom.strengthLabel.textContent = editing ? 'Selected block size' : 'Block size';
    }
    dom.strength.value = String(value);
    dom.strengthVal.textContent = value + ' px';
    dom.strengthNote.hidden = !(mode === 'blur' && value < 12);
  }

  function updateUI() {
    var has = !!S.bitmap;
    var hasRegions = S.regions.length > 0;

    [dom.toolSelect, dom.toolBlur, dom.toolPixelate, dom.toolSolid].forEach(function (b) {
      b.disabled = !has;
    });
    dom.btnUndo.disabled = !S.past.length;
    dom.btnRedo.disabled = !S.future.length;
    dom.btnDownload.disabled = !has;
    dom.btnDownloadTop.disabled = !has;
    dom.btnCopy.disabled = !has;
    dom.btnNew.disabled = !has;
    dom.btnDelete.disabled = S.sel == null;
    dom.btnClear.disabled = !hasRegions;
    dom.regionCount.textContent = String(S.regions.length);
    dom.listEmpty.hidden = hasRegions;
    updateStrengthUI();
    renderRegionList();
  }

  function renderRegionList() {
    var frag = document.createDocumentFragment();
    S.regions.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'item';
      li.setAttribute('aria-selected', String(r.id === S.sel));
      li.tabIndex = 0;

      var sw = document.createElement('span');
      sw.className = 'swatch ' + r.mode;

      var label = document.createElement('span');
      label.textContent = r.mode.charAt(0).toUpperCase() + r.mode.slice(1);

      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = r.mode === 'solid'
        ? Math.round(r.w) + '\u00d7' + Math.round(r.h)
        : r.strength + 'px';

      var del = document.createElement('button');
      del.className = 'x';
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete redaction ' + (i + 1));
      del.innerHTML = icon('x', 13);

      li.appendChild(sw);
      li.appendChild(label);
      li.appendChild(meta);
      li.appendChild(del);

      li.addEventListener('click', function (ev) {
        if (ev.target === del) return;
        S.sel = r.id;
        setTool('select');
        sceneChanged();
      });
      li.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          S.sel = r.id;
          setTool('select');
          sceneChanged();
        }
      });
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        S.sel = r.id;
        removeSelected();
      });

      frag.appendChild(li);
    });
    dom.regionList.textContent = '';
    dom.regionList.appendChild(frag);
  }

  /* ============================================================
     11. Export
     ============================================================ */
  function buildExportCanvas() {
    var maxDim = parseInt(dom.maxdim.value, 10) || 0;
    var scale = maxDim ? Math.min(1, maxDim / Math.max(S.w, S.h)) : 1;
    var ow = Math.max(1, Math.round(S.w * scale));
    var oh = Math.max(1, Math.round(S.h * scale));

    var full = document.createElement('canvas');
    full.width = S.w;
    full.height = S.h;
    renderSceneTo(full.getContext('2d'), { raw: false, draft: false });

    if (ow === S.w && oh === S.h) return full;

    var out = document.createElement('canvas');
    out.width = ow;
    out.height = oh;
    var octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(full, 0, 0, ow, oh);
    return out;
  }

  function exportBlob(typeOverride) {
    var type = typeOverride || dom.format.value;
    var quality = parseInt(dom.quality.value, 10) / 100;
    var src = buildExportCanvas();

    var target = src;
    if (type === 'image/jpeg') {
      target = document.createElement('canvas');
      target.width = src.width;
      target.height = src.height;
      var tctx = target.getContext('2d');
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, target.width, target.height);
      tctx.drawImage(src, 0, 0);
    }

    return new Promise(function (resolve, reject) {
      target.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Encoding failed'));
      }, type, quality);
    });
  }

  function outputName(blob) {
    var base = S.name.replace(/\.[^.]+$/, '') || 'image';
    base = base.replace(/[^\w\-]+/g, '_').slice(0, 60) || 'image';
    var ext = blob.type === 'image/jpeg' ? 'jpg' : (blob.type === 'image/webp' ? 'webp' : 'png');
    return base + '-redacted.' + ext;
  }

  function guardNoRegions() {
    if (S.regions.length) return true;
    return window.confirm('No redactions have been drawn.\n\nThe export will still be re-encoded (metadata removed) but the pixels are unchanged.\n\nDownload anyway?');
  }

  function download() {
    if (!S.bitmap) return;
    if (!guardNoRegions()) return;
    exportBlob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = outputName(blob);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('Saved ' + outputName(blob) + ' (' + fmtBytes(blob.size) + ') — metadata stripped.', 'ok');
    }).catch(function () {
      toast('Export failed. Try a smaller maximum size or a different format.', 'err');
    });
  }

  function copyToClipboard() {
    if (!S.bitmap) return;
    if (!window.isSecureContext && location.protocol !== 'file:') {
      toast('Clipboard is unavailable in this context — use Download.', 'err');
      return;
    }
    exportBlob('image/png').then(function (blob) {
      if (blob.type !== 'image/png') throw new Error('PNG encoding failed');
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }).then(function () {
      toast('Redacted image copied to the clipboard as PNG.', 'ok');
    }).catch(function () {
      toast('Could not write to the clipboard — use Download instead.', 'err');
    });
  }

  /* ============================================================
     12. Wire up
     ============================================================ */
  function openPicker() { dom.fileInput.value = ''; dom.fileInput.click(); }

  dom.btnOpen.addEventListener('click', openPicker);
  dom.btnBrowse.addEventListener('click', function (ev) { ev.stopPropagation(); openPicker(); });
  dom.btnNew.addEventListener('click', openPicker);
  dom.dropcard.addEventListener('click', openPicker);
  dom.dropcard.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPicker(); }
  });
  dom.fileInput.addEventListener('change', function (ev) {
    if (ev.target.files && ev.target.files[0]) decodeFile(ev.target.files[0]);
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    window.addEventListener(name, function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      dom.dropcard.classList.add('hot');
    });
  });
  ['dragleave', 'dragend'].forEach(function (name) {
    window.addEventListener(name, function () { dom.dropcard.classList.remove('hot'); });
  });
  window.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dom.dropcard.classList.remove('hot');
    var dt = ev.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) { decodeFile(dt.files[0]); return; }
    toast('Drop an image file (not a link).', 'warn');
  });
  window.addEventListener('paste', function (ev) {
    var items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { decodeFile(f); ev.preventDefault(); return; }
      }
    }
  });

  dom.toolSelect.addEventListener('click', function () { setTool('select'); });
  dom.toolBlur.addEventListener('click', function () { setTool('blur'); });
  dom.toolPixelate.addEventListener('click', function () { setTool('pixelate'); });
  dom.toolSolid.addEventListener('click', function () { setTool('solid'); });

  dom.strength.addEventListener('input', function (ev) {
    var v = parseInt(ev.target.value, 10);
    var sel = selectedRegion();

    if (S.tool === 'select' && sel && sel.mode !== 'solid') {
      if (!strengthDirty) { snapshot(); strengthDirty = true; }
      sel.strength = v;
      updateUI();
      scheduleRender();
      return;
    }

    if (S.tool === 'blur') S.strengths.blur = v;
    if (S.tool === 'pixelate') S.strengths.pixelate = v;
    if (sel && sel.mode === S.tool) sel.strength = v;
    updateUI();
    scheduleRender();
  });

  dom.strength.addEventListener('change', function () { strengthDirty = false; });

  dom.btnUndo.addEventListener('click', undo);
  dom.btnRedo.addEventListener('click', redo);
  dom.btnDelete.addEventListener('click', removeSelected);
  dom.btnClear.addEventListener('click', clearAll);
  dom.btnDownload.addEventListener('click', download);
  dom.btnDownloadTop.addEventListener('click', download);
  dom.btnCopy.addEventListener('click', copyToClipboard);

  dom.btnZoomIn.addEventListener('click', function () {
    var st = dom.stage.getBoundingClientRect();
    zoomAt(S.view.scale * 1.25, st.left + st.width / 2, st.top + st.height / 2);
  });
  dom.btnZoomOut.addEventListener('click', function () {
    var st = dom.stage.getBoundingClientRect();
    zoomAt(S.view.scale / 1.25, st.left + st.width / 2, st.top + st.height / 2);
  });
  dom.btnZoomFit.addEventListener('click', function () { fitView(); scheduleRender(); });

  var compareOn = function (ev) {
    if (ev) ev.preventDefault();
    if (!S.bitmap) return;
    S.compare = true;
    dom.btnCompare.setAttribute('aria-pressed', 'true');
    scheduleRender();
  };
  var compareOff = function () {
    if (!S.compare) return;
    S.compare = false;
    dom.btnCompare.setAttribute('aria-pressed', 'false');
    scheduleRender();
  };
  dom.btnCompare.addEventListener('pointerdown', compareOn);
  window.addEventListener('pointerup', compareOff);
  dom.btnCompare.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); compareOn(null); }
  });
  dom.btnCompare.addEventListener('keyup', compareOff);
  dom.btnCompare.addEventListener('blur', compareOff);

  dom.format.addEventListener('change', function () {
    var lossy = dom.format.value !== 'image/png';
    dom.qualityField.hidden = !lossy;
  });
  dom.quality.addEventListener('input', function () {
    dom.qualityVal.textContent = dom.quality.value + '%';
  });

  dom.btnPrivacy.addEventListener('click', function () { dom.privacyDialog.showModal(); });
  dom.btnPrivClose.addEventListener('click', function () { dom.privacyDialog.close(); });
  dom.privacyDialog.addEventListener('click', function (ev) {
    if (ev.target === dom.privacyDialog) dom.privacyDialog.close();
  });

  dom.stage.addEventListener('pointerdown', function (ev) {
    if (!S.bitmap) return;
    try { dom.stage.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    onPointerDown(ev);
  });
  dom.stage.addEventListener('pointermove', onPointerMove);
  dom.stage.addEventListener('pointerup', onPointerUp);
  dom.stage.addEventListener('pointercancel', onPointerUp);
  dom.stage.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    if (S.draft) { S.draft = null; drag = null; scheduleRender(); }
  });
  dom.stage.addEventListener('wheel', function (ev) {
    if (!S.bitmap) return;
    ev.preventDefault();
    var factor = Math.exp(-ev.deltaY * 0.0016);
    zoomAt(S.view.scale * factor, ev.clientX, ev.clientY);
  }, { passive: false });

  window.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'DIALOG';

    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
      if (!typing) { ev.preventDefault(); undo(); }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) {
      if (!typing) { ev.preventDefault(); redo(); }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
      ev.preventDefault(); openPicker(); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault(); download(); return;
    }
    if (ev.key === 'Escape') {
      if (S.draft) { S.draft = null; drag = null; scheduleRender(); return; }
      if (!typing && S.sel != null) { S.sel = null; sceneChanged(); }
      return;
    }
    if (typing) return;

    if (ev.key === ' ') { S.spaceDown = true; setCursor('grab'); return; }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.sel != null) {
      ev.preventDefault(); removeSelected(); return;
    }
    var k = ev.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 'b') setTool('blur');
    else if (k === 'p') setTool('pixelate');
    else if (k === 's') setTool('solid');
    else if (k === '+') { var a = dom.stage.getBoundingClientRect(); zoomAt(S.view.scale * 1.25, a.left + a.width / 2, a.top + a.height / 2); }
    else if (k === '-') { var b = dom.stage.getBoundingClientRect(); zoomAt(S.view.scale / 1.25, b.left + b.width / 2, b.top + b.height / 2); }
    else if (k === '0') { fitView(); scheduleRender(); }
  });

  window.addEventListener('keyup', function (ev) {
    if (ev.key === ' ') {
      S.spaceDown = false;
      if (!drag) setCursor(S.tool === 'select' ? 'move' : 'crosshair');
    }
  });

  window.addEventListener('blur', function () {
    S.spaceDown = false;
    compareOff();
  });

  window.addEventListener('resize', function () {
    if (!S.bitmap) return;
    if (!S.userZoom) { fitView(); }
    scheduleRender();
  });

  /* ============================================================
     13. Boot
     ============================================================ */
  dom.qualityVal.textContent = dom.quality.value + '%';
  setTool('blur');
  updateUI();
  dom.netCount.textContent = String(netAttempts);

  /* warn only when the page is served over http(s), i.e. the hosted copy */
  if (location.protocol === 'https:' || location.protocol === 'http:') {
    dom.hostedNote.hidden = false;
  }
})();
