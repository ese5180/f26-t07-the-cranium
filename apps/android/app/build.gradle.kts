import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ---------------------------------------------------------------------------------------------
// Configuration: the four values of the deployed stack (docs/mobile-apps.md, "Configuration").
// apps/config/cranium.json is written by apps/configure.sh and ignored by git, because it names
// the AWS account. Without it the build uses the example file, whose values are made up, and
// says so. The values themselves are never printed.
// ---------------------------------------------------------------------------------------------
val configDir: File = rootDir.resolve("../config").canonicalFile
val realConfig: File = configDir.resolve("cranium.json")
val usingExampleConfig: Boolean = !realConfig.isFile
val configFile: File = if (usingExampleConfig) configDir.resolve("cranium.example.json") else realConfig
if (usingExampleConfig) {
    logger.warn(
        "Cranium: apps/config/cranium.json not found, so this build uses " +
            "apps/config/cranium.example.json. Its values are made up and sign-in will not work. " +
            "Run apps/configure.sh, then build again.",
    )
}
if (!configFile.isFile) throw GradleException("Cranium: ${configFile.name} not found in apps/config")

@Suppress("UNCHECKED_CAST")
val craniumConfig = JsonSlurper().parse(configFile) as Map<String, Any?>

fun configValue(key: String, pattern: Regex): String {
    val value = (craniumConfig[key] as? String)?.trim()?.trimEnd('/')
        ?: throw GradleException("Cranium: apps/config/${configFile.name} has no \"$key\"")
    if (!pattern.matches(value)) {
        throw GradleException("Cranium: \"$key\" in apps/config/${configFile.name} does not look right (the value is not printed)")
    }
    return value
}

val httpsUrl = Regex("""^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$""")
val consoleUrl = configValue("consoleUrl", httpsUrl)
val loginDomain = configValue("loginDomain", httpsUrl)
val mobileClientId = configValue("mobileClientId", Regex("^[A-Za-z0-9]{1,128}$"))
val redirectUri = configValue("redirectUri", Regex("^cranium://signin$"))

// ---------------------------------------------------------------------------------------------
// Release signing. The keystore and its passwords live outside the repository, in
// ~/.cranium/android (build-release.sh creates them). Without them a release build is unsigned.
// ---------------------------------------------------------------------------------------------
val keystorePropertiesFile: File = file(
    System.getenv("CRANIUM_KEYSTORE_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.cranium/android/keystore.properties",
)

android {
    namespace = "com.craniumiot.cranium"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.craniumiot.cranium"
        minSdk = 26
        targetSdk = 37
        versionCode = providers.gradleProperty("craniumVersionCode").get().toInt()
        versionName = providers.gradleProperty("craniumVersionName").get()

        buildConfigField("String", "CONSOLE_URL", "\"$consoleUrl\"")
        buildConfigField("String", "LOGIN_DOMAIN", "\"$loginDomain\"")
        buildConfigField("String", "MOBILE_CLIENT_ID", "\"$mobileClientId\"")
        buildConfigField("String", "REDIRECT_URI", "\"$redirectUri\"")
        buildConfigField("boolean", "EXAMPLE_CONFIG", usingExampleConfig.toString())
        // AppAuth's redirect receiver listens for this scheme: cranium://signin.
        manifestPlaceholders["appAuthRedirectScheme"] = redirectUri.substringBefore("://")
    }

    signingConfigs {
        if (keystorePropertiesFile.isFile) {
            val keystore = Properties().apply { keystorePropertiesFile.inputStream().use { load(it) } }
            create("release") {
                storeFile = file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
                storeType = keystore.getProperty("storeType", "pkcs12")
            }
        }
    }

    buildTypes {
        release {
            // Not shrunk: mcumgr reads its responses with Jackson, by reflection, and nobody can
            // test a shrunk build against a board here.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.core.ktx)
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)
    implementation(libs.appauth)
    implementation(libs.security.crypto)
    implementation(libs.mcumgr.ble)
    implementation(libs.usb.serial)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
