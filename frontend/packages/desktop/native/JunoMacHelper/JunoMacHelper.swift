import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

// This helper only records system audio and answers the permission prompts. Screenshots and input are cua-driver's
// (embedded in the app, same TCC identity); nothing here posts global mouse or keyboard events.

private struct HelperError: Error {
    let code: String
    let message: String
    let settingsPath: String?
    let settingsURL: String?

    init(_ code: String, _ message: String, settingsPath: String? = nil, settingsURL: String? = nil) {
        self.code = code
        self.message = message
        self.settingsPath = settingsPath
        self.settingsURL = settingsURL
    }

    static var screenDenied: HelperError {
        HelperError(
            "screen_permission",
            "Screen & System Audio Recording permission is required for this Mac. Enable Juno in System Settings, then try again.",
            settingsPath: "System Settings > Privacy & Security > Screen & System Audio Recording",
            settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        )
    }

    var object: [String: Any] {
        var error: [String: Any] = ["code": code, "message": message]
        if let settingsPath { error["settingsPath"] = settingsPath }
        if let settingsURL { error["settingsURL"] = settingsURL }
        return ["ok": false, "error": error]
    }
}

private struct Request {
    let agentId: String
    let action: String
    let input: [String: Any]

    static func readFromStdin() throws -> Request {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty else {
            throw HelperError("bad_request", "expected one JSON request on stdin")
        }
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw HelperError("bad_request", "stdin did not contain valid JSON: \(error.localizedDescription)")
        }
        guard let object = value as? [String: Any],
              let agentId = object["agentId"] as? String,
              !agentId.isEmpty,
              let action = object["action"] as? String,
              let input = object["input"] as? [String: Any] else {
            throw HelperError("bad_request", "expected {agentId: string, action: string, input: object}")
        }
        return Request(agentId: agentId, action: action, input: input)
    }
}

private enum Dispatched {
    case response([String: Any])
    case recording(initial: [String: Any], recorder: SystemAudioRecorder, timeout: TimeInterval)
}

@main
private enum JunoMacHelper {
    static func main() async {
        do {
            let request = try Request.readFromStdin()
            switch try await dispatch(request) {
            case let .response(response):
                output(response)
            case let .recording(initial, recorder, timeout):
                output(initial)
                let gate = StopGate()
                recorder.onFailure = { message in gate.stop("error", detail: message) }

                Darwin.signal(SIGINT, SIG_IGN)
                Darwin.signal(SIGTERM, SIG_IGN)
                let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
                let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
                interrupt.setEventHandler { gate.stop("interrupt") }
                terminate.setEventHandler { gate.stop("terminated") }
                interrupt.resume()
                terminate.resume()

                let timeoutTask = Task {
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    gate.stop("timeout")
                }
                let stopped = await gate.wait()
                timeoutTask.cancel()
                interrupt.cancel()
                terminate.cancel()
                output(await recorder.finish(reason: stopped.0, failure: stopped.1))
            }
        } catch let failure as HelperError {
            output(failure.object)
            exit(EXIT_FAILURE)
        } catch {
            output(HelperError("internal", error.localizedDescription).object)
            exit(EXIT_FAILURE)
        }
    }

    private static func dispatch(_ request: Request) async throws -> Dispatched {
        switch request.action {
        case "permissions":
            return .response(try permissions(request.input))
        case "audio_start":
            guard #available(macOS 13.0, *) else {
                throw HelperError("unsupported", "system audio capture requires macOS 13 or later")
            }
            let recording = try await SystemAudioRecorder.start(input: request.input)
            return .recording(initial: recording.initial, recorder: recording.recorder, timeout: recording.timeout)
        case "audio_stop":
            throw HelperError("bad_request", "audio_stop is owned by the Juno host process and is not a helper action")
        case "browser":
            throw HelperError("bad_request", "browser is handled by the Juno host")
        default:
            throw HelperError("bad_request", "unsupported desktop action: \(request.action)")
        }
    }
}

private func output(_ object: [String: Any]) {
    do {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    } catch {
        FileHandle.standardError.write(Data("juno-mac-helper: could not encode response: \(error)\n".utf8))
    }
}

private func permissions(_ input: [String: Any]) throws -> [String: Any] {
    if let requested = input["request"] {
        guard let name = requested as? String, name == "screen" || name == "accessibility" else {
            throw HelperError("bad_request", "permissions.request must be screen or accessibility")
        }
        // These two calls are reachable only through the owner-clicked Settings IPC. A plain
        // permissions request below is status-only and never opens a macOS permission prompt.
        if name == "screen" {
            _ = CGRequestScreenCaptureAccess()
        } else {
            let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
        }
    }

    let screen = CGPreflightScreenCaptureAccess()
    let accessibility = AXIsProcessTrusted()
    let audio = screen && ProcessInfo.processInfo.isOperatingSystemAtLeast(
        OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)
    )
    return [
        "screen": screen,
        "accessibility": accessibility,
        "audio": audio,
        "settings": [
            "screen": "System Settings > Privacy & Security > Screen & System Audio Recording",
            "accessibility": "System Settings > Privacy & Security > Accessibility",
        ],
    ]
}

private func finiteDouble(_ value: Any?, _ name: String) throws -> Double {
    if value is Bool || value == nil {
        throw HelperError("bad_request", "\(name) must be a finite number")
    }
    guard let number = value as? NSNumber else {
        throw HelperError("bad_request", "\(name) must be a finite number")
    }
    let result = number.doubleValue
    guard result.isFinite else {
        throw HelperError("bad_request", "\(name) must be a finite number")
    }
    return result
}

private final class StopGate: @unchecked Sendable {
    typealias Stop = (String, String?)
    private let lock = NSLock()
    private var stop: Stop?
    private var continuation: CheckedContinuation<Stop, Never>?

    func stop(_ reason: String, detail: String? = nil) {
        lock.lock()
        guard stop == nil else {
            lock.unlock()
            return
        }
        let value = (reason, detail)
        stop = value
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }

    func wait() async -> Stop {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let stop {
                lock.unlock()
                continuation.resume(returning: stop)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }
}

private final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let recordingId: String
    let path: String
    let initial: [String: Any]
    let timeout: TimeInterval
    var onFailure: ((String) -> Void)?

    private let startedAt = Date()
    private let audioQueue = DispatchQueue(label: "com.juno.mac-helper.audio")
    private let format: AVAudioFormat
    private var stream: SCStream?
    private var file: AVAudioFile?
    private var failure: String?
    private let finishLock = NSLock()
    private var finished = false

    private init(recordingId: String, path: String, timeout: TimeInterval) throws {
        self.recordingId = recordingId
        self.path = path
        self.timeout = timeout
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2) else {
            throw HelperError("audio_failed", "the helper could not open a 48 kHz stereo audio format")
        }
        self.format = format
        self.file = try AVAudioFile(
            forWriting: URL(fileURLWithPath: path),
            settings: format.settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        initial = ["recordingId": recordingId, "path": path, "state": "recording"]
        super.init()
    }

    @available(macOS 13.0, *)
    static func start(input: [String: Any]) async throws -> (initial: [String: Any], recorder: SystemAudioRecorder, timeout: TimeInterval) {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError.screenDenied }
        guard let folder = input["folder"] as? String, folder.hasPrefix("/") else {
            throw HelperError("bad_request", "audio_start requires the host-owned folder")
        }
        let seconds: Double
        if let value = input["maxDurationSeconds"] {
            seconds = try finiteDouble(value, "maxDurationSeconds")
            guard seconds > 0 else { throw HelperError("bad_request", "maxDurationSeconds must be positive") }
        } else {
            seconds = 1800
        }
        let timeout = min(seconds, 3600)
        let recordings = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent("Recordings", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        } catch {
            throw HelperError("audio_failed", "could not create the Juno Recordings folder: \(error.localizedDescription)")
        }
        let identifier = UUID().uuidString.lowercased()
        let path = recordings.appendingPathComponent("\(identifier).caf").path
        let recorder = try SystemAudioRecorder(recordingId: identifier, path: path, timeout: timeout)
        do {
            try await recorder.startStream()
        } catch {
            try? FileManager.default.removeItem(atPath: path)
            throw error
        }
        return (recorder.initial, recorder, timeout)
    }

    @available(macOS 13.0, *)
    private func startStream() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let displayID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw HelperError("audio_failed", "the primary display is unavailable for system audio capture")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        self.stream = stream
        do {
            try await stream.startCapture()
        } catch {
            self.stream = nil
            throw HelperError("audio_failed", "ScreenCaptureKit could not start system audio: \(error.localizedDescription)")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, failure == nil else { return }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description) else {
            fail("ScreenCaptureKit delivered system audio without a PCM format")
            return
        }
        let incoming = AVAudioFormat(streamDescription: streamDescription)
        guard let incoming, incoming.sampleRate == format.sampleRate, incoming.channelCount == format.channelCount else {
            fail("system audio did not match the helper's 48 kHz stereo PCM format")
            return
        }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
            fail("the helper could not allocate an audio buffer")
            return
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: buffer.mutableAudioBufferList
        )
        guard status == noErr else {
            fail("system audio could not be decoded (OSStatus \(status))")
            return
        }
        do {
            try file?.write(from: buffer)
        } catch {
            fail("could not write the system audio recording: \(error.localizedDescription)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("ScreenCaptureKit stopped system audio: \(error.localizedDescription)")
    }

    func finish(reason: String, failure: String?) async -> [String: Any] {
        let alreadyFinished = claimFinish()

        if !alreadyFinished {
            if let stream {
                try? await stream.stopCapture()
            }
            audioQueue.sync {
                self.file = nil
            }
            stream = nil
        }
        let failure = failure ?? self.failure
        var result: [String: Any] = [
            "ok": failure == nil,
            "recordingId": recordingId,
            "path": path,
            "state": failure == nil ? "stopped" : "failed",
            "durationSeconds": Date().timeIntervalSince(startedAt),
            "reason": reason,
        ]
        if let failure {
            result["error"] = ["code": "audio_failed", "message": failure]
        }
        return result
    }

    private func claimFinish() -> Bool {
        finishLock.lock()
        defer { finishLock.unlock() }
        let alreadyFinished = finished
        finished = true
        return alreadyFinished
    }

    private func fail(_ message: String) {
        guard failure == nil else { return }
        failure = message
        onFailure?(message)
    }
}
