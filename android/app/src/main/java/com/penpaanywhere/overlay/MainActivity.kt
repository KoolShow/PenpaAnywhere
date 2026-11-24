package com.penpaanywhere.overlay

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.R as MaterialR
import com.google.android.material.button.MaterialButton
import com.google.android.material.color.DynamicColors
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private var inAppWebView: WebView? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var overlayToggleBtn: MaterialButton? = null
    @Volatile
    private var lastSafeInsetsJson: String = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            filePathCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
            filePathCallback = null
        }

    private val directImageLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            if (uri != null) {
                try {
                    val mime = contentResolver.getType(uri) ?: "image/png"
                    val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    if (bytes != null && bytes.isNotEmpty()) {
                        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                        val quoted = JSONObject.quote("data:$mime;base64,$b64")
                        inAppWebView?.evaluateJavascript(
                            "window.__PENPAANYWHERE_ON_ANDROID_IMAGE__ && window.__PENPAANYWHERE_ON_ANDROID_IMAGE__($quoted);",
                            null,
                        )
                    }
                } catch (_: Exception) {
                }
            }
        }

    private val overlayPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (Settings.canDrawOverlays(this)) {
                ensureMediaReadThenStartOverlay()
            } else {
                Toast.makeText(this, "需要悬浮窗权限", Toast.LENGTH_SHORT).show()
            }
        }

    private val mediaReadPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            startOverlayAndMinimize()
        }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (inAppWebView != null) {
                        closeInAppWebView()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
        showLauncherUi()
    }

    override fun onResume() {
        super.onResume()
        updateOverlayButtonStyle()
    }

    private fun updateOverlayButtonStyle() {
        val btn = overlayToggleBtn ?: return
        val running = OverlayService.isRunning
        if (running) {
            val bg = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorErrorContainer, "#8C1D18")
            val fg = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorOnErrorContainer, "#F9DEDC")
            btn.text = "停止叠加层"
            btn.backgroundTintList = ColorStateList.valueOf(bg)
            btn.setTextColor(fg)
        } else {
            val bg = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorPrimary, "#A8C7FA")
            val fg = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorOnPrimary, "#062E6F")
            btn.text = "启动叠加层"
            btn.backgroundTintList = ColorStateList.valueOf(bg)
            btn.setTextColor(fg)
        }
    }

    private fun showLauncherUi() {
        val surface = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorSurface, "#111318")
        val onSurface = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorOnSurface, "#E2E2E9")
        val secondaryContainer = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorSecondaryContainer, "#004A77")
        val onSecondaryContainer = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorOnSecondaryContainer, "#C2E7FF")

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(surface)
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(dp(32), sys.top + dp(32), dp(32), sys.bottom + dp(32))
            insets
        }

        val title = TextView(this).apply {
            text = "PenpaAnywhere"
            textSize = 28f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextColor(onSurface)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(32))
        }

        val btnOverlay = MaterialButton(this).apply {
            isAllCaps = false
            textSize = 15f
            cornerRadius = dp(28)
            minHeight = dp(56)
            insetTop = 0
            insetBottom = 0
            elevation = 0f
            stateListAnimator = null
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            setOnClickListener {
                if (OverlayService.isRunning) {
                    val stopIntent = Intent(this@MainActivity, OverlayService::class.java).apply {
                        action = OverlayService.ACTION_STOP
                    }
                    startService(stopIntent)
                    overlayToggleBtn?.postDelayed({ updateOverlayButtonStyle() }, 220)
                } else {
                    requestOrStartOverlay()
                }
            }
        }
        overlayToggleBtn = btnOverlay
        updateOverlayButtonStyle()

        val btnImage = MaterialButton(this).apply {
            text = "截图模式"
            isAllCaps = false
            textSize = 15f
            cornerRadius = dp(28)
            minHeight = dp(56)
            insetTop = 0
            insetBottom = 0
            elevation = 0f
            stateListAnimator = null
            backgroundTintList = ColorStateList.valueOf(secondaryContainer)
            setTextColor(onSecondaryContainer)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(12)
            }
            setOnClickListener { openInAppWebView() }
        }

        root.addView(title)
        root.addView(btnOverlay)
        root.addView(btnImage)
        setContentView(root)
    }

    private fun requestOrStartOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            overlayPermissionLauncher.launch(intent)
            return
        }
        ensureMediaReadThenStartOverlay()
    }

    private fun ensureMediaReadThenStartOverlay() {
        val hasAllFiles = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()
        val readPerm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        val hasRead = hasAllFiles ||
            ContextCompat.checkSelfPermission(this, readPerm) == PackageManager.PERMISSION_GRANTED
        val prefs = getSharedPreferences("penpaanywhere_prefs", MODE_PRIVATE)
        val askedOnce = prefs.getBoolean("asked_media_read_once", false)
        if (!hasRead && !askedOnce) {
            prefs.edit().putBoolean("asked_media_read_once", true).apply()
            mediaReadPermissionLauncher.launch(readPerm)
            return
        }
        startOverlayAndMinimize()
    }

    private fun startOverlayAndMinimize() {
        val intent = Intent(this, OverlayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(this, intent)
        } else {
            startService(intent)
        }
        moveTaskToBack(true)
    }

    private fun openInAppWebView() {
        val surface = Md3DynamicColorProvider.resolveColor(this, MaterialR.attr.colorSurface, "#111318")
        val container = FrameLayout(this).apply {
            setBackgroundColor(surface)
        }
        val bridge = OverlayWebViewFactory.JsBridge(
            overlayMode = false,
            onClickThrough = {},
            onFocusable = {},
            onGetDynamicColorTokens = { Md3DynamicColorProvider.exportCssTokensJson(this) },
            onGetSafeAreaInsets = { lastSafeInsetsJson },
            onClose = { runOnUiThread { closeInAppWebView() } },
            onPickImage = { runOnUiThread { directImageLauncher.launch("image/*") } },
        )
        val wv = OverlayWebViewFactory.create(this, bridge).apply {
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = filePathCallback
                    fileChooserLauncher.launch("image/*")
                    return true
                }
            }
        }
        inAppWebView = wv
        container.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        ViewCompat.setOnApplyWindowInsetsListener(container) { _, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
            val topCss = Math.round(sys.top / density).coerceAtLeast(0)
            val rightCss = Math.round(sys.right / density).coerceAtLeast(0)
            val bottomCss = Math.round(sys.bottom / density).coerceAtLeast(0)
            val leftCss = Math.round(sys.left / density).coerceAtLeast(0)
            val json = "{\"top\":$topCss,\"right\":$rightCss,\"bottom\":$bottomCss,\"left\":$leftCss}"
            if (json != lastSafeInsetsJson) {
                lastSafeInsetsJson = json
                wv.post {
                    inAppWebView?.evaluateJavascript(
                        "window.__PENPAANYWHERE_APPLY_SAFE_INSETS__ && window.__PENPAANYWHERE_APPLY_SAFE_INSETS__($json);",
                        null,
                    )
                }
            }
            insets
        }
        setContentView(container)
        ViewCompat.requestApplyInsets(container)
        wv.loadUrl(OverlayWebViewFactory.ENTRY_URL)
    }

    private fun closeInAppWebView() {
        val wv = inAppWebView
        if (wv == null) {
            showLauncherUi()
            return
        }
        inAppWebView = null
        var closed = false
        val finishClose = Runnable {
            if (!closed) {
                closed = true
                try {
                    CookieManager.getInstance().flush()
                } catch (_: Exception) {
                }
                wv.onPause()
                wv.destroy()
                showLauncherUi()
            }
        }
        wv.postDelayed(finishClose, 150)
        try {
            wv.evaluateJavascript(
                "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
            ) {
                wv.removeCallbacks(finishClose)
                finishClose.run()
            }
        } catch (_: Exception) {
            wv.removeCallbacks(finishClose)
            finishClose.run()
        }
    }

    override fun onPause() {
        inAppWebView?.evaluateJavascript(
            "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
            null,
        )
        try {
            CookieManager.getInstance().flush()
        } catch (_: Exception) {
        }
        super.onPause()
    }

    override fun onDestroy() {
        inAppWebView?.evaluateJavascript(
            "window.__PENPAANYWHERE_FLUSH_STORAGE__ && window.__PENPAANYWHERE_FLUSH_STORAGE__();",
            null,
        )
        inAppWebView?.destroy()
        inAppWebView = null
        super.onDestroy()
    }
}
