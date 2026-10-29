plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("androidx.baselineprofile")
}

android {
    namespace = "io.github.nigelleong0703.juno"
    compileSdk = 37
    defaultConfig {
        applicationId = "io.github.nigelleong0703.juno"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        // The backend the app talks to; the emulator reaches the Mac at 10.0.2.2.
        buildConfigField("String", "JUNO_SERVER_URL", "\"http://10.0.2.2:8787\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = true }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // No release keystore exists yet, so this local release variant is signed with the debug key.
            // It installs and runs, but it is not a distributable build: switch to a real signingConfig before shipping.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    val compose = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(compose)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.11.0")
    // The system splash (API 28+ through the compat library): the app icon on the canvas colour.
    implementation("androidx.core:core-splashscreen:1.2.0")
    // Installs the baseline profile at install time (and on first run for profile-less installs) so startup and scroll start compiled.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    baselineProfile(project(":baselineprofile"))
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.navigation:navigation-compose:2.9.5")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.composables:icons-lucide:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Images (Coil 3, OkHttp-backed) and Markdown rendering. Versions checked against Maven Central release dates.
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.45.0")
    // Syntax highlighting for fenced code (dev.snipme:highlights), same version as the renderer.
    implementation("com.mikepenz:multiplatform-markdown-renderer-code:0.45.0")
    // X25519 for secure-input sealing: the platform XDH KeyAgreement needs API 33, minSdk is 28.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    // BiometricPrompt with a CryptoObject for the saved-details vault. 1.1.0 is the newest stable release on Google Maven
    // (the 1.4 line is alpha only).
    implementation("androidx.biometric:biometric:1.1.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
