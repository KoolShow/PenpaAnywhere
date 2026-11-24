(function () {
  'use strict';

  // Prevent beforeunload blocking overlay close
  var origAddEventListener = document.addEventListener.bind(document);
  var origWinAddEventListener = window.addEventListener.bind(window);
  document.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') return;
    return origAddEventListener(type, listener, options);
  };
  window.addEventListener = function (type, listener, options) {
    if (type === 'beforeunload') return;
    return origWinAddEventListener(type, listener, options);
  };

  var frameVersion = 1;
  var listeners = new Set();
  var patchedProtos = new WeakSet();

  function notifyRedraw() {
    frameVersion++;
    listeners.forEach(function (fn) {
      try {
        fn(frameVersion);
      } catch (_) {}
    });
  }

  function tryPatchPuzzleProto() {
    if (typeof window.Puzzle === 'function' && window.Puzzle.prototype) {
      if (!patchedProtos.has(window.Puzzle.prototype)) {
        patchedProtos.add(window.Puzzle.prototype);
        var origRedraw = window.Puzzle.prototype.redraw;
        if (typeof origRedraw === 'function') {
          window.Puzzle.prototype.redraw = function () {
            var res = origRedraw.apply(this, arguments);
            notifyRedraw();
            return res;
          };
        }
        var origCanvasUpdate = window.Puzzle.prototype.canvasxy_update;
        if (typeof origCanvasUpdate === 'function') {
          window.Puzzle.prototype.canvasxy_update = function () {
            var res = origCanvasUpdate.apply(this, arguments);
            notifyRedraw();
            return res;
          };
        }
      }
    }
    if (window.pu && typeof window.pu.redraw === 'function') {
      var proto = Object.getPrototypeOf(window.pu);
      if (proto && !patchedProtos.has(proto)) {
        patchedProtos.add(proto);
        var orig = proto.redraw;
        if (typeof orig === 'function') {
          proto.redraw = function () {
            var res = orig.apply(this, arguments);
            notifyRedraw();
            return res;
          };
        }
      }
    }
  }

  function getCanvas() {
    return document.getElementById('canvas');
  }

  /**
   * Compute normalized [u0, v0, u1, v1] of the puzzle grid inside the full canvas.
   * Falls back to [0, 0, 1, 1] if grid geometry isn't ready.
   */
  function getGridBoundsNormalized() {
    var pu = window.pu;
    var canvas = getCanvas();
    if (!pu || !canvas || !pu.canvasx || !pu.canvasy) {
      return { u0: 0, v0: 0, u1: 1, v1: 1, canvasCssW: 1, canvasCssH: 1 };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    if (Array.isArray(pu.centerlist) && pu.centerlist.length > 0 && pu.point) {
      for (var i = 0; i < pu.centerlist.length; i++) {
        var cIdx = pu.centerlist[i];
        var cell = pu.point[cIdx];
        if (!cell) continue;
        if (Array.isArray(cell.surround) && cell.surround.length > 0) {
          for (var j = 0; j < cell.surround.length; j++) {
            var vPt = pu.point[cell.surround[j]];
            if (!vPt) continue;
            if (vPt.x < minX) minX = vPt.x;
            if (vPt.y < minY) minY = vPt.y;
            if (vPt.x > maxX) maxX = vPt.x;
            if (vPt.y > maxY) maxY = vPt.y;
          }
        } else {
          if (cell.x < minX) minX = cell.x;
          if (cell.y < minY) minY = cell.y;
          if (cell.x > maxX) maxX = cell.x;
          if (cell.y > maxY) maxY = cell.y;
        }
      }
    }

    if (!isFinite(minX) || maxX <= minX || maxY <= minY) {
      return {
        u0: 0,
        v0: 0,
        u1: 1,
        v1: 1,
        canvasCssW: pu.canvasx,
        canvasCssH: pu.canvasy,
      };
    }

    return {
      u0: Math.max(0, Math.min(1, minX / pu.canvasx)),
      v0: Math.max(0, Math.min(1, minY / pu.canvasy)),
      u1: Math.max(0, Math.min(1, maxX / pu.canvasx)),
      v1: Math.max(0, Math.min(1, maxY / pu.canvasy)),
      canvasCssW: pu.canvasx,
      canvasCssH: pu.canvasy,
    };
  }

  function getCanvasCssOffset(canvas) {
    // Penpa coord_point uses: x = e.pageX - canvas.offsetLeft; y = e.pageY - canvas.offsetTop;
    return {
      left: canvas.offsetLeft || 0,
      top: canvas.offsetTop || 0,
    };
  }

  function isTouchMode() {
    if (window.pu && window.pu.ondown_key) {
      return window.pu.ondown_key === 'touchstart';
    }
    return window.ondown_key === 'touchstart';
  }

  /**
   * Dispatch a synthesized mouse or touch event onto Penpa's native canvas at normalized (u, v) in [0,1]^2.
   */
  function dispatchPointer(phase, u, v, opts) {
    var canvas = getCanvas();
    var pu = window.pu;
    if (!canvas || !pu) return;

    opts = opts || {};
    var cssX = u * pu.canvasx;
    var cssY = v * pu.canvasy;
    var off = getCanvasCssOffset(canvas);
    var pageX = cssX + off.left;
    var pageY = cssY + off.top;
    var button = typeof opts.button === 'number' ? opts.button : 0;
    var buttons = typeof opts.buttons === 'number' ? opts.buttons : phase === 'up' ? 0 : 1;

    var useTouch = isTouchMode() && phase !== 'contextmenu' && button !== 2;

    if (useTouch) {
      var touchMap = {
        down: 'touchstart',
        move: 'touchmove',
        up: 'touchend',
        out: 'touchend',
      };
      var tType = touchMap[phase];
      if (!tType) return;

      var touchObj = {
        identifier: 1,
        target: canvas,
        pageX: pageX,
        pageY: pageY,
        clientX: pageX - window.scrollX,
        clientY: pageY - window.scrollY,
        screenX: pageX,
        screenY: pageY,
      };
      var evt = new Event(tType, { bubbles: true, cancelable: true });
      var list = phase === 'up' || phase === 'out' ? [] : [touchObj];
      Object.defineProperties(evt, {
        touches: { value: list },
        targetTouches: { value: list },
        changedTouches: { value: [touchObj] },
        ctrlKey: { value: !!opts.ctrlKey },
        shiftKey: { value: !!opts.shiftKey },
        altKey: { value: !!opts.altKey },
        metaKey: { value: !!opts.metaKey },
      });
      canvas.dispatchEvent(evt);
    } else {
      var mouseMap = {
        down: 'mousedown',
        move: 'mousemove',
        up: 'mouseup',
        out: 'mouseout',
        contextmenu: 'contextmenu',
      };
      var mType = mouseMap[phase];
      if (!mType) return;

      var mEvt = new MouseEvent(mType, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: button,
        buttons: buttons,
        ctrlKey: !!opts.ctrlKey,
        shiftKey: !!opts.shiftKey,
        altKey: !!opts.altKey,
        metaKey: !!opts.metaKey,
        clientX: pageX - window.scrollX,
        clientY: pageY - window.scrollY,
      });
      Object.defineProperties(mEvt, {
        pageX: { value: pageX },
        pageY: { value: pageY },
      });
      canvas.dispatchEvent(mEvt);
    }
  }

  function dispatchKey(type, opts) {
    var kEvt = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key: opts.key || '',
      code: opts.code || '',
      keyCode: opts.keyCode || 0,
      which: opts.which || opts.keyCode || 0,
      ctrlKey: !!opts.ctrlKey,
      shiftKey: !!opts.shiftKey,
      altKey: !!opts.altKey,
      metaKey: !!opts.metaKey,
      repeat: !!opts.repeat,
    });
    // Ensure legacy keyCode/which getters match for Penpa's onKeyDown
    if (opts.keyCode) {
      try {
        Object.defineProperty(kEvt, 'keyCode', { value: opts.keyCode });
        Object.defineProperty(kEvt, 'which', { value: opts.keyCode });
      } catch (_) {}
    }
    document.dispatchEvent(kEvt);
  }

  function isReady() {
    var c = getCanvas();
    return !!(c && c.width > 0 && c.height > 0 && window.pu && window.pu.canvasx > 0);
  }

  function getStatus() {
    var pu = window.pu;
    if (!pu) return { ready: false };
    var qa = pu.mode ? pu.mode.qa : 'pu_q';
    var editMode = pu.mode && pu.mode[qa] ? pu.mode[qa].edit_mode : '';
    return {
      ready: isReady(),
      gridtype: pu.gridtype || 'square',
      nx: pu.nx || 0,
      ny: pu.ny || 0,
      qa: qa,
      editMode: editMode,
      frameVersion: frameVersion,
    };
  }

  // Poll until Penpa finishes boot(), then hook redraw
  var bootTimer = setInterval(function () {
    tryPatchPuzzleProto();
    if (isReady()) {
      clearInterval(bootTimer);
      notifyRedraw();
    }
  }, 80);

  // Also re-check prototype hooking on any button click inside dock (e.g. New Grid changes pu subclass)
  origAddEventListener(
    'click',
    function () {
      setTimeout(function () {
        tryPatchPuzzleProto();
        notifyRedraw();
      }, 60);
    },
    true
  );

  // Android TYPE_APPLICATION_OVERLAY WebView crashes with WindowManager$BadTokenException
  // when native <select> tries to open an Activity-bound AlertDialog. Replace native <select>
  // popups inside Penpa+ with a pure-DOM dropdown menu whenever running in Android overlay mode.
  function isAndroidOverlayEnv() {
    try {
      return !!(
        window.parent &&
        window.parent.AndroidOverlay &&
        window.parent.AndroidOverlay.isOverlayMode &&
        window.parent.AndroidOverlay.isOverlayMode()
      );
    } catch (_) {
      return false;
    }
  }

  if (isAndroidOverlayEnv()) {
    var activeSelectMenu = null;
    function closeSelectMenu() {
      if (activeSelectMenu && activeSelectMenu.parentNode) {
        activeSelectMenu.parentNode.removeChild(activeSelectMenu);
      }
      activeSelectMenu = null;
    }

    function openCustomSelectMenu(selectEl) {
      closeSelectMenu();
      var rect = selectEl.getBoundingClientRect();
      var menu = document.createElement('div');
      menu.style.cssText =
        'position:fixed;z-index:2147483647;max-height:220px;overflow-y:auto;' +
        'background:#1d2024;color:#e2e2e9;border:1px solid #8e9099;border-radius:10px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,0.55);padding:4px;font-size:13px;min-width:120px;';
      menu.style.left = Math.max(4, Math.min(window.innerWidth - 150, rect.left)) + 'px';
      var topPos = rect.bottom + 2;
      if (topPos + 160 > window.innerHeight) {
        topPos = Math.max(4, rect.top - 160);
      }
      menu.style.top = topPos + 'px';

      for (var i = 0; i < selectEl.options.length; i++) {
        (function (opt) {
          var item = document.createElement('div');
          item.textContent = opt.textContent || opt.label || opt.value;
          var selected = opt.selected;
          item.style.cssText =
            'padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;' +
            (selected ? 'background:#0842a0;color:#d3e3fd;font-weight:600;' : '');
          item.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            selectEl.value = opt.value;
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            closeSelectMenu();
          });
          menu.appendChild(item);
        })(selectEl.options[i]);
      }

      document.body.appendChild(menu);
      activeSelectMenu = menu;
    }

    function interceptNativeSelect(e) {
      var target = e.target;
      if (!target || target.tagName !== 'SELECT') {
        if (activeSelectMenu && !activeSelectMenu.contains(target)) {
          closeSelectMenu();
        }
        return;
      }
      if (target.multiple || target.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        target.blur();
      } catch (_) {}
      if (e.type === 'pointerdown' || e.type === 'touchstart' || e.type === 'mousedown') {
        openCustomSelectMenu(target);
      }
    }

    origAddEventListener('pointerdown', interceptNativeSelect, true);
    origAddEventListener('mousedown', interceptNativeSelect, true);
    origAddEventListener('touchstart', interceptNativeSelect, true);
    origAddEventListener('click', interceptNativeSelect, true);

    // Request keyboard focus on Android overlay ONLY while an actual text/number input is focused
    function isTextInput(el) {
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        var t = (el.type || 'text').toLowerCase();
        return t === 'text' || t === 'number' || t === 'search' || t === 'url' || t === 'password';
      }
      return false;
    }
    origAddEventListener(
      'focusin',
      function (e) {
        if (isTextInput(e.target)) {
          try {
            window.parent.AndroidOverlay.setFocusable(true);
          } catch (_) {}
        }
      },
      true
    );
    origAddEventListener(
      'focusout',
      function (e) {
        if (isTextInput(e.target)) {
          try {
            window.parent.AndroidOverlay.setFocusable(false);
          } catch (_) {}
        }
      },
      true
    );
  }

  window.__PENPAANYWHERE_BRIDGE__ = {
    isReady: isReady,
    getCanvas: getCanvas,
    getFrameVersion: function () {
      return frameVersion;
    },
    getGridBoundsNormalized: getGridBoundsNormalized,
    getStatus: getStatus,
    dispatchPointer: dispatchPointer,
    dispatchKey: dispatchKey,
    forceRedraw: function () {
      if (window.pu && typeof window.pu.redraw === 'function') {
        window.pu.redraw();
      }
      notifyRedraw();
    },
    subscribe: function (fn) {
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    },
  };
})();
