package com.penpaanywhere.overlay

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Watches for system screenshots while OverlayService is active (for OEMs like HyperOS/MIUI
 * whose system screenshot omits TYPE_APPLICATION_OVERLAY layers).
 *
 * - First detected screenshot (state == "unset"): captures the current WebGL2 overlay snapshot
 *   and prompts the user whether to enable automatic in-place screenshot compositing.
 * - When enabled: automatically composites the transparent Penpa+ WebGL2 overlay onto the newly
 *   taken screenshot in-place using MANAGE_EXTERNAL_STORAGE (or WRITE_EXTERNAL_STORAGE on API <= 29).
 */
class ScreenshotCompositeManager(
    private val context: Context,
    private val captureOverlayAsync: (callback: (active: Boolean, snapshot: OverlaySnapshot?) -> Unit) -> Unit,
    private val onShowFirstTimePrompt: (fileName: String) -> Unit,
    private val onStatusChanged: (statusJson: String) -> Unit,
) {
    companion object {
        private const val TAG = "PenpaScreenshotComp"
        private const val PREFS_NAME = "penpaanywhere_prefs"
        private const val KEY_STATE = "screenshot_composite_state" // "unset" | "enabled" | "disabled"
        private const val COOLDOWN_MS = 6000L
        private val IMAGE_EXTS = setOf("png", "jpg", "jpeg", "webp")
    }

    data class OverlaySnapshot(
        val fullViewBitmap: Bitmap?,
        val glOverlayDataUrl: String?,
        val overlayScreenRect: Rect? = null,
    ) {
        fun recycle() {
            try {
                fullViewBitmap?.recycle()
            } catch (_: Exception) {
            }
        }
    }

    private data class PendingScreenshot(
        val file: File,
        val snapshot: OverlaySnapshot,
        val capturedAtMs: Long,
    )

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private val fileObservers = mutableListOf<FileObserver>()
    private var mediaObserver: ContentObserver? = null
    private val recentlyHandled = ConcurrentHashMap<String, Long>()

    @Volatile
    private var pendingFirstScreenshot: PendingScreenshot? = null

    @Volatile
    private var promptInFlight = false

    @Volatile
    private var permissionRequestInFlight = false

    @Volatile
    private var started = false

    private var compositeState: String
        get() = prefs.getString(KEY_STATE, "unset") ?: "unset"
        set(value) {
            prefs.edit().putString(KEY_STATE, value).apply()
            notifyStatus()
        }

    fun hasReadPermission(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) {
            return true
        }
        val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
    }

    fun hasWritePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            ) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun getStatusJson(): String {
        val obj = JSONObject()
        obj.put("state", compositeState)
        obj.put("enabled", compositeState == "enabled")
        obj.put("hasReadPermission", hasReadPermission())
        obj.put("hasWritePermission", hasWritePermission())
        return obj.toString()
    }

    private fun notifyStatus() {
        val json = getStatusJson()
        mainHandler.post { onStatusChanged(json) }
    }

    fun start() {
        if (started) return
        started = true
        registerFileObservers()
        registerMediaObserver()
        notifyStatus()
        Log.i(TAG, "Started (state=$compositeState, read=${hasReadPermission()}, write=${hasWritePermission()})")
    }

    fun stop() {
        started = false
        StoragePermissionActivity.onResult = null
        fileObservers.forEach {
            try {
                it.stopWatching()
            } catch (_: Exception) {
            }
        }
        fileObservers.clear()
        mediaObserver?.let {
            try {
                context.contentResolver.unregisterContentObserver(it)
            } catch (_: Exception) {
            }
        }
        mediaObserver = null
        pendingFirstScreenshot?.snapshot?.recycle()
        pendingFirstScreenshot = null
        promptInFlight = false
        permissionRequestInFlight = false
        ioExecutor.shutdownNow()
    }

    fun setEnabled(enabled: Boolean) {
        compositeState = if (enabled) "enabled" else "disabled"
        promptInFlight = false
        if (enabled && !hasWritePermission()) {
            requestWritePermission { granted ->
                notifyStatus()
                if (granted) {
                    restartWatchers()
                    val pending = pendingFirstScreenshot
                    pendingFirstScreenshot = null
                    if (pending != null && System.currentTimeMillis() - pending.capturedAtMs < 120_000L) {
                        compositeAndOverwriteAsync(pending.file, pending.snapshot)
                    } else {
                        pending?.snapshot?.recycle()
                        showToast(context.getString(R.string.toast_screenshot_composite_enabled))
                    }
                } else {
                    pendingFirstScreenshot?.snapshot?.recycle()
                    pendingFirstScreenshot = null
                    showToast(context.getString(R.string.toast_all_files_denied_overwrite))
                }
            }
        } else if (enabled) {
            restartWatchers()
            showToast(context.getString(R.string.toast_screenshot_composite_enabled))
        }
    }

    fun requestWritePermissionFromUi() {
        requestWritePermission { granted ->
            notifyStatus()
            if (granted) {
                restartWatchers()
                showToast(context.getString(R.string.toast_all_files_granted))
            }
        }
    }

    /**
     * choice: "enable" | "dismiss" | "later"
     */
    fun respondToFirstTimePrompt(choice: String) {
        promptInFlight = false
        when (choice) {
            "enable" -> {
                compositeState = "enabled"
                val pending = pendingFirstScreenshot
                if (hasWritePermission()) {
                    pendingFirstScreenshot = null
                    if (pending != null) {
                        compositeAndOverwriteAsync(pending.file, pending.snapshot)
                    }
                } else {
                    requestWritePermission { granted ->
                        notifyStatus()
                        val queued = pendingFirstScreenshot
                        pendingFirstScreenshot = null
                        if (granted && queued != null && System.currentTimeMillis() - queued.capturedAtMs < 120_000L) {
                            restartWatchers()
                            compositeAndOverwriteAsync(queued.file, queued.snapshot)
                        } else {
                            queued?.snapshot?.recycle()
                            if (!granted) {
                                showToast(context.getString(R.string.toast_all_files_denied_retry))
                            }
                        }
                    }
                }
            }
            "dismiss" -> {
                compositeState = "disabled"
                pendingFirstScreenshot?.snapshot?.recycle()
                pendingFirstScreenshot = null
            }
            else -> {
                // "later": keep state == "unset" so user can still decide next time or via Settings
                pendingFirstScreenshot?.snapshot?.recycle()
                pendingFirstScreenshot = null
            }
        }
    }

    private fun requestWritePermission(onDone: (Boolean) -> Unit) {
        if (permissionRequestInFlight) return
        permissionRequestInFlight = true
        StoragePermissionActivity.onResult = { granted ->
            mainHandler.post {
                permissionRequestInFlight = false
                onDone(granted)
            }
        }
        val intent = Intent(context, StoragePermissionActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            permissionRequestInFlight = false
            StoragePermissionActivity.onResult = null
            Log.e(TAG, "Failed to launch StoragePermissionActivity: ${e.message}")
            mainHandler.post { onDone(false) }
        }
    }

    private fun restartWatchers() {
        fileObservers.forEach {
            try {
                it.stopWatching()
            } catch (_: Exception) {
            }
        }
        fileObservers.clear()
        registerFileObservers()
    }

    private fun registerFileObservers() {
        val dirs = listOf(
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM), "Screenshots"),
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Screenshots"),
        )
        val mask = FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO
        for (dir in dirs) {
            if (!dir.exists() || !dir.isDirectory) continue
            try {
                val obs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    object : FileObserver(dir, mask) {
                        override fun onEvent(event: Int, path: String?) {
                            if (path != null) {
                                handleCandidateFile(File(dir, path))
                            }
                        }
                    }
                } else {
                    @Suppress("DEPRECATION")
                    object : FileObserver(dir.absolutePath, mask) {
                        override fun onEvent(event: Int, path: String?) {
                            if (path != null) {
                                handleCandidateFile(File(dir, path))
                            }
                        }
                    }
                }
                obs.startWatching()
                fileObservers.add(obs)
                Log.i(TAG, "Watching screenshot directory: ${dir.absolutePath}")
            } catch (e: Exception) {
                Log.w(TAG, "FileObserver failed for ${dir.absolutePath}: ${e.message}")
            }
        }
    }

    private fun registerMediaObserver() {
        val obs = object : ContentObserver(mainHandler) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                super.onChange(selfChange, uri)
                if (!started || compositeState == "disabled") return
                if (!hasReadPermission()) return
                ioExecutor.execute { queryLatestScreenshot(uri) }
            }
        }
        try {
            context.contentResolver.registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                obs,
            )
            mediaObserver = obs
        } catch (e: Exception) {
            Log.w(TAG, "ContentObserver registration failed: ${e.message}")
        }
    }

    private fun queryLatestScreenshot(changedUri: Uri?) {
        val projection = mutableListOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_ADDED,
            @Suppress("DEPRECATION")
            MediaStore.Images.Media.DATA,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projection.add(MediaStore.Images.Media.RELATIVE_PATH)
            projection.add(MediaStore.Images.Media.IS_PENDING)
        }

        val targetUri = if (changedUri != null && changedUri.toString().startsWith(MediaStore.Images.Media.EXTERNAL_CONTENT_URI.toString())) {
            changedUri
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }

        val nowSec = System.currentTimeMillis() / 1000L
        try {
            context.contentResolver.query(
                targetUri,
                projection.toTypedArray(),
                null,
                null,
                "${MediaStore.Images.Media.DATE_ADDED} DESC",
            )?.use { cursor ->
                if (!cursor.moveToFirst()) return
                val dateAdded = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED))
                if (nowSec - dateAdded > 10L) return

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val isPendingIdx = cursor.getColumnIndex(MediaStore.Images.Media.IS_PENDING)
                    if (isPendingIdx >= 0 && cursor.getInt(isPendingIdx) != 0) return
                }

                val name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)) ?: ""
                @Suppress("DEPRECATION")
                val dataPath = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)) ?: ""
                val relPath = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val idx = cursor.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH)
                    if (idx >= 0) cursor.getString(idx) ?: "" else ""
                } else {
                    ""
                }

                val combined = "$relPath/$name/$dataPath".lowercase()
                val looksLikeScreenshot =
                    combined.contains("screenshot") ||
                        combined.contains("截屏") ||
                        combined.contains("スクリーンショット")
                if (!looksLikeScreenshot || dataPath.isEmpty()) return

                handleCandidateFile(File(dataPath))
            }
        } catch (e: Exception) {
            Log.w(TAG, "queryLatestScreenshot failed: ${e.message}")
        }
    }

    private fun handleCandidateFile(file: File) {
        if (!started || compositeState == "disabled") return
        val name = file.name
        if (name.startsWith(".") || name.startsWith("tmp", ignoreCase = true)) return
        val ext = file.extension.lowercase()
        if (ext !in IMAGE_EXTS) return

        val key = try {
            file.canonicalPath
        } catch (_: Exception) {
            file.absolutePath
        }
        val now = System.currentTimeMillis()
        val prev = recentlyHandled[key]
        if (prev != null && now - prev < COOLDOWN_MS) {
            return
        }
        recentlyHandled[key] = now

        // Prune stale entries
        recentlyHandled.entries.removeIf { now - it.value > 30_000L }

        Log.i(TAG, "Detected screenshot: $key (state=$compositeState)")

        mainHandler.post {
            if (!started) return@post
            captureOverlayAsync { active, snapshot ->
                if (!active || snapshot == null || (snapshot.fullViewBitmap == null && snapshot.glOverlayDataUrl.isNullOrBlank())) {
                    snapshot?.recycle()
                    Log.i(TAG, "Skipped screenshot composite (overlay inactive or empty)")
                    return@captureOverlayAsync
                }

                when (compositeState) {
                    "unset" -> {
                        if (promptInFlight) {
                            snapshot.recycle()
                            return@captureOverlayAsync
                        }
                        promptInFlight = true
                        pendingFirstScreenshot?.snapshot?.recycle()
                        pendingFirstScreenshot = PendingScreenshot(file, snapshot, System.currentTimeMillis())
                        onShowFirstTimePrompt(file.name)
                    }
                    "enabled" -> {
                        if (hasWritePermission()) {
                            compositeAndOverwriteAsync(file, snapshot)
                        } else {
                            pendingFirstScreenshot?.snapshot?.recycle()
                            pendingFirstScreenshot = PendingScreenshot(file, snapshot, System.currentTimeMillis())
                            showToast(context.getString(R.string.toast_all_files_needed_composite))
                            requestWritePermission { granted ->
                                notifyStatus()
                                val queued = pendingFirstScreenshot
                                pendingFirstScreenshot = null
                                if (granted && queued != null) {
                                    compositeAndOverwriteAsync(queued.file, queued.snapshot)
                                } else {
                                    queued?.snapshot?.recycle()
                                }
                            }
                        }
                    }
                    else -> {
                        snapshot.recycle()
                    }
                }
            }
        }
    }

    private fun decodeOverlayBitmap(dataUrl: String): Bitmap? {
        val commaIdx = dataUrl.indexOf(',')
        val b64 = if (commaIdx >= 0) dataUrl.substring(commaIdx + 1) else dataUrl
        if (b64.isBlank()) return null
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    private fun decodeScreenshotWithRetry(file: File): Bitmap? {
        for (attempt in 0 until 6) {
            if (file.exists() && file.length() > 1024L) {
                val bmp = BitmapFactory.decodeFile(file.absolutePath)
                if (bmp != null && bmp.width > 0 && bmp.height > 0) {
                    return bmp
                }
            }
            try {
                Thread.sleep(150L)
            } catch (_: InterruptedException) {
                return null
            }
        }
        return null
    }

    /**
     * Check whether WebView.draw(swCanvas) already captured the WebGL2 pixels so we never
     * double-draw the board, while falling back to compositing glOverlayBmp underneath fullViewBmp
     * on GPUs where software WebView draw skips hardware WebGL2 surfaces.
     */
    private fun fullViewAlreadyContainsGl(fullBmp: Bitmap, glBmp: Bitmap): Boolean {
        var sampled = 0
        var matched = 0
        val stepX = (glBmp.width / 32).coerceAtLeast(1)
        val stepY = (glBmp.height / 48).coerceAtLeast(1)
        var y = stepY / 2
        while (y < glBmp.height && sampled < 24) {
            var x = stepX / 2
            while (x < glBmp.width && sampled < 24) {
                val glAlpha = (glBmp.getPixel(x, y) ushr 24) and 0xFF
                if (glAlpha > 180) {
                    sampled++
                    val fx = (x.toLong() * fullBmp.width / glBmp.width).toInt().coerceIn(0, fullBmp.width - 1)
                    val fy = (y.toLong() * fullBmp.height / glBmp.height).toInt().coerceIn(0, fullBmp.height - 1)
                    val fullAlpha = (fullBmp.getPixel(fx, fy) ushr 24) and 0xFF
                    if (fullAlpha > 96) {
                        matched++
                    }
                }
                x += stepX
            }
            y += stepY
        }
        return sampled > 0 && matched * 2 >= sampled
    }

    private fun compositeAndOverwriteAsync(file: File, snapshot: OverlaySnapshot) {
        ioExecutor.execute {
            var baseBmp: Bitmap? = null
            var glBmp: Bitmap? = null
            var outBmp: Bitmap? = null
            try {
                baseBmp = decodeScreenshotWithRetry(file)
                if (baseBmp == null) {
                    Log.w(TAG, "Failed to decode screenshot bitmap: ${file.absolutePath}")
                    return@execute
                }
                glBmp = snapshot.glOverlayDataUrl?.takeIf { it.isNotBlank() }?.let { decodeOverlayBitmap(it) }
                val fullBmp = snapshot.fullViewBitmap
                if (glBmp == null && fullBmp == null) {
                    Log.w(TAG, "Both fullViewBitmap and glOverlayBitmap are null")
                    return@execute
                }

                outBmp = baseBmp.copy(Bitmap.Config.ARGB_8888, true)
                val canvas = Canvas(outBmp)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
                val dstRect = snapshot.overlayScreenRect?.takeIf {
                    it.width() > 0 && it.height() > 0 &&
                        it.left >= 0 && it.top >= 0 &&
                        it.right <= outBmp.width + 4 && it.bottom <= outBmp.height + 4
                } ?: Rect(0, 0, outBmp.width, outBmp.height)

                if (fullBmp != null && glBmp != null) {
                    val alreadyHasGl = fullViewAlreadyContainsGl(fullBmp, glBmp)
                    if (!alreadyHasGl) {
                        canvas.drawBitmap(glBmp, null, dstRect, paint)
                    }
                    canvas.drawBitmap(fullBmp, null, dstRect, paint)
                    Log.i(TAG, "Full-screen composite (fullViewHasGl=$alreadyHasGl, dst=$dstRect, screenshot=${outBmp.width}x${outBmp.height})")
                } else if (fullBmp != null) {
                    canvas.drawBitmap(fullBmp, null, dstRect, paint)
                } else if (glBmp != null) {
                    canvas.drawBitmap(glBmp, null, dstRect, paint)
                }

                val key = try {
                    file.canonicalPath
                } catch (_: Exception) {
                    file.absolutePath
                }
                // Refresh cooldown BEFORE writing so FileObserver/ContentObserver ignore our own write
                recentlyHandled[key] = System.currentTimeMillis()

                val ext = file.extension.lowercase()
                val format = when (ext) {
                    "jpg", "jpeg" -> Bitmap.CompressFormat.JPEG
                    "webp" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        Bitmap.CompressFormat.WEBP_LOSSLESS
                    } else {
                        @Suppress("DEPRECATION")
                        Bitmap.CompressFormat.WEBP
                    }
                    else -> Bitmap.CompressFormat.PNG
                }
                val quality = if (format == Bitmap.CompressFormat.JPEG) 95 else 100

                FileOutputStream(file, false).use { fos ->
                    outBmp.compress(format, quality, fos)
                    fos.fd.sync()
                }
                recentlyHandled[key] = System.currentTimeMillis()

                refreshMediaStore(file)
                Log.i(TAG, "Composited full overlay onto screenshot: ${file.absolutePath} (${outBmp.width}x${outBmp.height})")
                showToast(context.getString(R.string.toast_screenshot_composite_success))
            } catch (e: Exception) {
                Log.e(TAG, "Failed to composite screenshot ${file.absolutePath}: ${e.message}", e)
                notifyStatus()
                showToast(context.getString(R.string.toast_screenshot_composite_failed, e.message ?: ""))
            } finally {
                baseBmp?.recycle()
                glBmp?.recycle()
                outBmp?.recycle()
                snapshot.recycle()
            }
        }
    }

    private fun refreshMediaStore(file: File) {
        try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.SIZE, file.length())
                put(MediaStore.Images.Media.DATE_MODIFIED, System.currentTimeMillis() / 1000L)
            }
            @Suppress("DEPRECATION")
            val selection = "${MediaStore.Images.Media.DATA} = ?"
            context.contentResolver.update(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                values,
                selection,
                arrayOf(file.absolutePath),
            )
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore metadata update warning: ${e.message}")
        }
        try {
            MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), null, null)
        } catch (_: Exception) {
        }
    }

    private fun showToast(msg: String) {
        mainHandler.post {
            Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
        }
    }
}
