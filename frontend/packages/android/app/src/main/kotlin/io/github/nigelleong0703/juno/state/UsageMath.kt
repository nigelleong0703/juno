package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentUsage
import java.util.Locale

// The Usage page's numbers (web features/usage/UsagePage.tsx). A spend with an unknown price reads "Unknown", never $0.00.

object UsageMath {
    /** Above this share of the included limit the spend bar turns to the warning colour. */
    const val WARN_AT = 0.85

    fun usd(amount: Double): String = String.format(Locale.US, "\$%.2f", amount)

    fun spend(costUsd: Double?, costKnown: Boolean?): String = if (costKnown == false) "Unknown" else usd(costUsd ?: 0.0)

    /** The bar's fill: the week's share of the limit, clamped to 0..1. */
    fun fraction(percent: Double?): Float = (percent ?: 0.0).coerceIn(0.0, 1.0).toFloat()

    fun isWarning(percent: Double?): Boolean = (percent ?: 0.0) > WARN_AT

    /** Counts as "1.2k" / "3.4M". */
    fun count(n: Long): String = when {
        n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
        n >= 1_000 -> String.format(Locale.US, "%.1fk", n / 1_000.0)
        else -> n.toString()
    }

    /** Agents with runs this period, most spend first (web: runs > 0, sorted by cost). */
    fun agentsWithRuns(byAgent: List<AgentUsage>): List<AgentUsage> =
        byAgent.filter { (it.runs ?: 0L) > 0L }.sortedByDescending { it.costUsd ?: 0.0 }

    fun totalRuns(byAgent: List<AgentUsage>): Long = byAgent.sumOf { it.runs ?: 0L }
}
