import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.koolshow.penpaanywhere"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.koolshow.penpaanywhere"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        create("release") {
            val ksPropsFile = rootProject.file("keystore.properties")
            val ksProps = Properties()
            if (ksPropsFile.exists()) {
                ksPropsFile.inputStream().use { ksProps.load(it) }
            }
            val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
                ?.takeIf { it.isNotBlank() }
                ?: ksProps.getProperty("storeFile")?.takeIf { it.isNotBlank() }
            if (!ksPath.isNullOrBlank() && file(ksPath).exists()) {
                storeFile = file(ksPath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                    ?.takeIf { it.isNotBlank() }
                    ?: ksProps.getProperty("storePassword")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                    ?.takeIf { it.isNotBlank() }
                    ?: ksProps.getProperty("keyAlias")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                    ?.takeIf { it.isNotBlank() }
                    ?: ksProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            val releaseSigning = signingConfigs.getByName("release")
            signingConfig = if (releaseSigning.storeFile != null) {
                releaseSigning
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
