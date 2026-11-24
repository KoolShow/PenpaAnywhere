package com.penpacanvas.overlay

import android.app.Application
import com.google.android.material.color.DynamicColors

class PenpaCanvasApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DynamicColors.applyToActivitiesIfAvailable(this)
    }
}
