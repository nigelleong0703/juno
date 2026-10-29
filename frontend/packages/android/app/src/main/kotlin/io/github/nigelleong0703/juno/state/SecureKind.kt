package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.SecureInputField
import java.time.LocalDate
import java.time.YearMonth

/**
 * Secure-input field kinds (iOS `SecureKind`): what may be typed and how it is formatted, what it is sent as, and the rules
 * the phone checks before sealing. The server only ever sees ciphertext, so these rules run here.
 */
object SecureKind {
    private val labelWords = listOf(
        "month" to listOf("月份", "month"), "year" to listOf("年份", "year"), "country" to listOf("国家", "country"),
        "city" to listOf("城市", "city"), "email" to listOf("邮箱", "邮件", "email", "e-mail"),
        "phone" to listOf("电话", "手机", "phone", "mobile"), "postal_code" to listOf("邮编", "zip", "postal", "postcode"),
        "name" to listOf("姓名", "名字", "name"), "address" to listOf("地址", "address"),
    )

    /** Older requests label every field `text`; the label then says what the field really is. */
    fun resolve(field: SecureInputField): String {
        val kind = field.kind ?: "text"
        if (kind != "text") return kind
        val label = field.label.orEmpty().lowercase()
        return labelWords.firstOrNull { (_, words) -> words.any { label.contains(it) } }?.first ?: "text"
    }

    /** Required unless the request says otherwise (`required == false`), as iOS `isRequired`. */
    fun isRequired(field: SecureInputField): Boolean = field.required != false

    /** What may be typed, formatted as it should look: cards in 4s, expiry as MM/YY, codes as digits. */
    fun sanitize(field: SecureInputField, raw: String): String {
        var s = raw
        when (resolve(field)) {
            "card_number" -> s = digits(s).take(19).chunked(4).joinToString(" ")
            "card_expiry" -> {
                val d = digits(s).take(4)
                s = if (d.length > 2) d.take(2) + "/" + d.drop(2) else d
            }
            "card_cvc" -> s = digits(s).take(4)
            "otp" -> s = digits(s).take(10)
            "number" -> {
                val out = StringBuilder()
                var dot = false
                for (ch in s) {
                    when {
                        ch in '0'..'9' -> out.append(ch)
                        (ch == '.' || ch == ',') && !dot -> { dot = true; out.append('.') }
                        ch == '-' && out.isEmpty() -> out.append(ch)
                    }
                }
                s = out.toString()
            }
            "postal_code" -> s = s.uppercase()
        }
        field.maxLength?.takeIf { it > 0 && s.length > it }?.let { s = s.take(it.toInt()) }
        return s
    }

    /** The text that goes to the page: card numbers without spaces, everything trimmed. */
    fun output(field: SecureInputField, value: String): String {
        val v = value.trim()
        return if (resolve(field) == "card_number") v.replace(" ", "") else v
    }

    /** The values that will be sent: formatted, trimmed, and only the fields that were filled. */
    fun outputs(fields: List<SecureInputField>, values: Map<String, String>): Map<String, String> =
        fields.mapNotNull { field -> output(field, values[field.id].orEmpty()).takeIf { it.isNotEmpty() }?.let { field.id to it } }.toMap()

    /** Null when fine (or optional and empty); otherwise the message to show. [now] is injectable for the expiry rule. */
    fun validate(field: SecureInputField, raw: String, now: YearMonth = YearMonth.now()): String? {
        val v = raw.trim()
        if (v.isEmpty()) return if (isRequired(field)) "Required" else null
        val d = digits(v)
        return when (resolve(field)) {
            "card_number" -> if (d.length in 12..19 && luhn(d)) null else "Enter a valid card number"
            "card_expiry" -> {
                val month = d.take(2).toIntOrNull()
                val year = d.takeLast(2).toIntOrNull()
                when {
                    d.length != 4 || month == null || year == null || month !in 1..12 -> "Enter the expiry as MM/YY"
                    year % 100 < now.year % 100 || (year == now.year % 100 && month < now.monthValue) -> "This card has expired"
                    else -> null
                }
            }
            "card_cvc" -> if (d.length in 3..4) null else "Enter the 3 or 4 digit security code"
            "otp" -> if (d.length in 4..10) null else "Enter the digits of the code"
            "email" -> if (EMAIL.matches(v)) null else "Enter a valid email address"
            "phone" -> if (PHONE.matches(v) && d.length >= 5) null else "Enter a valid phone number"
            "number" -> {
                val n = v.toDoubleOrNull()
                val lo = field.min
                val hi = field.max
                when {
                    n == null -> "Enter a number"
                    lo != null && n < lo -> "Must be at least $lo"
                    hi != null && n > hi -> "Must be at most $hi"
                    else -> null
                }
            }
            "date" -> if (runCatching { LocalDate.parse(v) }.isSuccess) null else "Enter a date as YYYY-MM-DD"
            else -> null
        }
    }

    /** The Luhn checksum of a card number's digits. */
    fun luhn(digits: String): Boolean {
        var sum = 0
        for ((i, ch) in digits.reversed().withIndex()) {
            var n = ch.digitToIntOrNull() ?: return false
            if (i % 2 == 1) { n *= 2; if (n > 9) n -= 9 }
            sum += n
        }
        return sum % 10 == 0
    }

    private fun digits(s: String): String = s.filter { it in '0'..'9' }

    private val EMAIL = Regex("""[^@\s]+@[^@\s]+\.[^@\s]+""")
    private val PHONE = Regex("""\+?[\d\s().-]{5,24}""")
}
