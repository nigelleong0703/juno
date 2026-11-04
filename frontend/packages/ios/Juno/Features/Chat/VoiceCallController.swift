import Foundation
import LiveKit
import Observation

/// Owns one room. Closing the screen invalidates all outstanding callbacks and disconnects audio.
///
/// A joined room is not yet a usable call: the dispatched worker has to join as a LiveKit agent
/// participant and report `listening` through its `lk.agent.state` attribute. Until then the call
/// waits; a worker that never arrives (timeout) or leaves makes the call unavailable.
@MainActor @Observable
final class VoiceCallController {
    /// How long a joined room waits for the worker to become a listening agent participant.
    nonisolated static let readinessTimeout: Duration = .seconds(30)

    private(set) var state = VoiceCallState.connecting
    /// 0...1, smoothed: your microphone while listening, the agent's voice while speaking.
    private(set) var level: Float = 0
    private(set) var muted = false
    private(set) var transcript = VoiceTranscript()
    private(set) var ready = false
    private var room: Room?
    private var roomObserver: VoiceRoomObserver?
    private var generation = UUID()
    private var changingMute = false
    private var readinessTask: Task<Void, Never>?
    private var timeline = VoiceCallTimeline()
    private var micPublished = false
    private var samplingTask: Task<Void, Never>?
    private let localMeter = VoiceLevelMeter()
    private let agentMeter = VoiceLevelMeter()
    private var localTrack: LocalAudioTrack?
    private var agentTrack: AudioTrack?

    /// Records a connect phase once per call (monotonic ms since the screen appeared; no identifiers logged).
    func mark(_ phase: VoiceCallTimeline.Phase) {
        guard let milliseconds = timeline.mark(phase) else { return }
        voiceCallLog.info("phase \(phase.rawValue, privacy: .public) +\(milliseconds)ms")
        if phase == .listening { voiceCallLog.info("timeline \(self.timeline.summary, privacy: .public)") }
    }

    /// Call when the screen appears, before anything else: it starts the call's clock.
    func begin() {
        timeline = VoiceCallTimeline()
        mark(.appeared)
    }

    func showError(_ message: String) {
        state = .failed(message)
    }

    func connect(url: String, token: String, localIdentity: String) async {
        guard room == nil else { return }
        let current = UUID()
        generation = current
        readinessTask?.cancel()
        readinessTask = nil
        ready = false
        micPublished = false
        transcript = VoiceTranscript()
        muted = false
        let observer = VoiceRoomObserver(
            onDisconnect: { [weak self] in
                Task { @MainActor in self?.disconnected(generation: current) }
            },
            onParticipantConnected: { [weak self] participant in
                Task { @MainActor in self?.agentParticipantChanged(participant, generation: current) }
            },
            onParticipantChanged: { [weak self] participant in
                Task { @MainActor in self?.agentParticipantChanged(participant, generation: current) }
            },
            onParticipantDisconnected: { [weak self] participant in
                Task { @MainActor in await self?.agentParticipantLeft(participant, generation: current) }
            }
        )
        roomObserver = observer
        let callRoom = Room(delegate: observer)
        room = callRoom
        state = .connecting
        do {
            try await callRoom.registerTextStreamHandler(for: "lk.transcription") { [weak self] reader, participant in
                let attributes = reader.info.attributes
                let segment = attributes["lk.segment_id"] ?? reader.info.id
                let final = attributes["lk.transcription_final"] == "true"
                var text = ""
                do {
                    for try await chunk in reader {
                        text += chunk
                        await self?.receive(segment: segment, participant: participant.stringValue,
                                            localIdentity: localIdentity, text: text, isFinal: false, generation: current)
                    }
                    await self?.receive(segment: segment, participant: participant.stringValue,
                                        localIdentity: localIdentity, text: text,
                                        isFinal: final || participant.stringValue != localIdentity, generation: current)
                } catch {
                    // A closed or interrupted stream must not create a synthetic final transcript.
                }
            }
            try await callRoom.connect(url: url, token: token)
            guard generation == current else { await callRoom.disconnect(); return }
            mark(.roomConnected)
            try await callRoom.localParticipant.setMicrophone(enabled: true)
            guard generation == current else { await callRoom.disconnect(); return }
            mark(.micPublished)
            micPublished = true
            startReadinessCountdown(generation: current)
            // The worker may already be in the room when this client finishes joining.
            if let agent = callRoom.agentParticipant {
                agentParticipantChanged(agent, generation: current)
            }
        } catch {
            await callRoom.disconnect()
            guard generation == current else { return }
            readinessTask?.cancel()
            readinessTask = nil
            ready = false
            room = nil
            roomObserver = nil
            stopSampling()
            state = .failed("Couldn't connect to the call. Please try again.")
        }
    }

    func toggleMute() async {
        guard let room, !changingMute else { return }
        changingMute = true
        defer { changingMute = false }
        let current = generation
        do {
            try await room.localParticipant.setMicrophone(enabled: muted)
            guard generation == current else { return }
            muted.toggle()
        } catch {
            guard generation == current else { return }
            state = .failed(error.localizedDescription)
        }
    }

    func end() async {
        generation = UUID()
        readinessTask?.cancel()
        readinessTask = nil
        ready = false
        let oldRoom = room
        room = nil
        roomObserver = nil
        stopSampling()
        state = .ended
        await oldRoom?.disconnect()
    }

    /// The worker's `lk.agent.state` is `initializing`/`idle` until its session starts, then
    /// `listening` (and `thinking`/`speaking` once the conversation is under way). Only an active
    /// state means the worker can hear the person; a joined room alone does not.
    nonisolated static func agentStateIsReady(_ rawValue: String) -> Bool {
        guard let state = AgentState(rawValue: rawValue) else { return false }
        switch state {
        case .listening, .thinking, .speaking:
            return true
        case .idle, .initializing:
            return false
        @unknown default:
            return false
        }
    }

    private func startReadinessCountdown(generation: UUID) {
        readinessTask?.cancel()
        readinessTask = Task { [weak self] in
            do {
                try await Task.sleep(for: Self.readinessTimeout)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await self?.readinessExpired(generation: generation)
        }
    }

    private func readinessExpired(generation: UUID) async {
        guard generation == self.generation, !ready else { return }
        await workerUnavailable(generation: generation)
    }

    /// Drops the room after a timeout or an agent departure so the microphone stops and the
    /// server can clean up. Invalidating the generation makes callbacks still in flight no-ops.
    private func workerUnavailable(generation: UUID) async {
        guard generation == self.generation, let callRoom = room else { return }
        self.generation = UUID()
        readinessTask?.cancel()
        readinessTask = nil
        ready = false
        room = nil
        roomObserver = nil
        stopSampling()
        state = .failed("The agent is unavailable. Please try again.")
        await callRoom.disconnect()
    }

    private func agentParticipantChanged(_ participant: Participant, generation: UUID) {
        guard generation == self.generation, let callRoom = room, participant.isAgent else { return }
        // Read the primary agent: an avatar worker is also an agent participant but carries no state.
        guard let agent = callRoom.agentParticipant else { return }
        mark(.agentJoined)
        // The call only counts as live once the microphone is actually publishing.
        guard micPublished, let next = VoiceCallState.agent(agent.agentState.rawValue) else { return }
        if !ready {
            guard Self.agentStateIsReady(agent.agentState.rawValue) else { return }
            ready = true
            readinessTask?.cancel()
            readinessTask = nil
            startSampling(generation: generation)
        }
        if state != next { state = next }
        if next == .listening { mark(.listening) }
    }

    private func startSampling(generation: UUID) {
        samplingTask?.cancel()
        samplingTask = Task { [weak self] in
            var smoother = VoiceLevelSmoother()
            while !Task.isCancelled {
                guard let self, generation == self.generation else { return }
                let next = smoother.push(self.sampleLevel())
                if abs(next - self.level) > 0.004 { self.level = next }
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    private func stopSampling() {
        samplingTask?.cancel()
        samplingTask = nil
        localTrack?.remove(audioRenderer: localMeter)
        agentTrack?.remove(audioRenderer: agentMeter)
        localTrack = nil
        agentTrack = nil
        localMeter.clear()
        agentMeter.clear()
        level = 0
    }

    /// Raw 0...1 level for the current state; tracks are attached lazily because they appear after the room joins.
    private func sampleLevel() -> Float {
        guard let room else { return 0 }
        switch state {
        case .listening:
            if localTrack == nil, let track = room.localParticipant.firstAudioPublication?.track as? LocalAudioTrack {
                track.add(audioRenderer: localMeter)
                localTrack = track
            }
            return muted ? 0 : localMeter.level
        case .speaking:
            let agent = room.agentParticipant
            if agentTrack == nil, let track = agent?.firstAudioPublication?.track as? AudioTrack {
                track.add(audioRenderer: agentMeter)
                agentTrack = track
            }
            return agentTrack == nil ? (agent?.audioLevel ?? 0) : agentMeter.level
        default:
            return 0
        }
    }

    private func agentParticipantLeft(_ participant: Participant, generation: UUID) async {
        guard generation == self.generation, let callRoom = room else { return }
        guard participant.isAgent else { return }
        // Avatar workers can publish on behalf of the agent; only the last agent participant
        // leaving ends the call.
        guard callRoom.agentParticipants.isEmpty else { return }
        await workerUnavailable(generation: generation)
    }

    private func disconnected(generation: UUID) {
        guard generation == self.generation, room != nil else { return }
        self.generation = UUID()
        readinessTask?.cancel()
        readinessTask = nil
        ready = false
        room = nil
        roomObserver = nil
        stopSampling()
        state = .failed("Call disconnected. Please try again.")
    }

    private func receive(segment: String, participant: String, localIdentity: String,
                         text: String, isFinal: Bool, generation: UUID) {
        guard generation == self.generation else { return }
        transcript.update(segmentID: segment, participantIdentity: participant, localIdentity: localIdentity,
                          text: text, isFinal: isFinal)
    }
}

private final class VoiceRoomObserver: NSObject, RoomDelegate, @unchecked Sendable {
    private let onDisconnect: @Sendable () -> Void
    private let onParticipantConnected: @Sendable (Participant) -> Void
    private let onParticipantChanged: @Sendable (Participant) -> Void
    private let onParticipantDisconnected: @Sendable (Participant) -> Void

    init(onDisconnect: @escaping @Sendable () -> Void,
         onParticipantConnected: @escaping @Sendable (Participant) -> Void,
         onParticipantChanged: @escaping @Sendable (Participant) -> Void,
         onParticipantDisconnected: @escaping @Sendable (Participant) -> Void) {
        self.onDisconnect = onDisconnect
        self.onParticipantConnected = onParticipantConnected
        self.onParticipantChanged = onParticipantChanged
        self.onParticipantDisconnected = onParticipantDisconnected
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        onDisconnect()
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        onParticipantConnected(participant)
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        onParticipantDisconnected(participant)
    }

    func room(_ room: Room, participant: Participant, didUpdateAttributes attributes: [String: String]) {
        onParticipantChanged(participant)
    }

    func room(_ room: Room, participant: Participant, didUpdateState state: ParticipantState) {
        onParticipantChanged(participant)
    }
}
