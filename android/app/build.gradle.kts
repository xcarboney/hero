import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "io.github.xcarboney.solitaire"
    compileSdk = 36
    // Pinned so the build does not depend on whichever build-tools AGP would pick by default.
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.xcarboney.solitaire"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            // Same applicationId as release on purpose: one install, one saved game.
        }
        release {
            // R8: shrink + optimise code, then drop unused resources. The JavascriptInterface keep
            // rules live in proguard-rules.pro. No signingConfig is checked in (see README.md), so
            // assembleRelease produces app-release-unsigned.apk.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    // Bytecode target 17 for Java and Kotlin. Deliberately not `kotlin { jvmToolchain(17) }`:
    // that would require exactly JDK 17 to be installed, while this builds with JDK 17 or 21.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true // BuildConfig.DEBUG gates WebView remote debugging
    }

    androidResources {
        // The app's own strings are English only: do not ship (or advertise) the dozens of
        // translations that the androidx libraries bring along.
        localeFilters += "en"
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        // "A newer version is available" checks. Each one fires for a deliberate pin, explained in
        // gradle/libs.versions.toml: AGP 9 needs Gradle 9, androidx.core 1.19 needs AGP 9.1 and
        // compileSdk 37, Kotlin 2.4 deprecates the pinned Gradle. Upgrade them together.
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}

// ---------------------------------------------------------------------------------------------
// The web game is the single source of truth: /solitaire in the repository root. Nothing is
// copied into src/. Instead this task syncs the runtime files into a generated assets directory
// that AGP merges into every variant, so the APK always contains the current game under
// assets/solitaire/.
// ---------------------------------------------------------------------------------------------

/**
 * Copies the runtime files of the web game into `<outputDir>/solitaire/`.
 *
 * Incremental (only the filtered file tree is an input, so editing dev/ or tests/ does not rerun
 * it), cacheable (relative path sensitivity) and strict: a checkout without the game fails here
 * with a clear message instead of producing an APK that shows a blank page.
 */
@CacheableTask
abstract class BundleWebGame : DefaultTask() {

    /** Root of the web game. Not an input itself: [sources] is the filtered view that counts. */
    @get:Internal
    abstract val webGameDir: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    @get:IgnoreEmptyDirectories
    abstract val sources: ConfigurableFileTree

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fileSystem: FileSystemOperations

    @TaskAction
    fun bundle() {
        val root = webGameDir.get().asFile
        if (!root.resolve("index.html").isFile) {
            throw GradleException(
                "Web game not found: ${root.resolve("index.html")} does not exist.\n" +
                    "The Android app bundles the web game from the 'solitaire' directory next to " +
                    "'android' in the repository; check out the whole repository, not only android/.",
            )
        }
        fileSystem.sync {
            from(sources)
            into(outputDir.dir("solitaire"))
            includeEmptyDirs = false
        }
    }
}

val bundleWebGame = tasks.register<BundleWebGame>("bundleWebGame") {
    group = "build"
    description = "Copies the web game (../solitaire) into the generated APK assets (assets/solitaire/)."
    webGameDir.set(rootProject.layout.projectDirectory.dir("../solitaire"))
    sources.setDir(webGameDir)
    // Only what the page needs at runtime goes into the APK.
    sources.exclude(
        "dev/**", // demo pages of the web modules
        "tests/**", "test/**", "**/*.test.js", "**/*.spec.js",
        "**/.*", "**/.*/**", // dot-files and dot-directories
        "sw.js", "**/*.webmanifest", "manifest.json", // PWA plumbing: meaningless inside the app
        "node_modules/**", "package.json", "package-lock.json",
        "**/*.md", "**/*.map",
    )
}

androidComponents {
    onVariants { variant ->
        // AGP assigns outputDir and makes asset merging (and lint) depend on the task.
        variant.sources.assets?.addGeneratedSourceDirectory(bundleWebGame, BundleWebGame::outputDir)
    }
}
