package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.contract.FeedUiDoc
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

// Juno UI blocks (BACKEND 8.7.1): the component standard the agent emits and the clients draw. The wire doc is kept as
// raw JSON and parsed block by block. One block this app cannot draw makes the whole doc non-renderable, and the doc
// then shows the server-written `text` instead, so a card is never empty. Web twin: components/uidoc/UiDoc.tsx.

/** A parsed UI doc. [isRenderable] is false for an unknown version, an empty doc, or any block this app cannot draw. */
data class UiDoc(
    val version: Double?,
    val title: String?,
    /** The plain-text fallback the server wrote (`uiDocToText`). */
    val text: String?,
    val blocks: List<UiBlock>,
) {
    val isRenderable: Boolean get() = version == 1.0 && blocks.isNotEmpty() && blocks.all { it.isKnown }

    /** The one block the user answers (choices or fields), if the doc has one. */
    val interactive: UiBlock? get() = blocks.firstOrNull { it.isInteractive }
}

data class UiFact(val label: String, val value: String, val emphasis: Boolean = false)
data class UiItemRow(val name: String, val detail: String?, val quantity: Int?, val price: String?, val imageUrl: String?)
data class UiChoiceOption(val id: String, val label: String, val style: String, val description: String?)
data class UiField(val id: String, val label: String, val kind: String, val options: List<String>, val required: Boolean, val placeholder: String?)

sealed interface UiBlock {
    /** False for a block this app cannot draw; a group is unknown when any block inside is. */
    val isKnown: Boolean get() = true
    val isInteractive: Boolean get() = false

    data class Text(val text: String) : UiBlock
    data class Facts(val rows: List<UiFact>) : UiBlock
    data class Items(val rows: List<UiItemRow>, val total: UiFact?) : UiBlock
    data class Table(val columns: List<String>, val rows: List<List<String>>) : UiBlock
    data class Notice(val tone: String, val text: String) : UiBlock
    data class Link(val url: String, val title: String, val subtitle: String?) : UiBlock
    data class Image(val libraryId: String, val caption: String?) : UiBlock
    data class Group(val title: String?, val blocks: List<UiBlock>) : UiBlock {
        override val isKnown: Boolean get() = blocks.all { it.isKnown && !it.isInteractive }
    }
    /** Up to three quick replies; the chat draws them as chips, the feed does not draw them. */
    data class Replies(val options: List<String>) : UiBlock
    data class Choices(val id: String, val options: List<UiChoiceOption>, val multiple: Boolean) : UiBlock {
        override val isInteractive: Boolean get() = true
    }
    data class Fields(val id: String, val fields: List<UiField>) : UiBlock {
        override val isInteractive: Boolean get() = true
    }
    data object Unknown : UiBlock {
        override val isKnown: Boolean get() = false
    }
}

/** A typed doc (chat items, requests) in its wire form, so the one parser and renderer serve it too. */
fun FeedUiDoc.toJson(): JsonElement = JunoJson.encodeToJsonElement(FeedUiDoc.serializer(), this)

/** A typed doc parsed into blocks. */
fun FeedUiDoc.parsed(): UiDoc = UiDocParser.parse(toJson())

/** The quick-reply labels of a doc (at most three), or none. */
val UiDoc.replies: List<String> get() = blocks.filterIsInstance<UiBlock.Replies>().firstOrNull()?.options.orEmpty()

/** Parses the wire doc. Never throws: anything malformed becomes [UiBlock.Unknown] or is left out of its list. */
object UiDocParser {
    private val tones = setOf("info", "warning", "success")
    private val fieldKinds = setOf("text", "number", "date", "select")

    fun parse(json: JsonElement?): UiDoc {
        val obj = json as? JsonObject ?: return UiDoc(null, null, null, emptyList())
        return UiDoc(
            version = num(obj, "version"),
            title = str(obj, "title"),
            text = str(obj, "text"),
            blocks = (obj["blocks"] as? JsonArray)?.map(::block).orEmpty(),
        )
    }

    fun block(json: JsonElement): UiBlock {
        val obj = json as? JsonObject ?: return UiBlock.Unknown
        return when (str(obj, "type")) {
            "text" -> str(obj, "text")?.let { UiBlock.Text(it) } ?: UiBlock.Unknown
            "facts" -> facts(obj)
            "items" -> items(obj)
            "table" -> table(obj)
            "notice" -> notice(obj)
            "link" -> link(obj)
            "image" -> str(obj, "libraryId")?.let { UiBlock.Image(it, str(obj, "caption")) } ?: UiBlock.Unknown
            "group" -> group(obj)
            "replies" -> replies(obj)
            "choices" -> choices(obj)
            "fields" -> fields(obj)
            else -> UiBlock.Unknown
        }
    }

    private fun facts(obj: JsonObject): UiBlock {
        val rows = array(obj, "rows") ?: return UiBlock.Unknown
        val facts = rows.mapNotNull(::fact)
        return if (facts.size == rows.size && facts.isNotEmpty()) UiBlock.Facts(facts) else UiBlock.Unknown
    }

    private fun items(obj: JsonObject): UiBlock {
        val rows = array(obj, "rows") ?: return UiBlock.Unknown
        val parsed = rows.mapNotNull { row ->
            val o = row as? JsonObject ?: return@mapNotNull null
            val name = str(o, "name") ?: return@mapNotNull null
            UiItemRow(
                name = name, detail = str(o, "detail"),
                quantity = num(o, "quantity")?.toInt(), price = str(o, "price"),
                imageUrl = str(o, "imageUrl")?.takeIf { it.startsWith("https://") },
            )
        }
        if (parsed.size != rows.size || parsed.isEmpty()) return UiBlock.Unknown
        return UiBlock.Items(parsed, (obj["total"] as? JsonObject)?.let(::fact))
    }

    private fun table(obj: JsonObject): UiBlock {
        val columns = array(obj, "columns")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        val rows = array(obj, "rows")
        if (columns == null || columns.size < 2 || rows == null) return UiBlock.Unknown
        // A short row is padded and a long one cut, so one ragged row never fails the whole table.
        val cells = rows.mapNotNull { it as? JsonArray }.map { row ->
            columns.indices.map { i -> (row.getOrNull(i) as? JsonPrimitive)?.contentOrNull.orEmpty() }
        }
        return if (cells.isEmpty()) UiBlock.Unknown else UiBlock.Table(columns, cells)
    }

    private fun notice(obj: JsonObject): UiBlock {
        val tone = str(obj, "tone")?.takeIf { it in tones } ?: return UiBlock.Unknown
        val text = str(obj, "text") ?: return UiBlock.Unknown
        return UiBlock.Notice(tone, text)
    }

    private fun link(obj: JsonObject): UiBlock {
        val url = str(obj, "url")?.takeIf { it.startsWith("https://") } ?: return UiBlock.Unknown
        val title = str(obj, "title") ?: return UiBlock.Unknown
        return UiBlock.Link(url, title, str(obj, "subtitle"))
    }

    private fun group(obj: JsonObject): UiBlock {
        val inner = array(obj, "blocks")?.map(::block)
        if (inner.isNullOrEmpty()) return UiBlock.Unknown
        return UiBlock.Group(str(obj, "title"), inner)
    }

    private fun replies(obj: JsonObject): UiBlock {
        val options = array(obj, "options")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
        return if (options.isEmpty()) UiBlock.Unknown else UiBlock.Replies(options.take(3))
    }

    private fun choices(obj: JsonObject): UiBlock {
        val id = str(obj, "id") ?: return UiBlock.Unknown
        val raw = array(obj, "options") ?: return UiBlock.Unknown
        val options = raw.mapNotNull { option ->
            val o = option as? JsonObject ?: return@mapNotNull null
            val optionId = str(o, "id") ?: return@mapNotNull null
            val label = str(o, "label") ?: return@mapNotNull null
            UiChoiceOption(optionId, label, str(o, "style") ?: "default", str(o, "description"))
        }
        return if (options.size == raw.size && options.size >= 2) {
            UiBlock.Choices(id, options, multiple = bool(obj, "multiple") == true)
        } else UiBlock.Unknown
    }

    private fun fields(obj: JsonObject): UiBlock {
        val id = str(obj, "id") ?: return UiBlock.Unknown
        val raw = array(obj, "fields") ?: return UiBlock.Unknown
        val fields = raw.mapNotNull { item ->
            val f = item as? JsonObject ?: return@mapNotNull null
            val fieldId = str(f, "id") ?: return@mapNotNull null
            val label = str(f, "label") ?: return@mapNotNull null
            val kind = str(f, "kind")?.takeIf { it in fieldKinds } ?: return@mapNotNull null
            val options = array(f, "options")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
            if (kind == "select" && options.isEmpty()) return@mapNotNull null
            UiField(
                id = fieldId, label = label, kind = kind, options = options,
                required = bool(f, "required") != false, placeholder = str(f, "placeholder"),
            )
        }
        return if (fields.size == raw.size && fields.isNotEmpty()) UiBlock.Fields(id, fields) else UiBlock.Unknown
    }

    private fun fact(json: JsonElement): UiFact? {
        val o = json as? JsonObject ?: return null
        val label = str(o, "label") ?: return null
        val value = str(o, "value") ?: return null
        return UiFact(label, value, emphasis = bool(o, "emphasis") == true)
    }

    /** A non-empty string field; an empty string counts as absent, as on iOS. */
    private fun str(obj: JsonObject, key: String): String? =
        (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }

    /** A real JSON number (a numeric string does not count). */
    private fun num(obj: JsonObject, key: String): Double? =
        (obj[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

    /** A real JSON boolean; anything else is null. */
    private fun bool(obj: JsonObject, key: String): Boolean? =
        (obj[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun array(obj: JsonObject, key: String): List<JsonElement>? = (obj[key] as? JsonArray)?.toList()
}
