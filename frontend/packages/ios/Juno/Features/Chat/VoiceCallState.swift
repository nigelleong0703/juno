import AVFoundation
import Foundation
import LiveKit
import os

/// What the call screen shows. `connecting` covers everything until the call is live (room joined, microphone
/// publishing and the agent listening); the finer phases are only in `VoiceCallTimeline`.
enum VoiceCallState: Equatable {
    case connecting, listening, thinking, speaking, ended
    case failed(String)

    /// Maps the worker's `lk.agent.state` attribute. Unknown values return nil so the screen keeps its current state.
    static func agent(_ rawValue: String) -> VoiceCallState? {
        switch rawValue {
        case "initializing", "idle": .connecting
        case "listening": .listening
        case "thinking": .thinking
        case "speaking": .speaking
        default: nil
        }
    }

    var label: String {
        switch self {
        case .connecting: "Connecting…"
        case .listening: "Listening"
        case .thinking: "Thinking…"
        case .speaking: "Speaking"
        case .ended: "Call ended"
        case .failed(let message): message
        }
    }

    /// States where the halo follows an audio level.
    var followsLevel: Bool { self == .listening || self == .speaking }
}

/// Turns raw RMS samples into a 0...1 value that rises fast and falls slowly, so the halo does not flicker.
struct VoiceLevelSmoother {
    private(set) var value: Float = 0
    var attack: Float = 0.55
    var release: Float = 0.15

    /// Speech RMS spans roughly -50 dBFS (quiet room) to -10 dBFS (loud); map that to 0...1.
    static func normalized(rms: Float) -> Float {
        let decibels = 20 * log10(max(rms, 1e-5))
        return min(max((decibels + 50) / 40, 0), 1)
    }

    @discardableResult
    mutating func push(_ target: Float) -> Float {
        let clamped = min(max(target, 0), 1)
        value += (clamped - value) * (clamped > value ? attack : release)
        if value < 0.005 { value = 0 }
        return value
    }

    mutating func reset() { value = 0 }
}

/// Receives PCM buffers from a LiveKit track and keeps the RMS of the latest one. Read from the sampler.
final class VoiceLevelMeter: NSObject, AudioRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private var rms: Float = 0

    var level: Float {
        lock.lock(); defer { lock.unlock() }
        return VoiceLevelSmoother.normalized(rms: rms)
    }

    func clear() {
        lock.lock(); rms = 0; lock.unlock()
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let count = Int(pcmBuffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        if let data = pcmBuffer.floatChannelData?[0] {
            for index in 0..<count { sum += data[index] * data[index] }
        } else if let data = pcmBuffer.int16ChannelData?[0] {
            for index in 0..<count {
                let sample = Float(data[index]) / Float(Int16.max)
                sum += sample * sample
            }
        } else {
            return
        }
        let value = (sum / Float(count)).squareRoot()
        lock.lock(); rms = value; lock.unlock()
    }
}

let voiceCallLog = Logger(subsystem: "io.github.nigelleong0703.juno", category: "voice-call")

/// Monotonic per-call timings, each phase recorded once, so a real call shows where the wait is.
struct VoiceCallTimeline {
    enum Phase: String, CaseIterable {
        case appeared, permission, token, roomConnected, micPublished, agentJoined, listening
    }

    private let clock = ContinuousClock()
    private let start: ContinuousClock.Instant
    private(set) var marks: [Phase: Int] = [:]

    init() { start = clock.now }

    /// Milliseconds since the call started, or nil if this phase was already recorded.
    @discardableResult
    mutating func mark(_ phase: Phase) -> Int? {
        guard marks[phase] == nil else { return nil }
        let parts = (clock.now - start).components
        let milliseconds = Int(parts.seconds * 1000 + parts.attoseconds / 1_000_000_000_000_000)
        marks[phase] = milliseconds
        return milliseconds
    }

    var summary: String {
        Phase.allCases.compactMap { phase in marks[phase].map { "\(phase.rawValue)=\($0)ms" } }.joined(separator: " ")
    }
}
