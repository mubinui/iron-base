package dev.ironbase.plugin.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe

/**
 * Where the Anthropic API key lives — the OS keychain via IntelliJ's
 * `PasswordSafe`, the same mechanism `AuthManager` uses through VS Code's
 * `SecretStorage` in the extension this is ported from. Never settings.xml,
 * never a plain file: both sync and both get read by anything that can open
 * the project directory.
 */
object CredentialStore {
    private val attributes = CredentialAttributes(generateServiceName("IronBase", "anthropic-api-key"))

    fun getApiKey(): String? = PasswordSafe.instance.getPassword(attributes)

    fun setApiKey(key: String) {
        PasswordSafe.instance.set(attributes, Credentials("ironbase", key))
    }

    fun clearApiKey() {
        PasswordSafe.instance.set(attributes, null)
    }
}
