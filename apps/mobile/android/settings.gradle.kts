pluginManagement {
    repositories {
        if ("true".equals(System.getenv("CI"), ignoreCase = true)) {
            google()
            mavenCentral()
            gradlePluginPortal()
        } else {
            // Prefer mainland mirrors for local builds where official repositories may be unreachable.
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/gradle-plugin")
            maven("https://maven.aliyun.com/repository/central")
            google()
            mavenCentral()
            gradlePluginPortal()
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (providers.gradleProperty("irohNative").orNull == "true") {
            // Official verifier archive pinned to a revision; Cargo.lock selects the AAR version.
            maven("https://raw.githubusercontent.com/rustls/rustls-platform-verifier/1aa691352a5e0c215210dfc9a3c2f2078639dc91/android-release-support/maven/") {
                content { includeGroup("org.rustls") }
            }
        }
        if ("true".equals(System.getenv("CI"), ignoreCase = true)) {
            google()
            mavenCentral()
        } else {
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/central")
            google()
            mavenCentral()
        }
    }
}

rootProject.name = "DSHMobileAndroid"
include(":app")
