package io.github.nigelleong0703.juno.ui.screens.rules

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.NewRuleDraft
import io.github.nigelleong0703.juno.state.NewRuleScopes
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.RuleBehaviors
import io.github.nigelleong0703.juno.state.behaviorsFor
import io.github.nigelleong0703.juno.state.createRule
import io.github.nigelleong0703.juno.state.subjectPlaceholder
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** "New rule" (web NewRuleDialog): the rule text, what it applies to, its subject and the behaviour when it matches. */
@Composable
fun NewRuleSheet(onDismiss: () -> Unit, onCreated: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(NewRuleDraft()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val ready = draft.toInput() != null

    JunoSheet(
        "New rule", onDismiss, long = true, primary = "Add rule", primaryEnabled = ready, loading = busy,
        onPrimary = {
            val input = draft.toInput()
            if (input != null) {
                busy = true; error = null
                scope.launch {
                    try { world.createRule(input); onCreated() }
                    catch (e: Throwable) { if (!e.isCancellation) error = e.userMessage }
                    busy = false
                }
            }
        },
    ) {
        Text(
            "Decide how agents handle one kind of decision before it reaches you.",
            style = junoText(TextSize.Base), color = JunoTheme.colors.fgMuted,
        )
        FormField("Rule") { FormTextField(draft.description, { draft = draft.copy(description = it) }, "e.g. Don’t email anyone outside the team") }
        FormField("Applies to") {
            GroupedSection {
                NewRuleScopes.forEach { (value, label) ->
                    GroupedChoiceRow(label, selected = draft.scope == value, onClick = { draft = draft.withScope(value) })
                }
            }
        }
        FormField("Subject") { FormTextField(draft.subject, { draft = draft.copy(subject = it) }, subjectPlaceholder(draft.scope)) }
        FormField("When it matches") {
            GroupedSection {
                behaviorsFor(draft.scope).forEach { (value, label) ->
                    GroupedChoiceRow(label, selected = draft.behavior == value, onClick = { draft = draft.copy(behavior = value) })
                }
            }
        }
        error?.let { SettingsError(it) }
    }
}

/** A rule's behaviour, and delete. The enable switch lives on the list row. */
@Composable
fun RuleEditSheet(rule: Rule, onDismiss: () -> Unit, onBehavior: (String) -> Unit, onDelete: () -> Unit) {
    var confirmDelete by remember { mutableStateOf(false) }
    JunoSheet(rule.description.orEmpty(), onDismiss) {
        Text(ruleSubtitle(rule), style = junoText(TextSize.Base), color = JunoTheme.colors.fgMuted)
        GroupedSection(header = "When it matches") {
            RuleBehaviors.forEach { (value, label) ->
                GroupedChoiceRow(label, selected = rule.behavior == value, onClick = { if (rule.behavior != value) onBehavior(value) })
            }
        }
        GroupedSection {
            GroupedRow("Delete rule", destructive = true, onClick = { confirmDelete = true })
        }
    }
    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete this rule?", body = "Agents stop following it.", confirm = "Delete",
            onConfirm = { confirmDelete = false; onDelete() }, onDismiss = { confirmDelete = false },
        )
    }
}
