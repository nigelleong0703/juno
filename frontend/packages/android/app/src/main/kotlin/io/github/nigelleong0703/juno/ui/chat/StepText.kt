package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A step in words (iOS `stepLine`). The agent's tools arrive as `verb: "Executed", target: "<tool name>"`; this turns
 * them into one readable sentence and hides bookkeeping. Condensed from the Swift: the common tools are named, the rest
 * are humanized. Null means "not worth a row".
 */
object StepText {
    private val hidden = setOf(
        "task_update", "task_stop", "tasks_list", "todo_write", "send_message", "state_update", "goal_update", "react",
        "profile_update", "agent_update", "connect_request", "transcript_read", "computer.screenshot", "browser.snapshot",
        "browser.get_text", "output_read", "child_wait", "child_results", "child_poll", "computer.move",
    )

    fun tool(step: Step): String = when (step.verb) {
        "Read" -> "web_fetch"
        "Looked up" -> "web_search"
        "Asked a helper" -> "child_spawn"
        else -> step.target.orEmpty()
    }

    private fun args(step: Step): JsonObject? =
        step.input?.summary?.let { runCatching { JunoJson.parseToJsonElement(it).jsonObject }.getOrNull() }

    private fun arg(step: Step, key: String): String? = args(step)?.get(key)?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }

    fun clip(s: String, n: Int): String {
        val one = s.replace("\n", " ").trim()
        return if (one.length > n) one.take(n).trim() + "…" else one
    }

    fun line(step: Step): String? {
        val tool = tool(step)
        if (tool in hidden || tool.startsWith("memory_")) return null
        val out = step.output?.summary ?: step.output?.text ?: ""
        if (step.status == "failed" && out.startsWith("Not clicked:")) return "Waiting for your approval to place the order"
        val onMac = if (arg(step, "on") == "mac") " on your Mac" else ""
        return when (tool) {
            "web_search" -> "Searched for “${clip(arg(step, "query") ?: step.target.orEmpty(), 60)}”"
            "web_fetch" -> "Read ${page(step, out)}"
            "browser.navigate", "browser.new_tab" -> "Opened ${page(step, out)} in the browser"
            "browser.click", "computer.click", "computer.double_click", "computer.right_click" ->
                clickedLabel(out)?.let { "Clicked ${clip(it, 50)}" } ?: "Clicked on the page"
            "browser.type", "computer.type" -> arg(step, "text").orEmpty().let { if (it.isEmpty()) "Typed some text" else "Typed “${clip(it, 40)}”" }
            "browser.fill" -> "Filled in a field"
            "computer.scroll" -> "Scrolled the page"
            "computer.key" -> "Pressed ${arg(step, "key") ?: "a key"}"
            "browser.tabs" -> "Checked the open tabs"
            "browser.dialog" -> "Answered a page dialog"
            "child_spawn" -> (arg(step, "title") ?: step.target).orEmpty().let { if (it.isEmpty()) "Asked a helper for a hand" else "Asked a helper to ${clip(it, 60)}" }
            "request_secure_input" -> "Asked you for details"
            "request_takeover" -> "Asked you to take over the screen"
            "shell.run", "shell.start" -> (arg(step, "command") ?: step.input?.command).orEmpty().let { (if (it.isEmpty()) "Ran a command" else "Ran ${clip(it, 40)}") + onMac }
            "files.read", "files.write", "files.edit" -> {
                val name = arg(step, "path")?.substringAfterLast('/')
                val verb = when (tool) { "files.read" -> "Read"; "files.write" -> "Wrote"; else -> "Edited" }
                (if (name.isNullOrEmpty()) "$verb a file" else "$verb $name") + onMac
            }
            else -> humanize(tool)
        }
    }

    private fun page(step: Step, out: String): String {
        val url = arg(step, "url") ?: step.input?.url.orEmpty()
        val host = url.substringAfter("://", "").substringBefore('/').removePrefix("www.").ifEmpty { null }
        val title = out.lineSequence().firstOrNull()?.takeIf { it.startsWith("Title:") }?.removePrefix("Title:")?.trim()?.ifEmpty { null }
        return title?.let { clip(it, 80) } ?: host ?: "a page"
    }

    /** The backend names what was clicked: `Clicked "512 GB" (e681) ...`. */
    private fun clickedLabel(out: String): String? {
        if (!out.startsWith("Clicked \"")) return null
        return out.drop(9).substringBefore('"').ifEmpty { null }
    }

    fun humanize(tool: String): String {
        val words = tool.replace('_', ' ').replace('.', ' ').replace('-', ' ')
        return if (words.isEmpty()) "Did something" else words.replaceFirstChar { it.uppercase() }
    }

    /** The steps that get a row: a step that reads the same as the one before shows once. */
    fun visible(steps: List<Step>): List<Step> {
        var last: String? = null
        return steps.filter { s ->
            val l = line(s) ?: return@filter false
            (l != last).also { last = l }
        }
    }

    private val ing = mapOf(
        "Clicked" to "Clicking", "Opened" to "Opening", "Searched" to "Searching", "Typed" to "Typing", "Filled" to "Filling",
        "Scrolled" to "Scrolling", "Pressed" to "Pressing", "Ran" to "Running", "Read" to "Reading", "Wrote" to "Writing",
        "Edited" to "Editing", "Copied" to "Copying", "Checked" to "Checking", "Answered" to "Answering", "Asked" to "Asking", "Looked" to "Looking",
    )

    fun progressive(line: String): String {
        val first = line.substringBefore(' ')
        return ing[first]?.let { it + line.removePrefix(first) } ?: line
    }

    /** "Clicking 256GB Included…", "Opening apple.com…", or "Working…". */
    fun statusText(steps: List<Step>): String {
        val step = steps.lastOrNull { line(it) != null } ?: return "Working…"
        val l = line(step) ?: return "Working…"
        return if (step.status == "running") progressive(l) + "…" else "$l…"
    }
}
