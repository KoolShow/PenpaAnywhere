package com.penpaanywhere.overlay

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
                startOverlayAndMinimize()
            } else {
                Toast.makeText(this, "需要悬浮窗权限", Toast.LENGTH_SHORT).show()
            }
        }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        DynamicColors.applyToActivityIfAvailable(this)
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
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
            onClose = { runOnUiThread { showLauncherUi() } },
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
        setContentView(container)
        wv.loadUrl(OverlayWebViewFactory.ENTRY_URL)
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
