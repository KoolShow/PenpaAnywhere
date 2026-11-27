package io.github.koolshow.penpaanywhere

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.File

object OverlayWebViewFactory {
    private const val TAG = "PenpaAnywhereWeb"
    const val ENTRY_URL = "https://appassets.androidplatform.net/assets/www/index.html"
    private const val APP_ORIGIN_PREFIX = "https://appassets.androidplatform.net/"
    private val mainHandler = Handler(Looper.getMainLooper())

    fun isAllowedExternalUrl(rawUrl: String?): Boolean {
        val url = rawUrl?.trim() ?: return false
        if (url.isEmpty() || url.length > 32768) return false
        if (url.any { it.isISOControl() || it.isWhitespace() }) return false
        val uri = try {
            Uri.parse(url)
        } catch (_: Exception) {
            return false
        }
        val scheme = uri.scheme?.lowercase() ?: return false
        return (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
    }

    fun isAppInternalUrl(rawUrl: String?): Boolean {
        val url = rawUrl?.trim() ?: return false
        return url.startsWith(APP_ORIGIN_PREFIX, ignoreCase = true)
    }

    fun openExternalBrowserUrl(context: Context, rawUrl: String, newTask: Boolean) {
        val url = rawUrl.trim()
        if (!isAllowedExternalUrl(url)) return
        try {
            val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                if (newTask) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(viewIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to open external URL: $url", e)
        }
    }

    fun copyTextToClipboard(context: Context, text: String): Boolean {
        return try {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
            val clip = ClipData.newPlainText("PenpaAnywhere", text)
            if (Looper.myLooper() == Looper.getMainLooper()) {
                cm.setPrimaryClip(clip)
            } else {
                mainHandler.post {
                    try {
                        cm.setPrimaryClip(clip)
                    } catch (_: Exception) {
                    }
                }
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to copy text to clipboard", e)
            false
        }
    }

    private fun sanitizeFilename(raw: String): String {
        val base = raw.trim().substringAfterLast('/').substringAfterLast('\\').trim()
        val cleaned = buildString {
            for (c in base) {
                if (!c.isISOControl() && c !in "<>:\"/\\|?*") append(c)
            }
        }.trim('.', ' ')
        return cleaned.ifEmpty { "download.bin" }
    }

    fun saveDownloadFile(
        context: Context,
        filename: String,
        mimeType: String,
        base64Data: String,
    ): String {
        val safeName = sanitizeFilename(filename)
        val effectiveMime = mimeType.trim().ifEmpty { "application/octet-stream" }
        val payload = base64Data.substringAfter(";base64,", base64Data)
        val bytes = try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decode download base64 for $safeName", e)
            return ""
        }
        return try {
            val savedLabel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val resolver = context.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, effectiveMime)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/PenpaAnywhere")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return ""
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return ""
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                safeName
            } else {
                val baseDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                    ?: context.filesDir
                val targetDir = File(baseDir, "PenpaAnywhere").apply { mkdirs() }
                val stem = safeName.substringBeforeLast('.', safeName)
                val ext = if (safeName.contains('.')) ".${safeName.substringAfterLast('.')}" else ""
                var outFile = File(targetDir, safeName)
                var idx = 1
                while (outFile.exists() && idx <= 9999) {
                    outFile = File(targetDir, "$stem ($idx)$ext")
                    idx++
                }
                outFile.writeBytes(bytes)
                outFile.name
            }
            mainHandler.post {
                Toast.makeText(
                    context.applicationContext,
                    "Saved: $savedLabel",
                    Toast.LENGTH_SHORT,
                ).show()
            }
            savedLabel
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save download file $safeName", e)
            ""
        }
    }

    class JsBridge(
        private val overlayMode: Boolean,
        private val onClickThrough: (Boolean) -> Unit,
        private val onFocusable: (Boolean) -> Unit,
        private val onUpdateHitRegions: (String) -> Unit = {},
        private val onGetDynamicColorTokens: () -> String = { "{}" },
        private val onGetDynamicColorBundle: () -> String = { "{}" },
        private val onGetSafeAreaInsets: () -> String = { "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}" },
        private val onGetScreenshotCompositeStatus: () -> String = { "{}" },
        private val onSetScreenshotCompositeEnabled: (Boolean) -> Unit = {},
        private val onRespondScreenshotPrompt: (String) -> Unit = {},
        private val onRequestAllFilesPermission: () -> Unit = {},
        private val onSwitchToImageActivity: () -> Unit = {},
        private val onSwitchToOverlayService: () -> Unit = {},
        private val onOpenExternalUrl: (String) -> Unit = {},
        private val onSaveDownloadFile: (String, String, String) -> String = { _, _, _ -> "" },
        private val onCopyText: (String) -> Boolean = { false },
        private val onClose: () -> Unit,
        private val onPickImage: () -> Unit,
    ) {
        @JavascriptInterface
        fun isOverlayMode(): Boolean = overlayMode

        @JavascriptInterface
        fun isDebugBuild(): Boolean = BuildConfig.DEBUG

        @JavascriptInterface
        fun setClickThrough(enabled: Boolean) {
            onClickThrough(enabled)
        }

        @JavascriptInterface
        fun setFocusable(focusable: Boolean) {
            onFocusable(focusable)
        }

        @JavascriptInterface
        fun updateHitRegions(payloadJson: String) {
            onUpdateHitRegions(payloadJson)
        }

        @JavascriptInterface
        fun getDynamicColorTokens(): String = onGetDynamicColorTokens()

        @JavascriptInterface
        fun getDynamicColorBundle(): String = onGetDynamicColorBundle()

        @JavascriptInterface
        fun getSafeAreaInsets(): String = onGetSafeAreaInsets()

        @JavascriptInterface
        fun getScreenshotCompositeStatus(): String = onGetScreenshotCompositeStatus()

        @JavascriptInterface
        fun setScreenshotCompositeEnabled(enabled: Boolean) {
            onSetScreenshotCompositeEnabled(enabled)
        }

        @JavascriptInterface
        fun respondScreenshotPrompt(choice: String) {
            onRespondScreenshotPrompt(choice)
        }

        @JavascriptInterface
        fun requestAllFilesPermission() {
            onRequestAllFilesPermission()
        }

        @JavascriptInterface
        fun switchToImageActivity() {
            onSwitchToImageActivity()
        }

        @JavascriptInterface
        fun switchToOverlayService() {
            onSwitchToOverlayService()
        }

        @JavascriptInterface
        fun openExternalUrl(url: String) {
            onOpenExternalUrl(url)
        }

        @JavascriptInterface
        fun saveDownloadFile(filename: String, mimeType: String, base64Data: String): String {
            return onSaveDownloadFile(filename, mimeType, base64Data)
        }

        @JavascriptInterface
        fun copyText(text: String): Boolean {
            return onCopyText(text)
        }

        @JavascriptInterface
        fun closeOverlay() {
            onClose()
        }

        @JavascriptInterface
        fun pickImage() {
            onPickImage()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context,
        bridge: JsBridge,
        onShowFileChooserCallback: (
            (ValueCallback<Array<Uri>>?, WebChromeClient.FileChooserParams?) -> Boolean
        )? = null,
    ): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

        return object : WebView(context) {
            override fun overScrollBy(
                deltaX: Int,
                deltaY: Int,
                scrollX: Int,
                scrollY: Int,
                scrollRangeX: Int,
                scrollRangeY: Int,
                maxOverScrollX: Int,
                maxOverScrollY: Int,
                isTouchEvent: Boolean,
            ): Boolean {
                return false
            }

            override fun scrollTo(x: Int, y: Int) {
                super.scrollTo(0, 0)
            }

            override fun computeScroll() {
                // Keep top-level overlay WebView locked at (0, 0) so mouse-wheel ACTION_SCROLL
                // or scroll-chaining never shifts overlay coordinates; inner DOM/iframe scrollers
                // remain handled inside Blink's compositor.
            }
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER

            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(this, true)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = true
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                useWideViewPort = true
                loadWithOverviewMode = true
                builtInZoomControls = false
                displayZoomControls = false
                setSupportMultipleWindows(true)
                javaScriptCanOpenWindowsAutomatically = true
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                    Log.d(TAG, "[JS ${cm.messageLevel()}] ${cm.message()} (${cm.sourceId()}:${cm.lineNumber()})")
                    return true
                }

                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                ): Boolean {
                    return onShowFileChooserCallback?.invoke(filePathCallback, fileChooserParams) ?: false
                }

                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message?,
                ): Boolean {
                    val parentView = view ?: return false
                    val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                    // Catch any unhooked target="_blank" / window.open navigation and route external URLs out
                    val tempWebView = WebView(parentView.context)
                    tempWebView.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            v: WebView?,
                            request: WebResourceRequest?,
                        ): Boolean {
                            val targetUrl = request?.url?.toString()
                            if (isAllowedExternalUrl(targetUrl) && !isAppInternalUrl(targetUrl)) {
                                bridge.openExternalUrl(targetUrl!!)
                            }
                            v?.destroy()
                            return true
                        }
                    }
                    transport.webView = tempWebView
                    resultMsg.sendToTarget()
                    return true
                }

                // Prevent native Activity-bound AlertDialog crashes in TYPE_APPLICATION_OVERLAY Service
                override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                    Log.w(TAG, "Suppressed native jsAlert in overlay: $message")
                    result?.confirm()
                    return true
                }

                override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                    Log.w(TAG, "Auto-confirmed native jsConfirm in overlay: $message")
                    result?.confirm()
                    return true
                }

                override fun onJsPrompt(
                    view: WebView?,
                    url: String?,
                    message: String?,
                    defaultValue: String?,
                    result: JsPromptResult?,
                ): Boolean {
                    Log.w(TAG, "Suppressed native jsPrompt in overlay: $message")
                    result?.confirm(defaultValue ?: "")
                    return true
                }
            }

            webViewClient = object : WebViewClientCompat() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val targetUrl = request.url?.toString() ?: return false
                    if (isAppInternalUrl(targetUrl)) return false
                    if (isAllowedExternalUrl(targetUrl)) {
                        bridge.openExternalUrl(targetUrl)
                    }
                    return true
                }

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }

                override fun onPageFinished(view: WebView, url: String) {
                    Log.i(TAG, "onPageFinished: $url")
                    view.setBackgroundColor(Color.TRANSPARENT)
                    val bundleJson = bridge.getDynamicColorBundle()
                    val safeInsetsJson = bridge.getSafeAreaInsets()
                    view.evaluateJavascript(
                        "window.__PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__ && window.__PENPAANYWHERE_APPLY_ANDROID_THEME_BUNDLE__($bundleJson);" +
                            "window.__PENPAANYWHERE_APPLY_SAFE_INSETS__ && window.__PENPAANYWHERE_APPLY_SAFE_INSETS__($safeInsetsJson);",
                        null,
                    )
                    view.invalidate()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceErrorCompat,
                ) {
                    Log.e(TAG, "onReceivedError: ${request.url} -> ${error.description}")
                }
            }

            addJavascriptInterface(bridge, "AndroidOverlay")
        }
    }
}
