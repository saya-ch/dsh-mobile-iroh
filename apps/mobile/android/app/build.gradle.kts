plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStoreFile = providers.environmentVariable("DSH_IROH_ANDROID_KEYSTORE_FILE")
val releaseStorePassword = providers.environmentVariable("DSH_IROH_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("DSH_IROH_ANDROID_KEY_ALIAS")
val releaseKeyPassword = providers.environmentVariable("DSH_IROH_ANDROID_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it.isPresent && it.get().isNotBlank() }

// Native transport is opt-in until its HTTPS WebView integration is accepted.
val irohNativeEnabled = providers.gradleProperty("irohNative").orNull == "true"
val irohAbis = providers.gradleProperty("irohAbis").orElse("arm64-v8a,x86_64")
val irohJniOutput = layout.buildDirectory.dir("generated/iroh/jniLibs")
val irohRoot = rootProject.projectDir.resolve("../../..").canonicalFile
val irohNdk = providers.gradleProperty("irohNdk").orElse(providers.environmentVariable("ANDROID_NDK_HOME"))
val buildIrohTransport = tasks.register<Exec>("buildIrohTransport") {
    group = "build"
    description = "Build and verify selected Rust Android ABIs with an explicitly selected NDK"
    onlyIf { irohNativeEnabled }
    inputs.dir(irohRoot.resolve("android-transport/src"))
    inputs.file(irohRoot.resolve("android-transport/Cargo.toml"))
    inputs.dir(irohRoot.resolve("tether-core/src"))
    inputs.file(irohRoot.resolve("tether-core/Cargo.toml"))
    inputs.file(irohRoot.resolve("Cargo.lock"))
    inputs.file(irohRoot.resolve("scripts/build-android-transport.mjs"))
    inputs.property("abis", irohAbis)
    inputs.property("ndk", irohNdk.orElse("not-configured"))
    if (irohNativeEnabled && irohNdk.isPresent) inputs.file(file(irohNdk.get()).resolve("source.properties"))
    outputs.dir(irohJniOutput)
    doFirst {
        val selectedNdk = irohNdk.orNull
            ?: error("Native builds require -PirohNdk=<NDK directory> or ANDROID_NDK_HOME")
        commandLine(
            "node", irohRoot.resolve("scripts/build-android-transport.mjs").absolutePath,
            "--ndk", selectedNdk,
            "--abis", irohAbis.get(),
            "--output", irohJniOutput.get().asFile.absolutePath,
        )
    }
}

android {
    namespace = "io.github.sayach.dshmobileiroh"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.sayach.dshmobileiroh"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-alpha.1"
        buildConfigField("boolean", "IROH_NATIVE_ENABLED", irohNativeEnabled.toString())
        // Native capabilities follow the copied DSH Mobile API baseline, not product version 0.1.
        buildConfigField("String", "MOBILE_COMPATIBILITY_VERSION", "\"0.6.5\"")
        if (irohNativeEnabled) {
            val selected = irohAbis.get().split(',')
            require(selected.isNotEmpty() && selected.distinct().size == selected.size
                && selected.all { it == "arm64-v8a" || it == "x86_64" }) { "Unsupported iroh ABI selection" }
            ndk.abiFilters.addAll(selected)
        }
    }

    signingConfigs {
        create("release") {
            if (releaseSigningConfigured) {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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

    lint {
        checkTestSources = false
    }

    sourceSets.getByName("test").resources.srcDir("../../contract")
    if (irohNativeEnabled) {
        sourceSets.getByName("main").jniLibs.srcDir(irohJniOutput)
    }
    packaging.jniLibs.useLegacyPackaging = false
    // The selected NDK strips and verifies these libraries before Gradle packages them.
    packaging.jniLibs.keepDebugSymbols.add("**/libdsh_mobile_iroh_android_transport.so")
}

if (irohNativeEnabled) {
    tasks.named("preBuild").configure { dependsOn(buildIrohTransport) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("com.google.zxing:core:3.5.4")
    if (irohNativeEnabled) {
        val lockText = providers.fileContents(layout.projectDirectory.file("../../../../Cargo.lock")).asText.get()
        val shim = Regex("(?m)^name = \"rustls-platform-verifier-android\"\\r?\\nversion = \"([^\"]+)\"")
            .findAll(lockText).toList().singleOrNull()
            ?: error("Cargo.lock must contain exactly one Android platform verifier version")
        implementation("org.rustls:rustls-platform-verifier:${shim.groupValues[1]}")
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
