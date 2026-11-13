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

    // JVM unit tests (./gradlew testDebugUnitTest) of the logic that needs no Android classes:
    // the storage rules and file store, and the gesture exclusion rectangles.
    testImplementation(libs.junit)
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
        // PWA plumbing, meaningless inside the app: js/pwa.js switches itself off there, so the
        // service worker, the web manifest and the install icons they refer to (icons/, with the
        // script that renders them) are never requested. The app has its own launcher icon.
        "sw.js", "**/*.webmanifest", "manifest.json", "icons/**",
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

// ---------------------------------------------------------------------------------------------
// Open-source notices. The APK tells its user which libraries it bundles and under which licence:
// src/main/assets/open_source_licenses.txt, which the game shows in Settings under "Open-source
// licences" (NativeBridge.openSourceLicenses). The list in that file is written by hand, after
// looking at the licence of each library, so the build checks it against what is really packaged.
// ---------------------------------------------------------------------------------------------

/**
 * Fails when the libraries listed in the notices file (its lines `- group:artifact`) are not
 * exactly the ones on the release runtime classpath. That happens when a dependency is added,
 * removed or renamed, also a transitive one after a version bump; the notices then have to follow.
 */
abstract class CheckOpenSourceNotices : DefaultTask() {

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val noticesFile: RegularFileProperty

    /** `group:artifact` of every library that is packaged into the app. */
    @get:Input
    abstract val packaged: SetProperty<String>

    /** Written on success, so that an unchanged list is not checked again. */
    @get:OutputFile
    abstract val result: RegularFileProperty

    @TaskAction
    fun check() {
        val file = noticesFile.get().asFile
        val listed = file.readLines().filter { it.startsWith("- ") }.map { it.removePrefix("- ").trim() }.toSet()
        val missing = (packaged.get() - listed).sorted()
        val stale = (listed - packaged.get()).sorted()
        if (missing.isNotEmpty() || stale.isNotEmpty()) {
            throw GradleException(
                buildString {
                    append("The open-source notices do not match the libraries in the app: $file\n")
                    if (missing.isNotEmpty()) {
                        append("Packaged but not listed (check the licence of each, then add a line \"- group:artifact\";\n")
                        append("a licence other than Apache 2.0 also needs its text in the file):\n")
                        missing.forEach { append("  - $it\n") }
                    }
                    if (stale.isNotEmpty()) {
                        append("Listed but no longer packaged (remove the line):\n")
                        stale.forEach { append("  - $it\n") }
                    }
                    append("The packaged libraries: ./gradlew :app:dependencies --configuration releaseRuntimeClasspath")
                },
            )
        }
        result.get().asFile.writeText(listed.sorted().joinToString(separator = "\n", postfix = "\n"))
    }
}

androidComponents {
    // Debug and release package the same libraries; the release classpath is the one that ships.
    onVariants(selector().withBuildType("release")) { variant ->
        val checkOpenSourceNotices = tasks.register<CheckOpenSourceNotices>("checkOpenSourceNotices") {
            group = "verification"
            description = "Checks that the open-source notices list exactly the libraries packaged into the app."
            noticesFile.set(layout.projectDirectory.file("src/main/assets/open_source_licenses.txt"))
            // Every module that contributes a file (a jar or an aar). Platforms (BOMs) and the
            // umbrella modules of multiplatform libraries have none and are not libraries in the APK.
            packaged.set(
                variant.runtimeConfiguration.incoming.artifacts.resolvedArtifacts.map { artifacts ->
                    artifacts.mapNotNull { it.id.componentIdentifier as? ModuleComponentIdentifier }
                        .map { "${it.group}:${it.module}" }
                        .toSet()
                },
            )
            result.set(layout.buildDirectory.file("checkOpenSourceNotices/libraries.txt"))
        }
        // Part of every build, debug included: an APK must not be produced with stale notices.
        tasks.named("preBuild") { dependsOn(checkOpenSourceNotices) }
    }
}
