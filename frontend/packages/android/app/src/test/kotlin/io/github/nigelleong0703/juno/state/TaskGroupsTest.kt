package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.core.JunoJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class TaskGroupsTest {
    private val now = Instant.parse("2026-10-22T12:00:00Z")
    private fun task(
        id: String, status: String, at: String, outcome: String? = null, parent: String? = null, kind: String = "task",
        routine: String? = null, childRun: String? = null,
    ) = AgentTask(
        id = id, kind = kind, parentId = parent, status = status, outcome = if (status == "ended") outcome ?: "done" else null, childRunId = childRun,
        routineId = routine, startedAt = at, finishedAt = if (status == "ended") at else null,
    )

    @Test fun `live tasks come first, newest start first, and are never capped`() {
        val tasks = (1..20).map { task("w$it", "waiting", "2026-10-22T0${it % 10}:00:00Z") } + task("r", "running", "2026-10-22T11:00:00Z") + task("q", "queued", "2026-10-21T00:00:00Z")
        val layout = TaskGroups.layout(tasks, limit = 1, now = now, zone = ZoneOffset.UTC)
        assertEquals(22, layout.active.size)
        assertEquals("r", layout.active.first().id)
        assertEquals("q", layout.active.last().id)
    }

    @Test fun `finished tasks are grouped by day newest first and capped`() {
        val tasks = listOf(
            task("old", "ended", "2026-10-10T09:00:00Z"), task("y", "ended", "2026-10-21T23:30:00Z", "failed"),
            task("t2", "ended", "2026-10-22T10:00:00Z"), task("t1", "ended", "2026-10-22T08:00:00Z", "cancelled"),
        )
        val layout = TaskGroups.layout(tasks, limit = 3, now = now, zone = ZoneOffset.UTC)
        assertEquals(listOf("Today", "Yesterday"), layout.days.map { it.title })
        assertEquals(listOf("t2", "t1"), layout.days[0].entries.map { it.id })
        assertEquals(4, layout.finishedTotal)
    }

    @Test fun `older days are titled with the date`() {
        val layout = TaskGroups.layout(listOf(task("old", "ended", "2026-10-10T09:00:00Z")), 12, now, ZoneOffset.UTC)
        assertEquals(1, layout.days.size)
        assertEquals(true, layout.days[0].title.contains("10"))
    }

    @Test fun `children hang under their parent and a missing parent is top-level`() {
        val sub = task("sub", "running", "2026-10-22T08:00:00Z", parent = "run-root", kind = "subagent", childRun = "run-child")
        val viaId = task("cmd", "ended", "2026-10-22T10:00:00Z", parent = "sub", kind = "command")
        val viaRun = task("conn", "ended", "2026-10-22T09:00:00Z", parent = "run-child", kind = "connector")
        val tree = TaskGroups.tree(listOf(viaId, sub, viaRun))
        assertEquals(listOf("sub"), tree.map { it.task.id })
        assertEquals(listOf("conn", "cmd"), tree[0].children.map { it.task.id })
        assertTrue("a live parent keeps its finished children on the Now list", TaskGroups.layout(listOf(viaId, sub, viaRun), 10, now, ZoneOffset.UTC).active.single().isLive)
    }

    @Test fun `tasks that point at each other are kept`() {
        val tree = TaskGroups.tree(listOf(task("x", "running", "2026-10-22T08:00:00Z", parent = "y"), task("y", "running", "2026-10-22T08:00:00Z", parent = "x")))
        assertEquals(setOf("x", "y"), tree.flatMap { it.tasks }.map { it.id }.toSet())
    }

    @Test fun `routine runs gather under their routine`() {
        val tasks = listOf(
            task("r1", "ended", "2026-10-22T05:00:00Z", kind = "routine", routine = "digest"), task("plain", "running", "2026-10-22T11:00:00Z"),
            task("r2", "ended", "2026-10-21T05:00:00Z", "failed", kind = "routine", routine = "digest"),
        )
        val entries = TaskGroups.entries(tasks)
        assertEquals(2, entries.size)
        val routine = entries[0] as TaskEntry.Routine
        assertEquals("digest", routine.routineId)
        assertEquals(listOf("r1", "r2"), routine.runs.map { it.task.id })
    }

    @Test fun `words for every state and where a tap goes`() {
        fun words(status: String, waitingFor: String? = null, outcome: String? = null, detail: String? = null, progress: String? = null, result: String? = null) =
            AgentTask("t", conversationId = "conv", status = status, waitingFor = waitingFor, outcome = outcome, outcomeDetail = detail, progress = progress, resultLine = result)
        assertEquals("Queued", TaskWords.phase(words("queued")).first)
        assertEquals("Waiting for approval", TaskWords.phase(words("waiting", waitingFor = "approval")).first)
        assertEquals("Didn't finish", TaskWords.phase(words("ended", outcome = "failed")).first)
        assertEquals("Stopped", TaskWords.phase(words("ended", outcome = "cancelled")).first)
        assertEquals("Outcome unknown, check before retrying", TaskWords.phase(words("ended", outcome = "unknown_effect")).first)
        assertEquals("Timed out · Exited with code 1", TaskWords.subtitle(words("ended", outcome = "failed", detail = "timed_out", result = "Exited with code 1")))
        assertEquals("Waiting for you · Which baseline?", TaskWords.subtitle(words("waiting", waitingFor = "owner_input", progress = "Which baseline?")))
        assertEquals("conv", TaskWords.needsYou(words("waiting", waitingFor = "owner_input")))
        assertEquals("conv", TaskWords.needsYou(words("ended", outcome = "unknown_effect", detail = "effect_review")))
        assertEquals("conv", TaskWords.needsYou(words("ended", outcome = "needs_input")))
        assertNull(TaskWords.needsYou(words("waiting", waitingFor = "event")))
        assertNull(TaskWords.needsYou(words("ended", outcome = "failed")))
    }

    @Test fun `a folded parent shows a descendant that needs the person`() {
        val top = AgentTask("top", kind = "subagent", status = "running", childRunId = "run-top")
        val mid = AgentTask("mid", kind = "subagent", parentId = "run-top", status = "running", childRunId = "run-mid")
        val leaf = AgentTask("leaf", kind = "task", parentId = "run-mid", status = "waiting", waitingFor = "approval")
        val question = AgentTask("q", kind = "task", parentId = "run-top", status = "waiting", waitingFor = "owner_input")
        val parent = TaskGroups.tree(listOf(top, mid, leaf)).single()
        assertEquals("Waiting for approval", parent.descendantsNeedingYou?.label)
        assertEquals("1 needs you", parent.descendantsNeedingYou?.line)
        assertEquals("Waiting for approval", parent.children[0].descendantsNeedingYou?.label)
        assertTrue(parent.startsExpanded)
        assertTrue(parent.children[0].startsExpanded)
        assertNull(parent.children[0].children[0].descendantsNeedingYou)
        val both = TaskGroups.tree(listOf(top, mid, leaf, question)).single()
        assertEquals("2 need you", both.descendantsNeedingYou?.line)
        assertEquals("Waiting for approval", both.descendantsNeedingYou?.label)
        assertNull(TaskGroups.tree(listOf(top, mid)).single().descendantsNeedingYou)
        assertEquals(false, TaskGroups.tree(listOf(top, mid)).single().startsExpanded)
    }

    @Test fun `decodes the task tree shape`() {
        val json = """{"id":"t1","kind":"routine","agentId":"a","parentId":"p","rootRunId":"r","depth":1,
            "origin":{"type":"routine","routineId":"rt","occurrenceAt":"2026-10-29T08:00:00.000Z"},"mode":"scheduled","replyTo":{"type":"delivery","channel":"chat"},
            "status":"ended","outcome":"failed","outcomeDetail":"timed_out","title":"Digest","resultLine":"Timed out","routineId":"rt",
            "startedAt":"2026-10-29T08:00:00.000Z","updatedAt":"2026-10-29T08:05:00.000Z"}"""
        val task = JunoJson.decodeFromString<AgentTask>(json)
        assertEquals("ended", task.status)
        assertEquals("timed_out", task.outcomeDetail)
        assertEquals("Started by a routine · Daily digest", startedByLine(task.origin!!, "Daily digest"))
    }
}
