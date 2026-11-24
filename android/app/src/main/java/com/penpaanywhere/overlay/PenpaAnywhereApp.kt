package com.penpaanywhere.overlay

import android.app.Application
import com.google.android.material.color.DynamicColors

class PenpaAnywhereApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DynamicColors.applyToActivitiesIfAvailable(this)
    }
}
