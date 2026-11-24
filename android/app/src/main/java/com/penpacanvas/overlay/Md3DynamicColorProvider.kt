package com.penpacanvas.overlay

import android.content.Context
import android.graphics.Color
import android.view.ContextThemeWrapper
import androidx.annotation.AttrRes
import com.google.android.material.R as MaterialR
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.MaterialColors
import org.json.JSONObject

/**
 * Resolves Material Design 3 Dark semantic tokens from Android's system Dynamic Color (Material You)
 * palette on Android 12+ and gracefully falls back to the default MD3 Dark tokens on older versions.
 * Exports the exact CSS custom property names defined in src/styles/md3-tokens.css.
 */
object Md3DynamicColorProvider {

    fun wrapWithDynamicTheme(base: Context): Context {
        val themed = ContextThemeWrapper(base, R.style.Theme_PenpaCanvas)
        return DynamicColors.wrapContextIfAvailable(themed)
    }

    fun isDynamicColorActive(): Boolean = DynamicColors.isDynamicColorAvailable()

    fun resolveColor(ctx: Context, @AttrRes attr: Int, fallbackHex: String): Int {
        return MaterialColors.getColor(ctx, attr, Color.parseColor(fallbackHex))
    }

    private fun toHex(colorInt: Int): String {
        return String.format("#%06X", colorInt and 0xFFFFFF)
    }

    fun exportCssTokensJson(context: Context): String {
        val ctx = wrapWithDynamicTheme(context)
        val obj = JSONObject()

        fun put(cssVar: String, @AttrRes attr: Int, fallback: String) {
            obj.put(cssVar, toHex(resolveColor(ctx, attr, fallback)))
        }

        // Primary
        put("--md-sys-color-primary", MaterialR.attr.colorPrimary, "#A8C7FA")
        put("--md-sys-color-on-primary", MaterialR.attr.colorOnPrimary, "#062E6F")
        put("--md-sys-color-primary-container", MaterialR.attr.colorPrimaryContainer, "#0842A0")
        put("--md-sys-color-on-primary-container", MaterialR.attr.colorOnPrimaryContainer, "#D3E3FD")

        // Secondary
        put("--md-sys-color-secondary", MaterialR.attr.colorSecondary, "#C2E7FF")
        put("--md-sys-color-on-secondary", MaterialR.attr.colorOnSecondary, "#003355")
        put("--md-sys-color-secondary-container", MaterialR.attr.colorSecondaryContainer, "#004A77")
        put("--md-sys-color-on-secondary-container", MaterialR.attr.colorOnSecondaryContainer, "#C2E7FF")

        // Tertiary
        put("--md-sys-color-tertiary", MaterialR.attr.colorTertiary, "#C4EED0")
        put("--md-sys-color-on-tertiary", MaterialR.attr.colorOnTertiary, "#072711")
        put("--md-sys-color-tertiary-container", MaterialR.attr.colorTertiaryContainer, "#0F5223")
        put("--md-sys-color-on-tertiary-container", MaterialR.attr.colorOnTertiaryContainer, "#C4EED0")

        // Error
        put("--md-sys-color-error", MaterialR.attr.colorError, "#F2B8B5")
        put("--md-sys-color-on-error", MaterialR.attr.colorOnError, "#601410")
        put("--md-sys-color-error-container", MaterialR.attr.colorErrorContainer, "#8C1D18")
        put("--md-sys-color-on-error-container", MaterialR.attr.colorOnErrorContainer, "#F9DEDC")

        // Background & Surface
        put("--md-sys-color-background", android.R.attr.colorBackground, "#111318")
        put("--md-sys-color-on-background", MaterialR.attr.colorOnBackground, "#E2E2E9")
        put("--md-sys-color-surface", MaterialR.attr.colorSurface, "#111318")
        put("--md-sys-color-on-surface", MaterialR.attr.colorOnSurface, "#E2E2E9")
        put("--md-sys-color-surface-variant", MaterialR.attr.colorSurfaceVariant, "#44474F")
        put("--md-sys-color-on-surface-variant", MaterialR.attr.colorOnSurfaceVariant, "#C4C6D0")
        put("--md-sys-color-surface-bright", MaterialR.attr.colorSurfaceBright, "#37393E")
        put("--md-sys-color-surface-dim", MaterialR.attr.colorSurfaceDim, "#111318")

        // Surface Containers
        put("--md-sys-color-surface-container-low", MaterialR.attr.colorSurfaceContainerLow, "#191C20")
        put("--md-sys-color-surface-container", MaterialR.attr.colorSurfaceContainer, "#1D2024")
        put("--md-sys-color-surface-container-high", MaterialR.attr.colorSurfaceContainerHigh, "#282A2F")
        put("--md-sys-color-surface-container-highest", MaterialR.attr.colorSurfaceContainerHighest, "#33353A")

        // Outline & Inverse
        put("--md-sys-color-outline", MaterialR.attr.colorOutline, "#8E9099")
        put("--md-sys-color-outline-variant", MaterialR.attr.colorOutlineVariant, "#44474F")
        put("--md-sys-color-inverse-surface", MaterialR.attr.colorSurfaceInverse, "#E2E2E9")
        put("--md-sys-color-inverse-on-surface", MaterialR.attr.colorOnSurfaceInverse, "#2E3036")
        put("--md-sys-color-inverse-primary", MaterialR.attr.colorPrimaryInverse, "#0B57D0")

        // Surface Tint / Shadow / Scrim
        put("--md-sys-color-surface-tint", MaterialR.attr.colorPrimary, "#A8C7FA")
        obj.put("--md-sys-color-shadow", "#000000")
        obj.put("--md-sys-color-scrim", "#000000")

        // Fixed roles
        put("--md-sys-color-primary-fixed", MaterialR.attr.colorPrimaryFixed, "#D3E3FD")
        put("--md-sys-color-primary-fixed-dim", MaterialR.attr.colorPrimaryFixedDim, "#A8C7FA")
        put("--md-sys-color-on-primary-fixed", MaterialR.attr.colorOnPrimaryFixed, "#041E49")
        put("--md-sys-color-on-primary-fixed-variant", MaterialR.attr.colorOnPrimaryFixedVariant, "#0842A0")

        put("--md-sys-color-secondary-fixed", MaterialR.attr.colorSecondaryFixed, "#C2E7FF")
        put("--md-sys-color-secondary-fixed-dim", MaterialR.attr.colorSecondaryFixedDim, "#7FCFFF")
        put("--md-sys-color-on-secondary-fixed", MaterialR.attr.colorOnSecondaryFixed, "#001D35")
        put("--md-sys-color-on-secondary-fixed-variant", MaterialR.attr.colorOnSecondaryFixedVariant, "#004A77")

        put("--md-sys-color-tertiary-fixed", MaterialR.attr.colorTertiaryFixed, "#C4EED0")
        put("--md-sys-color-tertiary-fixed-dim", MaterialR.attr.colorTertiaryFixedDim, "#6DD58C")
        put("--md-sys-color-on-tertiary-fixed", MaterialR.attr.colorOnTertiaryFixed, "#072711")
        put("--md-sys-color-on-tertiary-fixed-variant", MaterialR.attr.colorOnTertiaryFixedVariant, "#0F5223")

        return obj.toString()
    }
}
