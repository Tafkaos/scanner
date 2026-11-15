plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.tafkaos.scanner"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.tafkaos.scanner"
        minSdk = 29
        targetSdk = 35
        // Jeder GitHub-Build bekommt eine höhere Nummer, damit Updates sauber installieren.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // Fester Schlüssel nur für den privaten Gebrauch: So lässt sich jede neue
    // Version über die alte installieren, ohne dass Daten verloren gehen.
    signingConfigs {
        create("privat") {
            storeFile = rootProject.file("keystore/scanner.jks")
            storePassword = "scanner-privat"
            keyAlias = "scanner"
            keyPassword = "scanner-privat"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("privat")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("privat")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")
}
