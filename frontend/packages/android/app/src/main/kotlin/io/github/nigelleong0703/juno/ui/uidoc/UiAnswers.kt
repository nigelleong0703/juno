package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import java.time.LocalDate
import java.time.format.DateTimeParseException

/**
 * Answers to a card's interactive block, as strings keyed by block or field id. The rules are the server's
 * `validateUiAnswers`, so a bad answer is caught on the phone first.
 */
object UiAnswers {
    const val MAX_TEXT = 1000
    private val number = Regex("""-?\d+(\.\d+)?""")
    private val date = Regex("""\d{4}-\d{2}-\d{2}""")

    /** A choice value: the option id, or a JSON array string of ids when the choice is multiple. */
    fun encodeChoice(ids: List<String>): String = JunoJson.encodeToString(ListSerializer(String.serializer()), ids)

    fun decodeChoice(value: String?, multiple: Boolean): List<String> {
        if (value.isNullOrEmpty()) return emptyList()
        if (!multiple) return listOf(value)
        return runCatching { JunoJson.decodeFromString(ListSerializer(String.serializer()), value) }.getOrDefault(emptyList())
    }

    /** The reason a field's value is not acceptable, or null. An empty value is fine unless the field is required. */
    fun problem(field: UiField, raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty()) return if (field.required) "Required" else null
        return when (field.kind) {
            "number" -> if (number.matches(value)) null else "Enter a number"
            "date" -> if (isRealDate(value)) null else "Enter a date as YYYY-MM-DD"
            "select" -> if (value in field.options) null else "Pick one"
            else -> if (value.length > MAX_TEXT) "Must be at most $MAX_TEXT characters" else null
        }
    }

    /** Every field with a problem, by field id. */
    fun problems(fields: List<UiField>, values: Map<String, String>): Map<String, String> =
        fields.mapNotNull { f -> problem(f, values[f.id].orEmpty())?.let { f.id to it } }.toMap()

    /** The answers to send: trimmed, and empty optional answers left out. */
    fun payload(fields: List<UiField>, values: Map<String, String>): Map<String, String> =
        fields.mapNotNull { f -> values[f.id].orEmpty().trim().takeIf { it.isNotEmpty() }?.let { f.id to it } }.toMap()

    /** The id of the block the user answers (choices or fields), if the doc has one. */
    fun interactiveId(doc: UiDoc): String? = when (val block = doc.interactive) {
        is UiBlock.Choices -> block.id
        is UiBlock.Fields -> block.id
        else -> null
    }

    /** A decided question as one line: the labels of the picked options, or the typed values. */
    fun summary(doc: UiDoc, answers: Map<String, String>?): String {
        val given = answers.orEmpty()
        return when (val block = doc.interactive) {
            is UiBlock.Choices -> {
                val picked = decodeChoice(given[block.id], block.multiple)
                block.options.filter { it.id in picked }.joinToString(", ") { it.label }
            }
            is UiBlock.Fields -> block.fields.mapNotNull { f -> given[f.id]?.takeIf { it.isNotEmpty() } }.joinToString(", ")
            else -> ""
        }
    }

    /** A real calendar date in exactly `YYYY-MM-DD` form (2026-02-30 is not one). */
    fun isRealDate(value: String): Boolean {
        if (!date.matches(value)) return false
        return try {
            LocalDate.parse(value).toString() == value
        } catch (_: DateTimeParseException) {
            false
        }
    }
}
