import java.util.Base64

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val stableKeyB64 = System.getenv("ANDROID_KEYSTORE_BASE64").orEmpty().trim()
val stableStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD").orEmpty()
val stableKeyAlias = System.getenv("ANDROID_KEY_ALIAS").orEmpty().trim()
val stableKeyPassword = System.getenv("ANDROID_KEY_PASSWORD").orEmpty()
val hasStableDebugKey = listOf(stableKeyB64, stableStorePassword, stableKeyAlias, stableKeyPassword).all { it.isNotBlank() }

if (!hasStableDebugKey) {
    logger.warn("ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD are not all set. This debug APK uses a one-off signing key, so installing it over a previous copy fails with 'App not installed' until the old app is uninstalled.")
}

val stableKeystoreFile = layout.buildDirectory.file("frontier-stable-debug.keystore")

android {
    namespace="com.frontierguide.app"
    compileSdk=36
    buildFeatures { buildConfig = true }
    defaultConfig { applicationId="com.frontierguide.app"; minSdk=29; targetSdk=36; versionCode=8; versionName="1.4.1" }
    if (hasStableDebugKey) {
        val keystoreFile = stableKeystoreFile.get().asFile
        keystoreFile.parentFile?.mkdirs()
        keystoreFile.writeBytes(Base64.getDecoder().decode(stableKeyB64))
        signingConfigs {
            create("stableDebug") {
                storeFile = keystoreFile
                storePassword = stableStorePassword
                keyAlias = stableKeyAlias
                keyPassword = stableKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            if (hasStableDebugKey) signingConfig = signingConfigs.getByName("stableDebug")
        }
    }
    compileOptions {
        sourceCompatibility=JavaVersion.VERSION_17
        targetCompatibility=JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
