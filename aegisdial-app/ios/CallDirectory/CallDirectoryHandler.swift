import Foundation
import CallKit

/// AegisDial Call Directory extension.
///
/// iOS calls `beginRequest` whenever the system needs to reload caller
/// ID labels and blocked numbers. We read from the App Group shared
/// container where the main Flutter app writes:
///   - Blocked numbers (CXCallDirectoryPhoneNumber, Int64 format)
///   - Labeled numbers ("Likely Scam", "AegisDial: Fraud Risk", etc.)
///
/// The user enables this in:
///   Settings > Apps > Phone > Call Blocking & Identification > AegisDial
///
/// To trigger a reload from the main app after new data is written:
///   CXCallDirectoryManager.sharedInstance.reloadExtension(...)
final class CallDirectoryHandler: CXCallDirectoryProvider {

  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    context.delegate = self

    // Load data from shared App Group container
    let data = SharedCallData.load()

    // Add blocked numbers (must be sorted ascending)
    let blocked = data.blockedNumbers.sorted()
    for number in blocked {
      context.addBlockingEntry(withNextSequentialPhoneNumber: number)
    }

    // Add identification labels (must be sorted ascending by number)
    let labeled = data.labeledNumbers.sorted { $0.number < $1.number }
    for entry in labeled {
      context.addIdentificationEntry(
        withNextSequentialPhoneNumber: entry.number,
        label: entry.label
      )
    }

    context.completeRequest()
  }
}

extension CallDirectoryHandler: CXCallDirectoryExtensionContextDelegate {
  func requestFailed(for extensionContext: CXCallDirectoryExtensionContext,
                     withError error: Error) {
    // Log to shared container so the main app can surface diagnostics
    let defaults = UserDefaults(suiteName: SharedCallData.suiteName)
    defaults?.set(error.localizedDescription, forKey: "aegis_calldir_last_error")
    defaults?.set(Date().timeIntervalSince1970, forKey: "aegis_calldir_last_error_ts")
  }
}

// MARK: - Shared data

struct LabeledNumber {
  let number: CXCallDirectoryPhoneNumber // Int64 in E.164 format (e.g. 18005551234)
  let label: String
}

enum SharedCallData {
  static let suiteName = "group.com.aegisdial.app"
  private static let blockedKey = "aegis_blocked_numbers"
  private static let labeledKey = "aegis_labeled_numbers"

  struct LoadedData {
    let blockedNumbers: [CXCallDirectoryPhoneNumber]
    let labeledNumbers: [LabeledNumber]
  }

  static func load() -> LoadedData {
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      return LoadedData(blockedNumbers: [], labeledNumbers: [])
    }

    // Blocked numbers stored as [Int64] (E.164 without the +)
    let blocked: [CXCallDirectoryPhoneNumber]
    if let arr = defaults.array(forKey: blockedKey) as? [Int64] {
      blocked = arr
    } else if let arr = defaults.array(forKey: blockedKey) as? [NSNumber] {
      blocked = arr.map { $0.int64Value }
    } else {
      blocked = []
    }

    // Labeled numbers stored as [[String: Any]] with "n" (number) and "l" (label)
    var labeled: [LabeledNumber] = []
    if let arr = defaults.array(forKey: labeledKey) as? [[String: Any]] {
      for entry in arr {
        guard let num = (entry["n"] as? NSNumber)?.int64Value,
              let label = entry["l"] as? String else { continue }
        labeled.append(LabeledNumber(number: num, label: label))
      }
    }

    // Always include built-in known scam numbers
    labeled.append(contentsOf: Self.builtInLabels)

    return LoadedData(blockedNumbers: blocked, labeledNumbers: labeled)
  }

  /// Built-in scam numbers with labels. These show up immediately
  /// without the user having to do anything — common robocall / scam
  /// numbers from FTC complaint databases.
  ///
  /// Numbers are in E.164 Int64 format: country code + number, no +.
  /// The main app's backend can push additional numbers via the shared
  /// container; these are the baseline that ships with the app.
  static let builtInLabels: [LabeledNumber] = [
    // These are placeholder entries. In production, the backend pushes
    // real scam numbers from community reports + FTC databases. The
    // extension works with zero built-in entries — it just means caller
    // ID labels only appear after the first backend sync.
  ]
}
