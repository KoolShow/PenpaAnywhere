package com.penpacanvas.overlay

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import kotlin.math.roundToInt

class OverlayService : Service() {

    companion object {
        const val CHANNEL_ID = "penpacanvas_overlay_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_TOGGLE_PASSTHROUGH = "com.penpacanvas.overlay.ACTION_TOGGLE_PASSTHROUGH"
        const val ACTION_STOP = "com.penpacanvas.overlay.ACTION_STOP"

        @Volatile
        var isRunning = false
    }

    /**
     * Transparent touch-proxy window placed strictly over an interactive web UI region
     * (control bar, Penpa dock, or perspective board). It forwards local MotionEvents to
     * the full-screen non-touchable WebView using exact coordinate offset, leaving every
     * transparent area outside those regions 100% click-through to underlying Android apps.
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
                        // Apply any deferred geometry update right after finger lifts
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
                // Keep proxy alive and untouched mid-drag so gesture stream is never dropped
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

    private lateinit var overlayContext: Context
    private lateinit var windowManager: WindowManager
    private lateinit var webLayoutParams: WindowManager.LayoutParams
    private var rootContainer: FrameLayout? = null
    private var webView: WebView? = null

    // Z-order matches CSS: board (bottom) < dock (middle) < bar (top)
    private var boardProxy: TouchProxyWindow? = null
    private var dockProxy: TouchProxyWindow? = null
    private var barProxy: TouchProxyWindow? = null

    private var regionPassthroughEnabled = true
    private var forceClickThrough = false
    private var focusable = false
    private var lastBarRect: Rect? = null
    private var lastDockRect: Rect? = null
    private var lastBoardRect: Rect? = null
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
        return ContextThemeWrapper(base, R.style.Theme_PenpaCanvas)
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

    private fun computeWebWindowFlags(): Int {
        var f = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED

        // When region passthrough is active, the full-screen WebView is purely visual (NOT_TOUCHABLE);
        // only the dynamic TouchProxyWindows over actual UI/board rects capture touch!
        if (regionPassthroughEnabled) {
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
            // On Android 12+ (API 31+), keep non-touchable overlay within system untrusted-touch
            // opacity ceiling (0.8) so touches outside proxies pass straight through to underlying apps.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                alpha = 0.8f
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

        // 1. Bottom-most: full-screen transparent WebView renderer
        windowManager.addView(container, webLayoutParams)

        // 2. Touch proxies stacked in exact CSS z-order above WebView
        boardProxy = TouchProxyWindow("board").also { it.attach() }
        dockProxy = TouchProxyWindow("dock").also { it.attach() }
        barProxy = TouchProxyWindow("bar").also { it.attach() }

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
                "PenpaCanvasWeb",
                "Overlay attached (multi-proxy passthrough): hwAccel=${wv.isHardwareAccelerated}, size=${wv.width}x${wv.height}",
            )
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
        val left = (x * scaleX).roundToInt() - padPx
        val top = (y * scaleY).roundToInt() - padPx
        val right = ((x + w) * scaleX).roundToInt() + padPx
        val bottom = ((y + h) * scaleY).roundToInt() + padPx
        val maxW = webView?.width?.takeIf { it > 0 } ?: 10000
        val maxH = webView?.height?.takeIf { it > 0 } ?: 10000
        return Rect(
            left.coerceIn(0, maxW),
            top.coerceIn(0, maxH),
            right.coerceIn(0, maxW),
            bottom.coerceIn(0, maxH),
        )
    }

    private fun handleUpdateHitRegions(payloadJson: String) {
        lastPayloadJson = payloadJson
        val wv = webView ?: return
        try {
            val json = JSONObject(payloadJson)
            val nextPassthrough = json.optBoolean("passthroughEnabled", true)
            val nextForce = json.optBoolean("forceClickThrough", false)
            val vw = json.optDouble("viewportW", 0.0).takeIf { it > 0 } ?: 1.0
            val vh = json.optDouble("viewportH", 0.0).takeIf { it > 0 } ?: 1.0

            val scaleX = if (wv.width > 0) (wv.width.toDouble() / vw).toFloat() else resources.displayMetrics.density
            val scaleY = if (wv.height > 0) (wv.height.toDouble() / vh).toFloat() else resources.displayMetrics.density

            lastBarRect = parseCssRect(json.optJSONObject("barRect"), scaleX, scaleY, 6)
            lastDockRect = parseCssRect(json.optJSONObject("dockRect"), scaleX, scaleY, 4)
            lastBoardRect = parseCssRect(json.optJSONObject("boardRect"), scaleX, scaleY, 4)

            val flagsChanged = (nextPassthrough != regionPassthroughEnabled) || (nextForce != forceClickThrough)
            regionPassthroughEnabled = nextPassthrough
            forceClickThrough = nextForce
            if (flagsChanged) {
                updateWebWindowFlags()
            }
            applyProxyRegions()
        } catch (e: Exception) {
            Log.e("PenpaCanvasWeb", "updateHitRegions parse failed: ${e.message}")
        }
    }

    private fun applyProxyRegions() {
        if (!regionPassthroughEnabled) {
            // Non-overlay mode (e.g. uploaded image mode): WebView handles full-screen touches directly
            boardProxy?.updateRect(null)
            dockProxy?.updateRect(null)
            barProxy?.updateRect(null)
            return
        }
        if (forceClickThrough) {
            // Locked pass-through: board & dock pass straight through, keep top control bar tappable to unlock!
            boardProxy?.updateRect(null)
            dockProxy?.updateRect(null)
            barProxy?.updateRect(lastBarRect)
            return
        }
        // Smart region passthrough: only board, dock, and bar intercept touch; all other transparent space passes through!
        boardProxy?.updateRect(lastBoardRect)
        dockProxy?.updateRect(lastDockRect)
        barProxy?.updateRect(lastBarRect)
    }

    private fun launchImagePicker() {
        ImagePickerActivity.onImagePicked = { dataUrl ->
            mainHandler.post {
                val quoted = JSONObject.quote(dataUrl)
                webView?.evaluateJavascript(
                    "window.__PENPACANVAS_ON_ANDROID_IMAGE__ && window.__PENPACANVAS_ON_ANDROID_IMAGE__($quoted);",
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
            applyProxyRegions()
            webView?.evaluateJavascript(
                "window.__PENPACANVAS_ON_CLICK_THROUGH__ && window.__PENPACANVAS_ON_CLICK_THROUGH__($enabled);",
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
            webLayoutParams.alpha = if (regionPassthroughEnabled) 0.8f else 1.0f
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
                "PenpaCanvas 透明叠加层",
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

        val status = if (forceClickThrough) "当前：题板已穿透（点顶栏或此通知恢复）" else "当前：空白区自动穿透 / 元素区可交互"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentTitle("PenpaCanvas 叠加层运行中")
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
