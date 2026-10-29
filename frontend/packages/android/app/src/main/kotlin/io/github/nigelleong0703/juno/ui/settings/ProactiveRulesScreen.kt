package io.github.nigelleong0703.juno.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ProactiveRule
import io.github.nigelleong0703.juno.state.keepProactiveRule
import io.github.nigelleong0703.juno.state.proactiveRules
import io.github.nigelleong0703.juno.state.removeProactiveRule
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private const val CAP = 5
private val GROUPS = listOf("dont" to "Don't tell me", "less" to "Less of", "tell" to "Tell me", "where" to "Where and how")
private const val EMPTY = "Juno learns from the buttons and from what you tell it in chat, e.g. “stop telling me about cricket”."

/**
 * Settings > What's worth interrupting me for (iOS `ProactiveRulesView`): what Juno learned from the Ideas buttons and from
 * chat, grouped by what it does. Long press removes a rule (with a confirm); one due for review asks Keep or Remove.
 */
@Composable
fun ProactiveRulesScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    var rules by remember { mutableStateOf<List<ProactiveRule>?>(null) }
    var expanded by remember { mutableStateOf(emptySet<String>()) }
    var removing by remember { mutableStateOf<ProactiveRule?>(null) }
    LaunchedEffect(Unit) { rules = world.proactiveRules() ?: emptyList() }

    GroupedPage("What's worth interrupting me for", onBack) {
        val all = rules.orEmpty()
        if (rules != null && all.isEmpty()) GroupedSection { SettingsEmpty(EMPTY) }
        GROUPS.forEach { (kind, title) ->
            val items = all.filter { it.kind == kind }
            if (items.isEmpty()) return@forEach
            val open = kind in expanded
            GroupedSection(header = title) {
                (if (open) items else items.take(CAP)).forEach { rule ->
                    GroupedRow(
                        rule.text,
                        subtitle = "${rule.source} · ${dateText(rule.date)}",
                        onLongClick = { removing = rule },
                        trailing = if (rule.dueForReview) { { SettingsPill("Review", onClick = {}, enabled = false) } } else null,
                        extra = if (rule.dueForReview) {
                            {
                                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    SettingsPill("Keep", onClick = {
                                        world.keepProactiveRule(rule.id)
                                        rules = rules?.map { if (it.id == rule.id) it.copy(dueForReview = false) else it }
                                    })
                                    SettingsPill("Remove", onClick = { removing = rule })
                                }
                            }
                        } else null,
                    )
                }
                if (items.size > CAP) {
                    ShowMoreButton(if (open) "Show fewer" else "Show ${items.size - CAP} more") { expanded = if (open) expanded - kind else expanded + kind }
                }
            }
        }
    }

    removing?.let { rule ->
        ConfirmDialog(
            title = "Remove this?", body = rule.text, confirm = "Remove",
            onConfirm = {
                removing = null
                world.removeProactiveRule(rule.id)
                rules = rules?.filter { it.id != rule.id }
            },
            onDismiss = { removing = null },
        )
    }
}

private fun dateText(date: String): String =
    runCatching { LocalDate.parse(date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(date)
