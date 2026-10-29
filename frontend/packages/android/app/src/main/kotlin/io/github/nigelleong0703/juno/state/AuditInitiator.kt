package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.RunOrigin

/**
 * The "who started it" line under an activity row (web `startedByLine`, iOS `Contract.RunOrigin.startedByLine`; same words).
 * A routine shows its name when [routineName] is known; a system wake shows what woke the agent (`label`, else the wake kind in
 * plain words), and nothing for an entry no run belongs to.
 */
fun startedByLine(initiator: RunOrigin, routineName: String? = null): String = when (initiator.type) {
    RunOrigin.TypeValue.ownerMessage -> "Started by you"
    RunOrigin.TypeValue.channel -> {
        val platform = ChannelPlatform.ofKind(initiator.channel)?.title ?: initiator.channel ?: "a chat"
        when (initiator.speaker) {
            RunOrigin.SpeakerValue.owner -> "Started by you on $platform"
            RunOrigin.SpeakerValue.member -> "Started by a member on $platform"
            else -> "Started by a stranger on $platform"
        }
    }
    RunOrigin.TypeValue.routine -> if (routineName == null) "Started by a routine" else "Started by a routine · $routineName"
    RunOrigin.TypeValue.parentRun -> "Started by an agent task"
    else -> {
        val what = initiator.label ?: initiator.wakeKind?.takeIf { it != "system" }?.replace('_', ' ')
        if (what == null) "Started by the system" else "Started by the system · $what"
    }
}
