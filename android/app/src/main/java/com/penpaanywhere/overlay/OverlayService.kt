package com.penpaanywhere.overlay

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.Region
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

class OverlayService : Service() {

    companion object {
        const val CHANNEL_ID = "penpaanywhere_overlay_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_TOGGLE_PASSTHROUGH = "com.penpaanywhere.overlay.ACTION_TOGGLE_PASSTHROUGH"
        const val ACTION_STOP = "com.penpaanywhere.overlay.ACTION_STOP"

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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        private var activeGesture = false
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
                        pendingRect?.let { r ->
                            pendingRect = null
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

    // Legacy proxies only used on Android < 13 (API < 33)
    private var boardProxy: TouchProxyWindow? = null
    private var dockProxy: TouchProxyWindow? = null
    private var barProxy: TouchProxyWindow? = null

    private var regionPassthroughEnabled = true
    private var forceClickThrough = false
    private var focusable = false
    private var calibrating = true

    private var lastBarRect: Rect? = null
    private var lastDockRect: Rect? = null
    private var lastBoardRect: Rect? = null
    private var lastQuadPts: List<PointF> = emptyList()
    private var lastCornerPts: List<PointF> = emptyList()
    private var lastScaleX = 1f
    private var lastPayloadJson: String? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        overlayContext = createOverlayUiContext()
        windowManager = overlayContext.getSystemService(WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
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
        val tokensJson = Md3DynamicColorProvider.exportCssTokensJson(overlayContext)
        mainHandler.post {
            webView?.evaluateJavascript(
                "window.__PENPAANYWHERE_APPLY_MD3_TOKENS__ && window.__PENPAANYWHERE_APPLY_MD3_TOKENS__($tokensJson);",
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
                stopSelf()
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
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
            onClose = {
                mainHandler.post { stopSelf() }
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

        if (!useNativeTouchMask) {
            boardProxy = TouchProxyWindow("board").also { it.attach() }
            dockProxy = TouchProxyWindow("dock").also { it.attach() }
            barProxy = TouchProxyWindow("bar").also { it.attach() }
        }

        wv.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if ((right - left) != (oldRight - oldLeft) || (bottom - top) != (oldBottom - oldTop)) {
                lastPayloadJson?.let { payload ->
                    mainHandler.post { handleUpdateHitRegions(payload) }
                }
            }
        }
        wv.onResume()
        wv.resumeTimers()
        wv.loadUrl(OverlayWebViewFactory.ENTRY_URL)

        mainHandler.postDelayed({
            Log.i(
                "PenpaAnywhereWeb",
                "Overlay attached (nativeTouchMask=$useNativeTouchMask): hwAccel=${wv.isHardwareAccelerated}, size=${wv.width}x${wv.height}",
            )
            lastPayloadJson?.let { handleUpdateHitRegions(it) }
            wv.invalidate()
        }, 1000)
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
            lastBoardRect = parseCssRect(json.optJSONObject("boardRect"), scaleX, scaleY, 4)
            lastQuadPts = parseCssPoints(json.optJSONArray("quad"), scaleX, scaleY)
            lastCornerPts = parseCssPoints(json.optJSONArray("corners"), scaleX, scaleY)

            val flagsChanged = (nextPassthrough != regionPassthroughEnabled) || (nextForce != forceClickThrough)
            regionPassthroughEnabled = nextPassthrough
            forceClickThrough = nextForce
            if (flagsChanged) {
                updateWebWindowFlags()
            }
            applyTouchRegions()
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
            barProxy?.updateRect(null)
            return
        }
        if (forceClickThrough) {
            boardProxy?.updateRect(null)
            dockProxy?.updateRect(null)
            barProxy?.updateRect(lastBarRect)
            return
        }
        boardProxy?.updateRect(lastBoardRect)
        dockProxy?.updateRect(lastDockRect)
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
        val sc = root.rootSurfaceControl ?: return

        if (!regionPassthroughEnabled) {
            // Non-overlay (uploaded image) mode: whole window is touchable
            sc.setTouchableRegion(null)
            return
        }

        val w = root.width.takeIf { it > 0 } ?: return
        val h = root.height.takeIf { it > 0 } ?: return
        val clip = Region(0, 0, w, h)
        val mask = Region()

        // Always keep top control bar interactive so user can unlock passthrough / switch modes
        lastBarRect?.let { mask.op(it, Region.Op.UNION) }

        if (!forceClickThrough) {
            lastDockRect?.let { mask.op(it, Region.Op.UNION) }

            // Exact arbitrary perspective quad mask (matches distorted trapezoid/quadrilateral!)
            val polyPts = if (lastQuadPts.size == 4) lastQuadPts else lastCornerPts
            if (polyPts.size == 4) {
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
            } else {
                lastBoardRect?.let { mask.op(it, Region.Op.UNION) }
            }

            // Include circular touch targets around the 4 perspective corner handles during calibration
            if (calibrating && lastCornerPts.isNotEmpty()) {
                val handleRadiusPx = (22f * lastScaleX).coerceAtLeast(32f)
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
                "PenpaAnywhere 透明叠加层",
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

        val status = if (forceClickThrough) "当前：题板已穿透（点顶栏或此通知恢复）" else "当前：精确蒙版穿透 / 元素区可交互"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle("PenpaAnywhere 叠加层运行中")
            .setContentText(status)
            .setOngoing(true)
            .addAction(
                0,
                if (forceClickThrough) "恢复题板交互" else "锁定题板穿透",
                togglePending,
            )
            .addAction(0, "关闭叠加层", stopPending)
            .build()
    }

    override fun onDestroy() {
        isRunning = false
        ImagePickerActivity.onImagePicked = null
        barProxy?.detach()
        dockProxy?.detach()
        boardProxy?.detach()
        barProxy = null
        dockProxy = null
        boardProxy = null
        rootContainer?.let { root ->
            try {
                windowManager.removeView(root)
            } catch (_: Exception) {
            }
        }
        webView?.let { wv ->
            wv.onPause()
            wv.destroy()
        }
        rootContainer = null
        webView = null
        super.onDestroy()
    }
}
