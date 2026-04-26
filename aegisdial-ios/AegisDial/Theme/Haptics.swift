import SwiftUI
import UIKit

// Thin wrapper on UIKit haptics. We avoid `.sensoryFeedback` in places we
// need finer control, but use it in SwiftUI views where we can.

enum AegisHaptic {
  case light
  case medium
  case heavy
  case soft
  case rigid
  case success
  case warning
  case error
  case selection

  func play() {
    switch self {
    case .light:
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case .medium:
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    case .heavy:
      UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    case .soft:
      UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    case .rigid:
      UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    case .success:
      UINotificationFeedbackGenerator().notificationOccurred(.success)
    case .warning:
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
    case .error:
      UINotificationFeedbackGenerator().notificationOccurred(.error)
    case .selection:
      UISelectionFeedbackGenerator().selectionChanged()
    }
  }
}
