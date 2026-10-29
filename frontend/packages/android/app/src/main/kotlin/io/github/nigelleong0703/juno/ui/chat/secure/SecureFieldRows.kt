package io.github.nigelleong0703.juno.ui.chat.secure

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.SecureInputField
import io.github.nigelleong0703.juno.core.SecureVault
import io.github.nigelleong0703.juno.state.SecureKind
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Year
import java.util.Locale

/** One field of the secure-input form (iOS `SecureInputSheet.row` + `saveToggle`): the input, its error, and the save switch. */
@Composable
fun SecureFieldRow(field: SecureInputField, form: SecureFormState, site: String?, enabled: Boolean) {
    val c = JunoTheme.colors
    FormField(label = field.label ?: field.placeholder ?: "Value", optional = !SecureKind.isRequired(field)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FieldInput(field, form, enabled)
            form.errorFor(field)?.let { Text(it, color = JunoStatus.danger, style = junoText(TextSize.Xs)) }
            SaveSwitch(field, form, site, enabled)
        }
    }
}

@Composable
private fun FieldInput(field: SecureInputField, form: SecureFormState, enabled: Boolean) {
    val kind = SecureKind.resolve(field)
    val options = field.options?.takeIf { it.isNotEmpty() } ?: when (kind) {
        "month" -> (1..12).map { "%02d".format(it) }
        "year" -> Year.now().value.let { y -> (y..y + 15).map { it.toString() } }
        "country" -> countryNames
        else -> null
    }
    if (options != null) ChoiceRow(field, form, options, enabled) else TextEntry(field, kind, form)
}

/** A row showing the chosen value; tapping it opens the list of choices. */
@Composable
private fun ChoiceRow(field: SecureInputField, form: SecureFormState, options: List<String>, enabled: Boolean) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    val value = form.values[field.id].orEmpty()
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.lg)).background(c.inputBg).border(1.dp, c.border, RoundedCornerShape(Radius.lg))
            .let { if (enabled) it.clickable { open = true } else it }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            value.ifEmpty { "None" }, style = junoText(TextSize.Lg),
            color = if (value.isEmpty()) c.fgSubtle else c.fg, modifier = Modifier.weight(1f),
        )
    }
    if (open) {
        JunoSheet(title = field.label ?: "Choose", onDismiss = { open = false }, long = options.size > 8) {
            ChoiceOption("None", selected = value.isEmpty()) { form.values[field.id] = ""; form.touched[field.id] = true; open = false }
            options.forEach { option ->
                ChoiceOption(option, selected = option == value) { form.values[field.id] = option; form.touched[field.id] = true; open = false }
            }
        }
    }
}

@Composable
private fun ChoiceOption(label: String, selected: Boolean, onPick: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = onPick).padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
        if (selected) {
            Spacer(Modifier.size(12.dp))
            Icon(JunoIcons.Check, contentDescription = "Selected", tint = c.fg)
        }
    }
}

@Composable
private fun TextEntry(field: SecureInputField, kind: String, form: SecureFormState) {
    val c = JunoTheme.colors
    val id = field.id
    val vaultFilled = form.vaultFilled[id] == true
    val shown = form.revealed[id] == true
    val canReveal = kind == "password" || vaultFilled
    val reveal: (@Composable () -> Unit)? = if (!canReveal) null else {
        {
            IconButton(onClick = { form.revealed[id] = !shown }) {
                Icon(
                    if (shown) JunoIcons.EyeOff else JunoIcons.Eye,
                    contentDescription = if (shown) "Hide" else "Show", tint = c.fgMuted,
                )
            }
        }
    }
    JunoTextField(
        value = form.values[id].orEmpty(),
        onValueChange = { form.type(field, it) },
        label = field.placeholder ?: placeholderFor(kind),
        modifier = Modifier.fillMaxWidth(),
        keyboardOptions = keyboardFor(kind),
        secret = (kind in SECRET_KINDS || vaultFilled) && !shown,
        trailingIcon = reveal,
    )
}

/** The "Save on this phone" switch, and the name the entry gets, for a field the vault may keep. */
@Composable
private fun SaveSwitch(field: SecureInputField, form: SecureFormState, site: String?, enabled: Boolean) {
    if (form.vaultKind(field) == null) return
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("Save on this phone", style = junoText(TextSize.Xs), color = c.fgMuted, modifier = Modifier.weight(1f))
        val haptic = LocalHapticFeedback.current
        Switch(
            checked = form.saves(field),
            onCheckedChange = { haptic.performHapticFeedback(if (it) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff); form.saveOn[field.id] = it },
            enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = c.fg, checkedThumbColor = c.canvas, checkedBorderColor = c.fg),
        )
    }
    if (form.saves(field) && !form.vaultLocked) {
        Text(
            "Saved on this phone is not locked: this phone has no fingerprint, face or screen lock. Add one to lock it.",
            style = junoText(TextSize.Xs), color = c.fgMuted,
        )
    } else if (form.saves(field)) {
        Text("Saving asks for your fingerprint, face or screen lock.", style = junoText(TextSize.Xs), color = c.fgMuted)
    }
    if (form.saves(field)) {
        val label = form.labelFor(field, site)
        JunoTextField(value = label, onValueChange = { form.labels[field.id] = it }, label = "Name", modifier = Modifier.fillMaxWidth())
        SecureVault.labelProblem(label)?.let { Text(it, color = JunoStatus.danger, style = junoText(TextSize.Xs)) }
    }
}

private val SECRET_KINDS = setOf("password", "card_cvc", "otp")

private fun placeholderFor(kind: String): String = when (kind) {
    "card_number" -> "1234 5678 9012 3456"
    "card_expiry" -> "MM/YY"
    "email" -> "name@example.com"
    else -> ""
}

private fun keyboardFor(kind: String): KeyboardOptions {
    val type = when (kind) {
        "card_number", "card_expiry", "card_cvc", "otp", "month", "year" -> KeyboardType.Number
        "password" -> KeyboardType.Password
        "email" -> KeyboardType.Email
        "phone" -> KeyboardType.Phone
        "number" -> KeyboardType.Decimal
        else -> KeyboardType.Text
    }
    val capitalization = when (kind) {
        "name", "address", "city" -> KeyboardCapitalization.Words
        "text" -> KeyboardCapitalization.Sentences
        "postal_code" -> KeyboardCapitalization.Characters
        else -> KeyboardCapitalization.None
    }
    return KeyboardOptions(keyboardType = type, capitalization = capitalization, autoCorrectEnabled = false)
}

/** Country names in the device's language, sorted (iOS `CountryList`). */
private val countryNames: List<String> by lazy {
    val locale = Locale.getDefault()
    Locale.getISOCountries().map { code -> Locale.Builder().setRegion(code).build().getDisplayCountry(locale) }
        .filter { it.isNotEmpty() }.sortedWith(String.CASE_INSENSITIVE_ORDER)
}
