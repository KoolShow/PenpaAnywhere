package io.github.koolshow.penpaanywhere

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

object OverlayWebViewFactory {
    private const val TAG = "PenpaAnywhereWeb"
    const val ENTRY_URL = "https://appassets.androidplatform.net/assets/www/index.html"

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
        private val onClose: () -> Unit,
        private val onPickImage: () -> Unit,
    ) {
        @JavascriptInterface
        fun isOverlayMode(): Boolean = overlayMode

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
        fun closeOverlay() {
            onClose()
        }

        @JavascriptInterface
        fun pickImage() {
            onPickImage()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context, bridge: JsBridge): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

        return WebView(context).apply {
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
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                    Log.d(TAG, "[JS ${cm.messageLevel()}] ${cm.message()} (${cm.sourceId()}:${cm.lineNumber()})")
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
