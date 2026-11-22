// Root build file: plugin versions come from gradle/libs.versions.toml, modules apply them.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
