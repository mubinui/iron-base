plugins {
    id("java")
    kotlin("jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(providers.gradleProperty("platformType"), providers.gradleProperty("platformVersion"))
        // BasePlatformTestCase and friends — a real, headless IDE fixture that
        // runs under `./gradlew test`, no display required. It is what makes
        // WorkspaceToolsTest an actual verification of VFS-touching code
        // rather than something only checkable by clicking through a running
        // IDE, which this environment cannot do.
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
    testImplementation(kotlin("test-junit5"))
    // Gradle 9's test executor needs the launcher on the runtime classpath
    // explicitly; `useJUnitPlatform()` alone no longer pulls it in.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // BasePlatformTestCase is written against JUnit 3's TestCase — the
    // platform's own test suite predates JUnit 5 and still runs this way.
    // junit:junit carries that class for compilation; the Vintage engine is
    // what lets Gradle's JUnit5-only `useJUnitPlatform()` runner execute it.
    testImplementation("junit:junit:4.13.2")
    testRuntimeOnly("org.junit.vintage:junit-vintage-engine")
}

kotlin {
    // IC 2024.2 is itself built and run on JBR 21; a plugin targeting it
    // compiles against the same bytecode level.
    jvmToolchain(21)
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = "242"
        }
    }
}

tasks {
    test {
        useJUnitPlatform()
    }
}
