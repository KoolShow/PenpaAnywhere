package com.penpaanywhere.overlay

import android.net.Uri
import android.os.Bundle
import android.util.Base64
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class ImagePickerActivity : AppCompatActivity() {

    companion object {
        @Volatile
        var onImagePicked: ((String) -> Unit)? = null
    }

    private val picker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri != null) {
            try {
                val mime = contentResolver.getType(uri) ?: "image/png"
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes != null && bytes.isNotEmpty()) {
                    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    onImagePicked?.invoke("data:$mime;base64,$b64")
                }
            } catch (_: Exception) {
            }
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        picker.launch("image/*")
    }
}
