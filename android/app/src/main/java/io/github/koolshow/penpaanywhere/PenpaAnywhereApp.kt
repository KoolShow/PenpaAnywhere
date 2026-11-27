package io.github.koolshow.penpaanywhere

import android.app.Application
import android.webkit.WebView
import com.google.android.material.color.DynamicColors

class PenpaAnywhereApp : Application() {
    override fun onCreate() {
        super.onCreate()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        DynamicColors.applyToActivitiesIfAvailable(this)
    }
}
