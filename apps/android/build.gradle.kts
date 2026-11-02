// The Kotlin Gradle plugin is declared here, not applied, so that the Android plugin's built-in
// Kotlin support compiles with this version of Kotlin (mcumgr-ble is built with Kotlin 2.4).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
