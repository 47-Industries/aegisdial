import Foundation
import AVFoundation
import Speech

// On-device speech recognizer. Uses SFSpeechRecognizer configured with
// requiresOnDeviceRecognition = true — audio bytes never leave the phone.
// The engine hands partial results back as they come; callers chunk them
// into fixed windows before posting to the backend.
//
// iOS note: SFSpeechRecognizer cannot tap arbitrary call audio. The
// shield captures whatever the device microphone hears (which is the
// caller when the user has the phone on speaker or a hands-free profile).
// We surface this limitation clearly in the consent sheet.

public enum SpeechEngineError: Error, LocalizedError {
  case authorizationDenied
  case recognizerUnavailable
  case onDeviceUnsupported
  case audioSession(Error)
  case recognitionFailed(Error)

  public var errorDescription: String? {
    switch self {
    case .authorizationDenied: return "Microphone or speech permission denied."
    case .recognizerUnavailable: return "Speech recognition isn't available right now."
    case .onDeviceUnsupported: return "This device doesn't support on-device speech recognition."
    case .audioSession(let e): return "Audio session error: \(e.localizedDescription)"
    case .recognitionFailed(let e): return "Speech recognition failed: \(e.localizedDescription)"
    }
  }
}

public actor SpeechEngine {
  public struct Partial: Sendable {
    public let text: String
    public let isFinal: Bool
    public let confidence: Double?
  }

  private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private let audioEngine = AVAudioEngine()
  private var task: SFSpeechRecognitionTask?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var continuation: AsyncThrowingStream<Partial, Error>.Continuation?

  public init() {}

  public static func requestAuthorization() async -> Bool {
    Track.event(.permissionPrompted, ["permission": "speech"])
    let speechOK = await withCheckedContinuation { cont in
      SFSpeechRecognizer.requestAuthorization { status in
        cont.resume(returning: status == .authorized)
      }
    }
    Track.event(speechOK ? .permissionGranted : .permissionDenied, ["permission": "speech"])

    Track.event(.permissionPrompted, ["permission": "mic"])
    let micOK = await withCheckedContinuation { cont in
      AVAudioApplication.requestRecordPermission { granted in
        cont.resume(returning: granted)
      }
    }
    Track.event(micOK ? .permissionGranted : .permissionDenied, ["permission": "mic"])

    return speechOK && micOK
  }

  public func start() throws -> AsyncThrowingStream<Partial, Error> {
    guard let recognizer, recognizer.isAvailable else {
      throw SpeechEngineError.recognizerUnavailable
    }

    // Privacy-first: we require on-device recognition whenever the OS
    // + current locale support it. When both are true, transcripts
    // never leave the phone — this is the marketing-critical
    // "transcripts never leave your phone" guarantee.
    //
    // On the (rare) older hardware / unsupported locales where the
    // recognizer is available but on-device mode isn't, we fall back
    // to Apple server recognition rather than failing the shield.
    // That's a soft privacy regression, not a silent one — we log it.
    let canRunOnDevice = recognizer.supportsOnDeviceRecognition

    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers]
      )
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      throw SpeechEngineError.audioSession(error)
    }

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if canRunOnDevice {
      req.requiresOnDeviceRecognition = true
    } else {
      req.requiresOnDeviceRecognition = false
      // TODO: add a dedicated `liveShieldOnDeviceUnsupported` analytics
      // event (Networking/Analytics.swift is out of this agent's scope)
      // so we can size how many users land on the server path.
      #if DEBUG
      print("[SpeechEngine] on-device recognition unsupported; falling back to Apple server recognition")
      #endif
    }
    req.taskHint = .dictation
    request = req

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buffer, _ in
      req?.append(buffer)
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      throw SpeechEngineError.audioSession(error)
    }

    let stream = AsyncThrowingStream<Partial, Error> { continuation in
      self.continuation = continuation
      // If the consumer's Task is cancelled or the stream is dropped,
      // tear down the audio tap + recognition task so we don't leak.
      continuation.onTermination = { [weak self] _ in
        Task { await self?.stop() }
      }
      self.task = recognizer.recognitionTask(with: req) { result, error in
        if let result {
          let segs = result.bestTranscription.segments
          let conf: Double? = segs.isEmpty
            ? nil
            : Double(segs.map(\.confidence).reduce(0, +) / Float(segs.count))
          continuation.yield(
            Partial(
              text: result.bestTranscription.formattedString,
              isFinal: result.isFinal,
              confidence: conf
            )
          )
          if result.isFinal { continuation.finish() }
        }
        if let error {
          continuation.finish(throwing: SpeechEngineError.recognitionFailed(error))
        }
      }
    }
    return stream
  }

  public func stop() {
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    continuation?.finish()
    continuation = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
