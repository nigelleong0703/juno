package io.github.nigelleong0703.juno.ui.screens.rules

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AuditEntry
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.contract.UpdateRuleInput
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.auditDecisionLabel
import io.github.nigelleong0703.juno.state.builtinRules
import io.github.nigelleong0703.juno.state.customRules
import io.github.nigelleong0703.juno.state.deleteRule
import io.github.nigelleong0703.juno.state.exportAuditCsv
import io.github.nigelleong0703.juno.state.filterRules
import io.github.nigelleong0703.juno.state.loadAudit
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.state.loadRules
import io.github.nigelleong0703.juno.state.ruleBehaviorLabel
import io.github.nigelleong0703.juno.state.ruleScopeLabel
import io.github.nigelleong0703.juno.state.startedByLine
import io.github.nigelleong0703.juno.state.updateRule
import io.github.nigelleong0703.juno.ui.agents.JunoSwitch
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import io.github.nigelleong0703.juno.state.Fmt
import kotlinx.coroutines.launch

private enum class RulesTab { Rules, Activity }

/**
 * The Rules page (web RulesPage): the built-in guardrails, your own rules with an enable switch, and the Activity log of
 * decisions agents made under them. Tap a rule to change its behaviour or delete it; "New rule" opens the create sheet.
 */
@Composable
fun RulesScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(RulesTab.Rules) }
    var rules by remember { mutableStateOf<List<Rule>?>(null) }
    var audit by remember { mutableStateOf<List<AuditEntry>?>(null) }
    var auditNext by remember { mutableStateOf<String?>(null) }
    var unattendedOnly by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val routines = world.agentsData.collectAsState().value.routines
    var query by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    // The rule being edited by id, so the sheet shows the reloaded copy rather than a stale one.
    var editingId by remember { mutableStateOf<String?>(null) }

    fun fail(e: Throwable) { if (!e.isCancellation) error = e.userMessage }

    fun reloadRules() = scope.launch {
        try { rules = world.loadRules(); error = null } catch (e: Throwable) { fail(e) }
    }
    fun showMoreAudit() = scope.launch {
        val filter = unattendedOnly
        try {
            val page = world.loadAudit(filter, auditNext)
            if (filter == unattendedOnly) { audit = audit.orEmpty() + page.items; auditNext = page.next }
        } catch (e: Throwable) { fail(e) }
    }

    fun exportCsv() = scope.launch {
        try { context.shareActivityCsv(world.exportAuditCsv(unattendedOnly)); error = null } catch (e: Throwable) { fail(e) }
    }

    LaunchedEffect(Unit) { reloadRules(); world.loadRoutines() }
    // The first page for the filter; changing the filter or the tab cancels a load still in flight.
    LaunchedEffect(tab, unattendedOnly) {
        if (tab != RulesTab.Activity) return@LaunchedEffect
        audit = null; auditNext = null
        try { val page = world.loadAudit(unattendedOnly); audit = page.items; auditNext = page.next; error = null } catch (e: Throwable) { fail(e) }
    }

    // A switch flips at once; the server's answer (or a failure) then replaces the local copy.
    fun setEnabled(rule: Rule, on: Boolean) {
        rules = rules?.map { if (it.id == rule.id) it.copy(enabled = on) else it }
        scope.launch {
            try { world.updateRule(rule.id, UpdateRuleInput(enabled = on)) } catch (e: Throwable) { fail(e) }
            reloadRules()
        }
    }

    GroupedPage(
        title = "Rules", onBack = onBack,
        actions = {
            if (tab == RulesTab.Rules) JunoButton("New rule", { creating = true }, size = ButtonSize.Sm, leadingIcon = JunoIcons.Plus)
            else JunoButton("Export CSV", { exportCsv() }, size = ButtonSize.Sm, variant = ButtonVariant.Secondary)
        },
    ) {
        SegmentedControl(
            options = listOf(RulesTab.Rules to "Rules", RulesTab.Activity to "Activity"),
            selected = tab, onSelect = { tab = it },
        )
        error?.let { SettingsError(it) }

        if (tab == RulesTab.Rules) {
            val all = rules
            if (all == null) {
                SettingsEmpty("Loading…")
            } else {
                GroupedSearchField(query, "Search your rules", onChange = { query = it })
                GroupedSection(
                    header = "Built-in guardrails",
                    footer = "Always on. They keep agents inside your workspace and can't be turned off.",
                ) {
                    builtinRules(all).forEach { rule ->
                        GroupedRow(
                            title = rule.description.orEmpty(),
                            subtitle = ruleSubtitle(rule),
                            icon = JunoIcons.Lock,
                            value = ruleBehaviorLabel(rule.behavior),
                        )
                    }
                }
                GroupedSection(header = "Your rules") {
                    val mine = filterRules(customRules(all), query)
                    if (mine.isEmpty()) {
                        SettingsEmpty("Rules you add decide, ahead of time, how agents handle one kind of decision.")
                    }
                    mine.forEach { rule ->
                        GroupedRow(
                            title = rule.description.orEmpty(),
                            subtitle = ruleSubtitle(rule) + " · " + ruleBehaviorLabel(rule.behavior),
                            onClick = { editingId = rule.id },
                            trailing = { JunoSwitch(rule.enabled != false, { setEnabled(rule, it) }) },
                        )
                    }
                }
            }
        } else {
            SegmentedControl(
                options = listOf(false to "All", true to "Unattended"),
                selected = unattendedOnly, onSelect = { unattendedOnly = it },
            )
            val entries = audit
            when {
                entries == null -> SettingsEmpty("Loading…")
                entries.isEmpty() -> SettingsEmpty(
                    if (unattendedOnly) "Nothing happened without you. Work that routines, strangers or the system started shows up here."
                    else "Every decision an agent makes under a rule shows up here.",
                )
                else -> {
                    GroupedSection {
                        entries.forEach { entry ->
                            val initiator = entry.initiator
                            GroupedRow(
                                title = entry.action.orEmpty(),
                                subtitle = entry.reason,
                                value = auditDecisionLabel(entry.decision),
                                extra = {
                                    if (initiator != null) {
                                        val routineName = routines.firstOrNull { it.id == initiator.routineId }?.name
                                        Text(startedByLine(initiator, routineName), style = junoText(TextSize.Xs), color = JunoTheme.colors.fgSubtle)
                                    }
                                    Text(Fmt.ago(entry.at), style = junoText(TextSize.Xs), color = JunoTheme.colors.fgSubtle)
                                },
                            )
                        }
                    }
                    if (auditNext != null) ShowMoreButton("Show more") { showMoreAudit() }
                }
            }
        }
    }

    if (creating) NewRuleSheet(onDismiss = { creating = false }, onCreated = { creating = false; reloadRules() })
    val editRule = rules?.firstOrNull { it.id == editingId }
    if (editRule != null) {
        RuleEditSheet(
            rule = editRule,
            onDismiss = { editingId = null },
            onBehavior = { behavior ->
                rules = rules?.map { if (it.id == editRule.id) it.copy(behavior = behavior) else it }
                scope.launch {
                    try { world.updateRule(editRule.id, UpdateRuleInput(behavior = behavior)) } catch (e: Throwable) { fail(e) }
                    reloadRules()
                }
            },
            onDelete = {
                editingId = null
                scope.launch {
                    try { world.deleteRule(editRule.id) } catch (e: Throwable) { fail(e) }
                    reloadRules()
                }
            },
        )
    }
}

/** "Action · browser.click" or just the scope when the rule has no subject. */
internal fun ruleSubtitle(rule: Rule): String =
    listOfNotNull(ruleScopeLabel(rule.scope).takeIf { it.isNotEmpty() }, rule.subject?.takeIf { it.isNotEmpty() }).joinToString(" · ")
