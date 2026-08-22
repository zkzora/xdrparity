plugins {
    java
    application
    id("com.gradleup.shadow") version "8.3.9"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("network.lightsail:stellar-sdk:4.0.1")
    implementation("com.google.code.gson:gson:2.14.0")
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

application {
    mainClass = "Runner"
}

dependencyLocking {
    lockAllConfigurations()
}

tasks.shadowJar {
    archiveFileName = "runner-java-all.jar"
}
