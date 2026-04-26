import Foundation

// Response from /v1/verdict. Mirrors src/types.ts + services/verdict.ts on
// the backend. Decodable for JSON wire format.

public struct VerdictResponse: Codable, Hashable, Sendable {
  public let number: String
  public let trustScore: Int
  public let verdict: Verdict
  public let summary: String
  public let userMessage: String?
  public let displayColor: String?
  public let recommendedAction: String?
  public let evidence: [Evidence]
  public let signals: Signals
  /// "Who is this?" enrichment — caller name, carrier, line type,
  /// spoofability. Null when no provider is configured server-side.
  public let publicInfo: PublicPhoneInfo?
  public let latencyMs: Int?
  public let freshnessSeconds: Int?
  public let scoreVersion: Int?
  public let cached: Bool?

  enum CodingKeys: String, CodingKey {
    case number
    case trustScore = "trust_score"
    case verdict
    case summary
    case userMessage = "user_message"
    case displayColor = "display_color"
    case recommendedAction = "recommended_action"
    case evidence
    case signals
    case publicInfo = "public_info"
    case latencyMs = "latency_ms"
    case freshnessSeconds = "freshness_seconds"
    case scoreVersion = "score_version"
    case cached
  }

  public struct PublicPhoneInfo: Codable, Hashable, Sendable {
    public let ownerName: String?
    public let lineType: String   // mobile | landline | voip | toll_free | premium | unknown
    public let carrierName: String?
    public let countryCode: String?
    public let city: String?
    public let stateCode: String?
    public let isSpoofable: Bool
    /// Carrier + line_type match a known burner/disposable VoIP service
    /// (Google Voice, TextNow, Hushed, etc.) — treat caller ID with
    /// heavy skepticism.
    public let isLikelyBurner: Bool
    /// Country code is outside +1 — unexpected international call.
    public let isOverseas: Bool
    /// Human label for the burner service when recognized ("Google
    /// Voice", "TextNow", etc.). null when it's generic VoIP.
    public let burnerService: String?
    public let spamRiskScore: Int?
    public let sources: [String]

    enum CodingKeys: String, CodingKey {
      case ownerName = "owner_name"
      case lineType = "line_type"
      case carrierName = "carrier_name"
      case countryCode = "country_code"
      case city
      case stateCode = "state_code"
      case isSpoofable = "is_spoofable"
      case isLikelyBurner = "is_likely_burner"
      case isOverseas = "is_overseas"
      case burnerService = "burner_service"
      case spamRiskScore = "spam_risk_score"
      case sources
    }

    public var displayLineType: String {
      switch lineType {
      case "mobile": return "Mobile"
      case "landline": return "Landline"
      case "voip": return "VoIP"
      case "toll_free": return "Toll-free"
      case "premium": return "Premium rate"
      default: return "Unknown line type"
      }
    }

    public var hasAnyInfo: Bool {
      ownerName != nil || carrierName != nil || city != nil
        || isSpoofable || isLikelyBurner || isOverseas
    }
  }

  public enum Verdict: String, Codable, Sendable, CaseIterable {
    case trusted
    case unknown
    case suspicious
    case likelySpoof = "likely_spoof"
    case spoofRiskHigh = "spoof_risk_high"

    // Forward-compatible decoder: any unknown verdict string (from a
    // future server that adds a new band like "questionable") decodes
    // to .unknown instead of crashing the whole response. We'd rather
    // the user see "unknown" than a blank screen.
    public init(from decoder: Decoder) throws {
      let raw = try decoder.singleValueContainer().decode(String.self)
      self = Verdict(rawValue: raw) ?? .unknown
    }
  }

  public struct Evidence: Codable, Hashable, Sendable {
    public let source: String
    public let url: String?
    public let snippet: String?
    public let date: String?
    public let sentiment: String?
    public let weight: Double
  }

  public struct Signals: Codable, Hashable, Sendable {
    public let mentionCount30d: Int?
    public let mentionCountAll: Int?
    public let negativeSentimentRatio: Double?
    public let complaintSources: Int?
    public let firstSeen: String?
    public let lastSeen: String?
    public let stirShakenAttestation: String?
    public let carrier: String?
    public let lineType: String?
    public let numberAgeDays: Int?
    public let businessMatch: BusinessMatch?
    public let spoofReports30d: Int?

    enum CodingKeys: String, CodingKey {
      case mentionCount30d = "mention_count_30d"
      case mentionCountAll = "mention_count_all"
      case negativeSentimentRatio = "negative_sentiment_ratio"
      case complaintSources = "complaint_sources"
      case firstSeen = "first_seen"
      case lastSeen = "last_seen"
      case stirShakenAttestation = "stir_shaken_attestation"
      case carrier
      case lineType = "line_type"
      case numberAgeDays = "number_age_days"
      case businessMatch = "business_match"
      case spoofReports30d = "spoof_reports_30d"
    }
  }

  public struct BusinessMatch: Codable, Hashable, Sendable {
    public let name: String
    public let category: String
    public let verified: Bool
  }
}

public struct AuthTokenResponse: Codable, Sendable {
  public let token: String
  public let userId: String
  public let tier: String

  enum CodingKeys: String, CodingKey {
    case token
    case userId = "user_id"
    case tier
  }
}

public struct SubscriptionStatus: Codable, Sendable, Equatable {
  public let tier: Tier
  public let active: Bool
  public let subscription: ActiveSubscription?
  // Server-assigned UUID used as Product.purchase(options:
  // [.appAccountToken(_)]) so Apple can tie the StoreKit transaction to
  // our user row (prevents account-sharing purchase replay). Nil on
  // first launch before the backend has seen this device.
  public let appAccountToken: String?

  enum CodingKeys: String, CodingKey {
    case tier
    case active
    case subscription
    case appAccountToken = "app_account_token"
  }

  public enum Tier: String, Codable, Sendable {
    case pending
    case pro
    case expired
    case cancelled
  }

  public struct ActiveSubscription: Codable, Sendable, Equatable {
    public let currentPeriodEnd: String
    public let status: String
    public let provider: String
    public let providerProductId: String

    enum CodingKeys: String, CodingKey {
      case currentPeriodEnd = "current_period_end"
      case status
      case provider
      case providerProductId = "provider_product_id"
    }
  }
}

public struct AppleVerifyResponse: Codable, Sendable {
  public let tier: SubscriptionStatus.Tier
  public let currentPeriodEnd: String

  enum CodingKeys: String, CodingKey {
    case tier
    case currentPeriodEnd = "current_period_end"
  }
}

/// Response from `PATCH /v1/users/me`. `ok` is the server's acknowledgement;
/// `phoneNumber` echoes back the normalized (or null, if cleared) phone so
/// the client can cache the canonical value without re-fetching.
public struct UpdateMeResponse: Codable, Sendable {
  public let ok: Bool
  public let phoneNumber: String?

  enum CodingKeys: String, CodingKey {
    case ok
    case phoneNumber = "phone_number"
  }
}

public struct FamilyInviteResponse: Codable, Sendable {
  public let code: String
  public let label: String?
  public let expiresAt: String
  public let shareMessage: String

  enum CodingKeys: String, CodingKey {
    case code
    case label
    case expiresAt = "expires_at"
    case shareMessage = "share_message"
  }
}

public struct FamilyAcceptResponse: Codable, Sendable {
  public let familyPlanId: String
  public let tier: SubscriptionStatus.Tier
  public let joinedAt: String

  enum CodingKeys: String, CodingKey {
    case familyPlanId = "family_plan_id"
    case tier
    case joinedAt = "joined_at"
  }
}

public struct RecoverySession: Codable, Sendable, Equatable, Identifiable {
  public let session: Session
  public let steps: [Step]

  public var id: String { session.id }

  public struct Session: Codable, Sendable, Equatable {
    public let id: String
    public let scamNumber: String?
    public let scamType: String
    public let amountLostUsd: Double?
    public let description: String?
    public let status: Status
    /// "recovery" (default) or "triage" (pre-loss "is this a scam?" chat).
    public let mode: String?
    /// Set when a triage session reaches a terminal resolution.
    public let resolvedAs: String?
    public let resolvedAt: String?
    public let startedAt: String
    public let completedAt: String?
    public let progress: Progress

    public var isTriage: Bool { mode == "triage" }

    enum CodingKeys: String, CodingKey {
      case id
      case scamNumber = "scam_number"
      case scamType = "scam_type"
      case amountLostUsd = "amount_lost_usd"
      case description
      case status
      case mode
      case resolvedAs = "resolved_as"
      case resolvedAt = "resolved_at"
      case startedAt = "started_at"
      case completedAt = "completed_at"
      case progress
    }
  }

  public enum Status: String, Codable, Sendable {
    case active
    case completed
    case abandoned
  }

  public struct Progress: Codable, Sendable, Equatable {
    public let total: Int
    public let completed: Int
    public let skipped: Int
  }

  public struct Step: Codable, Sendable, Equatable, Identifiable {
    public var id: String { stepKey }
    public let stepKey: String
    public let ordinal: Int
    public let title: String
    public let body: String
    public let ctaLabel: String?
    public let ctaUrl: String?
    public let phoneToCall: String?
    public let status: StepStatus
    public let completedAt: String?

    enum CodingKeys: String, CodingKey {
      case stepKey = "step_key"
      case ordinal
      case title
      case body
      case ctaLabel = "cta_label"
      case ctaUrl = "cta_url"
      case phoneToCall = "phone_to_call"
      case status
      case completedAt = "completed_at"
    }
  }

  public enum StepStatus: String, Codable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed
    case skipped
  }
}

public struct RecoveryActiveResponse: Codable, Sendable {
  public let active: Bool
  public let session: RecoverySession?
}

public enum ScamType: String, Codable, Sendable, CaseIterable, Identifiable {
  // Impersonation
  case bankImpersonation = "bank_impersonation"
  case bankEmployeeImpersonation = "bank_employee_impersonation"
  case irsImpersonation = "irs_impersonation"
  case irsRefundBait = "irs_refund_bait"
  case ssaImpersonation = "ssa_impersonation"
  case lawEnforcementImpersonation = "law_enforcement_impersonation"
  case fbiDeaImpersonation = "fbi_dea_impersonation"
  case uscisIceImpersonation = "uscis_ice_impersonation"
  case digitalArrest = "digital_arrest"
  case medicareImpersonation = "medicare_impersonation"
  case medicareAdvantageSwitch = "medicare_advantage_switch"
  case utilityShutoff = "utility_shutoff"
  // Tech / credential theft
  case techSupport = "tech_support"
  case fakeRefundScam = "fake_refund_scam"
  case appleIcloudLocked = "apple_icloud_locked"
  case googleAccountTakeover = "google_account_takeover"
  case simSwapPortOut = "sim_swap_port_out"
  case bankingAppPushBombing = "banking_app_push_bombing"
  case quishingQrPhishing = "quishing_qr_phishing"
  case clickfixMalware = "clickfix_malware"
  case coinbaseSupportSpoof = "coinbase_support_spoof"
  // Emotional
  case grandchildEmergency = "grandchild_emergency"
  case aiVoiceCloneFamily = "ai_voice_clone_family"
  case virtualKidnapping = "virtual_kidnapping"
  case sextortion
  case romanceScam = "romance_scam"
  case pigButchering = "pig_butchering"
  case parentTeacherSpoof = "parent_teacher_spoof"
  // Financial
  case zelleVenmoSupportScam = "zelle_venmo_support_scam"
  case bitcoinAtmScam = "bitcoin_atm_scam"
  case giftCardScam = "gift_card_scam"
  case investmentScam = "investment_scam"
  case cryptoScam = "crypto_scam"
  case brokerage401kPhishing = "brokerage_401k_phishing"
  case debtCollectionPhantom = "debt_collection_phantom"
  case carWarrantyExpiration = "car_warranty_expiration"
  case homeWarrantyScam = "home_warranty_scam"
  case subscriptionTrap = "subscription_trap"
  case advanceFeeInheritance = "advance_fee_inheritance"
  case lotterySweepstakes = "lottery_sweepstakes"
  // Services / property
  case employmentScam = "employment_scam"
  case rentalScam = "rental_scam"
  case timeshareResale = "timeshare_resale"
  case solarPanelScam = "solar_panel_scam"
  case movingCompanyHostage = "moving_company_hostage"
  case homeRepairStormChaser = "home_repair_storm_chaser"
  case funeralCremationScam = "funeral_cremation_scam"
  case petScam = "pet_scam"
  // Health / benefits / education
  case studentLoanForgiveness = "student_loan_forgiveness"
  case veteransBenefitsBuyout = "veterans_benefits_buyout"
  case affordableCareActScam = "affordable_care_act_scam"
  case taxPrepIdentityTheft = "tax_prep_identity_theft"
  // Civic / seasonal
  case charityScam = "charity_scam"
  case politicalDonationScamPac = "political_donation_scam_pac"
  case censusSurveyScam = "census_survey_scam"
  case femaDisasterReliefFraud = "fema_disaster_relief_fraud"
  // Text / smishing
  case packageRedelivery = "package_redelivery"
  case unpaidToll = "unpaid_toll"
  // Re-victimization
  case recoveryScamSecondary = "recovery_scam_secondary"
  case generic

  public var id: String { rawValue }

  public var displayName: String {
    switch self {
    case .bankImpersonation:           return "Bank or credit card"
    case .bankEmployeeImpersonation:   return "Your bank's 'fraud team'"
    case .irsImpersonation:            return "IRS / taxes"
    case .irsRefundBait:               return "Fake IRS refund"
    case .ssaImpersonation:            return "Social Security"
    case .lawEnforcementImpersonation: return "Fake police or warrant"
    case .fbiDeaImpersonation:         return "Fake FBI / DEA"
    case .uscisIceImpersonation:       return "Fake ICE / immigration"
    case .digitalArrest:               return "Video-call 'digital arrest'"
    case .medicareImpersonation:       return "Medicare impersonation"
    case .medicareAdvantageSwitch:     return "Medicare Advantage switch"
    case .utilityShutoff:              return "Utility shutoff threat"
    case .techSupport:                 return "Tech support / computer"
    case .fakeRefundScam:              return "Fake refund (Geek Squad / Norton)"
    case .appleIcloudLocked:           return "Apple ID / iCloud locked"
    case .googleAccountTakeover:       return "Google account takeover"
    case .simSwapPortOut:              return "SIM swap / port-out"
    case .bankingAppPushBombing:       return "Bank MFA push bombing"
    case .quishingQrPhishing:          return "QR-code phishing (quishing)"
    case .clickfixMalware:             return "ClickFix / fake CAPTCHA"
    case .coinbaseSupportSpoof:        return "Fake Coinbase support"
    case .grandchildEmergency:         return "Grandchild in trouble"
    case .aiVoiceCloneFamily:          return "AI voice clone of family"
    case .virtualKidnapping:           return "Virtual kidnapping"
    case .sextortion:                  return "Sextortion"
    case .romanceScam:                 return "Romance / relationship"
    case .pigButchering:               return "Pig-butchering (crypto romance)"
    case .parentTeacherSpoof:          return "Fake school / teacher call"
    case .zelleVenmoSupportScam:       return "Zelle / Venmo / Cash App"
    case .bitcoinAtmScam:              return "Bitcoin ATM scam"
    case .giftCardScam:                return "Gift card demand"
    case .investmentScam:              return "Investment scheme"
    case .cryptoScam:                  return "Crypto / wallet"
    case .brokerage401kPhishing:       return "Brokerage / 401(k) phishing"
    case .debtCollectionPhantom:       return "Phantom debt collection"
    case .carWarrantyExpiration:       return "Car warranty robocall"
    case .homeWarrantyScam:            return "Home warranty scam"
    case .subscriptionTrap:            return "Subscription trap"
    case .advanceFeeInheritance:       return "Inheritance / advance fee"
    case .lotterySweepstakes:          return "Lottery / sweepstakes"
    case .employmentScam:              return "Fake job offer"
    case .rentalScam:                  return "Rental listing"
    case .timeshareResale:             return "Timeshare resale"
    case .solarPanelScam:              return "Solar panel scam"
    case .movingCompanyHostage:        return "Moving hostage extortion"
    case .homeRepairStormChaser:       return "Storm-chaser home repair"
    case .funeralCremationScam:        return "Funeral / cremation"
    case .petScam:                     return "Pet adoption scam"
    case .studentLoanForgiveness:      return "Student loan forgiveness"
    case .veteransBenefitsBuyout:      return "VA benefits buyout"
    case .affordableCareActScam:       return "ACA / health insurance"
    case .taxPrepIdentityTheft:        return "Fake tax preparer"
    case .charityScam:                 return "Fake charity"
    case .politicalDonationScamPac:    return "Scam PAC / political"
    case .censusSurveyScam:            return "Fake Census / survey"
    case .femaDisasterReliefFraud:     return "FEMA / disaster relief"
    case .packageRedelivery:           return "Package redelivery"
    case .unpaidToll:                  return "Unpaid toll"
    case .recoveryScamSecondary:       return "Fake 'recovery' follow-up"
    case .generic:                     return "Something else"
    }
  }

  public var systemIcon: String {
    switch self {
    case .bankImpersonation:           return "building.columns.fill"
    case .bankEmployeeImpersonation:   return "person.badge.shield.checkmark.fill"
    case .irsImpersonation:            return "building.2.fill"
    case .irsRefundBait:               return "dollarsign.arrow.circlepath"
    case .ssaImpersonation:            return "person.text.rectangle.fill"
    case .lawEnforcementImpersonation: return "shield.slash.fill"
    case .fbiDeaImpersonation:         return "shield.lefthalf.filled.slash"
    case .uscisIceImpersonation:       return "airplane.departure"
    case .digitalArrest:                return "video.slash.fill"
    case .medicareImpersonation:       return "cross.case.fill"
    case .medicareAdvantageSwitch:     return "arrow.triangle.2.circlepath"
    case .utilityShutoff:              return "bolt.slash.fill"
    case .techSupport:                 return "desktopcomputer.trianglebadge.exclamationmark"
    case .fakeRefundScam:              return "arrow.counterclockwise.circle.fill"
    case .appleIcloudLocked:           return "lock.icloud.fill"
    case .googleAccountTakeover:       return "g.circle.fill"
    case .simSwapPortOut:              return "simcard.2.fill"
    case .bankingAppPushBombing:       return "app.badge.fill"
    case .quishingQrPhishing:          return "qrcode.viewfinder"
    case .clickfixMalware:             return "terminal.fill"
    case .coinbaseSupportSpoof:        return "bitcoinsign.circle.trianglebadge.exclamationmark"
    case .grandchildEmergency:         return "person.crop.circle.badge.exclamationmark"
    case .aiVoiceCloneFamily:          return "waveform.badge.exclamationmark"
    case .virtualKidnapping:           return "exclamationmark.bubble.fill"
    case .sextortion:                  return "eye.slash.fill"
    case .romanceScam:                 return "heart.slash.fill"
    case .pigButchering:               return "chart.line.downtrend.xyaxis.circle.fill"
    case .parentTeacherSpoof:          return "figure.and.child.holdinghands"
    case .zelleVenmoSupportScam:       return "dollarsign.square.fill"
    case .bitcoinAtmScam:              return "bitcoinsign.circle"
    case .giftCardScam:                return "giftcard.fill"
    case .investmentScam:              return "chart.line.downtrend.xyaxis"
    case .cryptoScam:                  return "bitcoinsign.circle.fill"
    case .brokerage401kPhishing:       return "chart.pie.fill"
    case .debtCollectionPhantom:       return "creditcard.trianglebadge.exclamationmark"
    case .carWarrantyExpiration:       return "car.fill"
    case .homeWarrantyScam:            return "house.lodge.fill"
    case .subscriptionTrap:            return "arrow.triangle.2.circlepath.circle"
    case .advanceFeeInheritance:       return "envelope.open.badge.clock"
    case .lotterySweepstakes:          return "sparkles"
    case .employmentScam:              return "briefcase.fill"
    case .rentalScam:                  return "house.fill"
    case .timeshareResale:             return "building.2.crop.circle"
    case .solarPanelScam:              return "sun.max.trianglebadge.exclamationmark.fill"
    case .movingCompanyHostage:        return "shippingbox.and.arrow.backward.fill"
    case .homeRepairStormChaser:       return "hammer.fill"
    case .funeralCremationScam:        return "staroflife.fill"
    case .petScam:                     return "pawprint.fill"
    case .studentLoanForgiveness:      return "graduationcap.fill"
    case .veteransBenefitsBuyout:      return "flag.fill"
    case .affordableCareActScam:       return "heart.text.clipboard.fill"
    case .taxPrepIdentityTheft:        return "doc.text.magnifyingglass"
    case .charityScam:                 return "heart.text.square.fill"
    case .politicalDonationScamPac:    return "checkmark.seal.trianglebadge.exclamationmark"
    case .censusSurveyScam:            return "list.clipboard.fill"
    case .femaDisasterReliefFraud:     return "tornado"
    case .packageRedelivery:           return "shippingbox.fill"
    case .unpaidToll:                  return "road.lanes"
    case .recoveryScamSecondary:       return "arrow.uturn.backward.circle.fill"
    case .generic:                     return "questionmark.circle.fill"
    }
  }
}

public struct FamilyStatus: Codable, Sendable, Equatable {
  public let onPlan: Bool
  public let role: Role?
  public let plan: Plan?
  public let members: [Member]
  public let pendingInvites: [PendingInvite]

  public init(
    onPlan: Bool, role: Role? = nil, plan: Plan? = nil,
    members: [Member] = [], pendingInvites: [PendingInvite] = []
  ) {
    self.onPlan = onPlan
    self.role = role
    self.plan = plan
    self.members = members
    self.pendingInvites = pendingInvites
  }

  enum CodingKeys: String, CodingKey {
    case onPlan = "on_plan"
    case role
    case plan
    case members
    case pendingInvites = "pending_invites"
  }

  public enum Role: String, Codable, Sendable {
    case owner
    case member
  }

  public struct Plan: Codable, Sendable, Equatable {
    public let id: String
    public let ownerUserId: String
    public let includedLines: Int
    public let addonLines: Int
    public let capacity: Int
    public let seatsUsed: Int
    public let seatsAvailable: Int
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
      case id
      case ownerUserId = "owner_user_id"
      case includedLines = "included_lines"
      case addonLines = "addon_lines"
      case capacity
      case seatsUsed = "seats_used"
      case seatsAvailable = "seats_available"
      case createdAt = "created_at"
    }
  }

  public struct Member: Codable, Sendable, Equatable, Identifiable {
    public var id: String { userId }
    public let userId: String
    public let role: Role
    public let label: String?
    public let displayName: String?
    public let addedAt: String
    public let isYou: Bool

    enum CodingKeys: String, CodingKey {
      case userId = "user_id"
      case role
      case label
      case displayName = "display_name"
      case addedAt = "added_at"
      case isYou = "is_you"
    }
  }

  public struct PendingInvite: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let code: String
    public let label: String?
    public let expiresAt: String
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
      case id
      case code
      case label
      case expiresAt = "expires_at"
      case createdAt = "created_at"
    }
  }
}

public struct APIErrorResponse: Codable, Sendable {
  public let error: String
  public let message: String?
}

public enum APIError: Error, LocalizedError {
  case badStatus(Int, String?)
  case invalidResponse
  case notAuthenticated
  case decoding(Error)
  case transport(Error)

  public var errorDescription: String? {
    switch self {
    case .badStatus(let code, let msg):
      return msg.map { "\($0) (\(code))" } ?? "Request failed (\(code))"
    case .invalidResponse: return "Unexpected response from server"
    case .notAuthenticated: return "Please sign in again"
    case .decoding(let err): return "Decoding error: \(err.localizedDescription)"
    case .transport(let err): return err.localizedDescription
    }
  }
}

// MARK: - Guardian safe-word challenge
//
// Response body from `POST /v1/guardian/challenge`. Backend returns an
// opaque 403 `challenge_not_available` on failure (safe-word pairing
// absent, rate-limited, subject isn't on the caller's plan — all mapped
// to the same surface so a bad actor can't probe who has pairings).
// iOS translates that single server signal into a gentle explainer in
// `SafeWordChallengeInitiateSheet`.
public struct SafeWordChallengeCreated: Decodable, Sendable {
  public let id: String
  public let expiresAt: String

  enum CodingKeys: String, CodingKey {
    case id
    case expiresAt = "expires_at"
  }
}

// MARK: - Plan-owner transfer (appended 2026-04-19)
//
// Two-step owner-handoff. The owner POSTs /v1/family/transfer/request and
// gets back a raw token ONCE — we show it, let the user share, then drop
// it from memory. The receiving member POSTs /v1/family/transfer/accept
// with that token. Server stores only sha256(token), so re-showing the
// raw value after the sheet dismisses is impossible by design.

public struct OwnershipTransferCreated: Decodable, Sendable, Equatable {
  public let id: String
  public let token: String
  public let expiresAt: String

  enum CodingKeys: String, CodingKey {
    case id
    case token
    case expiresAt = "expires_at"
  }
}

public struct OwnershipTransferAccepted: Decodable, Sendable, Equatable {
  public let accepted: Bool
  public let familyPlanId: String

  enum CodingKeys: String, CodingKey {
    case accepted
    case familyPlanId = "family_plan_id"
  }
}

// MARK: - Bulk crime reports (appended 2026-04-19)
//
// The aggregate-level IC3/FTC-ready bundles the backend's daily
// bulkCrimeReporter writes when ≥N users report the same scammer. A user
// "owns" a bulk report iff their recovery session id is in session_ids.
// We surface the aggregate facts (victim count, total loss window) plus
// FTC + IC3 narratives the user can paste into reportfraud.ftc.gov /
// ic3.gov.
//
// NOTE on shape: the backend /mine endpoint returns rows with fields like
// `distinct_users`, `scam_type`, `window_end_date`, `created_at` — no
// explicit `title` or `session_count`. We decode both the documented
// `session_count` name AND the backend's actual `distinct_users` name so
// a future rename on either side is a soft landing rather than a hard
// decode failure. `title` is decoded if present, otherwise the view
// synthesizes one from `window_end_date` / `scam_type`.

public struct BulkCrimeReportSummary: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String?
  public let createdAt: String
  public let sessionCount: Int
  public let windowEndDate: String?
  public let scamType: String?

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case createdAt = "created_at"
    case sessionCount = "session_count"
    case distinctUsers = "distinct_users"
    case windowEndDate = "window_end_date"
    case scamType = "scam_type"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    sessionCount =
      (try? c.decode(Int.self, forKey: .sessionCount))
      ?? (try? c.decode(Int.self, forKey: .distinctUsers))
      ?? 0
    windowEndDate = try c.decodeIfPresent(String.self, forKey: .windowEndDate)
    scamType = try c.decodeIfPresent(String.self, forKey: .scamType)
  }

  /// Row title. Prefers backend `title`, then "Crime report — {window}",
  /// then scam-type banner, then generic fallback. Used by the list row
  /// — never empty-string.
  public var displayTitle: String {
    if let t = title, !t.isEmpty { return t }
    if let window = windowEndDate { return "Crime report — \(window)" }
    if let scam = scamType, !scam.isEmpty {
      return "Crime report — \(scam.replacingOccurrences(of: "_", with: " "))"
    }
    return "Crime report"
  }
}

public struct BulkCrimeReportDetail: Decodable, Sendable, Equatable {
  public let id: String
  public let narrativeFtc: String
  public let narrativeIc3: String
  public let createdAt: String
  public let sessionCount: Int

  // The backend's /v1/recovery/bulk-reports/:id returns
  //   { report: { id, created_at, distinct_users, ... }, ftc, ic3 }
  // We flatten to a single struct at decode time. A flat fixture-shaped
  // response (`{ id, narrative_ftc, narrative_ic3, ... }`) is also
  // accepted so future API shape churn or unit-test mocks don't require
  // a re-ship of the client.
  enum OuterKeys: String, CodingKey {
    case report
    case ftc
    case ic3
    case id
    case narrativeFtc = "narrative_ftc"
    case narrativeIc3 = "narrative_ic3"
    case createdAt = "created_at"
    case sessionCount = "session_count"
    case distinctUsers = "distinct_users"
  }

  enum ReportKeys: String, CodingKey {
    case id
    case createdAt = "created_at"
    case sessionCount = "session_count"
    case distinctUsers = "distinct_users"
  }

  public init(from decoder: Decoder) throws {
    let outer = try decoder.container(keyedBy: OuterKeys.self)
    if outer.contains(.report) {
      let report = try outer.nestedContainer(keyedBy: ReportKeys.self, forKey: .report)
      id = try report.decode(String.self, forKey: .id)
      createdAt = try report.decode(String.self, forKey: .createdAt)
      sessionCount =
        (try? report.decode(Int.self, forKey: .sessionCount))
        ?? (try? report.decode(Int.self, forKey: .distinctUsers))
        ?? 0
      narrativeFtc = try outer.decode(String.self, forKey: .ftc)
      narrativeIc3 = try outer.decode(String.self, forKey: .ic3)
    } else {
      id = try outer.decode(String.self, forKey: .id)
      createdAt = try outer.decode(String.self, forKey: .createdAt)
      sessionCount =
        (try? outer.decode(Int.self, forKey: .sessionCount))
        ?? (try? outer.decode(Int.self, forKey: .distinctUsers))
        ?? 0
      narrativeFtc = try outer.decode(String.self, forKey: .narrativeFtc)
      narrativeIc3 = try outer.decode(String.self, forKey: .narrativeIc3)
    }
  }
}
