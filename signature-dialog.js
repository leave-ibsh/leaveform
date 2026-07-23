/**
 * signature-dialog.js
 * Shared signature canvas dialog for IBSH leave approvals.
 *
 * Usage:
 *   const dataUrl = await window.SignatureDialog.open({
 *     email: 'teacher@ibsh.tw',
 *     title: 'Sign as Homeroom Teacher',
 *     subtitle: 'Stage: Homeroom / Homeroom Teacher',
 *   });
 *   if (!dataUrl) { return; } // cancelled
 *
 * Behaviour:
 *   - Loads the user's existing signature from /signatures/{email} (via AppDB).
 *   - If found: shows preview + "Redraw" button.
 *   - If none:  shows blank canvas.
 *   - On Confirm: saves to /signatures/{email} (overwrites) AND returns dataUrl.
 *   - On Cancel: returns null.
 *
 * Returned dataUrl is a transparent PNG data URI you can embed directly into
 * an <img> or SVG <image> tag.
 */
(function () {
  'use strict';
  const CANVAS_W = 480;
  const CANVAS_H = 270;
  const STROKE_COLOR = '#3F5648';
  const STROKE_WIDTH = 2.6;
  let _injected = false;
  let _activeResolver = null;
  function _injectStylesAndMarkup() {
    if (_injected) return;
    _injected = true;
    const css = `
      .sigdlg-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);
        backdrop-filter:blur(2px);z-index:99998;display:none;align-items:center;
        justify-content:center;padding:16px;animation:sigdlgFade .15s ease-out;}
      .sigdlg-overlay.show{display:flex;}
      .sigdlg-card{background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.25);
        max-width:540px;width:100%;padding:24px;font-family:"Inter","Segoe UI","Noto Sans TC",sans-serif;
        animation:sigdlgPop .2s cubic-bezier(.18,.89,.32,1.28);position:relative;}
      .sigdlg-title{font-size:1.15rem;font-weight:800;color:#0f172a;margin:0 0 4px;}
      .sigdlg-subtitle{font-size:.86rem;color:#64748b;margin:0 0 18px;}
      .sigdlg-existing-label{font-size:.78rem;font-weight:700;color:#10b981;text-transform:uppercase;
        letter-spacing:.04em;margin-bottom:6px;}
      .sigdlg-existing{border:1px dashed #cbd5e1;border-radius:12px;padding:10px;background:#f8fafc;
        display:flex;align-items:center;justify-content:center;min-height:80px;margin-bottom:10px;}
      .sigdlg-existing img{max-width:100%;max-height:120px;}
      .sigdlg-canvas-wrap{position:relative;border:1px solid #cbd5e1;border-radius:12px;
        background:#fff;background-image:linear-gradient(to right,#f1f5f9 1px,transparent 1px),
        linear-gradient(to bottom,#f1f5f9 1px,transparent 1px);
        background-size:24px 24px;overflow:hidden;touch-action:none;cursor:crosshair;}
      .sigdlg-canvas-wrap.hidden{display:none;}
      .sigdlg-canvas{display:block;width:100%;height:auto;}
      .sigdlg-hint{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);
        text-align:center;color:#94a3b8;font-size:.85rem;pointer-events:none;font-style:italic;}
      .sigdlg-hint.hidden{display:none;}
      .sigdlg-toolbar{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;}
      .sigdlg-btn{padding:9px 16px;border-radius:10px;font-size:.88rem;font-weight:700;
        cursor:pointer;border:1px solid transparent;transition:all .15s;font-family:inherit;}
      .sigdlg-btn:disabled{opacity:.5;cursor:not-allowed;}
      .sigdlg-btn-ghost{background:#fff;border-color:#e2e8f0;color:#475569;}
      .sigdlg-btn-ghost:hover:not(:disabled){background:#f1f5f9;}
      .sigdlg-btn-warn{background:#fff7ed;border-color:#fed7aa;color:#9a3412;}
      .sigdlg-btn-warn:hover:not(:disabled){background:#ffedd5;}
      .sigdlg-btn-primary{background:#10b981;color:#fff;}
      .sigdlg-btn-primary:hover:not(:disabled){background:#059669;}
      .sigdlg-btn-danger{background:#fff;border-color:#e2e8f0;color:#94a3b8;}
      .sigdlg-btn-danger:hover:not(:disabled){background:#fee2e2;color:#991b1b;border-color:#fecaca;}
      .sigdlg-status{font-size:.82rem;color:#64748b;margin-top:8px;text-align:right;min-height:18px;}
      .sigdlg-status.error{color:#dc2626;}
      html.sigdlg-open body{overflow:hidden;}
      @media(max-width:640px){
        .sigdlg-overlay{align-items:flex-end;justify-content:center;padding:0;background:rgba(15,23,42,.48);
          backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);}
        .sigdlg-card{max-width:none;width:100%;border-radius:28px 28px 0 0;padding:38px 20px calc(18px + env(safe-area-inset-bottom));
          max-height:88vh;max-height:88svh;overflow-y:auto;overscroll-behavior:contain;
          box-sizing:border-box;box-shadow:0 -18px 48px rgba(15,23,42,.18);animation:sigdlgSheet .2s ease-out;}
        .sigdlg-card::before{content:'';position:absolute;top:14px;left:50%;transform:translateX(-50%);
          width:46px;height:5px;border-radius:999px;background:#d1d5db;}
        .sigdlg-title{font-size:1.35rem;letter-spacing:-.03em;margin-right:44px;}
        .sigdlg-subtitle{font-size:.92rem;line-height:1.4;margin:0 44px 14px 0;color:#6b8176;}
        .sigdlg-existing-label{margin-bottom:5px;}
        .sigdlg-existing{min-height:0;max-height:170px;padding:8px;margin-bottom:8px;border-radius:16px;overflow:hidden;}
        .sigdlg-existing img{max-height:150px;object-fit:contain;}
        .sigdlg-canvas-wrap{border-radius:18px;border-color:#e2e8f0;background:#fff;background-image:none;min-height:clamp(170px,32svh,230px);}
        .sigdlg-canvas{height:clamp(170px,32svh,230px);}
        .sigdlg-hint{top:auto;bottom:28px;text-align:left;left:44px;right:auto;transform:none;font-size:.82rem;color:#c7d2cc;font-style:normal;}
        .sigdlg-status{text-align:left;margin-top:8px;min-height:0;line-height:1.35;}
        .sigdlg-toolbar{display:grid;grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);gap:10px;margin-top:12px;}
        .sigdlg-btn{min-height:50px;border-radius:16px;font-size:.96rem;}
        .sigdlg-btn-ghost{position:absolute;right:18px;top:18px;width:38px;height:38px;min-height:38px;padding:0;border-radius:50%;
          font-size:0;background:#f8fafc;border-color:#e2e8f0;color:#64748b;}
        .sigdlg-btn-ghost::before{content:'×';font-size:24px;line-height:1;font-weight:700;}
        .sigdlg-btn-danger{grid-column:1;background:#fff;color:#3F5648;border-color:#e2e8f0;box-shadow:0 8px 18px -14px rgba(15,23,42,.4);}
        .sigdlg-btn-primary{grid-column:1 / -1;background:#3F5648;color:#fff;box-shadow:0 14px 28px -16px rgba(63,86,72,.8);}
        .sigdlg-btn-primary:hover:not(:disabled){background:#33483d;}
        .sigdlg-btn-warn{grid-column:2;background:#fff7ed;}
      }
      @keyframes sigdlgFade{from{opacity:0}to{opacity:1}}
      @keyframes sigdlgPop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
      @keyframes sigdlgSheet{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.className = 'sigdlg-overlay';
    overlay.id = 'sigdlgOverlay';
    overlay.innerHTML = `
      <div class="sigdlg-card" role="dialog" aria-modal="true" aria-labelledby="sigdlgTitle">
        <h3 class="sigdlg-title" id="sigdlgTitle">Sign here</h3>
        <p class="sigdlg-subtitle" id="sigdlgSubtitle"></p>
        <div id="sigdlgExistingBlock" style="display:none;">
          <div class="sigdlg-existing-label">Saved Signature</div>
          <div class="sigdlg-existing"><img id="sigdlgExistingImg" alt="Existing signature"></div>
        </div>
        <div class="sigdlg-canvas-wrap" id="sigdlgCanvasWrap">
          <canvas class="sigdlg-canvas" id="sigdlgCanvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
          <div class="sigdlg-hint" id="sigdlgHint">Sign here</div>
        </div>
        <div class="sigdlg-status" id="sigdlgStatus"></div>
        <div class="sigdlg-toolbar">
          <button class="sigdlg-btn sigdlg-btn-ghost" type="button" id="sigdlgCancelBtn">Cancel</button>
          <button class="sigdlg-btn sigdlg-btn-danger" type="button" id="sigdlgClearBtn">Clear</button>
          <button class="sigdlg-btn sigdlg-btn-warn" type="button" id="sigdlgRedrawBtn" style="display:none;">Redraw and overwrite</button>
          <button class="sigdlg-btn sigdlg-btn-primary" type="button" id="sigdlgConfirmBtn">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  function _setStatus(msg, isError) {
    const el = document.getElementById('sigdlgStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }
  function _showCanvas(showHint) {
    document.getElementById('sigdlgCanvasWrap').classList.remove('hidden');
    document.getElementById('sigdlgHint').classList.toggle('hidden', !showHint);
  }
  function _hideCanvas() {
    document.getElementById('sigdlgCanvasWrap').classList.add('hidden');
  }
  function _setupCanvasDrawing(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = STROKE_WIDTH;
    let drawing = false;
    let lastX = 0;
    let lastY = 0;
    let hasInk = false;
    function pointFromEvent(evt) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const isTouch = evt.touches && evt.touches.length;
      const clientX = isTouch ? evt.touches[0].clientX : evt.clientX;
      const clientY = isTouch ? evt.touches[0].clientY : evt.clientY;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    }
    function start(evt) {
      evt.preventDefault();
      drawing = true;
      const p = pointFromEvent(evt);
      lastX = p.x;
      lastY = p.y;
    }
    function move(evt) {
      if (!drawing) return;
      evt.preventDefault();
      const p = pointFromEvent(evt);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x;
      lastY = p.y;
      if (!hasInk) {
        hasInk = true;
        document.getElementById('sigdlgHint').classList.add('hidden');
      }
    }
    function end(evt) {
      if (drawing) {
        evt.preventDefault();
      }
      drawing = false;
    }
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end, { passive: false });
    canvas.addEventListener('touchcancel', end, { passive: false });
    function clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false;
      document.getElementById('sigdlgHint').classList.remove('hidden');
    }
    function isEmpty() {
      return !hasInk;
    }
    /**
     * Find the bounding box of non-transparent pixels and return a cropped
     * PNG dataURL. Adds a small padding so strokes don't touch the edge.
     * Falls back to the full canvas if cropping fails for any reason.
     */
    function toDataUrl() {
      try {
        const w = canvas.width;
        const h = canvas.height;
        const img = ctx.getImageData(0, 0, w, h).data;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // alpha channel
            if (img[(y * w + x) * 4 + 3] > 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return canvas.toDataURL('image/png'); // empty
        const pad = 6;
        const cropX = Math.max(0, minX - pad);
        const cropY = Math.max(0, minY - pad);
        const cropW = Math.min(w, maxX + pad) - cropX;
        const cropH = Math.min(h, maxY + pad) - cropY;
        const out = document.createElement('canvas');
        out.width = cropW;
        out.height = cropH;
        out.getContext('2d').drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        return out.toDataURL('image/png');
      } catch (err) {
        console.warn('[SignatureDialog] crop failed, falling back to full canvas:', err);
        return canvas.toDataURL('image/png');
      }
    }
    return { clear, isEmpty, toDataUrl };
  }
  let _canvasController = null;
  function _resolveAndClose(value) {
    const overlay = document.getElementById('sigdlgOverlay');
    if (overlay) overlay.classList.remove('show');
    document.documentElement.classList.remove('sigdlg-open');
    const confirmBtn = document.getElementById('sigdlgConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = false;
    const r = _activeResolver;
    _activeResolver = null;
    if (r) r(value);
  }
  function _bindOnce() {
    if (_canvasController) return;
    const canvas = document.getElementById('sigdlgCanvas');
    _canvasController = _setupCanvasDrawing(canvas);
    document.getElementById('sigdlgCancelBtn').addEventListener('click', () => _resolveAndClose(null));
    document.getElementById('sigdlgClearBtn').addEventListener('click', () => {
      _canvasController.clear();
      _setStatus('');
    });
    document.getElementById('sigdlgRedrawBtn').addEventListener('click', () => {
      // Hide saved image, show canvas for redraw
      document.getElementById('sigdlgExistingBlock').style.display = 'none';
      document.getElementById('sigdlgRedrawBtn').style.display = 'none';
      _showCanvas(true);
      _canvasController.clear();
      _setStatus('Redraw and confirm to overwrite the saved signature.');
    });
    document.getElementById('sigdlgConfirmBtn').addEventListener('click', async () => {
      const ctx = window.__SIGDLG_CTX__ || {};
      const email = ctx.email || '';
      // If user is keeping the existing signature (canvas hidden), just resolve with it.
      const existingBlock = document.getElementById('sigdlgExistingBlock');
      const usingExisting = existingBlock && existingBlock.style.display !== 'none';
      if (usingExisting) {
        _resolveAndClose(ctx.existingDataUrl || null);
        return;
      }
      if (_canvasController.isEmpty()) {
        _setStatus('Please draw your signature first.', true);
        return;
      }
      const dataUrl = _canvasController.toDataUrl();
      const confirmBtn = document.getElementById('sigdlgConfirmBtn');
      confirmBtn.disabled = true;
      _setStatus('Saving...');
      try {
        if (email && window.AppDB && typeof window.AppDB.saveSignature === 'function') {
          await window.AppDB.saveSignature(email, dataUrl);
        }
        _resolveAndClose(dataUrl);
      } catch (err) {
        console.error('[SignatureDialog] Save failed:', err);
        _setStatus('Save failed: ' + (err && err.message ? err.message : 'unknown error'), true);
        confirmBtn.disabled = false;
      }
    });
    // Close on Escape
    document.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') {
        const overlay = document.getElementById('sigdlgOverlay');
        if (overlay && overlay.classList.contains('show')) {
          _resolveAndClose(null);
        }
      }
    });
  }
  async function open(opts) {
    const options = opts || {};
    const email = String(options.email || '').trim().toLowerCase();
    const title = options.title || 'Sign here';
    const subtitle = options.subtitle || '';
    _injectStylesAndMarkup();
    _bindOnce();
    document.getElementById('sigdlgTitle').textContent = title;
    document.getElementById('sigdlgSubtitle').textContent = subtitle;
    const confirmBtn = document.getElementById('sigdlgConfirmBtn');
    confirmBtn.textContent = options.confirmText || 'Confirm';
    confirmBtn.disabled = false;
    _setStatus('');
    _canvasController.clear();
    // Try to load existing signature
    let existing = null;
    if (email && window.AppDB && typeof window.AppDB.getSignature === 'function') {
      try { existing = await window.AppDB.getSignature(email); }
      catch (err) { console.warn('[SignatureDialog] getSignature failed:', err); }
    }
    const existingBlock = document.getElementById('sigdlgExistingBlock');
    const existingImg = document.getElementById('sigdlgExistingImg');
    const redrawBtn = document.getElementById('sigdlgRedrawBtn');
    window.__SIGDLG_CTX__ = { email, existingDataUrl: existing ? existing.dataUrl : null };
    if (existing && existing.dataUrl) {
      existingImg.src = existing.dataUrl;
      existingBlock.style.display = 'block';
      redrawBtn.style.display = '';
      _hideCanvas();
      _setStatus('Click Confirm to use the saved signature, or Redraw to replace.');
    } else {
      existingBlock.style.display = 'none';
      redrawBtn.style.display = 'none';
      _showCanvas(true);
    }
    document.documentElement.classList.add('sigdlg-open');
    document.getElementById('sigdlgOverlay').classList.add('show');
    return new Promise(resolve => {
      _activeResolver = resolve;
    });
  }
  window.SignatureDialog = { open };
})();
