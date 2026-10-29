package io.github.nigelleong0703.juno.ui.discover

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Skill
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.createAgent
import io.github.nigelleong0703.juno.state.description
import io.github.nigelleong0703.juno.state.loadSkills
import io.github.nigelleong0703.juno.state.name
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.TabHeading
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** One installable agent template: name, role, and one line on what it does (the same six as iOS and the web dialog). */
data class DiscoverTemplate(val name: String, val title: String, val blurb: String)

internal val DiscoverTemplates: List<DiscoverTemplate> = listOf(
    DiscoverTemplate("Juno", "Research & inbox", "Reads your inbox, researches answers and drafts replies."),
    DiscoverTemplate("Patch", "Engineering & PRs", "Watches repositories, reviews pull requests and triages issues."),
    DiscoverTemplate("Ledger", "Finance & expenses", "Reconciles spend, files reimbursements and flags anomalies."),
    DiscoverTemplate("Echo", "Meetings & notes", "Joins calls, writes summaries and tracks follow-ups."),
    DiscoverTemplate("Scout", "Recruiting & network", "Screens candidates and keeps your network warm."),
    DiscoverTemplate("Atlas", "Travel & calendar", "Plans trips, books travel and protects focus time."),
)

/** The Discover categories (iOS `DiscoverTab.Category`). */
private enum class DiscoverCategory(val title: String) { All("All"), Agents("Agents"), Skills("Skills"), Spaces("Spaces") }

/** Rows per list before "Show more". */
private const val LIST_LIMIT = 6

/**
 * Discover, the fourth tab (owner-approved 2026-10-26, iOS `DiscoverTab`): a featured agent, the categories, and what can be
 * installed. Install creates an agent from a template through the normal create flow and opens its chat; skills open in
 * Plugins; Spaces are not offered yet. The footer says what is shared: persona, skills and workflows only.
 */
@Composable
fun DiscoverScreen() {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var category by remember { mutableStateOf(DiscoverCategory.All) }
    var installing by remember { mutableStateOf(false) }
    var skills by remember { mutableStateOf<List<Skill>>(emptyList()) }
    var note by remember { mutableStateOf<String?>(null) }
    val c = JunoTheme.colors

    LaunchedEffect(Unit) { skills = runCatching { world.loadSkills() }.getOrDefault(emptyList()) }

    // Install creates the agent and opens its chat (createAgent does both); a failed create leaves the list as it was and says so.
    val install: (DiscoverTemplate) -> Unit = { template ->
        if (!installing) {
            installing = true
            note = null
            scope.launch {
                runCatching { world.createAgent(template.name, template.title) }
                    .onFailure { if (!it.isCancellation) note = "${template.name} could not be installed: ${it.userMessage}" }
                installing = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        TabHeading("Discover")
        note?.let { SettingsError(it) }
        if (category == DiscoverCategory.All) FeaturedCard(DiscoverTemplates.first(), installing, install)
        SegmentedControl(
            options = DiscoverCategory.entries.map { it to it.title },
            selected = category,
            onSelect = { category = it },
        )
        if (category == DiscoverCategory.All || category == DiscoverCategory.Agents) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Agents", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
                TemplateList(DiscoverTemplates, installing, install)
            }
        }
        if (category == DiscoverCategory.All || category == DiscoverCategory.Skills) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Skills", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
                SkillList(skills) { world.open(Route.Plugins()) }
            }
        }
        if (category == DiscoverCategory.Spaces) EmptyLine("Shared spaces are coming soon.")
        Text(
            "Only persona, skills and workflows are shared — your memory, people and accounts never are.",
            color = c.fgSubtle, style = junoText(TextSize.Xs),
        )
    }
}

/** The featured template: its name and role, what it does, and Install. */
@Composable
private fun FeaturedCard(template: DiscoverTemplate, busy: Boolean, onInstall: (DiscoverTemplate) -> Unit) {
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Featured", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
        Text("${template.name} · ${template.title}", color = c.fg, style = junoText(TextSize.Xl, FontWeight.SemiBold))
        Text(template.blurb, color = c.fgMuted, style = junoText(TextSize.Md))
        JunoButton("Install", { onInstall(template) }, enabled = !busy, size = ButtonSize.Regular)
    }
}

@Composable
private fun TemplateList(templates: List<DiscoverTemplate>, busy: Boolean, onInstall: (DiscoverTemplate) -> Unit) {
    val c = JunoTheme.colors
    var limit by remember { mutableIntStateOf(LIST_LIMIT) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        templates.take(limit).forEach { template ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "${template.name} · ${template.title}", color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(template.blurb, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                JunoButton("Install", { onInstall(template) }, enabled = !busy, size = ButtonSize.Sm)
            }
        }
        ShowMore(shown = minOf(limit, templates.size), total = templates.size, onMore = { limit += LIST_LIMIT })
    }
}

/** Skills, six at a time; "Open" goes to Plugins. */
@Composable
private fun SkillList(skills: List<Skill>, onOpen: () -> Unit) {
    val c = JunoTheme.colors
    var limit by remember { mutableIntStateOf(LIST_LIMIT) }
    if (skills.isEmpty()) {
        EmptyLine("Nothing in this category yet.")
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        skills.take(limit).forEach { skill ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(skill.name.orEmpty(), color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(skill.description.orEmpty(), color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Text(
                    "Open", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium),
                    modifier = Modifier.clickable(onClick = onOpen).padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
        }
        ShowMore(shown = minOf(limit, skills.size), total = skills.size, onMore = { limit += LIST_LIMIT })
    }
}
