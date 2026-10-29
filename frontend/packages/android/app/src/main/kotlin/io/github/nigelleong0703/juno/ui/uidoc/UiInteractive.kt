package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDefaults
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A choice block: one option answers at once; several toggle and go with Submit. Once answered the options are
 * locked and show what was picked.
 */
@Composable
internal fun UiChoices(block: UiBlock.Choices, answering: UiAnswering) {
    val c = JunoTheme.colors
    val recorded = answering.recorded?.let { UiAnswers.decodeChoice(it[block.id], block.multiple) }
    var picked by remember(block) { mutableStateOf<List<String>>(emptyList()) }
    val selected = recorded ?: picked
    val locked = recorded != null || answering.busy
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        block.options.forEach { option ->
            val on = option.id in selected
            val primary = option.style == "primary" && !(on && block.multiple)
            val ink = when {
                primary -> c.primaryFg
                option.style == "destructive" -> JunoStatus.danger
                else -> c.fg
            }
            Row(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(Radius.tile))
                    .background(if (primary) c.primary else c.tile)
                    .border(
                        width = if (on && !primary) 1.5.dp else 0.dp,
                        color = if (on && !primary) c.fg else c.tile,
                        shape = RoundedCornerShape(Radius.tile),
                    )
                    .clickable(enabled = !locked) {
                        if (block.multiple) {
                            picked = if (option.id in picked) picked - option.id else picked + option.id
                        } else {
                            picked = listOf(option.id)
                            answering.onAnswer(mapOf(block.id to option.id))
                        }
                    }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(option.label, style = junoText(TextSize.Lg, if (on) FontWeight.SemiBold else FontWeight.Normal), color = ink)
                    option.description?.let { Text(it, style = junoText(TextSize.Sm), color = ink.copy(alpha = if (primary) 0.8f else 1f)) }
                }
                if (on) Icon(JunoIcons.Check, contentDescription = null, tint = ink)
            }
        }
        answering.errors[block.id]?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
        if (block.multiple && recorded == null) {
            JunoButton(
                text = "Submit", enabled = picked.isNotEmpty() && !answering.busy,
                onClick = { answering.onAnswer(mapOf(block.id to UiAnswers.encodeChoice(block.options.map { it.id }.filter { it in picked }))) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * A small form (text, number, date, select) checked with [UiAnswers]. Problems show after the first Submit; a
 * server reason shows on its field until the user edits it. Answered forms show the recorded values.
 */
@Composable
internal fun UiFieldsForm(block: UiBlock.Fields, answering: UiAnswering) {
    val c = JunoTheme.colors
    val recorded = answering.recorded
    var values by remember(block) { mutableStateOf(recorded.orEmpty()) }
    var shown by remember(block) { mutableStateOf(false) }
    var edited by remember(answering.errors) { mutableStateOf(emptySet<String>()) }
    val problems = UiAnswers.problems(block.fields, values)
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        block.fields.forEach { field ->
            val serverError = answering.errors[field.id]?.takeIf { field.id !in edited }
            val error = serverError ?: if (shown) problems[field.id] else null
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    if (field.required) field.label else "${field.label} (optional)",
                    style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted,
                )
                if (recorded != null) {
                    Text(recorded[field.id].orEmpty().ifEmpty { "—" }, style = junoText(TextSize.Base), color = c.fg)
                } else if (field.kind == "select") {
                    SelectField(field, values[field.id].orEmpty()) { picked ->
                        values = values + (field.id to picked)
                        edited = edited + field.id
                    }
                } else if (field.kind == "date") {
                    DateField(field, values[field.id].orEmpty()) { picked ->
                        values = values + (field.id to picked)
                        edited = edited + field.id
                    }
                } else {
                    JunoTextField(
                        value = values[field.id].orEmpty(),
                        onValueChange = { text ->
                            values = values + (field.id to text)
                            edited = edited + field.id
                        },
                        label = field.placeholder ?: field.label,
                        keyboardOptions = if (field.kind == "number") KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                error?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
            }
        }
        if (recorded == null) {
            JunoButton(
                text = "Submit", enabled = !answering.busy,
                onClick = {
                    if (problems.isEmpty()) answering.onAnswer(UiAnswers.payload(block.fields, values)) else shown = true
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** A date field: a Material date picker, answered as YYYY-MM-DD (the value [UiAnswers] checks). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateField(field: UiField, value: String, onPick: (String) -> Unit) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        JunoTextField(
            value = value, onValueChange = {}, label = field.placeholder ?: field.label,
            modifier = Modifier.fillMaxWidth().clickable { open = true },
        )
    }
    if (open) {
        // The picker works in UTC midnights; the answer is the calendar date it shows.
        val initial = value.takeIf { UiAnswers.isRealDate(it) }?.let { LocalDate.parse(it).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }
        val picker = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        picker.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }
                        open = false
                    },
                    enabled = picker.selectedDateMillis != null,
                ) { Text("OK", color = c.fg) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("Cancel", color = c.fgMuted) } },
            colors = DatePickerDefaults.colors(containerColor = c.card),
        ) { DatePicker(state = picker, colors = DatePickerDefaults.colors(containerColor = c.card)) }
    }
}

@Composable
private fun SelectField(field: UiField, value: String, onPick: (String) -> Unit) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        JunoTextField(
            value = value, onValueChange = {}, label = field.placeholder ?: field.label,
            modifier = Modifier.fillMaxWidth().clickable { open = true },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            field.options.forEach { option ->
                DropdownMenuItem(text = { Text(option, color = c.fg) }, onClick = { open = false; onPick(option) })
            }
        }
    }
}
