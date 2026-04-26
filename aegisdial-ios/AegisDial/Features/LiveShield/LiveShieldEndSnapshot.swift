import Foundation

// Snapshot handed to the parent view when Live Shield ends at high or
// critical risk. Parent uses this to:
//   - decide whether to show the Recovery handoff sheet (yes on crit,
//     optional prompt on high)
//   - prefill scam_type based on which category patterns fired during
//     the shielded call
//   - prefill scam_number from the peer E.164

public struct LiveShieldEndSnapshot: Hashable, Identifiable {
  public var id: String {
    "\(peerNumber ?? "unknown")-\(riskScore)-\(triggeredCategories.joined(separator: ","))"
  }
  public let peerNumber: String?
  public let riskScore: Int
  public let riskLevel: LiveShieldRiskLevel
  public let triggeredCategories: [String]

  /// Map the set of triggered scam-phrase categories to the best
  /// matching recovery scam_type. Order of checks matters — we pick
  /// the most specific match first. User can always change in the
  /// Recovery Start sheet.
  public var suggestedScamType: ScamType {
    let cats = Set(triggeredCategories)

    // Emergency-relative cluster — default to AI voice clone since
    // 2024+ deepfakes are the dominant pattern; user can switch to
    // grandchildEmergency or virtualKidnapping.
    if cats.contains("emergency_relative") { return .aiVoiceCloneFamily }

    // Remote-access opener — fake refund variant if paired with
    // payment, else standard tech support.
    if cats.contains("remote_access") {
      if cats.contains("payment_fraud") { return .fakeRefundScam }
      return .techSupport
    }

    if cats.contains("crypto_investment") { return .cryptoScam }

    if cats.contains("smishing_bait") {
      if cats.contains("payment_fraud") { return .giftCardScam }
      return .packageRedelivery
    }

    if cats.contains("impersonation_authority") { return .irsImpersonation }
    if cats.contains("impersonation_financial") { return .bankImpersonation }
    if cats.contains("payment_fraud")           { return .bankImpersonation }

    return .generic
  }
}
