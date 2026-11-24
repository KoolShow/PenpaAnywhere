package com.penpaanywhere.overlay

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Translucent helper Activity launched from OverlayService to request MANAGE_EXTERNAL_STORAGE
 * (Android 11+) or WRITE_EXTERNAL_STORAGE (Android <= 10) for in-place screenshot compositing.
 */
class StoragePermissionActivity : AppCompatActivity() {

    companion object {
        @Volatile
        var onResult: ((granted: Boolean) -> Unit)? = null
    }

    private val allFilesLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Environment.isExternalStorageManager()
            } else {
                true
            }
            finishWithResult(granted)
        }

    private val legacyWriteLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { map ->
            val granted = map.values.all { it }
            finishWithResult(granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (Environment.isExternalStorageManager()) {
                finishWithResult(true)
                return
            }
            val intent = Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            try {
                allFilesLauncher.launch(intent)
            } catch (_: Exception) {
                val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                allFilesLauncher.launch(fallback)
            }
        } else {
            val perms = arrayOf(
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            )
            val allGranted = perms.all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
            if (allGranted) {
                finishWithResult(true)
            } else {
                legacyWriteLauncher.launch(perms)
            }
        }
    }

    private fun finishWithResult(granted: Boolean) {
        val cb = onResult
        onResult = null
        cb?.invoke(granted)
        finish()
    }
}
