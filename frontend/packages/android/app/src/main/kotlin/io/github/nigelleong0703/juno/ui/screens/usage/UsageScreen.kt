package io.github.nigelleong0703.juno.ui.screens.usage

import io.github.nigelleong0703.juno.ui.theme.CenteredLines
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Usage
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.UsageMath
import io.github.nigelleong0703.juno.state.loadUsage
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.SettingsPill
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private val SpendStyle = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, lineHeightStyle = CenteredLines)

/**
 * Usage (web UsagePage): this week's spend against the included limit, the token, compute and run totals, then the same
 * spend per agent and per app.
 */
@Composable
fun UsageScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val scope = rememberCoroutineScope()
    var usage by remember { mutableStateOf<Usage?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    fun load() = scope.launch {
        try { usage = world.loadUsage(); error = null }
        catch (e: Throwable) { if (!e.isCancellation) error = e.userMessage }
    }
    LaunchedEffect(Unit) { load() }

    GroupedPage("Usage", onBack) {
        val u = usage
        when {
            u != null -> UsageBody(u, agentOf = { id -> state.agent(id) })
            error != null -> {
                SettingsError(error.orEmpty())
                SettingsPill("Try again", onClick = { load() })
            }
            else -> SettingsEmpty("Loading…")
        }
    }
}

@Composable
private fun UsageBody(usage: Usage, agentOf: (String) -> Agent?) {
    val c = JunoTheme.colors
    val week = usage.week
    val byAgent = usage.byAgent.orEmpty()
    val agents = UsageMath.agentsWithRuns(byAgent)

    GroupedSection(
        header = "This week",
        footer = if (week?.measured == false) "Token totals unknown: some runs reported no usage. Cost is unknown, not zero." else null,
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.Bottom) {
                Text(UsageMath.spend(week?.costUsd, week?.costKnown), style = SpendStyle, color = c.fg)
                Text(
                    "  of ${UsageMath.usd(week?.limitUsd ?: 0.0)} included",
                    style = junoText(TextSize.Base), color = c.fgMuted,
                )
            }
            UsageBar(UsageMath.fraction(week?.percent), warn = UsageMath.isWarning(week?.percent))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Stat("Tokens", UsageMath.count((week?.inputTokens ?: 0L) + (week?.outputTokens ?: 0L)))
                Stat("Compute", "${Math.round((week?.computeSeconds ?: 0.0) / 60)} min")
                Stat("Runs", UsageMath.count(UsageMath.totalRuns(byAgent)))
            }
        }
    }

    if (agents.isNotEmpty()) {
        GroupedSection(header = "By agent") {
            agents.forEach { row ->
                val id = row.agentId.orEmpty()
                val agent = agentOf(id)
                GroupedRow(
                    title = agent?.name ?: id.removePrefix("agent-"),
                    subtitle = "${UsageMath.count(row.runs ?: 0L)} runs",
                    leading = { AgentAvatar(agent ?: Agent(id = id), 32.dp, animated = false) },
                    value = UsageMath.spend(row.costUsd, row.costKnown),
                )
            }
        }
    }

    val apps = usage.byApp.orEmpty().filter { (it.runs ?: 0L) > 0L }
    if (apps.isNotEmpty()) {
        GroupedSection(header = "By app") {
            apps.forEach { row ->
                GroupedRow(
                    title = row.app.orEmpty(),
                    subtitle = "${UsageMath.count(row.runs ?: 0L)} runs",
                    value = UsageMath.spend(row.costUsd, null),
                )
            }
        }
    }
}

@Composable
private fun UsageBar(fraction: Float, warn: Boolean) {
    val c = JunoTheme.colors
    Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(c.border)) {
        Box(
            Modifier.fillMaxWidth(fraction).height(6.dp).clip(CircleShape)
                .background(if (warn) JunoStatus.warning else c.fg),
        )
    }
}

@Composable
private fun Stat(label: String, value: String) {
    val c = JunoTheme.colors
    Column {
        Text(label, style = junoText(TextSize.Xs), color = c.fgSubtle)
        Text(value, style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg)
    }
}
