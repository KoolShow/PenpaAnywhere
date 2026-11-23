package com.penpacanvas.overlay

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private var inAppWebView: WebView? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

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
                            "window.__PENPACANVAS_ON_ANDROID_IMAGE__ && window.__PENPACANVAS_ON_ANDROID_IMAGE__($quoted);",
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
                Toast.makeText(this, "需要悬浮窗权限才能作为透明叠加层显示", Toast.LENGTH_SHORT).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showLauncherUi()
    }

    private fun showLauncherUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#111318"))
            setPadding(48, 48, 48, 48)
        }

        val title = TextView(this).apply {
            text = "PenpaCanvas — Penpa+ 透明透视叠加层"
            textSize = 20f
            setTextColor(Color.parseColor("#E2E2E9"))
            gravity = Gravity.CENTER
        }

        val subtitle = TextView(this).apply {
            text = "支持全局悬浮透明叠加（Alpha=1-亮度）与本地截图正片叠底模式"
            textSize = 13f
            setTextColor(Color.parseColor("#C4C6D0"))
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 40)
        }

        val btnStartOverlay = Button(this).apply {
            text = "启动系统透明叠加层（悬浮窗）"
            setBackgroundColor(Color.parseColor("#0842A0"))
            setTextColor(Color.parseColor("#D3E3FD"))
            setOnClickListener { requestOrStartOverlay() }
        }

        val btnStopOverlay = Button(this).apply {
            text = "停止系统叠加层"
            setBackgroundColor(Color.parseColor("#282A2F"))
            setTextColor(Color.parseColor("#E2E2E9"))
            setOnClickListener {
                stopService(Intent(this@MainActivity, OverlayService::class.java))
                Toast.makeText(this@MainActivity, "叠加层已停止", Toast.LENGTH_SHORT).show()
            }
        }

        val btnInApp = Button(this).apply {
            text = "应用内截图模式（免悬浮权限）"
            setBackgroundColor(Color.parseColor("#004A77"))
            setTextColor(Color.parseColor("#C2E7FF"))
            setOnClickListener { openInAppWebView() }
        }

        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            topMargin = 20
        }

        root.addView(title)
        root.addView(subtitle)
        root.addView(btnStartOverlay, lp)
        root.addView(btnStopOverlay, lp)
        root.addView(btnInApp, lp)
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
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#111318"))
        }
        val bridge = OverlayWebViewFactory.JsBridge(
            overlayMode = false,
            onClickThrough = {},
            onFocusable = {},
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

    override fun onDestroy() {
        inAppWebView?.destroy()
        inAppWebView = null
        super.onDestroy()
    }
}
