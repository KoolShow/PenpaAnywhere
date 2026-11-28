(function () {
  'use strict';

  // Upstream Penpa+ stores UserSettings (theme, language, shortcuts, etc.) via document.cookie
  // with `this._expDate` (undefined in forEach / 2147483647 days -> Invalid Date), making every
  // cookie session-only so settings reset on app restart. Back document.cookie with localStorage
  // so every Penpa+ UserSettings preference persists across Web, Tauri, and Android restarts.
  // Identify this Penpa+ iframe instance from its host-assigned data-grid-id attribute
  // (never use location.search/hash so upstream Penpa+ boot() never treats gridId as a puzzle URL).
  var GRID_ID = 'grid_primary';
  try {
    var fe = window.frameElement;
    var attrId = fe && typeof fe.getAttribute === 'function' ? fe.getAttribute('data-grid-id') : '';
    if (attrId && typeof attrId === 'string' && attrId.trim()) {
      GRID_ID = attrId.trim();
    }
  } catch (_) {}

  var COOKIE_STORAGE_KEY = 'penpaanywhere:penpa_cookies_v1';
  var nativeCookieDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
    (typeof HTMLDocument !== 'undefined' &&
      Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie'));

  function readCookieStore() {
    try {
      var raw = window.localStorage.getItem(COOKIE_STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_) {}
    return {};
  }

  function writeCookieStore(map) {
    try {
      window.localStorage.setItem(COOKIE_STORAGE_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  var cookieStore = readCookieStore();

  if (nativeCookieDesc && nativeCookieDesc.get) {
    try {
      var existingCookies = nativeCookieDesc.get.call(document) || '';
      if (existingCookies) {
        var seeded = false;
        existingCookies.split(';').forEach(function (part) {
          var eq = part.indexOf('=');
          if (eq <= 0) return;
          var k = part.slice(0, eq).trim();
          var v = part.slice(eq + 1).trim();
          if (k && !(k in cookieStore)) {
            cookieStore[k] = v;
            seeded = true;
          }
        });
        if (seeded) writeCookieStore(cookieStore);
      }
    } catch (_) {}
  }

  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      enumerable: true,
      get: function () {
        cookieStore = readCookieStore();
        var keys = Object.keys(cookieStore);
        var pairs = [];
        for (var i = 0; i < keys.length; i++) {
          pairs.push(keys[i] + '=' + cookieStore[keys[i]]);
        }
        return pairs.join('; ');
      },
      set: function (cookieStr) {
        if (typeof cookieStr !== 'string') return;
        var parts = cookieStr.split(';');
        var first = parts[0] || '';
        var eq = first.indexOf('=');
        if (eq <= 0) return;
        var name = first.slice(0, eq).trim();
        var value = first.slice(eq + 1).trim();
        if (!name) return;

        var isDelete = false;
        for (var i = 1; i < parts.length; i++) {
          var attr = parts[i].trim();
          var lower = attr.toLowerCase();
          if (lower.indexOf('expires=') === 0) {
            var expMs = Date.parse(attr.slice(8).trim());
            if (!isNaN(expMs) && expMs <= Date.now()) {
              isDelete = true;
            }
          } else if (lower.indexOf('max-age=') === 0) {
            var maxAge = parseInt(attr.slice(8).trim(), 10);
            if (!isNaN(maxAge) && maxAge <= 0) {
              isDelete = true;
            }
          }
        }

        cookieStore = readCookieStore();
        if (isDelete) {
          delete cookieStore[name];
        } else {
          cookieStore[name] = value;
        }
        writeCookieStore(cookieStore);

        if (nativeCookieDesc && nativeCookieDesc.set) {
          try {
            var fixed = isDelete
              ? name + '=;path=/;SameSite=Lax;max-age=0'
              : name + '=' + value + ';path=/;SameSite=Lax;max-age=31536000';
            nativeCookieDesc.set.call(document, fixed);
          } catch (_) {}
        }
      },
    });
  } catch (_) {}

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

  // Unified official Penpa+ URL base so all share/export/shortlink outputs use the official host
  // instead of local Tauri/Android/Web host origins.
  var OFFICIAL_PENPA_BASE_URL = 'https://swaroopg92.github.io/penpa-edit/';

  function extractPenpaParamString(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    var trimmed = rawUrl.trim();
    var hashIdx = trimmed.indexOf('#');
    if (hashIdx >= 0) return trimmed.slice(hashIdx + 1);
    var qIdx = trimmed.indexOf('?');
    if (qIdx >= 0) return trimmed.slice(qIdx + 1);
    if (trimmed.indexOf('p=') >= 0 || trimmed.indexOf('m=') >= 0) return trimmed;
    return '';
  }

  function toOfficialPenpaUrl(rawUrl) {
    var param = extractPenpaParamString(rawUrl);
    return param ? OFFICIAL_PENPA_BASE_URL + '#' + param : OFFICIAL_PENPA_BASE_URL;
  }

  function isAllowedExternalHttpUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    var trimmed = rawUrl.trim();
    if (!trimmed || trimmed.length > 32768 || /[\s\u0000-\u001F\u007F]/.test(trimmed)) return false;
    try {
      var parsed = new URL(trimmed, window.location.href);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.host;
    } catch (_) {
      return false;
    }
  }

  function isNativeHostEnv() {
    try {
      return !!(
        window.parent &&
        window.parent !== window &&
        (window.parent.__TAURI_INTERNALS__ || window.parent.AndroidOverlay)
      );
    } catch (_) {
      return false;
    }
  }

  function isDebugBuildEnv() {
    try {
      if (window.parent && typeof window.parent.__PENPAANYWHERE_IS_DEBUG__ === 'boolean') {
        return window.parent.__PENPAANYWHERE_IS_DEBUG__;
      }
      if (
        window.parent &&
        window.parent.AndroidOverlay &&
        typeof window.parent.AndroidOverlay.isDebugBuild === 'function'
      ) {
        return !!window.parent.AndroidOverlay.isDebugBuild();
      }
    } catch (_) {}
    return false;
  }

  // Suppress default browser/WebView context menu in non-debug builds
  // (bubble phase so Penpa+'s own canvas right-click handlers still execute)
  origWinAddEventListener('contextmenu', function (e) {
    if (!isDebugBuildEnv()) {
      e.preventDefault();
    }
  });

  function openExternalViaHost(url) {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_OPEN_EXTERNAL__ === 'function'
      ) {
        window.parent.__PENPAANYWHERE_OPEN_EXTERNAL__(url);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function previewImageViaHost(dataUrl, filename, mimeType) {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_PREVIEW_IMAGE__ === 'function'
      ) {
        window.parent.__PENPAANYWHERE_PREVIEW_IMAGE__(
          dataUrl,
          filename || 'penpa-image.png',
          mimeType || 'image/png'
        );
        return true;
      }
    } catch (_) {}
    return false;
  }

  function downloadViaHost(filename, mimeType, base64Data) {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_DOWNLOAD__ === 'function'
      ) {
        window.parent.__PENPAANYWHERE_DOWNLOAD__(filename, mimeType, base64Data);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function getSuggestedImageFilename(mimeType) {
    var ext = mimeType === 'image/svg+xml' ? 'svg' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
    var base = 'penpa-image';
    try {
      var input = document.getElementById('saveimagename');
      if (input && typeof input.value === 'string' && input.value.trim()) {
        base = input.value.trim();
      }
    } catch (_) {}
    if (base.toLowerCase().endsWith('.' + ext)) return base;
    return base + '.' + ext;
  }

  function parseDataUrlParts(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return null;
    var commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return null;
    var header = dataUrl.slice(5, commaIdx);
    var body = dataUrl.slice(commaIdx + 1);
    var isBase64 = header.toLowerCase().indexOf(';base64') >= 0;
    var mime = header.split(';')[0] || 'application/octet-stream';
    if (isBase64) {
      return { mimeType: mime, base64Data: body };
    }
    try {
      var decoded = decodeURIComponent(body);
      var b64 = btoa(unescape(encodeURIComponent(decoded)));
      return { mimeType: mime, base64Data: b64 };
    } catch (_) {
      return null;
    }
  }

  function readBlobUrlAsDataUrl(blobUrl) {
    return fetch(blobUrl)
      .then(function (resp) {
        return resp.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onloadend = function () {
            resolve({
              dataUrl: typeof reader.result === 'string' ? reader.result : '',
              mimeType: blob.type || 'application/octet-stream',
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      });
  }

  function dispatchAnchorDownloadToHost(anchor) {
    if (!anchor) return false;
    var rawHref = anchor.getAttribute('href') || anchor.href || '';
    if (!rawHref) return false;
    var filename = anchor.getAttribute('download') || 'download.bin';
    if (rawHref.indexOf('data:') === 0) {
      var parsed = parseDataUrlParts(rawHref);
      if (parsed) {
        downloadViaHost(filename, parsed.mimeType, parsed.base64Data);
        return true;
      }
      return false;
    }
    if (rawHref.indexOf('blob:') === 0) {
      readBlobUrlAsDataUrl(rawHref)
        .then(function (res) {
          var parts = parseDataUrlParts(res.dataUrl);
          if (parts) {
            downloadViaHost(filename, parts.mimeType || res.mimeType, parts.base64Data);
          }
        })
        .catch(function () {});
      return true;
    }
    return false;
  }

  function createVirtualImagePreviewWindow() {
    var htmlBuffer = '';
    var delivered = false;
    function tryDeliver() {
      if (delivered || !htmlBuffer) return;
      var match = htmlBuffer.match(/src\s*=\s*(['"])(data:image\/[^'"]+|blob:[^'"]+)\1/i);
      if (!match) return;
      var src = match[2];
      delivered = true;
      if (src.indexOf('data:') === 0) {
        var parts = parseDataUrlParts(src);
        var mime = (parts && parts.mimeType) || 'image/png';
        previewImageViaHost(src, getSuggestedImageFilename(mime), mime);
      } else if (src.indexOf('blob:') === 0) {
        readBlobUrlAsDataUrl(src)
          .then(function (res) {
            if (res.dataUrl) {
              previewImageViaHost(res.dataUrl, getSuggestedImageFilename(res.mimeType), res.mimeType);
            }
          })
          .catch(function () {});
      }
    }
    return {
      closed: false,
      focus: function () {},
      close: function () {
        this.closed = true;
      },
      document: {
        open: function () {},
        write: function (chunk) {
          htmlBuffer += String(chunk == null ? '' : chunk);
          tryDeliver();
        },
        writeln: function (chunk) {
          htmlBuffer += String(chunk == null ? '' : chunk) + '\n';
          tryDeliver();
        },
        close: function () {
          tryDeliver();
        },
      },
    };
  }

  function handleUnifiedNewTabOpen(rawUrl, origOpenArgs) {
    var urlStr = typeof rawUrl === 'string' ? rawUrl.trim() : '';

    // 1. Blank popup (e.g. saveimage_window PNG/JPG calling window.open() + win.document.write(<img/>))
    if (!urlStr || urlStr.toLowerCase() === 'about:blank') {
      if (isNativeHostEnv()) {
        return createVirtualImagePreviewWindow();
      }
      return origWindowOpen ? origWindowOpen.apply(window, origOpenArgs || []) : null;
    }

    // 2. In-memory image/blob preview (e.g. saveimage_window SVG calling window.open(blobUrl))
    if (urlStr.indexOf('blob:') === 0 || urlStr.indexOf('data:image/') === 0) {
      if (isNativeHostEnv()) {
        if (urlStr.indexOf('data:') === 0) {
          var parts = parseDataUrlParts(urlStr);
          var mime = (parts && parts.mimeType) || 'image/png';
          previewImageViaHost(urlStr, getSuggestedImageFilename(mime), mime);
        } else {
          readBlobUrlAsDataUrl(urlStr)
            .then(function (res) {
              if (res.dataUrl) {
                previewImageViaHost(res.dataUrl, getSuggestedImageFilename(res.mimeType), res.mimeType);
              }
            })
            .catch(function () {});
        }
        return null;
      }
      return origWindowOpen ? origWindowOpen.apply(window, origOpenArgs || [urlStr, '_blank']) : null;
    }

    // 3. Any http(s) link -> open uniformly in system default browser
    if (isAllowedExternalHttpUrl(urlStr)) {
      var resolvedExternal = new URL(urlStr, window.location.href).href;
      if (openExternalViaHost(resolvedExternal)) {
        return null;
      }
      return origWindowOpen ? origWindowOpen.call(window, resolvedExternal, '_blank', 'noopener,noreferrer') : null;
    }

    return null;
  }

  // Unified window.open hook inside Penpa+ iframe
  var origWindowOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
  try {
    window.open = function (url) {
      return handleUnifiedNewTabOpen(url, arguments);
    };
  } catch (_) {}

  // Unified <a download> hook on non-Web hosts (intercepts programmatic downloadLink.click() too)
  if (isNativeHostEnv() && typeof HTMLAnchorElement !== 'undefined' && HTMLAnchorElement.prototype) {
    var origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this && this.hasAttribute && this.hasAttribute('download')) {
        if (dispatchAnchorDownloadToHost(this)) return;
      }
      return origAnchorClick.apply(this, arguments);
    };
  }

  // Unified capture-phase anchor click router:
  // 1) a[download] -> native host download (non-Web)
  // 2) any http(s) link click -> prevent iframe navigation and open uniformly in system browser
  origAddEventListener(
    'click',
    function (e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var anchor = target.closest('a[href]');
      if (!anchor) return;

      if (anchor.hasAttribute('download')) {
        if (isNativeHostEnv() && dispatchAnchorDownloadToHost(anchor)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      var rawHref = (anchor.getAttribute('href') || '').trim();
      if (!rawHref || rawHref === '#' || rawHref.toLowerCase().indexOf('javascript:') === 0) {
        return;
      }

      var resolvedHref = '';
      try {
        resolvedHref = new URL(rawHref, window.location.href).href;
      } catch (_) {
        return;
      }

      if (isAllowedExternalHttpUrl(resolvedHref)) {
        e.preventDefault();
        e.stopPropagation();
        handleUnifiedNewTabOpen(resolvedHref, [resolvedHref, '_blank']);
      }
    },
    true
  );

  function cloneGridViaHost(param) {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_CLONE_GRID__ === 'function'
      ) {
        window.parent.__PENPAANYWHERE_CLONE_GRID__(GRID_ID, param || '');
        return true;
      }
    } catch (_) {}
    return false;
  }

  function relocateHeaderIntoSettingsModal() {
    var header = document.getElementById('header');
    var modalContent = document.getElementById('modal-settings-content');
    if (!header || !modalContent) return;
    if (header.parentNode !== modalContent) {
      modalContent.insertBefore(header, modalContent.firstChild);
    }
  }

  function patchDuplicateControl() {
    if (typeof window.duplicate === 'function' && !window.duplicate.__acPatched) {
      var wrappedDup = function (inPlace) {
        if (!window.pu || typeof window.pu.maketext_duplicate !== 'function') return;
        var rawAddr = '';
        try {
          rawAddr = window.pu.maketext_duplicate();
          if (window.pu.mmode === 'solve') {
            rawAddr = rawAddr + '&l=solvedup';
          }
        } catch (_) {
          return;
        }
        var param = extractPenpaParamString(rawAddr);
        if (inPlace) {
          // Use same-origin hash when updating in-place history so official external base URL
          // never triggers a cross-origin SecurityError in history.pushState.
          if (param) {
            try {
              window.history.pushState('', '', '#' + param);
            } catch (_) {}
          }
          return;
        }
        if (param) {
          cloneGridViaHost(param);
        }
      };
      wrappedDup.__acPatched = true;
      window.duplicate = wrappedDup;
    }
  }

  var frameVersion = 1;
  var listeners = new Set();
  var patchedProtos = new WeakSet();
  var DRAFT_KEY =
    GRID_ID === 'grid_primary'
      ? 'penpaanywhere:penpa_draft_v1'
      : 'penpaanywhere:penpa_draft_v1:' + GRID_ID;
  var draftSaveTimer = 0;
  var isRestoringDraft = false;
  var draftRestoreAttempted = false;
  var draftSuppressed = false;

  function suppressDraftSave() {
    draftSuppressed = true;
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = 0;
    }
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch (_) {}
  }

  function saveDraftNow() {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = 0;
    }
    if (draftSuppressed || isRestoringDraft || !draftRestoreAttempted) return;
    if (!window.pu || typeof window.pu.maketext_duplicate !== 'function') return;
    try {
      var param = extractPenpaParamString(window.pu.maketext_duplicate());
      if (param && param.indexOf('p=') >= 0) {
        window.localStorage.setItem(DRAFT_KEY, param);
      }
    } catch (_) {}
  }

  function scheduleDraftSave() {
    if (draftSuppressed || isRestoringDraft || !draftRestoreAttempted) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(function () {
      draftSaveTimer = 0;
      saveDraftNow();
    }, 350);
  }

  function restoreDraftOnce() {
    if (draftRestoreAttempted) return;
    draftRestoreAttempted = true;
    try {
      var saved = window.localStorage.getItem(DRAFT_KEY);
      if (!saved || saved.indexOf('p=') === -1 || typeof window.load !== 'function') {
        return;
      }
      var preferredTheme = cookieStore.color_theme;
      var preferredLang = cookieStore.app_language;
      isRestoringDraft = true;
      Promise.resolve(window.load(saved, 'localstorage'))
        .catch(function () {})
        .finally(function () {
          try {
            if (typeof UserSettings !== 'undefined') {
              if (preferredTheme && String(UserSettings.color_theme) !== String(preferredTheme)) {
                UserSettings.color_theme = preferredTheme;
              }
              if (preferredLang && String(UserSettings.app_language) !== String(preferredLang)) {
                UserSettings.app_language = preferredLang;
              }
            }
          } catch (_) {}
          isRestoringDraft = false;
          tryPatchPuzzleProto();
          notifyRedraw();
        });
    } catch (_) {
      isRestoringDraft = false;
    }
  }

  function notifyRedraw() {
    frameVersion++;
    scheduleDraftSave();
    listeners.forEach(function (fn) {
      try {
        fn(frameVersion);
      } catch (_) {}
    });
  }

  origWinAddEventListener('pagehide', saveDraftNow);
  origWinAddEventListener('beforeunload', saveDraftNow);
  origAddEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      saveDraftNow();
    }
  });

  function patchPuzzlePrototype(proto) {
    if (!proto || proto === Object.prototype) return;
    if (
      Object.prototype.hasOwnProperty.call(proto, 'maketext_baseurl') &&
      typeof proto.maketext_baseurl === 'function' &&
      !proto.maketext_baseurl.__acOfficialBaseUrl
    ) {
      var officialBaseUrlFn = function () {
        return OFFICIAL_PENPA_BASE_URL;
      };
      officialBaseUrlFn.__acOfficialBaseUrl = true;
      proto.maketext_baseurl = officialBaseUrlFn;
    }
    if (!patchedProtos.has(proto)) {
      patchedProtos.add(proto);
      if (
        Object.prototype.hasOwnProperty.call(proto, 'redraw') &&
        typeof proto.redraw === 'function'
      ) {
        var origRedraw = proto.redraw;
        proto.redraw = function () {
          var res = origRedraw.apply(this, arguments);
          notifyRedraw();
          return res;
        };
      }
      if (
        Object.prototype.hasOwnProperty.call(proto, 'canvasxy_update') &&
        typeof proto.canvasxy_update === 'function'
      ) {
        var origCanvasUpdate = proto.canvasxy_update;
        proto.canvasxy_update = function () {
          var res = origCanvasUpdate.apply(this, arguments);
          notifyRedraw();
          return res;
        };
      }
    }
  }

  function tryPatchPuzzleProto() {
    relocateHeaderIntoSettingsModal();
    patchDuplicateControl();
    if (typeof window.Puzzle === 'function' && window.Puzzle.prototype) {
      patchPuzzlePrototype(window.Puzzle.prototype);
    }
    if (window.pu) {
      // Walk the full prototype chain (e.g. Puzzle_square -> Puzzle) because ES6 `class Puzzle`
      // is a lexical global binding rather than a `window.Puzzle` property. Patching the base
      // `Puzzle.prototype` ensures every grid subclass (hex, tri, iso, penrose, etc.) inherits
      // the unified official base URL and redraw hooks immediately upon creation.
      var proto = Object.getPrototypeOf(window.pu);
      while (proto && proto !== Object.prototype) {
        patchPuzzlePrototype(proto);
        proto = Object.getPrototypeOf(proto);
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

  // Relocate #header into #modal-settings as early as DOM is ready so it never flashes in the main bar
  if (document.readyState === 'loading') {
    origAddEventListener('DOMContentLoaded', relocateHeaderIntoSettingsModal);
  } else {
    relocateHeaderIntoSettingsModal();
  }

  // Poll until Penpa finishes boot(), then hook redraw and restore saved draft
  var bootTimer = setInterval(function () {
    tryPatchPuzzleProto();
    if (isReady()) {
      clearInterval(bootTimer);
      restoreDraftOnce();
      notifyRedraw();
    }
  }, 80);

  // Notify host app whenever user interacts inside the Penpa+ iframe so canvas selection clears
  // and unfocused dock opacity restores immediately.
  function notifyHostIframeInteract() {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_ON_IFRAME_INTERACT__ === 'function'
      ) {
        window.parent.__PENPAANYWHERE_ON_IFRAME_INTERACT__(GRID_ID);
      }
    } catch (_) {}
  }
  origAddEventListener('pointerdown', notifyHostIframeInteract, true);

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
    // Route all clipboard writes directly to native Android ClipboardManager in overlay mode,
    // bypassing WebView clipboard APIs that silently fail in FLAG_NOT_FOCUSABLE overlay windows.
    function copyViaAndroidClipboard(text) {
      try {
        if (
          window.parent &&
          window.parent.AndroidOverlay &&
          typeof window.parent.AndroidOverlay.copyText === 'function'
        ) {
          return !!window.parent.AndroidOverlay.copyText(String(text == null ? '' : text));
        }
      } catch (_) {}
      return false;
    }

    try {
      var writeTextNative = function (text) {
        copyViaAndroidClipboard(text);
        return Promise.resolve();
      };
      var nativeClipboardProxy = { writeText: writeTextNative };
      if (navigator.clipboard) {
        try {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: writeTextNative,
          });
        } catch (_) {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            get: function () {
              return nativeClipboardProxy;
            },
          });
        }
      } else {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          get: function () {
            return nativeClipboardProxy;
          },
        });
      }
    } catch (_) {}

    if (typeof document.execCommand === 'function') {
      var origExecCommand = document.execCommand.bind(document);
      document.execCommand = function (commandId) {
        if (typeof commandId === 'string' && commandId.toLowerCase() === 'copy') {
          var copiedText = '';
          try {
            var activeEl = document.activeElement;
            if (
              activeEl &&
              (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT') &&
              typeof activeEl.value === 'string'
            ) {
              var selStart = typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : 0;
              var selEnd = typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : activeEl.value.length;
              copiedText = selEnd > selStart ? activeEl.value.slice(selStart, selEnd) : activeEl.value;
            }
            if (!copiedText && window.getSelection) {
              copiedText = String(window.getSelection() || '');
            }
          } catch (_) {}
          return copyViaAndroidClipboard(copiedText);
        }
        return origExecCommand.apply(document, arguments);
      };
    }

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

  // Prevent Ctrl+Wheel browser zoom inside the dock iframe so dock scale stays controlled by PenpaDockWindow
  origWinAddEventListener(
    'wheel',
    function (e) {
      if (e && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  origWinAddEventListener(
    'keydown',
    function (e) {
      if (
        e &&
        e.code === 'F12' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey &&
        window.parent &&
        window.parent !== window &&
        typeof window.parent.__PENPAANYWHERE_TOGGLE_DEVTOOLS__ === 'function'
      ) {
        if (window.parent.__PENPAANYWHERE_TOGGLE_DEVTOOLS__(!e.repeat)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    true
  );

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
    officialBaseUrl: OFFICIAL_PENPA_BASE_URL,
    extractPenpaParamString: extractPenpaParamString,
    toOfficialPenpaUrl: toOfficialPenpaUrl,
    saveDraftNow: saveDraftNow,
    suppressDraftSave: suppressDraftSave,
    setMd3Tokens: function (tokens) {
      if (!tokens || typeof tokens !== 'object') return;
      var rootStyle = document.documentElement && document.documentElement.style;
      if (!rootStyle) return;
      var keys = Object.keys(tokens);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('--md-sys-color-') === 0 && typeof tokens[k] === 'string') {
          rootStyle.setProperty(k, tokens[k]);
        }
      }
    },
    setCustomCss: function (cssText) {
      var id = 'penpaanywhere-custom-css';
      var el = document.getElementById(id);
      if (!cssText || typeof cssText !== 'string' || !cssText.trim()) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        (document.head || document.documentElement).appendChild(el);
      }
      el.textContent = cssText;
    },
    setLanguage: function (lang) {
      if (lang !== 'ZH' && lang !== 'EN' && lang !== 'JP') return;
      try {
        if (typeof UserSettings !== 'undefined') {
          UserSettings.app_language = lang;
          patchDuplicateControl();
          return;
        }
      } catch (_) {}
      try {
        var opt = document.getElementById('language_opt');
        if (opt) {
          opt.value = lang;
          opt.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (_) {}
      patchDuplicateControl();
    },
    subscribe: function (fn) {
      listeners.add(fn);
      return function () {
        listeners.delete(fn);
      };
    },
  };
})();
