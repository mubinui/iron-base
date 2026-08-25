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
    }
    testImplementation(kotlin("test-junit5"))
    // Gradle 9's test executor needs the launcher on the runtime classpath
    // explicitly; `useJUnitPlatform()` alone no longer pulls it in.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
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
