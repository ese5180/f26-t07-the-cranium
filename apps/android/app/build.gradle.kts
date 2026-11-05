import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ---------------------------------------------------------------------------------------------
// Configuration: the values of the deployed stack (docs/mobile-apps.md, "Configuration").
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
// The app's own sign-in screen talks to the user pool itself (SRP), as the console's page does.
val region = configValue("region", Regex("^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$"))
val userPoolId = configValue("userPoolId", Regex("^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}_[0-9A-Za-z]{1,64}$"))
if (!userPoolId.startsWith("${region}_")) {
    throw GradleException("Cranium: \"userPoolId\" in apps/config/${configFile.name} is not in its \"region\" (the values are not printed)")
}

// The customer side (docs/mobile-apps.md, "Customers"): the customer pool, its phone client, its Region
// and the customer API's address. All four or none: a configuration written before the stack had the
// customer pool has none, and then the app has the admin sign-in only and says so.
val customerKeys = listOf("customerApiUrl", "customerClientId", "customerRegion", "customerUserPoolId")
val customerGiven = customerKeys.filter { craniumConfig[it] != null }
if (customerGiven.isNotEmpty() && customerGiven.size != customerKeys.size) {
    throw GradleException(
        "Cranium: apps/config/${configFile.name} has ${customerGiven.joinToString()} but not " +
            "${(customerKeys - customerGiven.toSet()).joinToString()}: all four or none. Run apps/configure.sh",
    )
}
val hasCustomer = customerGiven.isNotEmpty()
val customerApiUrl = if (hasCustomer) configValue("customerApiUrl", httpsUrl) else ""
val customerClientId = if (hasCustomer) configValue("customerClientId", Regex("^[A-Za-z0-9]{1,128}$")) else ""
val customerRegion = if (hasCustomer) configValue("customerRegion", Regex("^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$")) else ""
val customerUserPoolId = if (hasCustomer) configValue("customerUserPoolId", Regex("^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}_[0-9A-Za-z]{1,64}$")) else ""
if (hasCustomer && !customerUserPoolId.startsWith("${customerRegion}_")) {
    throw GradleException("Cranium: \"customerUserPoolId\" in apps/config/${configFile.name} is not in its \"customerRegion\" (the values are not printed)")
}

// Help: apps/shared/help.json, the topics both phone apps show, goes into the app as an asset when
// it is there. Without it the Help screen says that this build has none.
val helpFile: File = rootDir.resolve("../shared/help.json").canonicalFile

abstract class CopyHelp : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val help: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        help.files.filter { it.isFile }.forEach { it.copyTo(out.resolve("help.json"), overwrite = true) }
    }
}

val copyHelp = tasks.register<CopyHelp>("copyHelp") {
    help.from(helpFile)
    outputDir.set(layout.buildDirectory.dir("generated/helpAssets"))
}

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
        buildConfigField("String", "REGION", "\"$region\"")
        buildConfigField("String", "USER_POOL_ID", "\"$userPoolId\"")
        // Empty strings when the configuration has no customer pool.
        buildConfigField("String", "CUSTOMER_API_URL", "\"$customerApiUrl\"")
        buildConfigField("String", "CUSTOMER_CLIENT_ID", "\"$customerClientId\"")
        buildConfigField("String", "CUSTOMER_REGION", "\"$customerRegion\"")
        buildConfigField("String", "CUSTOMER_USER_POOL_ID", "\"$customerUserPoolId\"")
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

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyHelp, CopyHelp::outputDir)
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
    implementation(libs.biometric)
    implementation(libs.fragment)
    implementation(libs.appcompat)
    implementation(libs.mcumgr.ble)
    implementation(libs.usb.serial)
    implementation(libs.work.runtime.ktx)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
