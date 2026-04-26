import SwiftUI

// Sheet for capturing the user's own phone number. We store it server-side
// under `users.phone_number` (backend normalizes to E.164 but we also strip
// formatting client-side so a kind error path is shown instead of a 400).
//
// The phone is used *only* for emergency SMS escalation — if a family
// member tries to reach the user through a scam-in-progress and we can't
// route through the app (APNs down, phone off, etc.), we fall back to
// SMS. Never marketing. Never shared.
//
// Surfaced from Settings as "Phone for emergency SMS". Not required at
// onboarding today — see TODO.md item about wiring into onboarding for
// the adult-child-bought-for-parent flow.

@MainActor
struct PhoneNumberCaptureView: View {
  @Environment(\.dismiss) private var dismiss

  let initialValue: String?
  let onSaved: (String?) -> Void

  @State private var raw: String
  @State private var saving: Bool = false
  @State private var errorMessage: String?

  init(initialValue: String?, onSaved: @escaping (String?) -> Void) {
    self.initialValue = initialValue
    self.onSaved = onSaved
    _raw = State(initialValue: initialValue ?? "")
  }

  private var normalized: String {
    Self.normalize(raw)
  }

  private var isValid: Bool {
    Self.isValidE164ish(normalized)
  }

  private var hasExisting: Bool {
    (initialValue ?? "").isEmpty == false
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("We use your phone only for emergency SMS alerts — if a family member tries to reach you about a scam and we can't reach them through the app, we'll text you. Never marketing. Never shared. You can remove it anytime.")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        }

        Section("Mobile number") {
          TextField("+1 415 555 0123", text: $raw)
            .keyboardType(.phonePad)
            .textContentType(.telephoneNumber)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
          if !raw.isEmpty && !isValid {
            Text("Enter a valid mobile number (10–15 digits, optional leading +).")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.verdictSpoofHigh)
          }
        }

        if let errorMessage {
          Section {
            Text(errorMessage)
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.verdictSpoofHigh)
          }
        }

        Section {
          Button {
            // Synchronous flip so a second tap (or a simultaneous tap on
            // Remove phone) can't schedule a second Task before the
            // first Task's first await sets `saving = true`.
            guard !saving else { return }
            saving = true
            Task { await save() }
          } label: {
            HStack {
              Spacer()
              if saving {
                ProgressView().controlSize(.small)
              } else {
                Text("Save").font(AegisType.bodyBold)
              }
              Spacer()
            }
          }
          .disabled(saving || !isValid || normalized == Self.normalize(initialValue ?? ""))
        }

        if hasExisting {
          Section {
            Button(role: .destructive) {
              guard !saving else { return }
              saving = true
              Task { await remove() }
            } label: {
              HStack {
                Spacer()
                Text("Remove phone").font(AegisType.bodyBold)
                Spacer()
              }
            }
            .disabled(saving)
          } footer: {
            Text("Removes your number from our servers. You won't receive emergency SMS until you re-add it.")
              .font(AegisType.caption)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(AegisColor.background)
      .navigationTitle(hasExisting ? "Phone Number" : "Add Phone Number")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
            .disabled(saving)
        }
      }
      .preferredColorScheme(.dark)
    }
  }

  // MARK: - Actions

  // `saving` is flipped true synchronously in the Button action — these
  // handlers only need to reset on exit and clear error on entry.
  private func save() async {
    errorMessage = nil
    defer { saving = false }
    do {
      let resp = try await APIClient.shared.updateMe(phone: normalized)
      onSaved(resp.phoneNumber)
      dismiss()
    } catch {
      errorMessage = AegisError.from(error).userMessage
    }
  }

  private func remove() async {
    errorMessage = nil
    defer { saving = false }
    do {
      _ = try await APIClient.shared.updateMe(phone: nil)
      onSaved(nil)
      dismiss()
    } catch {
      errorMessage = AegisError.from(error).userMessage
    }
  }

  // MARK: - Helpers

  /// Aggressively strip everything except digits and a single leading +.
  /// Backend re-normalizes — this just makes the error path kinder so a
  /// user who types "(415) 555-0123" doesn't get a 400.
  static func normalize(_ input: String) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    let hasLeadingPlus = trimmed.hasPrefix("+")
    let digitString = String(trimmed.filter { $0.isNumber })
    return hasLeadingPlus ? "+\(digitString)" : digitString
  }

  /// Loose E.164-ish check: 10–15 digits, optional leading +. The server
  /// does the authoritative validation.
  static func isValidE164ish(_ input: String) -> Bool {
    let pattern = #"^\+?[0-9]{10,15}$"#
    return input.range(of: pattern, options: .regularExpression) != nil
  }
}
