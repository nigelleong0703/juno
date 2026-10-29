package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.FeedPost
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.ui.components.RelativeTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class FeedItemTest {
    @Test fun aPostWithAMalformedUiDocStillDecodes() {
        // The UI doc is kept raw and parsed on its own, so its shape cannot drop the post.
        val raw = JunoJson.parseToJsonElement(
            """{"id":"p1","agentId":"a1","title":"News","feedback":"more","ui":{"version":1,"blocks":[{"type":"table","columns":3}]}}""",
        )
        val item = decodeFeedItem(raw)
        assertNotNull(item)
        assertEquals("p1", item!!.post.id)
        assertEquals("more", item.post.feedback)
        assertNotNull(item.ui)
    }

    @Test fun aPostWithoutAnIdIsDropped() {
        assertNull(decodeFeedItem(JunoJson.parseToJsonElement("""{"title":"no id"}""")))
    }

    @Test fun cardSummaryFallsBackToTheStrippedBody() {
        val post = FeedPost(id = "p", body = "## Heading\n\nSome **bold** and a [link](https://x.y) text.\n```\ncode\n```")
        assertEquals("Heading Some bold and a link text.", post.cardSummary)
    }

    @Test fun cardSummaryPrefersTheSummary() {
        assertEquals("Short", FeedPost(id = "p", summary = "Short", body = "long body").cardSummary)
    }

    @Test fun relativeTimeIsShort() {
        val now = Instant.parse("2026-10-22T12:00:00Z")
        val zone = ZoneId.of("UTC")
        assertEquals("now", RelativeTime.short(now.minusSeconds(30), now, zone))
        assertEquals("5m", RelativeTime.short(now.minusSeconds(300), now, zone))
        assertEquals("2h", RelativeTime.short(now.minusSeconds(7_200), now, zone))
        assertEquals("3d", RelativeTime.short(now.minusSeconds(3 * 86_400L), now, zone))
        assertEquals("2w", RelativeTime.short(now.minusSeconds(14 * 86_400L), now, zone))
        assertEquals("12 Aug", RelativeTime.short(Instant.parse("2026-08-12T00:00:00Z"), now, zone))
        assertEquals("", RelativeTime.short(null, now, zone))
    }
}
