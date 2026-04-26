import Foundation
import IdentityLookup

// ILMessageFilterExtension — iOS's built-in SMS/MMS/RCS junk filter hook.
// The system calls `handle(_:context:completion:)` for every message
// from a sender that's NOT in the user's Contacts. We:
//   1. Run a fast on-device pass using a small keyword set.
//   2. If we need more signal, defer to network — the OS performs the
//      HTTPS POST to the URL configured in
//      NSExtension → NSExtensionAttributes → ILMessageFilterExtensionNetworkURL
//      (mapped to /v1/sms-classify).
//   3. Parse the backend's JSON and map to MessageFilterAction.
//
// iOS 18 adds MMS + RCS coverage via ILMessageFilterCapabilitiesQueryHandling —
// the system first asks which sub-actions we support, then routes messages
// accordingly.

final class MessageFilterExtension: ILMessageFilterExtension {}

// MARK: - Capabilities (iOS 18+ MMS + RCS)

extension MessageFilterExtension: ILMessageFilterCapabilitiesQueryHandling {
  func handle(
    _ capabilitiesQueryRequest: ILMessageFilterCapabilitiesQueryRequest,
    context: ILMessageFilterExtensionContext,
    completion: @escaping (ILMessageFilterCapabilitiesQueryResponse) -> Void
  ) {
    let response = ILMessageFilterCapabilitiesQueryResponse()
    response.transactionalSubActions = [
      ILMessageFilterSubAction.transactionalOrders,
      ILMessageFilterSubAction.transactionalFinance,
      ILMessageFilterSubAction.transactionalReminders,
      ILMessageFilterSubAction.transactionalHealth,
      ILMessageFilterSubAction.transactionalCarriers,
      ILMessageFilterSubAction.transactionalRewards,
      ILMessageFilterSubAction.transactionalPublicServices,
    ]
    response.promotionalSubActions = [
      ILMessageFilterSubAction.promotionalOffers,
      ILMessageFilterSubAction.promotionalCoupons,
    ]
    completion(response)
  }
}

// MARK: - Per-message query

extension MessageFilterExtension: ILMessageFilterQueryHandling {
  func handle(
    _ queryRequest: ILMessageFilterQueryRequest,
    context: ILMessageFilterExtensionContext,
    completion: @escaping (ILMessageFilterQueryResponse) -> Void
  ) {
    let offline = offlineAction(sender: queryRequest.sender, text: queryRequest.messageBody)

    // If offline says "clearly junk" or "clearly transactional", skip network.
    switch offline {
    case .junk:
      completion(response(action: .junk, subAction: ILMessageFilterSubAction.none))
      return
    case .allowKnownTransactional:
      completion(response(action: .allow, subAction: .transactionalReminders))
      return
    default:
      break
    }

    context.deferQueryRequestToNetwork { networkResponse, error in
      if let error {
        NSLog("AegisDial SMS filter: network defer failed: \(error.localizedDescription)")
        completion(self.response(action: .allow, subAction: ILMessageFilterSubAction.none))
        return
      }
      guard
        let resp = networkResponse,
        let http = resp.urlResponse as HTTPURLResponse?,
        (200..<300).contains(http.statusCode)
      else {
        completion(self.response(action: .allow, subAction: ILMessageFilterSubAction.none))
        return
      }
      let (action, subAction) = self.parseBackendDecision(resp.data)
      completion(self.response(action: action, subAction: subAction))
    }
  }

  // MARK: - Offline triage
  //
  // Tiny subset of the backend phrase catalog for when the network defer
  // would be overkill. Keeps clear scams off the wire.

  private enum OfflineVerdict {
    case junk
    case allowKnownTransactional
    case needsNetwork
  }

  private func offlineAction(sender: String?, text: String?) -> OfflineVerdict {
    guard let text = text?.lowercased(), !text.isEmpty else { return .needsNetwork }

    let junkPatterns: [String] = [
      "usps.*redeliver", "ups.*delivery.*failed", "package.*cannot be delivered",
      "unpaid toll", "e-?zpass.*owe", "apple id.*(locked|suspended)",
      "icloud.*(locked|suspended)", "account.*(locked|suspended|restricted).*(verify|click|tap)",
      "claim.*(prize|gift card|reward)", "you.?ve won.*(gift|prize|lottery)",
    ]
    for p in junkPatterns {
      if text.range(of: p, options: .regularExpression) != nil { return .junk }
    }

    // 2FA / OTP from numeric short codes (3–7 digit sender IDs globally) —
    // almost always legit; let them through so the lock-screen autofill works.
    if let sender,
       sender.range(of: #"^\d{3,7}$"#, options: .regularExpression) != nil,
       text.range(of: #"(verification code|security code|confirmation code|one.?time|your code is)"#,
                  options: .regularExpression) != nil {
      return .allowKnownTransactional
    }

    return .needsNetwork
  }

  // MARK: - Backend response mapping

  private struct BackendDecision: Decodable {
    let action: String
    let risk_score: Int?
    let risk_level: String?
    let reason: String?
  }

  private func parseBackendDecision(
    _ data: Data
  ) -> (ILMessageFilterAction, ILMessageFilterSubAction) {
    guard let decoded = try? JSONDecoder().decode(BackendDecision.self, from: data) else {
      return (.allow, ILMessageFilterSubAction.none)
    }
    switch decoded.action {
    case "junk":
      return (.junk, ILMessageFilterSubAction.none)
    case "promotion":
      return (.promotion, .promotionalOffers)
    case "transaction":
      return (.allow, .transactionalOrders)
    default:
      return (.allow, ILMessageFilterSubAction.none)
    }
  }

  private func response(
    action: ILMessageFilterAction,
    subAction: ILMessageFilterSubAction
  ) -> ILMessageFilterQueryResponse {
    let r = ILMessageFilterQueryResponse()
    r.action = action
    r.subAction = subAction
    return r
  }
}
