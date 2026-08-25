package dev.ironbase.plugin.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import dev.ironbase.plugin.llm.AnthropicClient
import dev.ironbase.plugin.llm.ChatMessage
import dev.ironbase.plugin.llm.LlmException
import dev.ironbase.plugin.llm.StreamEvent
import dev.ironbase.plugin.settings.CredentialStore
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JPasswordField
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * The tool window's whole UI: connect an account, then talk to it.
 *
 * Everything the VS Code panel's build conversation does beyond this — the
 * tool trace, planning versus building, permission prompts, checkpoint and
 * undo — belongs to the engine layer, which has not been ported (see the
 * module README). This is the one path that is real: type a message, get a
 * streamed reply back from the model you connected.
 *
 * A plain Swing tree rather than a JCEF-embedded copy of the VS Code webview.
 * JCEF gets closer to that panel's actual look, but it is a bundled Chromium
 * process with its own async-initialization and JS-bridge failure modes that
 * cannot be exercised from outside a running IDE — exactly the kind of bug
 * that would ship invisibly in a skeleton nobody can click through yet.
 * Swing is plain enough to read correctly by inspection.
 */
class ChatPanel : JPanel(BorderLayout()) {

    private val history = mutableListOf<ChatMessage>()
    private val transcript = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        border = JBUI.Borders.empty(8)
    }
    private val input = JBTextField()
    private val sendButton = JButton("Send")
    private val status = JBLabel(" ")
    private val apiKeyField = JPasswordField()
    private val modelBox = JComboBox(arrayOf("claude-opus-5", "claude-sonnet-5", "claude-haiku-4"))

    init {
        add(buildAccountBar(), BorderLayout.NORTH)
        add(JBScrollPane(transcript), BorderLayout.CENTER)
        add(buildComposer(), BorderLayout.SOUTH)

        CredentialStore.getApiKey()?.let { apiKeyField.text = it }
        renderTranscript()
    }

    // --- Layout ------------------------------------------------------------

    private fun buildAccountBar(): JPanel {
        val bar = JPanel()
        bar.layout = BoxLayout(bar, BoxLayout.Y_AXIS)
        bar.border = JBUI.Borders.empty(6, 8)

        val row = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
        row.add(JBLabel("Claude API key:"))
        apiKeyField.columns = 22
        row.add(apiKeyField)
        val save = JButton("Save")
        save.addActionListener {
            val key = String(apiKeyField.password).trim()
            if (key.isEmpty()) {
                setStatus("Enter a key first.", error = true)
                return@addActionListener
            }
            CredentialStore.setApiKey(key)
            setStatus("Saved to the system keychain.", error = false)
        }
        row.add(save)
        row.add(Box.createHorizontalStrut(12))
        row.add(JBLabel("Model:"))
        modelBox.isEditable = true
        row.add(modelBox)
        bar.add(row)

        status.foreground = UIColors.muted()
        status.border = JBUI.Borders.emptyLeft(2)
        bar.add(status)
        bar.add(JBLabel(" ").apply { border = JBUI.Borders.emptyBottom(4) })

        return bar
    }

    private fun buildComposer(): JPanel {
        val bar = JPanel(BorderLayout(6, 0))
        bar.border = JBUI.Borders.empty(8)
        input.addActionListener { send() }
        bar.add(input, BorderLayout.CENTER)
        sendButton.addActionListener { send() }
        bar.add(sendButton, BorderLayout.EAST)
        return bar
    }

    // --- Sending -------------------------------------------------------

    private fun send() {
        val text = input.text.trim()
        if (text.isEmpty()) return

        val apiKey = String(apiKeyField.password).trim()
        if (apiKey.isEmpty()) {
            setStatus("Set a Claude API key above first.", error = true)
            return
        }

        history.add(ChatMessage(ChatMessage.Role.USER, text))
        // The assistant's turn is added empty and grown in place as the reply
        // streams in, so `renderTranscript` never has to know it is mid-turn.
        val assistantTurn = ChatMessage(ChatMessage.Role.ASSISTANT, "")
        history.add(assistantTurn)
        input.text = ""
        renderTranscript()
        setBusy(true)

        val model = (modelBox.editor.item as? String)?.trim().orEmpty().ifEmpty { "claude-opus-5" }
        val client = AnthropicClient(apiKey, model)
        val sentTurns = history.dropLast(1) // the empty assistant turn carries nothing to send

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                client.chat(sentTurns, onEvent = { event ->
                    SwingUtilities.invokeLater {
                        when (event) {
                            is StreamEvent.Text -> {
                                val index = history.lastIndex
                                history[index] = history[index].copy(text = history[index].text + event.delta)
                                renderTranscript()
                            }
                            is StreamEvent.Done -> {
                                setBusy(false)
                                setStatus(
                                    "${event.inputTokens} in / ${event.outputTokens} out tokens.",
                                    error = false,
                                )
                            }
                        }
                    }
                })
            } catch (err: LlmException) {
                SwingUtilities.invokeLater {
                    setBusy(false)
                    setStatus(err.message ?: "The request failed.", error = true)
                }
            } catch (err: Exception) {
                SwingUtilities.invokeLater {
                    setBusy(false)
                    setStatus("Unexpected error: ${err.message}", error = true)
                }
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        sendButton.isEnabled = !busy
        input.isEnabled = !busy
        if (busy) setStatus("Waiting for a reply…", error = false)
    }

    private fun setStatus(text: String, error: Boolean) {
        status.text = text
        status.foreground = if (error) UIColors.error() else UIColors.muted()
    }

    // --- Rendering -----------------------------------------------------

    private fun renderTranscript() {
        val text = history.joinToString("\n\n") { turn ->
            val who = if (turn.role == ChatMessage.Role.USER) "You" else "IronBase"
            "$who:\n${turn.text}"
        }
        transcript.text = text
        transcript.caretPosition = transcript.document.length
    }
}

/**
 * Small, fixed colours rather than a full theme dependency — a skeleton this
 * size does not need `EditorColorsManager` wired in for two label tints.
 */
private object UIColors {
    fun muted(): Color = Color(128, 128, 128)
    fun error(): Color = Color(200, 70, 70)
}
