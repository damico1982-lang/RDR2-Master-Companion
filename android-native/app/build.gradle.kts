plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace="com.frontierguide.app"
    compileSdk=36
    defaultConfig { applicationId="com.frontierguide.app"; minSdk=29; targetSdk=36; versionCode=3; versionName="1.2.0" }
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
