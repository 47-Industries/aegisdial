import Foundation

// Minimal, explicit API client. One method per endpoint. Actor-isolated so
// the token and session handle can't be torn by concurrent callers. We avoid
// any general-purpose "route whatever" layer — each call site is typed.

public actor APIClient {
  public static let shared = APIClient()

  private let session: URLSession
  private var token: String?

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func setToken(_ token: String?) {
    self.token = token
  }

  // MARK: - Auth

  public func authApple(idToken: String, displayName: String?, dobYear: Int?) async throws -> AuthTokenResponse {
    var body: [String: Any] = [
      "id_token": idToken,
      "display_name": displayName as Any,
    ]
    if let dobYear { body["dob_year"] = dobYear }
    return try await post("/auth/apple", body: body, authenticated: false)
  }

  public func authEmailSignup(email: String, password: String, displayName: String?, dobYear: Int) async throws -> AuthTokenResponse {
    try await post(
      "/auth/email/signup",
      body: [
        "email": email,
        "password": password,
        "display_name": displayName as Any,
        "dob_year": dobYear,
      ],
      authenticated: false
    )
  }

  public func authEmailLogin(email: String, password: String) async throws -> AuthTokenResponse {
    try await post(
      "/auth/email/login",
      body: [
        "email": email,
        "password": password,
      ],
      authenticated: false
    )
  }

  // MARK: - Subscription

  public func subscriptionStatus() async throws -> SubscriptionStatus {
    try await get("/subscription/status", authenticated: true)
  }

  public func verifyAppleTransaction(
    jws: String,
    productId: String,
    expiresDateMs: Int64?,
    originalTransactionId: String?
  ) async throws -> AppleVerifyResponse {
    try await post(
      "/subscription/apple/verify",
      body: [
        "transaction_jws": jws,
        "product_id": productId,
        "expires_date_ms": expiresDateMs as Any,
        "original_transaction_id": originalTransactionId as Any,
      ],
      authenticated: true
    )
  }

  // MARK: - Family plan

  public func familyStatus() async throws -> FamilyStatus {
    try await get("/v1/family", authenticated: true)
  }

  public func createFamilyInvite(label: String?, contact: String?) async throws -> FamilyInviteResponse {
    try await post(
      "/v1/family/invite",
      body: [
        "label": label as Any,
        "invited_contact": contact as Any,
      ],
      authenticated: true
    )
  }

  public func acceptFamilyInvite(code: String) async throws -> FamilyAcceptResponse {
    try await post("/v1/family/accept", body: ["code": code], authenticated: true)
  }

  public func revokeFamilyInvite(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await delete("/v1/family/invite/\(id)", authenticated: true)
  }

  public func removeFamilyMember(userId: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await delete("/v1/family/member/\(userId)", authenticated: true)
  }

  // MARK: - Recovery Concierge

  public func startRecovery(
    scamNumber: String?,
    scamType: ScamType,
    amountLostUSD: Double?,
    description: String?
  ) async throws -> RecoverySession {
    try await post(
      "/v1/recovery/start",
      body: [
        "scam_number": scamNumber as Any,
        "scam_type": scamType.rawValue,
        "amount_lost_usd": amountLostUSD as Any,
        "description": description as Any,
      ],
      authenticated: true
    )
  }

  public func activeRecovery() async throws -> RecoveryActiveResponse {
    try await get("/v1/recovery/active", authenticated: true)
  }

  // "Check a suspicious text" analyzer — stateless paste-and-check.
  public struct TextAnalysisResult: Codable, Sendable {
    public let trustScore: Int
    public let verdict: String            // trusted | unknown | suspicious | likely_scam | definitely_scam
    public let verdictHeadline: String
    public let scamType: String?
    public let scamTypeDisplay: String?
    public let matchedPatterns: [MatchedPattern]
    public let redFlags: [String]
    public let playbook: String?
    public let whyItWorks: String?
    public let whatToDo: [String]
    public let urlFindings: [URLFinding]
    public let llmRefined: Bool

    public struct MatchedPattern: Codable, Sendable, Hashable {
      public let patternId: String
      public let category: String
      public let severity: Int
      public let matchedText: String
      enum CodingKeys: String, CodingKey {
        case patternId = "pattern_id"
        case category
        case severity
        case matchedText = "matched_text"
      }
    }

    public struct URLFinding: Codable, Sendable, Hashable {
      public let url: String
      public let isMalicious: Bool
      public let reason: String?
      enum CodingKeys: String, CodingKey {
        case url
        case isMalicious = "is_malicious"
        case reason
      }
    }

    enum CodingKeys: String, CodingKey {
      case trustScore = "trust_score"
      case verdict
      case verdictHeadline = "verdict_headline"
      case scamType = "scam_type"
      case scamTypeDisplay = "scam_type_display"
      case matchedPatterns = "matched_patterns"
      case redFlags = "red_flags"
      case playbook
      case whyItWorks = "why_it_works"
      case whatToDo = "what_to_do"
      case urlFindings = "url_findings"
      case llmRefined = "llm_refined"
    }
  }

  public func analyzeScamText(
    text: String,
    sender: String? = nil,
    anonymousId: String? = nil
  ) async throws -> TextAnalysisResult {
    // Anonymous-tolerant: attaches the bearer when the user is signed
    // in, omits it when they're not. Backend uses optionalAppUser and
    // applies the 3-day anonymous trial gate when no JWT is present.
    try await postOptionallyAuth(
      "/v1/recovery/analyze-text",
      body: [
        "text": text,
        "sender": sender as Any,
        "anonymous_id": anonymousId as Any,
      ]
    )
  }

  // Triage mode — "Is this a scam?" pre-loss session.
  public func startTriage(scamNumber: String?, description: String?) async throws -> RecoverySession {
    try await post(
      "/v1/recovery/triage/start",
      body: [
        "scam_number": scamNumber as Any,
        "description": description as Any,
      ],
      authenticated: true
    )
  }

  public enum TriageResolution: String {
    case scamConfirmedNoLoss = "scam_confirmed_no_loss"
    case convertedToRecovery = "converted_to_recovery"
    case notAScam = "not_a_scam"
    case unclear = "unclear"
  }

  /// Resolve a triage session. For `convertedToRecovery`, pass the
  /// confirmed scam type + optional amount so the server generates the
  /// full step playbook and kicks off guardian alerts.
  public func resolveTriage(
    sessionId: String,
    resolvedAs: TriageResolution,
    scamType: ScamType? = nil,
    amountLostUSD: Double? = nil,
    namedGuardianUserId: String? = nil
  ) async throws -> RecoverySession {
    var body: [String: Any] = ["resolved_as": resolvedAs.rawValue]
    if let scamType { body["scam_type"] = scamType.rawValue }
    if let amountLostUSD { body["amount_lost_usd"] = amountLostUSD }
    if let namedGuardianUserId { body["named_guardian_user_id"] = namedGuardianUserId }
    return try await post(
      "/v1/recovery/\(sessionId)/triage/resolve",
      body: body,
      authenticated: true
    )
  }

  public func recovery(id: String) async throws -> RecoverySession {
    try await get("/v1/recovery/\(id)", authenticated: true)
  }

  public func updateRecoveryStep(
    sessionId: String,
    stepKey: String,
    status: RecoverySession.StepStatus
  ) async throws -> RecoverySession {
    try await post(
      "/v1/recovery/\(sessionId)/step/\(stepKey)/status",
      body: ["status": status.rawValue],
      authenticated: true
    )
  }

  public func abandonRecovery(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/recovery/\(id)/abandon", body: [:], authenticated: true)
  }

  // MARK: - Recovery evidence locker

  public struct EvidenceItem: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let payload: [String: AnyCodable]
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
      case id, kind, payload
      case createdAt = "created_at"
    }
  }

  public func recoveryEvidenceList(sessionId: String) async throws -> [EvidenceItem] {
    struct Wrap: Decodable { let items: [EvidenceItem] }
    let resp: Wrap = try await get("/v1/recovery/\(sessionId)/evidence", authenticated: true)
    return resp.items
  }

  public func recoveryEvidenceAdd(
    sessionId: String, kind: String, payload: [String: Any]
  ) async throws -> EvidenceItem {
    try await post(
      "/v1/recovery/\(sessionId)/evidence",
      body: ["kind": kind, "payload": payload],
      authenticated: true
    )
  }

  public func recoveryEvidenceDelete(sessionId: String, evidenceId: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await delete(
      "/v1/recovery/\(sessionId)/evidence/\(evidenceId)",
      authenticated: true
    )
  }

  public func recoveryNotifyFamily(sessionId: String) async throws -> Int {
    struct Wrap: Decodable { let delivered: Int }
    let resp: Wrap = try await post(
      "/v1/recovery/\(sessionId)/notify-family",
      body: [:],
      authenticated: true
    )
    return resp.delivered
  }

  // MARK: - Recovery Companion (AI chat)

  public struct CompanionMessage: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let role: String         // "user" | "assistant"
    public let content: String
    public let crisisDetected: Bool
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
      case id, role, content
      case crisisDetected = "crisis_detected"
      case createdAt = "created_at"
    }
  }

  public struct CompanionReply: Codable, Sendable {
    public let reply: String
    public let crisisDetected: Bool

    enum CodingKeys: String, CodingKey {
      case reply
      case crisisDetected = "crisis_detected"
    }
  }

  public func companionMessages(sessionId: String) async throws -> [CompanionMessage] {
    struct Wrap: Decodable { let messages: [CompanionMessage] }
    let resp: Wrap = try await get("/v1/recovery/\(sessionId)/companion/messages", authenticated: true)
    return resp.messages
  }

  public func sendCompanionMessage(sessionId: String, message: String) async throws -> CompanionReply {
    try await post(
      "/v1/recovery/\(sessionId)/companion/message",
      body: ["message": message],
      authenticated: true
    )
  }

  // MARK: - Recovery outcome

  public func submitRecoveryOutcome(
    sessionId: String,
    recoveredAny: Bool?,
    recoveredCents: Int?,
    notes: String?,
    stepFeedback: [String: [String: Any]]?,
    moodBefore: Int?,
    moodAfter: Int?,
    toldFamily: Bool?,
    reportedToPolice: Bool?
  ) async throws {
    var body: [String: Any] = [:]
    if let recoveredAny { body["recovered_any"] = recoveredAny }
    if let recoveredCents { body["recovered_cents"] = recoveredCents }
    if let notes { body["notes"] = notes }
    if let stepFeedback { body["step_feedback"] = stepFeedback }
    if let moodBefore { body["mood_before"] = moodBefore }
    if let moodAfter { body["mood_after"] = moodAfter }
    if let toldFamily { body["told_family"] = toldFamily }
    if let reportedToPolice { body["reported_to_police"] = reportedToPolice }
    struct Wrap: Decodable { let ok: Bool }
    let _: Wrap = try await post(
      "/v1/recovery/\(sessionId)/outcome",
      body: body,
      authenticated: true
    )
  }

  // MARK: - Auto-populate + pre-filled reports

  public struct AutoPopulateSuggestion: Codable, Sendable {
    public let scamNumber: String?
    public let scamType: String
    public let callStartedAt: String
    public let riskLevel: String

    enum CodingKeys: String, CodingKey {
      case scamNumber = "scam_number"
      case scamType = "scam_type"
      case callStartedAt = "call_started_at"
      case riskLevel = "risk_level"
    }
  }

  public func recoveryAutoPopulate() async throws -> AutoPopulateSuggestion? {
    struct Wrap: Decodable { let suggestion: AutoPopulateSuggestion? }
    let resp: Wrap = try await get("/v1/recovery/auto-populate", authenticated: true)
    return resp.suggestion
  }

  public struct PrefilledReport: Codable, Sendable {
    public let agency: String
    public let url: String
    public let narrative: String
    public let fields: [ReportField]

    public struct ReportField: Codable, Sendable, Hashable {
      public let label: String
      public let value: String
    }
  }

  public func recoveryReportFtc(sessionId: String) async throws -> PrefilledReport {
    try await get("/v1/recovery/\(sessionId)/report/ftc", authenticated: true)
  }
  public func recoveryReportIc3(sessionId: String) async throws -> PrefilledReport {
    try await get("/v1/recovery/\(sessionId)/report/ic3", authenticated: true)
  }

  // MARK: - Bank directory

  public struct BankEntry: Codable, Hashable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let category: String
    public let fraudPhones: [String]
    public let notes: String?

    enum CodingKeys: String, CodingKey {
      case name, category
      case fraudPhones = "fraud_phones"
      case notes
    }
  }

  public func banksSearch(query q: String) async throws -> [BankEntry] {
    struct Wrap: Decodable { let banks: [BankEntry] }
    let path = "/v1/banks/search?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)"
    let resp: Wrap = try await get(path, authenticated: true)
    return resp.banks
  }

  // MARK: - Live Shield

  public func liveShieldStart(
    peerNumber: String?,
    direction: LiveShieldDirection,
    consentGiven: Bool
  ) async throws -> LiveShieldStartResponse {
    try await post(
      "/v1/live-shield/start",
      body: [
        "peer_number": peerNumber as Any,
        "direction": direction.rawValue,
        "consent_given": consentGiven,
      ],
      authenticated: true
    )
  }

  public func liveShieldTranscript(
    sessionId: String,
    seq: Int,
    speaker: LiveShieldSpeaker,
    text: String,
    confidence: Double?
  ) async throws -> LiveShieldTranscriptResponse {
    try await post(
      "/v1/live-shield/\(sessionId)/transcript",
      body: [
        "seq": seq,
        "speaker": speaker.rawValue,
        "text": text,
        "confidence": confidence as Any,
      ],
      authenticated: true
    )
  }

  public func liveShieldEnd(
    sessionId: String,
    outcome: LiveShieldOutcome
  ) async throws -> LiveShieldEndResponse {
    try await post(
      "/v1/live-shield/\(sessionId)/end",
      body: ["outcome": outcome.rawValue],
      authenticated: true
    )
  }

  // MARK: - Stats

  public struct StatsSummary: Codable, Sendable {
    public let shieldsThisWeek: Int
    public let criticalCallsAvoided30d: Int
    public let breachesFound30d: Int
    public let scamsBlockedAllTime: Int
    public let lookupsAllTime: Int

    enum CodingKeys: String, CodingKey {
      case shieldsThisWeek = "shields_this_week"
      case criticalCallsAvoided30d = "critical_calls_avoided_30d"
      case breachesFound30d = "breaches_found_30d"
      case scamsBlockedAllTime = "scams_blocked_all_time"
      case lookupsAllTime = "lookups_all_time"
    }
  }

  public func statsSummary() async throws -> StatsSummary {
    try await get("/v1/stats/summary", authenticated: true)
  }

  // MARK: - Heatmap

  public struct HeatmapRegion: Codable, Hashable, Sendable, Identifiable {
    public var id: String { regionCode }
    public let regionCode: String
    public let regionName: String
    public let lat: Double
    public let lng: Double
    public let reports30d: Int
    public let reportsAllTime: Int
    public let topScamCategory: String?

    enum CodingKeys: String, CodingKey {
      case regionCode = "region_code"
      case regionName = "region_name"
      case lat, lng
      case reports30d = "reports_30d"
      case reportsAllTime = "reports_all_time"
      case topScamCategory = "top_scam_category"
    }
  }

  public struct HeatmapResponse: Codable, Sendable {
    public let regions: [HeatmapRegion]
    public let maxReports30d: Int
    public let generatedAt: String

    enum CodingKeys: String, CodingKey {
      case regions
      case maxReports30d = "max_reports_30d"
      case generatedAt = "generated_at"
    }
  }

  public func scamHeatmap() async throws -> HeatmapResponse {
    try await get("/v1/scams/heatmap", authenticated: true)
  }

  // MARK: - Analytics (funnel events)

  // Fire-and-forget funnel event. Unauthenticated is fine — onboarding
  // events happen before signup. Errors are swallowed inside this call
  // so the UI never blocks on telemetry.
  //
  // Takes pre-serialized JSON Data for `properties` so call sites that
  // dispatch from a non-isolated context (Task.detached) can build a
  // Sendable payload before crossing isolation boundaries.
  public func trackEventJSON(
    name: String,
    propertiesJSON: Data?,
    anonymousId: String? = nil
  ) async {
    var body: [String: Any] = ["name": name]
    if let propertiesJSON,
       let obj = try? JSONSerialization.jsonObject(with: propertiesJSON),
       let dict = obj as? [String: Any] {
      body["properties"] = dict
    }
    if let anonymousId { body["anonymous_id"] = anonymousId }
    do {
      struct Wrap: Decodable { let ok: Bool }
      let _: Wrap = try await post(
        "/v1/analytics/event",
        body: body,
        authenticated: token != nil
      )
    } catch {
      // Swallow — telemetry must never break the UI.
    }
  }

  // MARK: - Account

  // Returns the raw JSON-encoded export as a Data blob so the caller can hand
  // it straight to UIActivityViewController / a share sheet. We don't decode
  // — the user downloads whatever the server returns.
  public func exportAccountData() async throws -> Data {
    var url = APIConfig.baseURL
    url.append(path: "/v1/users/me/export")
    var req = URLRequest(url: url, timeoutInterval: 60)
    req.httpMethod = "GET"
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let t = token else { throw APIError.notAuthenticated }
    req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    let (data, response): (Data, URLResponse)
    do { (data, response) = try await session.data(for: req) }
    catch { throw APIError.transport(error) }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    return data
  }

  public func deleteAccount() async throws {
    struct Wrap: Decodable { let deleted: Bool }
    let _: Wrap = try await bodyRequest(
      path: "/v1/users/me",
      method: "DELETE",
      body: ["confirm": "DELETE"],
      authenticated: true
    )
  }

  /// Update mutable fields on the current user. Currently supports
  /// `phone_number` (pass nil to clear). Backend re-normalizes the
  /// number to E.164 and validates — we send whatever the user typed
  /// after client-side normalization (see `PhoneNumberCaptureView`).
  public func updateMe(phone: String?) async throws -> UpdateMeResponse {
    // `bodyRequest` strips optionals via `OptionalProtocol`, which would
    // drop a nil `phone_number` from the wire payload. For "remove my
    // phone" we need the backend to actually see `phone_number: null`,
    // so build the URLRequest by hand here to preserve JSON null.
    var url = APIConfig.baseURL
    url.append(path: "/v1/users/me")
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = "PATCH"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let t = token else { throw APIError.notAuthenticated }
    req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")

    // JSONSerialization needs NSNull for an explicit null — a Swift
    // `Optional<String>.none` bridged to Any gets rejected by
    // JSONSerialization outright ("Invalid top-level type"), so we
    // resolve the optional to a concrete value here.
    let phoneValue: Any = phone.map { $0 as Any } ?? NSNull()
    let body: [String: Any] = ["phone_number": phoneValue]
    req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

    let (data, response): (Data, URLResponse)
    do { (data, response) = try await session.data(for: req) }
    catch { throw APIError.transport(error) }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    do {
      return try JSONDecoder().decode(UpdateMeResponse.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  // MARK: - Support

  public func submitSupportTicket(
    subject: String,
    body: String,
    category: String,
    email: String?,
    appVersion: String?,
    deviceModel: String?,
    iosVersion: String?
  ) async throws -> String {
    struct Wrap: Decodable { let ticket_id: String; let status: String }
    let resp: Wrap = try await post(
      "/v1/support/contact",
      body: [
        "subject": subject,
        "body": body,
        "category": category,
        "email": email as Any,
        "app_version": appVersion as Any,
        "device_model": deviceModel as Any,
        "ios_version": iosVersion as Any,
      ],
      authenticated: true
    )
    return resp.ticket_id
  }

  // MARK: - Device / push

  public func registerDevice(
    apnsToken: String,
    environment: String = "sandbox",
    deviceModel: String? = nil,
    appVersion: String? = nil
  ) async throws {
    struct Wrap: Decodable { let device_id: String }
    let _: Wrap = try await post(
      "/v1/device/register",
      body: [
        "apns_token": apnsToken,
        "environment": environment,
        "device_model": deviceModel as Any,
        "app_version": appVersion as Any,
      ],
      authenticated: true
    )
  }

  public func unregisterDevice(apnsToken: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post(
      "/v1/device/unregister",
      body: ["apns_token": apnsToken],
      authenticated: true
    )
  }

  // MARK: - Guardian dashboard

  public func guardianAlerts(includeSeen: Bool = false) async throws -> [GuardianAlert] {
    struct Wrap: Decodable { let alerts: [GuardianAlert] }
    let path = "/v1/guardian/alerts" + (includeSeen ? "?seen=true" : "")
    let resp: Wrap = try await get(path, authenticated: true)
    return resp.alerts
  }

  public func guardianUnseenCount() async throws -> Int {
    struct Wrap: Decodable { let count: Int }
    let resp: Wrap = try await get("/v1/guardian/alerts/unseen-count", authenticated: true)
    return resp.count
  }

  public func guardianMarkSeen(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/guardian/alerts/\(id)/seen", body: [:], authenticated: true)
  }

  public func guardianMarkAllSeen() async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/guardian/alerts/seen-all", body: [:], authenticated: true)
  }

  // MARK: - Breach monitoring (pre-attack signal)

  public func breachAddMonitor(kind: MonitoredIdentifierKind, value: String) async throws -> MonitoredAddResponse {
    try await post(
      "/v1/breach/monitor",
      body: ["kind": kind.rawValue, "value": value],
      authenticated: true
    )
  }

  public func breachListMonitored() async throws -> [MonitoredIdentifier] {
    struct Wrap: Decodable { let items: [MonitoredIdentifier] }
    let resp: Wrap = try await get("/v1/breach/monitor", authenticated: true)
    return resp.items
  }

  public func breachDeleteMonitored(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await delete("/v1/breach/monitor/\(id)", authenticated: true)
  }

  public func breachRescan(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/breach/monitor/\(id)/scan", body: [:], authenticated: true)
  }

  public func breachListAlerts(includeDismissed: Bool = false) async throws -> [BreachAlert] {
    struct Wrap: Decodable { let alerts: [BreachAlert] }
    let path = "/v1/breach/alerts" + (includeDismissed ? "?dismissed=true" : "")
    let resp: Wrap = try await get(path, authenticated: true)
    return resp.alerts
  }

  public func breachDismissAlert(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/breach/alerts/\(id)/dismiss", body: [:], authenticated: true)
  }

  public func breachAckAlert(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post("/v1/breach/alerts/\(id)/ack", body: [:], authenticated: true)
  }

  // MARK: - Family contacts (deepfake defense)

  public func listFamilyContacts() async throws -> [FamilyContact] {
    let resp: FamilyContactListResponse = try await get("/v1/family-contacts", authenticated: true)
    return resp.contacts
  }

  public func familyContactByPhone(_ phone: String) async throws -> FamilyContact? {
    struct Wrap: Decodable { let contact: FamilyContact? }
    let resp: Wrap = try await get(
      "/v1/family-contacts/by-phone/\(phone.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? phone)",
      authenticated: true
    )
    return resp.contact
  }

  public func createFamilyContact(
    displayName: String,
    phone: String,
    relationship: String?,
    isGuardian: Bool,
    safeWord: String?,
    challengePrompt: String?,
    challengeAnswer: String?,
    notes: String?
  ) async throws -> FamilyContact {
    struct Wrap: Decodable { let contact: FamilyContact }
    let resp: Wrap = try await post(
      "/v1/family-contacts",
      body: [
        "display_name": displayName,
        "phone": phone,
        "relationship": relationship as Any,
        "is_guardian": isGuardian,
        "safe_word": safeWord as Any,
        "challenge_prompt": challengePrompt as Any,
        "challenge_answer": challengeAnswer as Any,
        "notes": notes as Any,
      ],
      authenticated: true
    )
    return resp.contact
  }

  public func updateFamilyContact(
    id: String,
    patch: [String: Any]
  ) async throws -> FamilyContact {
    struct Wrap: Decodable { let contact: FamilyContact }
    let resp: Wrap = try await patchJSON(
      "/v1/family-contacts/\(id)",
      body: patch,
      authenticated: true
    )
    return resp.contact
  }

  public func deleteFamilyContact(id: String) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await delete("/v1/family-contacts/\(id)", authenticated: true)
  }

  public func verifyFamilyContact(
    id: String,
    value: String,
    kind: String = "safe_word",
    callSessionId: String? = nil
  ) async throws -> Bool {
    let resp: FamilyVerifyResponse = try await post(
      "/v1/family-contacts/\(id)/verify",
      body: [
        "value": value,
        "kind": kind,
        "call_session_id": callSessionId as Any,
      ],
      authenticated: true
    )
    return resp.match
  }

  // MARK: - Verdict

  public func verdict(number: String) async throws -> VerdictResponse {
    try await post("/v1/verdict", body: ["number": number], authenticated: true)
  }

  public func report(number: String, category: String, note: String?) async throws {
    struct Empty: Decodable {}
    let _: Empty = try await post(
      "/v1/report",
      body: [
        "number": number,
        "category": category,
        "note": note as Any,
      ],
      authenticated: true
    )
  }

  // MARK: - Internal

  private func get<T: Decodable>(
    _ path: String,
    authenticated: Bool
  ) async throws -> T {
    var url = APIConfig.baseURL
    url.append(path: path)
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = "GET"
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if authenticated {
      guard let t = token else { throw APIError.notAuthenticated }
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    }
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw APIError.transport(error)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  private func delete<T: Decodable>(
    _ path: String,
    authenticated: Bool
  ) async throws -> T {
    var url = APIConfig.baseURL
    url.append(path: path)
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = "DELETE"
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if authenticated {
      guard let t = token else { throw APIError.notAuthenticated }
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    }
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw APIError.transport(error)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    if data.isEmpty { return try JSONDecoder().decode(T.self, from: "{}".data(using: .utf8)!) }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  private func patchJSON<T: Decodable>(
    _ path: String,
    body: [String: Any],
    authenticated: Bool
  ) async throws -> T {
    return try await bodyRequest(path: path, method: "PATCH", body: body, authenticated: authenticated)
  }

  private func bodyRequest<T: Decodable>(
    path: String,
    method: String,
    body: [String: Any],
    authenticated: Bool
  ) async throws -> T {
    var url = APIConfig.baseURL
    url.append(path: path)
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if authenticated {
      guard let t = token else { throw APIError.notAuthenticated }
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    }
    let cleaned = body.compactMapValues { value -> Any? in
      if let opt = value as? any OptionalProtocol { return opt.unwrapped }
      return value
    }
    req.httpBody = try JSONSerialization.data(withJSONObject: cleaned, options: [])
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw APIError.transport(error)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  private func post<T: Decodable>(
    _ path: String,
    body: [String: Any],
    authenticated: Bool
  ) async throws -> T {
    var url = APIConfig.baseURL
    url.append(path: path)
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if authenticated {
      guard let t = token else { throw APIError.notAuthenticated }
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    }
    // JSONSerialization drops NSNull if a caller passed an Any from an
    // Optional — strip nulls first so the backend sees a clean body.
    let cleaned = body.compactMapValues { value -> Any? in
      if let opt = value as? any OptionalProtocol { return opt.unwrapped }
      return value
    }
    req.httpBody = try JSONSerialization.data(withJSONObject: cleaned, options: [])

    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw APIError.transport(error)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  /// POST helper that attaches the bearer token when one is present
  /// in the keychain but does NOT throw `notAuthenticated` when it's
  /// absent. Used by endpoints that allow both signed-in and truly
  /// anonymous callers — currently just `/v1/recovery/analyze-text`
  /// for the 3-day Paste-a-Text trial.
  private func postOptionallyAuth<T: Decodable>(
    _ path: String,
    body: [String: Any]
  ) async throws -> T {
    var url = APIConfig.baseURL
    url.append(path: path)
    var req = URLRequest(url: url, timeoutInterval: APIConfig.timeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let t = token {
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    }
    let cleaned = body.compactMapValues { value -> Any? in
      if let opt = value as? any OptionalProtocol { return opt.unwrapped }
      return value
    }
    req.httpBody = try JSONSerialization.data(withJSONObject: cleaned, options: [])
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw APIError.transport(error)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    guard (200..<300).contains(http.statusCode) else {
      let detail = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
      throw APIError.badStatus(http.statusCode, detail?.error)
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }
}

extension APIClient {
  // MARK: - Guardian safe-word challenge (INITIATE side)
  //
  // Guardian taps "Challenge" on a family member's row. Server fires a
  // push to the subject's device with the stored challenge prompt; the
  // subject types the answer on their end (RESPOND flow, not in this
  // agent's scope). We only kick off the challenge here and surface a
  // single plain-language error when the pairing isn't set up.
  //
  // Backend intentionally returns an OPAQUE 403 `challenge_not_available`
  // for every "can't send" reason (no safe-word registered, subject
  // isn't on your plan, cooldown, etc.) so a caller can't probe which
  // relationships exist. iOS surfaces one warm sentence for that case
  // and routes anything else through the standard `AegisError.from`
  // pipeline.
  public func initiateSafeWordChallenge(
    subjectUserId: String
  ) async throws -> SafeWordChallengeCreated {
    do {
      return try await post(
        "/v1/guardian/challenge",
        body: ["subject_user_id": subjectUserId],
        authenticated: true
      )
    } catch let api as APIError {
      if case let .badStatus(403, code) = api, code == "challenge_not_available" {
        throw AegisError.unknown(
          "This person hasn't set up a safe word with you yet."
        )
      }
      throw api
    }
  }
}

extension APIClient {
  // MARK: - Plan-owner transfer (appended 2026-04-19)
  //
  // Owner-side request creates a pending transfer row and returns the
  // RAW token exactly once. We don't persist it; the sheet shows it then
  // drops it. Member-side accept consumes the token and swaps ownership
  // atomically on the server. Both endpoints are per-user rate-limited
  // server-side — no client-side throttle needed here.
  public func requestOwnershipTransfer(
    newOwnerUserId: String
  ) async throws -> OwnershipTransferCreated {
    try await post(
      "/v1/family/transfer/request",
      body: ["new_owner_user_id": newOwnerUserId],
      authenticated: true
    )
  }

  public func acceptOwnershipTransfer(
    token: String
  ) async throws -> OwnershipTransferAccepted {
    try await post(
      "/v1/family/transfer/accept",
      body: ["token": token],
      authenticated: true
    )
  }

  // MARK: - Bulk crime reports (appended 2026-04-19)
  //
  // `/mine` returns `{ reports: [...] }`. We unwrap to [summary]. An
  // empty array is a valid empty-state — view renders the "no aggregate
  // reports yet" copy rather than an error.
  public func listMyBulkReports() async throws -> [BulkCrimeReportSummary] {
    struct Wrap: Decodable { let reports: [BulkCrimeReportSummary] }
    let resp: Wrap = try await get(
      "/v1/recovery/bulk-reports/mine",
      authenticated: true
    )
    return resp.reports
  }

  public func getBulkReport(id: String) async throws -> BulkCrimeReportDetail {
    try await get(
      "/v1/recovery/bulk-reports/\(id)",
      authenticated: true
    )
  }
}

// Runtime Optional check used by the body cleaner above.
private protocol OptionalProtocol {
  var isNil: Bool { get }
  var unwrapped: Any? { get }
}
extension Optional: OptionalProtocol {
  var isNil: Bool { self == nil }
  var unwrapped: Any? {
    switch self {
    case .some(let v): return v
    case .none: return nil
    }
  }
}
