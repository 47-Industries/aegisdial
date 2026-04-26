import SwiftUI
import UIKit

// Contact-support form. POSTs to /v1/support/contact which creates a
// support_tickets row + emails our ops inbox. Satisfies App Review
// Guideline 1.5: apps must include a working support contact path.

struct SupportFormView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var subject: String = ""
  @State private var body: String = ""
  @State private var category: Category = .question
  @State private var email: String = ""
  @State private var sending: Bool = false
  @State private var sentTicketId: String?
  @State private var errorText: String?

  enum Category: String, CaseIterable, Identifiable {
    case question, bug, billing, feature, other
    var id: String { rawValue }
    var label: String {
      switch self {
      case .question: return "Question"
      case .bug:      return "Bug report"
      case .billing:  return "Billing"
      case .feature:  return "Feature request"
      case .other:    return "Other"
      }
    }
  }

  var body: some View {
    Form {
      if let id = sentTicketId {
        successSection(id: id)
      } else {
        formSection
      }
    }
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Contact Support")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Sections

  @ViewBuilder
  private var formSection: some View {
    Section {
      Picker("Category", selection: $category) {
        ForEach(Category.allCases) { c in Text(c.label).tag(c) }
      }
      TextField("Subject", text: $subject)
        .textInputAutocapitalization(.sentences)
      TextField("Reply-to email (optional if signed in)", text: $email)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    }

    Section {
      TextEditor(text: $body)
        .frame(minHeight: 180)
        .scrollContentBackground(.hidden)
    } header: {
      Text("Message")
    } footer: {
      Text("Include any steps, numbers, or screenshots that help us reproduce. We reply within 24 hours on weekdays.")
        .font(.footnote)
    }

    if let err = errorText {
      Section {
        ErrorBanner(message: err) { Task { await send() } }
      }
    }

    Section {
      Button {
        Task { await send() }
      } label: {
        HStack {
          if sending { ProgressView().scaleEffect(0.8) }
          Text(sending ? "Sending…" : "Send")
            .font(AegisType.bodyBold)
        }
        .frame(maxWidth: .infinity)
      }
      .disabled(!canSend || sending)
    }
  }

  private func successSection(id: String) -> some View {
    Section {
      VStack(spacing: AegisSpacing.m) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 48))
          .foregroundStyle(AegisColor.verdictTrusted)
          .accessibilityHidden(true)
        Text("Ticket sent")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Ticket #\(String(id.prefix(8)))")
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textSecondary)
        Text("We'll reply by email within one business day.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
        Button("Close") { dismiss() }
          .buttonStyle(.bordered)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, AegisSpacing.l)
    }
  }

  // MARK: - Send

  private var canSend: Bool {
    !subject.trimmingCharacters(in: .whitespaces).isEmpty
    && !body.trimmingCharacters(in: .whitespaces).isEmpty
  }

  private func send() async {
    sending = true
    errorText = nil
    defer { sending = false }
    do {
      let id = try await APIClient.shared.submitSupportTicket(
        subject: subject.trimmingCharacters(in: .whitespaces),
        body: body.trimmingCharacters(in: .whitespaces),
        category: category.rawValue,
        email: email.isEmpty ? nil : email.trimmingCharacters(in: .whitespaces),
        appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
        deviceModel: deviceModel(),
        iosVersion: UIDevice.current.systemVersion
      )
      AegisHaptic.success.play()
      sentTicketId = id
    } catch {
      errorText = error.localizedDescription
      AegisHaptic.error.play()
    }
  }

  private func deviceModel() -> String {
    var sysinfo = utsname()
    uname(&sysinfo)
    let raw = withUnsafePointer(to: &sysinfo.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
    return raw
  }
}
