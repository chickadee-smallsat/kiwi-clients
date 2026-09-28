import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// ── Signing ────────────────────────────────────────────────────────────────
// For local development / sideloading we auto-generate a debug keystore.
// For production releases, set KIWI_KEY_STORE, KIWI_KEY_ALIAS,
// KIWI_KEY_PASSWORD, and KIWI_STORE_PASSWORD as environment variables.
val releaseSigningConfig = if (System.getenv("KIWI_KEY_STORE") != null) {
    val storeFile   = file(System.getenv("KIWI_KEY_STORE")!!)
    val keyAlias    = System.getenv("KIWI_KEY_ALIAS")    ?: "kiwi"
    val keyPass     = System.getenv("KIWI_KEY_PASSWORD") ?: ""
    val storePass   = System.getenv("KIWI_STORE_PASSWORD") ?: keyPass
    android.signingConfigs.create("release") {
        this.storeFile   = storeFile
        this.keyAlias    = keyAlias
        this.keyPassword = keyPass
        this.storePassword = storePass
    }
} else null

android {
    compileSdk = 36
    namespace = "com.kiwi.mainboard"
    defaultConfig {
        // Allow HTTP to the local Kiwi sensor server (LAN / localhost).
        // This is an instrument monitor, not a public web app.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.kiwi.mainboard"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            // Use explicit signing config when env vars are set; otherwise
            // Gradle defaults to the debug keystore (fine for sideloading).
            if (releaseSigningConfig != null) {
                signingConfig = releaseSigningConfig
            }
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")