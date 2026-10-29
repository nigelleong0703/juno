plugins {
    id("com.android.test")
    id("androidx.baselineprofile")
}

android {
    namespace = "io.github.nigelleong0703.juno.baselineprofile"
    compileSdk = 37
    defaultConfig {
        minSdk = 28
        targetSdk = 36
    }
    // The module that is profiled; its release variant is what the generator runs against.
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
}

// Generation needs a connected device or emulator: `./gradlew :app:generateBaselineProfile`.
baselineProfile {
    useConnectedDevices = true
}

dependencies {
    implementation("androidx.benchmark:benchmark-macro-junit4:1.5.0")
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
