package io.github.koolshow.penpaanywhere

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.Region
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

class OverlayService : Service() {

    companion object {
        const val CHANNEL_ID = "penpaanywhere_overlay_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_TOGGLE_PASSTHROUGH = "io.github.koolshow.penpaanywhere.ACTION_TOGGLE_PASSTHROUGH"
        const val ACTION_STOP = "io.github.koolshow.penpaanywhere.ACTION_STOP"

        @Volatile
        var isRunning = false
    }

    /**
     * Fallback proxy window for Android < 13 (API < 33) where AttachedSurfaceControl.setTouchableRegion
     * is not available. On Android 13+, a single WebView window uses exact Region touch masks instead.
     */
    private inner class TouchProxyWindow(val tag: String) {
        val params = WindowManager.LayoutParams(
            0,
            0,
            0,
            0,
            overlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                fitInsetsTypes = 0
                fitInsetsSides = 0
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        private var activeGesture = false
        private var hasPendingRect = false
        private var pendingRect: Rect? = null
        private var attached = false
        private val proxyLoc = IntArray(2)
        private val webLoc = IntArray(2)

        @SuppressLint("ClickableViewAccessibility")
        val view: View = object : View(overlayContext) {
            override fun onTouchEvent(event: MotionEvent): Boolean {
                val wv = webView ?: return false
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> activeGesture = true
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        activeGesture = false
                        if (hasPendingRect) {
                            val r = pendingRect
                            pendingRect = null
                            hasPendingRect = false
                            mainHandler.post { applyRectImmediate(r) }
                        }
                    }
                }
                getLocationOnScreen(proxyLoc)
                wv.getLocationOnScreen(webLoc)
                val mapped = MotionEvent.obtain(event)
                mapped.offsetLocation(
                    (proxyLoc[0] - webLoc[0]).toFloat(),
                    (proxyLoc[1] - webLoc[1]).toFloat(),
                )
                val handled = wv.dispatchTouchEvent(mapped)
                mapped.recycle()
                return handled || true
            }
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
        }

        fun attach() {
            if (attached) return
            view.visibility = View.GONE
            windowManager.addView(view, params)
            attached = true
        }

        fun updateRect(rect: Rect?) {
            if (!attached) return
            if (activeGesture) {
                pendingRect = rect
                hasPendingRect = true
                return
            }
            applyRectImmediate(rect)
        }

        private fun applyRectImmediate(rect: Rect?) {
            if (!attached) return
            if (rect == null || rect.width() <= 2 || rect.height() <= 2) {
                if (view.visibility != View.GONE) {
                    view.visibility = View.GONE
                    params.x = 0
                    params.y = 0
                    params.width = 0
                    params.height = 0
                    try {
                        windowManager.updateViewLayout(view, params)
                    } catch (_: Exception) {
                    }
                }
                return
            }
            val changed = view.visibility != View.VISIBLE ||
                params.x != rect.left ||
                params.y != rect.top ||
                params.width != rect.width() ||
                params.height != rect.height()
            if (!changed) return

            view.visibility = View.VISIBLE
            params.x = rect.left
            params.y = rect.top
            params.width = rect.width()
            params.height = rect.height()
            try {
                windowManager.updateViewLayout(view, params)
            } catch (_: Exception) {
            }
        }

        fun detach() {
            if (!attached) return
            try {
                windowManager.removeView(view)
            } catch (_: Exception) {
            }
            attached = false
        }
    }

    private val useNativeTouchMask: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    private lateinit var overlayContext: Context
    private lateinit var windowManager: WindowManager
    private lateinit var webLayoutParams: WindowManager.LayoutParams
    private var rootContainer: FrameLayout? = null
    private var webView: WebView? = null
    private var screenshotManager: ScreenshotCompositeManager? = null

    // Legacy proxies only used on Android < 13 (API < 33)
    private var boardProxy: TouchProxyWindow? = null
    private var dockProxy: TouchProxyWindow? = null
    private var layersProxy: TouchProxyWindow? = null
    private var toolbarProxy: TouchProxyWindow? = null
    private var barProxy: TouchProxyWindow? = null

    private var regionPassthroughEnabled = true
    private var forceClickThrough = false
    private var focusable = false
    private var calibrating = true

    private var lastBarRect: Rect? = null
    private var lastDockRect: Rect? = null
    private var lastUiRects: List<Rect> = emptyList()
    private var lastBoardRect: Rect? = null
    private var lastQuadPts: List<PointF> = emptyList()
    private var lastQuads: List<List<PointF>> = emptyList()
    private var lastGizmoQuad: List<PointF> = emptyList()
    private var lastCornerPts: List<PointF> = emptyList()
    private var lastScaleX = 1f
    private var lastPayloadJson: String? = null
    private var storageFlushedForStop = false
    @Volatile
    private var lastSafeInsetsJson: String = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

    private val mainHandler = Handler(Looper.getMainLooper())
    private val reapplyTouchRegionsRunnable = Runnable { applyTouchRegions() }

    private fun scheduleReapplyTouchRegions() {
        mainHandler.removeCallbacks(reapplyTouchRegionsRunnable)
        mainHandler.post(reapplyTouchRegionsRunnable)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Log.w("PenpaAnywhereWeb", "OverlayService started without SYSTEM_ALERT_WINDOW permission; stopping safely")
            Toast.makeText(this, getString(R.string.toast_overlay_permission_missing), Toast.LENGTH_SHORT).show()
            isRunning = false
            stopSelf()
            return
        }
        isRunning = true
        overlayContext = createOverlayUiContext()
        windowManager = overlayContext.getSystemService(WINDOW_SERVICE) as WindowManager
        attachOverlayWindows()
    }

    private fun overlayWindowType(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
    }

    private fun createOverlayUiContext(): Context {
        val base = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val dm = getSystemService(DisplayManager::class.java)
            val display = dm.getDisplay(Display.DEFAULT_DISPLAY)
            createDisplayContext(display)
                .createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        } else {
            this
        }
        return Md3DynamicColorProvider.wrapWithDynamicTheme(base)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        overlayContext = createOverlayUiContext()
        val bundleJson = Md3DynamicColorProvider.exportDualTokensJson(overlayContext, newConfig)
        mainHandler.post {
            webView?.evaluateJavascript(
                "window.__PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__ && window.__PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__($bundleJson);",
                null,
            )
            lastPayloadJson?.let { handleUpdateHitRegions(it) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE_PASSTHROUGH -> {
                setClickThroughState(!forceClickThrough)
            }
            ACTION_STOP -> {
                flushWebStorageAndStop()
            }
        }
        return START_STICKY
    }

    private fun safePassthroughAlpha(): Float {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val im = getSystemService(InputManager::class.java)
            val maxOpacity = im?.maximumObscuringOpacityForTouch ?: 0.8f
            (maxOpacity - 0.02f).coerceIn(0.5f, 0.78f)
        } else {
            1.0f
        }
    }

    private fun computeWebWindowFlags(): Int {
        var f = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED

        // On API 33+, the WebView itself receives touches strictly inside rootSurfaceControl.setTouchableRegion(mask),
        // so it must NOT have FLAG_NOT_TOUCHABLE. On API < 33, legacy TouchProxyWindows forward touches instead.
        if (!useNativeTouchMask && regionPassthroughEnabled) {
            f = f or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        if (!focusable || forceClickThrough) {
            f = f or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        }
        return f
    }

    private fun attachOverlayWindows() {
        webLayoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            overlayWindowType(),
            computeWebWindowFlags(),
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                alpha = safePassthroughAlpha()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                fitInsetsTypes = 0
                fitInsetsSides = 0
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        val bridge = OverlayWebViewFactory.JsBridge(
            overlayMode = true,
            onClickThrough = { enabled -> setClickThroughState(enabled) },
            onFocusable = { canFocus ->
                mainHandler.post {
                    focusable = canFocus
                    updateWebWindowFlags()
                }
            },
            onUpdateHitRegions = { payloadJson ->
                mainHandler.post { handleUpdateHitRegions(payloadJson) }
            },
            onGetDynamicColorTokens = {
                Md3DynamicColorProvider.exportCssTokensJson(overlayContext)
            },
            onGetDynamicColorBundle = {
                Md3DynamicColorProvider.exportDualTokensJson(overlayContext)
            },
            onGetSafeAreaInsets = {
                lastSafeInsetsJson
            },
            onGetScreenshotCompositeStatus = {
                screenshotManager?.getStatusJson() ?: "{}"
            },
            onSetScreenshotCompositeEnabled = { enabled ->
                mainHandler.post { screenshotManager?.setEnabled(enabled) }
            },
            onRespondScreenshotPrompt = { choice ->
                mainHandler.post { screenshotManager?.respondToFirstTimePrompt(choice) }
            },
            onRequestAllFilesPermission = {
                mainHandler.post { screenshotManager?.requestWritePermissionFromUi() }
            },
            onSwitchToImageActivity = {
                mainHandler.post { switchToImageActivity() }
            },
            onOpenExternalUrl = { url ->
                mainHandler.post {
                    OverlayWebViewFactory.openExternalBrowserUrl(overlayContext, url, newTask = true)
                }
            },
            onSaveDownloadFile = { filename, mimeType, base64Data ->
                OverlayWebViewFactory.saveDownloadFile(overlayContext, filename, mimeType, base64Data)
            },
            onCopyText = { text ->
                OverlayWebViewFactory.copyTextToClipboard(overlayContext, text)
            },
            onClose = {
                mainHandler.post { flushWebStorageAndStop() }
            },
            onPickImage = {
                mainHandler.post { launchImagePicker() }
            },
        )

        val container = FrameLayout(overlayContext).apply {
            setBackgroundColor(Color.TRANSPARENT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                isForceDarkAllowed = false
            }
        }
        val wv = OverlayWebViewFactory.create(overlayContext, bridge).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                isForceDarkAllowed = false
            }
        }
        container.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        rootContainer = container
        webView = wv

        windowManager.addView(container, webLayoutParams)

        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            updateSafeAreaInsetsFromView(v, insets)
            insets
        }
        ViewCompat.requestApplyInsets(container)

        if (!useNativeTouchMask) {
            boardProxy = TouchProxyWindow("board").also { it.attach() }
            dockProxy = TouchProxyWindow("dock").also { it.attach() }
            layersProxy = TouchProxyWindow("layers").also { it.attach() }
            toolbarProxy = TouchProxyWindow("toolbar").also { it.attach() }
            barProxy = TouchProxyWindow("bar").also { it.attach() }
        }

        container.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if ((right - left) != (oldRight - oldLeft) || (bottom - top) != (oldBottom - oldTop)) {
                scheduleReapplyTouchRegions()
            }
        }
        wv.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if ((right - left) != (oldRight - oldLeft) || (bottom - top) != (oldBottom - oldTop)) {
                rootContainer?.let { ViewCompat.requestApplyInsets(it) }
                lastPayloadJson?.let { payload ->
                    mainHandler.post { handleUpdateHitRegions(payload) }
                }
            }
        }
        wv.onResume()
        wv.resumeTimers()
        wv.loadUrl(OverlayWebViewFactory.ENTRY_URL)

        screenshotManager = ScreenshotCompositeManager(
            context = this,
            captureOverlayAsync = { cb ->
                val activeWv = webView
                if (activeWv == null) {
                    cb(false, null)
                    return@ScreenshotCompositeManager
                }
                // Capture the full overlay WebView (control bar, Penpa+ dock, SVG handles, DOM)
                // along with its exact on-screen pixel rect so compositing aligns 1:1 with the display.
                val fullBmp = captureFullWebViewBitmap(activeWv)
                val loc = IntArray(2)
                activeWv.getLocationOnScreen(loc)
                val screenRect = if (activeWv.width > 0 && activeWv.height > 0) {
                    Rect(loc[0], loc[1], loc[0] + activeWv.width, loc[1] + activeWv.height)
                } else {
                    null
                }
                activeWv.evaluateJavascript(
                    "window.__PENPAANYWHERE_CAPTURE_OVERLAY__ ? window.__PENPAANYWHERE_CAPTURE_OVERLAY__() : null;",
                ) { raw ->
                    if (raw == null || raw == "null") {
                        fullBmp?.recycle()
                        cb(false, null)
                        return@evaluateJavascript
                    }
                    try {
                        val obj = JSONObject(raw)
                        val active = obj.optBoolean("active", false)
                        val dataUrl = obj.optString("dataUrl", "").ifBlank { null }
                        if (!active) {
                            fullBmp?.recycle()
                            cb(false, null)
                        } else {
                            cb(true, ScreenshotCompositeManager.OverlaySnapshot(fullBmp, dataUrl, screenRect))
                        }
                    } catch (_: Exception) {
                        fullBmp?.recycle()
                        cb(false, null)
                    }
                }
            },
            onShowFirstTimePrompt = { fileName ->
                val quoted = JSONObject.quote(fileName)
                webView?.evaluateJavascript(
                    "window.__PENPAANYWHERE_ON_SCREENSHOT_PROMPT__ && window.__PENPAANYWHERE_ON_SCREENSHOT_PROMPT__($quoted);",
                    null,
                )
            },
            onStatusChanged = { statusJson ->
                webView?.evaluateJavascript(
                    "window.__PENPAANYWHERE_ON_SCREENSHOT_STATUS__ && window.__PENPAANYWHERE_ON_SCREENSHOT_STATUS__($statusJson);",
                    null,
                )
            },
        ).also { it.start() }

        mainHandler.postDelayed({
            Log.i(
                "PenpaAnywhereWeb",
                "Overlay attached (nativeTouchMask=$useNativeTouchMask): hwAccel=${wv.isHardwareAccelerated}, size=${wv.width}x${wv.height}",
            )
            lastPayloadJson?.let { handleUpdateHitRegions(it) }
            wv.invalidate()
        }, 1000)
    }

    private fun updateSafeAreaInsetsFromView(view: View, insets: WindowInsetsCompat) {
        val sys = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        val topCss = (sys.top / density).roundToInt().coerceAtLeast(0)
        val rightCss = (sys.right / density).roundToInt().coerceAtLeast(0)
        val bottomCss = (sys.bottom / density).roundToInt().coerceAtLeast(0)
        val leftCss = (sys.left / density).roundToInt().coerceAtLeast(0)
        val json = "{\"top\":$topCss,\"right\":$rightCss,\"bottom\":$bottomCss,\"left\":$leftCss}"
        if (json == lastSafeInsetsJson) return
        lastSafeInsetsJson = json
        Log.i("PenpaAnywhereWeb", "Overlay safe-area insets (CSS px): $json (raw px=${sys.top},${sys.right},${sys.bottom},${sys.left}, view=${view.width}x${view.height})")
        mainHandler.post {
            webView?.evaluateJavascript(
                "window.__PENPAANYWHERE_APPLY_SAFE_INSETS__ && window.__PENPAANYWHERE_APPLY_SAFE_INSETS__($json);",
                null,
            )
        }
    }

    private fun captureFullWebViewBitmap(wv: WebView): Bitmap? {
        val w = wv.width
        val h = wv.height
        if (w <= 0 || h <= 0) return null
        return try {
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bmp.eraseColor(Color.TRANSPARENT)
            val canvas = Canvas(bmp)
            canvas.translate(-wv.scrollX.toFloat(), -wv.scrollY.toFloat())
            wv.draw(canvas)
            bmp
        } catch (e: Exception) {
            Log.w("PenpaAnywhereWeb", "captureFullWebViewBitmap failed: ${e.message}")
            null
        }
    }

    private fun parseCssRect(obj: JSONObject?, scaleX: Float, scaleY: Float, padPx: Int): Rect? {
        if (obj == null) return null
        val w = obj.optDouble("w", 0.0)
        val h = obj.optDouble("h", 0.0)
        if (w <= 1.0 || h <= 1.0) return null
        val x = obj.optDouble("x", 0.0)
        val y = obj.optDouble("y", 0.0)
        val maxW = webView?.width?.takeIf { it > 0 } ?: 10000
        val maxH = webView?.height?.takeIf { it > 0 } ?: 10000
        val left = ((x * scaleX).roundToInt() - padPx).coerceIn(0, maxW)
        val top = ((y * scaleY).roundToInt() - padPx).coerceIn(0, maxH)
        val right = (((x + w) * scaleX).roundToInt() + padPx).coerceIn(0, maxW)
        val bottom = (((y + h) * scaleY).roundToInt() + padPx).coerceIn(0, maxH)
        return if (right > left && bottom > top) Rect(left, top, right, bottom) else null
    }

    private fun parseCssPoints(arr: JSONArray?, scaleX: Float, scaleY: Float): List<PointF> {
        if (arr == null || arr.length() == 0) return emptyList()
        val list = ArrayList<PointF>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val x = (o.optDouble("x", 0.0) * scaleX).toFloat()
            val y = (o.optDouble("y", 0.0) * scaleY).toFloat()
            list.add(PointF(x, y))
        }
        return list
    }

    private fun handleUpdateHitRegions(payloadJson: String) {
        lastPayloadJson = payloadJson
        val wv = webView ?: return
        try {
            val json = JSONObject(payloadJson)
            val nextPassthrough = json.optBoolean("passthroughEnabled", true)
            val nextForce = json.optBoolean("forceClickThrough", false)
            calibrating = json.optBoolean("calibrating", true)

            val vw = json.optDouble("viewportW", 0.0).takeIf { it > 0 } ?: 1.0
            val vh = json.optDouble("viewportH", 0.0).takeIf { it > 0 } ?: 1.0

            val scaleX = if (wv.width > 0) (wv.width.toDouble() / vw).toFloat() else resources.displayMetrics.density
            val scaleY = if (wv.height > 0) (wv.height.toDouble() / vh).toFloat() else resources.displayMetrics.density
            lastScaleX = scaleX

            val barPad = if (useNativeTouchMask) 2 else 6
            val dockPad = if (useNativeTouchMask) 2 else 4
            lastBarRect = parseCssRect(json.optJSONObject("barRect"), scaleX, scaleY, barPad)
            lastDockRect = parseCssRect(json.optJSONObject("dockRect"), scaleX, scaleY, dockPad)
            val uiArr = json.optJSONArray("uiRects")
            val parsedUi = ArrayList<Rect>()
            if (uiArr != null) {
                for (i in 0 until uiArr.length()) {
                    parseCssRect(uiArr.optJSONObject(i), scaleX, scaleY, dockPad)?.let { parsedUi.add(it) }
                }
            }
            lastUiRects = parsedUi
            lastBoardRect = parseCssRect(json.optJSONObject("boardRect"), scaleX, scaleY, 4)
            lastQuadPts = parseCssPoints(json.optJSONArray("quad"), scaleX, scaleY)
            val quadsArr = json.optJSONArray("quads")
            val parsedQuads = ArrayList<List<PointF>>()
            if (quadsArr != null) {
                for (i in 0 until quadsArr.length()) {
                    val pts = parseCssPoints(quadsArr.optJSONArray(i), scaleX, scaleY)
                    if (pts.size == 4) parsedQuads.add(pts)
                }
            }
            if (parsedQuads.isEmpty() && lastQuadPts.size == 4) {
                parsedQuads.add(lastQuadPts)
            }
            lastQuads = parsedQuads
            lastGizmoQuad = parseCssPoints(json.optJSONArray("gizmoQuad"), scaleX, scaleY)
            lastCornerPts = parseCssPoints(json.optJSONArray("corners"), scaleX, scaleY)

            val flagsChanged = (nextPassthrough != regionPassthroughEnabled) || (nextForce != forceClickThrough)
            regionPassthroughEnabled = nextPassthrough
            forceClickThrough = nextForce
            if (flagsChanged) {
                updateWebWindowFlags()
            }
            applyTouchRegions()
            if (flagsChanged) {
                // Re-apply after updateViewLayout's scheduled traversal so WMS/SurfaceFlinger never keeps stale bounds
                scheduleReapplyTouchRegions()
            }
        } catch (e: Exception) {
            Log.e("PenpaAnywhereWeb", "updateHitRegions parse failed: ${e.message}")
        }
    }

    private fun applyTouchRegions() {
        if (useNativeTouchMask) {
            applyNativeSurfaceTouchableRegion()
            return
        }
        if (!regionPassthroughEnabled) {
            boardProxy?.updateRect(null)
            dockProxy?.updateRect(null)
            layersProxy?.updateRect(null)
            toolbarProxy?.updateRect(null)
            barProxy?.updateRect(null)
            return
        }
        // PenpaDockWindow, LayersWindow, ElementToolbar & ControlBar never pass through;
        // only boardProxy is excluded when grid element passThrough is enabled.
        boardProxy?.updateRect(if (forceClickThrough) null else lastBoardRect)
        dockProxy?.updateRect(lastDockRect)
        layersProxy?.updateRect(lastUiRects.getOrNull(0))
        toolbarProxy?.updateRect(lastUiRects.getOrNull(1))
        barProxy?.updateRect(lastBarRect)
    }

    /**
     * Android 13+ (API 33+): directly supply an exact pixel-aligned Region touch mask to the
     * window's AttachedSurfaceControl. Supports arbitrary perspective quadrilaterals + circular
     * corner handles + toolbar + Penpa dock in surface-local coordinates with zero offset error.
     */
    private fun applyNativeSurfaceTouchableRegion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val root = rootContainer ?: return
        if (!root.isAttachedToWindow) return
        val sc = root.rootSurfaceControl
        val w = root.width
        val h = root.height
        if (sc == null || w <= 0 || h <= 0) {
            scheduleReapplyTouchRegions()
            return
        }

        val clip = Region(0, 0, w, h)
        if (!regionPassthroughEnabled) {
            // Pass an explicit non-null full-window Region instead of null:
            // On Android 13/14 ViewRootImpl.performTraversals(), setTouchableRegion(null) skips
            // mWindowSession.setInsets() when no OnComputeInternalInsetsListener is registered
            // (`&& mTouchableRegion != null`), leaving the previous toolbar/dock mask stuck in WMS.
            sc.setTouchableRegion(clip)
            return
        }

        val mask = Region()

        // Always keep ControlBar, PenpaDockWindow(s), LayersWindow, and Element Floating Toolbar interactive
        lastBarRect?.let { mask.op(it, Region.Op.UNION) }
        lastDockRect?.let { mask.op(it, Region.Op.UNION) }
        for (uiRect in lastUiRects) {
            mask.op(uiRect, Region.Op.UNION)
        }

        if (!forceClickThrough) {
            // Exact arbitrary perspective quad masks for ALL interactive world elements (grids, images, screens)
            if (lastQuads.isNotEmpty()) {
                for (polyPts in lastQuads) {
                    val polyPath = Path().apply {
                        moveTo(polyPts[0].x, polyPts[0].y)
                        lineTo(polyPts[1].x, polyPts[1].y)
                        lineTo(polyPts[2].x, polyPts[2].y)
                        lineTo(polyPts[3].x, polyPts[3].y)
                        close()
                    }
                    val polyRegion = Region()
                    polyRegion.setPath(polyPath, clip)
                    mask.op(polyRegion, Region.Op.UNION)
                }
            } else {
                lastBoardRect?.let { mask.op(it, Region.Op.UNION) }
            }

            // Include stroked border touch area for the active transform gizmo (so group border edges &
            // corners extending outside individual child quads remain fully draggable in overlay mode,
            // while keeping the hollow interior transparent to underlying touches).
            if (lastGizmoQuad.size == 4) {
                val borderPath = Path().apply {
                    moveTo(lastGizmoQuad[0].x, lastGizmoQuad[0].y)
                    lineTo(lastGizmoQuad[1].x, lastGizmoQuad[1].y)
                    lineTo(lastGizmoQuad[2].x, lastGizmoQuad[2].y)
                    lineTo(lastGizmoQuad[3].x, lastGizmoQuad[3].y)
                    close()
                }
                val strokePaint = Paint().apply {
                    style = Paint.Style.STROKE
                    strokeWidth = (32f * lastScaleX).coerceAtLeast(44f)
                    strokeCap = Paint.Cap.ROUND
                    strokeJoin = Paint.Join.ROUND
                }
                val strokedBorderPath = Path()
                strokePaint.getFillPath(borderPath, strokedBorderPath)
                val borderRegion = Region()
                borderRegion.setPath(strokedBorderPath, clip)
                mask.op(borderRegion, Region.Op.UNION)
            }

            // Include circular touch targets around the perspective corner/edge handles during calibration
            if (calibrating && lastCornerPts.isNotEmpty()) {
                val handleRadiusPx = (24f * lastScaleX).coerceAtLeast(36f)
                val handlePath = Path()
                for (pt in lastCornerPts) {
                    handlePath.addCircle(pt.x, pt.y, handleRadiusPx, Path.Direction.CW)
                }
                val handleRegion = Region()
                handleRegion.setPath(handlePath, clip)
                mask.op(handleRegion, Region.Op.UNION)
            }
        }

        sc.setTouchableRegion(mask)
    }

    private fun switchToImageActivity() {
        val launch = Runnable {
            val intent = Intent(this, MainActivity::class.java).apply {
                putExtra(MainActivity.EXTRA_OPEN_IMAGE_MODE, true)
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP,
                )
            }
            try {
                startActivity(intent)
            } catch (_: Exception) {
            }
            stopSelf()
        }
        val wv = webView
        if (wv == null) {
            launch.run()
            return
        }
        var done = false
        val finish = Runnable {
            if (!done) {
                done = true
                storageFlushedForStop = true
                try {
                    CookieManager.getInstance().flush()
                } catch (_: Exception) {
                }
                launch.run()
            }
        }
        mainHandler.postDelayed(finish, 180)
        try {
            wv.evaluateJavascript(
                "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
            ) {
                mainHandler.removeCallbacks(finish)
                finish.run()
            }
        } catch (_: Exception) {
            mainHandler.removeCallbacks(finish)
            finish.run()
        }
    }

    private fun launchImagePicker() {
        ImagePickerActivity.onImagePicked = { dataUrl ->
            mainHandler.post {
                val quoted = JSONObject.quote(dataUrl)
                webView?.evaluateJavascript(
                    "window.__PENPAANYWHERE_ON_ANDROID_IMAGE__ && window.__PENPAANYWHERE_ON_ANDROID_IMAGE__($quoted);",
                    null,
                )
            }
        }
        val intent = Intent(this, ImagePickerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
    }

    private fun setClickThroughState(enabled: Boolean) {
        mainHandler.post {
            forceClickThrough = enabled
            updateWebWindowFlags()
            applyTouchRegions()
            webView?.evaluateJavascript(
                "window.__PENPAANYWHERE_ON_CLICK_THROUGH__ && window.__PENPAANYWHERE_ON_CLICK_THROUGH__($enabled);",
                null,
            )
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun updateWebWindowFlags() {
        val root = rootContainer ?: return
        webLayoutParams.flags = computeWebWindowFlags()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            webLayoutParams.alpha = if (regionPassthroughEnabled) safePassthroughAlpha() else 1.0f
        }
        try {
            windowManager.updateViewLayout(root, webLayoutParams)
        } catch (_: Exception) {
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val toggleIntent = Intent(this, OverlayService::class.java).apply {
            action = ACTION_TOGGLE_PASSTHROUGH
        }
        val togglePending = PendingIntent.getService(
            this,
            1,
            toggleIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = Intent(this, OverlayService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val status = if (forceClickThrough) {
            getString(R.string.notification_status_passthrough)
        } else {
            getString(R.string.notification_status_interactive)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(status)
            .setOngoing(true)
            .addAction(
                0,
                if (forceClickThrough) {
                    getString(R.string.notification_action_unlock)
                } else {
                    getString(R.string.notification_action_lock)
                },
                togglePending,
            )
            .addAction(0, getString(R.string.notification_action_stop), stopPending)
            .build()
    }

    private fun flushWebStorageAndStop() {
        val wv = webView
        if (wv == null) {
            stopSelf()
            return
        }
        var stopped = false
        val doStop = Runnable {
            if (!stopped) {
                stopped = true
                storageFlushedForStop = true
                try {
                    CookieManager.getInstance().flush()
                } catch (_: Exception) {
                }
                stopSelf()
            }
        }
        mainHandler.postDelayed(doStop, 150)
        try {
            wv.evaluateJavascript(
                "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
            ) {
                mainHandler.removeCallbacks(doStop)
                doStop.run()
            }
        } catch (_: Exception) {
            mainHandler.removeCallbacks(doStop)
            doStop.run()
        }
    }

    override fun onDestroy() {
        isRunning = false
        mainHandler.removeCallbacks(reapplyTouchRegionsRunnable)
        screenshotManager?.stop()
        screenshotManager = null
        ImagePickerActivity.onImagePicked = null
        barProxy?.detach()
        dockProxy?.detach()
        layersProxy?.detach()
        toolbarProxy?.detach()
        boardProxy?.detach()
        barProxy = null
        dockProxy = null
        layersProxy = null
        toolbarProxy = null
        boardProxy = null
        rootContainer?.let { root ->
            try {
                windowManager.removeView(root)
            } catch (_: Exception) {
            }
        }
        webView?.let { wv ->
            if (!storageFlushedForStop) {
                try {
                    wv.evaluateJavascript(
                        "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
                        null,
                    )
                } catch (_: Exception) {
                }
            }
            wv.onPause()
            wv.destroy()
        }
        rootContainer = null
        webView = null
        super.onDestroy()
    }
}
