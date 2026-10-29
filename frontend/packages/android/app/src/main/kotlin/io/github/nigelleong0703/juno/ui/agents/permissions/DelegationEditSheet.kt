package io.github.nigelleong0703.juno.ui.agents.permissions

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.DelegationLimits
import io.github.nigelleong0703.juno.contract.MoneyLimit
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.state.DecisionWords
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.revokeDelegation
import io.github.nigelleong0703.juno.state.updateDelegation
import io.github.nigelleong0703.juno.ui.agents.JunoSwitch
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Spending needs an amount per purchase; the other categories are valid as they are (iOS `DelegationLimitFields.isValid`). */
fun limitsValid(category: String?, limits: DelegationLimits): Boolean =
    category != "spending" || (limits.perPurchase?.amount?.toDoubleOrNull() ?: 0.0) > 0.0

/** Edit a delegation's limits, or revoke it (spec 2.18). */
@Composable
fun DelegationEditSheet(rule: Rule, agentId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val category = rule.delegation?.category
    val original = rule.delegation?.limits ?: DelegationLimits()
    var limits by remember { mutableStateOf(original) }
    var confirmRevoke by remember { mutableStateOf(false) }
    val platform = DecisionWords.platformName(rule.delegation?.platformKey) { state.conversation(it)?.title ?: "a chat" }
    JunoSheet(
        DecisionWords.name(category), onDismiss, long = true, primary = "Save", primaryEnabled = limitsValid(category, limits) && limits != original,
        onPrimary = { world.updateDelegation(rule, limits, agentId); onDismiss() },
    ) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(DecisionWords.limitsSummary(rule, platform), style = junoText(TextSize.Base), color = JunoTheme.colors.fgMuted)
            LimitFields(category, limits) { limits = it }
            JunoButton("Revoke", { confirmRevoke = true }, Modifier.fillMaxWidth(), ButtonVariant.Secondary)
        }
    }
    if (confirmRevoke) ConfirmDialog(
        title = "Revoke this rule?", body = "The agent stops doing this without asking you.", confirm = "Revoke",
        onConfirm = { world.revokeDelegation(rule, agentId); onDismiss() }, onDismiss = { confirmRevoke = false },
    )
}

/** The limits a category has, and only those (iOS `DelegationLimitFields`). */
@Composable
private fun LimitFields(category: String?, limits: DelegationLimits, onChange: (DelegationLimits) -> Unit) {
    val currency = limits.perPurchase?.currency ?: limits.perMonth?.currency ?: "USD"
    fun amount(current: MoneyLimit?, text: String): MoneyLimit? = text.filter { it.isDigit() || it == '.' }.let { clean -> if (clean.isEmpty()) null else MoneyLimit(clean, currency) }
    when (category) {
        "spending" -> {
            FormField("Each purchase ($currency)") { FormTextField(limits.perPurchase?.amount.orEmpty(), { onChange(limits.copy(perPurchase = amount(limits.perPurchase, it))) }, "0.00", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)) }
            FormField("Each month ($currency)", optional = true) { FormTextField(limits.perMonth?.amount.orEmpty(), { onChange(limits.copy(perMonth = amount(limits.perMonth, it))) }, "0.00", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)) }
            SwitchRow("Allow subscriptions", limits.allowRecurring ?: false) { onChange(limits.copy(allowRecurring = it)) }
        }
        "speaking" -> { SwitchRow("Replies only", limits.replyOnly ?: false) { onChange(limits.copy(replyOnly = it)) }; PerDay(limits, onChange) }
        "committing" -> SwitchRow("Accept invitations only", limits.acceptOnly ?: false) { onChange(limits.copy(acceptOnly = it)) }
        "public" -> PerDay(limits, onChange)
    }
}

@Composable
private fun SwitchRow(title: String, on: Boolean, onChange: (Boolean) -> Unit) =
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = junoText(TextSize.Lg), color = JunoTheme.colors.fg, modifier = Modifier.weight(1f))
        JunoSwitch(on, onChange)
    }

@Composable
private fun PerDay(limits: DelegationLimits, onChange: (DelegationLimits) -> Unit) {
    val n = limits.maxPerDay ?: 10L
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Up to $n a day", style = junoText(TextSize.Lg), color = JunoTheme.colors.fg, modifier = Modifier.weight(1f))
        JunoButton("−", { onChange(limits.copy(maxPerDay = maxOf(1, n - 1))) }, variant = ButtonVariant.Secondary, size = ButtonSize.Regular)
        JunoButton("+", { onChange(limits.copy(maxPerDay = minOf(200, n + 1))) }, variant = ButtonVariant.Secondary, size = ButtonSize.Regular)
    }
}
