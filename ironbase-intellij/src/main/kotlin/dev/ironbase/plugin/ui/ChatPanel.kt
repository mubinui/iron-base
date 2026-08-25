package dev.ironbase.plugin.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import dev.ironbase.plugin.engine.AgentLoop
import dev.ironbase.plugin.llm.AnthropicClient
import dev.ironbase.plugin.llm.LlmException
import dev.ironbase.plugin.llm.Turn
import dev.ironbase.plugin.settings.CredentialStore
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JPanel
import javax.swing.JPasswordField
import javax.swing.SwingUtilities

/**
 * The tool window's whole UI: connect an account, then talk to it about the
 * open project.
 *
 * Everything the VS Code panel's build conversation does beyond this — plan
 * versus build, the tool trace's real UI, permission prompts, checkpoint and
 * undo, writing files at all — belongs to the engine layer this has only
 * partly ported (see the module README). What is real: the model can read
 * files, list directories and search the project through `AgentLoop`, and
 * you can watch it do that while it answers.
 *
 * A plain Swing tree rather than a JCEF-embedded copy of the VS Code webview.
 * JCEF gets closer to that panel's actual look, but it is a bundled Chromium
 * process with its own async-initialization and JS-bridge failure modes that
 * cannot be exercised from outside a running IDE — exactly the kind of bug
 * that would ship invisibly in a skeleton nobody can click through yet.
 * Swing is plain enough to read correctly by inspection.
 */
class ChatPanel(private val project: Project) : JPanel(BorderLayout()) {

    private val history = mutableListOf<Turn>()
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

    /** Set while a tool's activity line is open, waiting for its result. */
    private var toolLineOpen = false

    init {
        add(buildAccountBar(), BorderLayout.NORTH)
        add(JBScrollPane(transcript), BorderLayout.CENTER)
        add(buildComposer(), BorderLayout.SOUTH)

        CredentialStore.getApiKey()?.let { apiKeyField.text = it }
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
        val root = project.basePath?.let { LocalFileSystem.getInstance().findFileByPath(it) }
        if (root == null) {
            setStatus("Could not find this project's root folder.", error = true)
            return
        }

        appendLine("You:")
        appendLine(text)
        appendRaw("\nIronBase:\n")
        history.add(Turn.User(text))
        input.text = ""
        setBusy(true)

        val model = (modelBox.editor.item as? String)?.trim().orEmpty().ifEmpty { "claude-opus-5" }
        val loop = AgentLoop(AnthropicClient(apiKey, model), root)

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                loop.run(
                    history = history,
                    onProgress = { progress ->
                        SwingUtilities.invokeLater { render(progress) }
                    },
                )
                SwingUtilities.invokeLater {
                    appendRaw("\n\n")
                    setBusy(false)
                }
            } catch (err: LlmException) {
                SwingUtilities.invokeLater {
                    appendRaw("\n")
                    setBusy(false)
                    setStatus(err.message ?: "The request failed.", error = true)
                }
            } catch (err: Exception) {
                SwingUtilities.invokeLater {
                    appendRaw("\n")
                    setBusy(false)
                    setStatus("Unexpected error: ${err.message}", error = true)
                }
            }
        }
    }

    /** Applies one `AgentLoop.Progress` event to the transcript. Always on the EDT. */
    private fun render(progress: AgentLoop.Progress) {
        when (progress) {
            is AgentLoop.Progress.Text -> appendRaw(progress.delta)
            is AgentLoop.Progress.ToolStarted -> {
                if (toolLineOpen) appendRaw("\n")
                appendRaw("  → ${progress.name} ${progress.summary}".trimEnd())
                toolLineOpen = true
            }
            is AgentLoop.Progress.ToolFinished -> {
                if (progress.note != null) {
                    appendRaw(if (progress.ok) " — ${progress.note}" else " — ${progress.note} (failed)")
                }
                appendRaw("\n")
                toolLineOpen = false
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        sendButton.isEnabled = !busy
        input.isEnabled = !busy
        if (busy) setStatus("Working…", error = false) else setStatus(" ", error = false)
    }

    private fun setStatus(text: String, error: Boolean) {
        status.text = text
        status.foreground = if (error) UIColors.error() else UIColors.muted()
    }

    // --- Rendering -----------------------------------------------------

    private fun appendLine(text: String) = appendRaw("$text\n")

    private fun appendRaw(text: String) {
        transcript.append(text)
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
