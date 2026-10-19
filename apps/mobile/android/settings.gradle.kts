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
