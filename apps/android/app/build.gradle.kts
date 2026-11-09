import groovy.json.JsonSlurper
import java.io.ByteArrayOutputStream
import java.util.Properties
import javax.inject.Inject
import org.gradle.process.ExecOperations

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
// customer pool has none, and then the one sign-in takes team accounts only.
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

// The live API's WebSocket (docs/live.md), from console 2.4.0: the pages keep it open, so that a board's
// change shows at once. A configuration without it builds an app whose pages poll. It goes into the
// pages' policy, so it must be exactly what the stack's LiveUrl output is, in the user pool's Region
// (CraniumConfig.isLiveUrl checks the same).
val liveUrl = if (craniumConfig["liveUrl"] != null) {
    configValue("liveUrl", Regex("^wss://[a-z0-9]{10}\\.execute-api\\.${Regex.escape(region)}\\.amazonaws\\.com/[A-Za-z0-9_-]{1,128}$"))
} else {
    ""
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
// The web bundle built into the app (docs/mobile-apps.md, "The app shell"): the console's and the
// customer site's pages as cloud/web/build-bundle.mjs writes them, into assets/web/ (manifest.json and
// files/<sha256>). The app serves it until it has fetched a newer one from the console, and falls back
// on it whenever what it fetched does not check out. Node.js makes it: the same code that serves it.
// ---------------------------------------------------------------------------------------------
val repoDir: File = rootDir.resolve("../..").canonicalFile

abstract class BuildWebBundle : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webSources: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val script: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val consoleVersion: RegularFileProperty

    @get:Input
    abstract val node: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun build() {
        val root = outputDir.get().asFile
        root.deleteRecursively()
        root.mkdirs()
        val output = ByteArrayOutputStream()
        val result = try {
            exec.exec {
                commandLine(node.get(), script.get().asFile.absolutePath, "--out", root.resolve("web").absolutePath)
                standardOutput = output
                errorOutput = output
                isIgnoreExitValue = true
            }
        } catch (e: Exception) {
            throw GradleException(
                "Cranium: the app's built-in web bundle is made with Node.js (cloud/web/build-bundle.mjs), and " +
                    "\"${node.get()}\" could not be run. Install Node.js 20 or later, or set CRANIUM_NODE to its path.",
            )
        }
        if (result.exitValue != 0) {
            throw GradleException("Cranium: cloud/web/build-bundle.mjs failed: ${output.toString().trim()}")
        }
        logger.lifecycle(output.toString().trim())
    }
}

val buildWebBundle = tasks.register<BuildWebBundle>("buildWebBundle") {
    webSources.set(repoDir.resolve("cloud/web/src"))
    script.set(repoDir.resolve("cloud/web/build-bundle.mjs"))
    consoleVersion.set(repoDir.resolve("cloud/VERSION"))
    node.set(providers.environmentVariable("CRANIUM_NODE").orElse("node"))
    outputDir.set(layout.buildDirectory.dir("generated/webBundle"))
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
        // Empty when the configuration has no live API: the pages poll.
        buildConfigField("String", "LIVE_URL", "\"$liveUrl\"")
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

// The unit tests read the built-in bundle as the app does (BuiltInBundleTest): Node's manifest, the app's reader.
tasks.withType<Test>().configureEach {
    dependsOn(buildWebBundle)
    systemProperty("cranium.webBundle", layout.buildDirectory.dir("generated/webBundle/web").get().asFile.absolutePath)
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyHelp, CopyHelp::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(buildWebBundle, BuildWebBundle::outputDir)
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
    implementation(libs.webkit)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
