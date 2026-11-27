package io.github.koolshow.penpaanywhere

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.view.ContextThemeWrapper
import androidx.annotation.AttrRes
import com.google.android.material.R as MaterialR
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.MaterialColors
import org.json.JSONObject

/**
 * Resolves Material Design 3 Dark & Light semantic tokens from Android's system Dynamic Color
 * (Material You) palette on Android 12+ and gracefully falls back to default MD3 tokens on older versions.
 */
object Md3DynamicColorProvider {

    fun wrapWithDynamicTheme(base: Context, light: Boolean = false): Context {
        val styleRes = if (light) R.style.Theme_PenpaAnywhere_Light else R.style.Theme_PenpaAnywhere
        val themed = ContextThemeWrapper(base, styleRes)
        return DynamicColors.wrapContextIfAvailable(themed)
    }

    fun isDynamicColorActive(): Boolean = DynamicColors.isDynamicColorAvailable()

    fun isSystemDarkMode(context: Context, configOverride: Configuration? = null): Boolean {
        val cfg = configOverride ?: context.resources.configuration
        val mask = cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return mask == Configuration.UI_MODE_NIGHT_YES
    }

    fun resolveColor(ctx: Context, @AttrRes attr: Int, fallbackHex: String): Int {
        return MaterialColors.getColor(ctx, attr, Color.parseColor(fallbackHex))
    }

    private fun toHex(colorInt: Int): String {
        return String.format("#%06X", colorInt and 0xFFFFFF)
    }

    private fun buildTokensObject(ctx: Context, light: Boolean): JSONObject {
        val obj = JSONObject()
        fun put(cssVar: String, @AttrRes attr: Int, darkFallback: String, lightFallback: String) {
            val fb = if (light) lightFallback else darkFallback
            obj.put(cssVar, toHex(resolveColor(ctx, attr, fb)))
        }

        // Primary
        put("--md-sys-color-primary", MaterialR.attr.colorPrimary, "#A8C7FA", "#0B57D0")
        put("--md-sys-color-on-primary", MaterialR.attr.colorOnPrimary, "#062E6F", "#FFFFFF")
        put("--md-sys-color-primary-container", MaterialR.attr.colorPrimaryContainer, "#0842A0", "#D3E3FD")
        put("--md-sys-color-on-primary-container", MaterialR.attr.colorOnPrimaryContainer, "#D3E3FD", "#041E49")

        // Secondary
        put("--md-sys-color-secondary", MaterialR.attr.colorSecondary, "#C2E7FF", "#00639B")
        put("--md-sys-color-on-secondary", MaterialR.attr.colorOnSecondary, "#003355", "#FFFFFF")
        put("--md-sys-color-secondary-container", MaterialR.attr.colorSecondaryContainer, "#004A77", "#CEE5FF")
        put("--md-sys-color-on-secondary-container", MaterialR.attr.colorOnSecondaryContainer, "#C2E7FF", "#001D33")

        // Tertiary
        put("--md-sys-color-tertiary", MaterialR.attr.colorTertiary, "#C4EED0", "#146C2E")
        put("--md-sys-color-on-tertiary", MaterialR.attr.colorOnTertiary, "#072711", "#FFFFFF")
        put("--md-sys-color-tertiary-container", MaterialR.attr.colorTertiaryContainer, "#0F5223", "#C4EED0")
        put("--md-sys-color-on-tertiary-container", MaterialR.attr.colorOnTertiaryContainer, "#C4EED0", "#072711")

        // Error
        put("--md-sys-color-error", MaterialR.attr.colorError, "#F2B8B5", "#B3261E")
        put("--md-sys-color-on-error", MaterialR.attr.colorOnError, "#601410", "#FFFFFF")
        put("--md-sys-color-error-container", MaterialR.attr.colorErrorContainer, "#8C1D18", "#F9DEDC")
        put("--md-sys-color-on-error-container", MaterialR.attr.colorOnErrorContainer, "#F9DEDC", "#410E0B")

        // Background & Surface
        put("--md-sys-color-background", android.R.attr.colorBackground, "#111318", "#F8F9FC")
        put("--md-sys-color-on-background", MaterialR.attr.colorOnBackground, "#E2E2E9", "#1A1C1E")
        put("--md-sys-color-surface", MaterialR.attr.colorSurface, "#111318", "#F8F9FC")
        put("--md-sys-color-on-surface", MaterialR.attr.colorOnSurface, "#E2E2E9", "#1A1C1E")
        put("--md-sys-color-surface-variant", MaterialR.attr.colorSurfaceVariant, "#44474F", "#E0E2EC")
        put("--md-sys-color-on-surface-variant", MaterialR.attr.colorOnSurfaceVariant, "#C4C6D0", "#44474E")
        put("--md-sys-color-surface-bright", MaterialR.attr.colorSurfaceBright, "#37393E", "#FFFFFF")
        put("--md-sys-color-surface-dim", MaterialR.attr.colorSurfaceDim, "#111318", "#D9DBE2")

        // Surface Containers
        put("--md-sys-color-surface-container-low", MaterialR.attr.colorSurfaceContainerLow, "#191C20", "#F3F4F9")
        put("--md-sys-color-surface-container", MaterialR.attr.colorSurfaceContainer, "#1D2024", "#EDF0F7")
        put("--md-sys-color-surface-container-high", MaterialR.attr.colorSurfaceContainerHigh, "#282A2F", "#E6EAF2")
        put("--md-sys-color-surface-container-highest", MaterialR.attr.colorSurfaceContainerHighest, "#33353A", "#DFE3EC")

        // Outline & Inverse
        put("--md-sys-color-outline", MaterialR.attr.colorOutline, "#8E9099", "#74777F")
        put("--md-sys-color-outline-variant", MaterialR.attr.colorOutlineVariant, "#44474F", "#C4C6D0")
        put("--md-sys-color-inverse-surface", MaterialR.attr.colorSurfaceInverse, "#E2E2E9", "#2E3036")
        put("--md-sys-color-inverse-on-surface", MaterialR.attr.colorOnSurfaceInverse, "#2E3036", "#F0F1F7")
        put("--md-sys-color-inverse-primary", MaterialR.attr.colorPrimaryInverse, "#0B57D0", "#A8C7FA")

        // Surface Tint / Shadow / Scrim
        put("--md-sys-color-surface-tint", MaterialR.attr.colorPrimary, "#A8C7FA", "#0B57D0")
        obj.put("--md-sys-color-shadow", "#000000")
        obj.put("--md-sys-color-scrim", "#000000")

        // Fixed roles
        put("--md-sys-color-primary-fixed", MaterialR.attr.colorPrimaryFixed, "#D3E3FD", "#D3E3FD")
        put("--md-sys-color-primary-fixed-dim", MaterialR.attr.colorPrimaryFixedDim, "#A8C7FA", "#A8C7FA")
        put("--md-sys-color-on-primary-fixed", MaterialR.attr.colorOnPrimaryFixed, "#041E49", "#041E49")
        put("--md-sys-color-on-primary-fixed-variant", MaterialR.attr.colorOnPrimaryFixedVariant, "#0842A0", "#0842A0")

        put("--md-sys-color-secondary-fixed", MaterialR.attr.colorSecondaryFixed, "#C2E7FF", "#CEE5FF")
        put("--md-sys-color-secondary-fixed-dim", MaterialR.attr.colorSecondaryFixedDim, "#7FCFFF", "#96CCFF")
        put("--md-sys-color-on-secondary-fixed", MaterialR.attr.colorOnSecondaryFixed, "#001D35", "#001D33")
        put("--md-sys-color-on-secondary-fixed-variant", MaterialR.attr.colorOnSecondaryFixedVariant, "#004A77", "#004A77")

        put("--md-sys-color-tertiary-fixed", MaterialR.attr.colorTertiaryFixed, "#C4EED0", "#C4EED0")
        put("--md-sys-color-tertiary-fixed-dim", MaterialR.attr.colorTertiaryFixedDim, "#6DD58C", "#6DD58C")
        put("--md-sys-color-on-tertiary-fixed", MaterialR.attr.colorOnTertiaryFixed, "#072711", "#072711")
        put("--md-sys-color-on-tertiary-fixed-variant", MaterialR.attr.colorOnTertiaryFixedVariant, "#0F5223", "#0F5223")

        return obj
    }

    fun exportCssTokensJson(context: Context): String {
        val ctx = wrapWithDynamicTheme(context, light = false)
        return buildTokensObject(ctx, light = false).toString()
    }

    fun exportDualTokensJson(context: Context, configOverride: Configuration? = null): String {
        val darkCtx = wrapWithDynamicTheme(context, light = false)
        val lightCtx = wrapWithDynamicTheme(context, light = true)
        val root = JSONObject()
        root.put("dark", buildTokensObject(darkCtx, light = false))
        root.put("light", buildTokensObject(lightCtx, light = true))
        root.put("systemDark", isSystemDarkMode(context, configOverride))
        root.put("available", isDynamicColorActive())
        return root.toString()
    }
}
