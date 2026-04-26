import SwiftUI

struct SettingsView: View {
  @Environment(AuthStore.self) private var auth
  @Environment(SubscriptionStore.self) private var subs
  @State private var showingDemo: Bool = false
  @State private var showingDeleteSheet: Bool = false
  @State private var showingSignOutConfirm: Bool = false
  @State private var showingPhoneSheet: Bool = false
  // Cached locally so the Settings row updates immediately after the sheet
  // saves. Source of truth is the server (/v1/users/me); we could refresh
  // on appear if needed — for now the post-save callback is enough.
  @AppStorage("aegis.user.phone_number") private var storedPhoneNumber: String = ""

  var body: some View {
      List {
        Section("Account") {
          if case .signedIn(let ctx) = auth.state {
            LabeledContent("Signed in as") {
              Text(ctx.method.label).foregroundStyle(AegisColor.textSecondary)
            }
          }
        }

        Section("Subscription") {
          NavigationLink {
            SubscriptionStatusView()
          } label: {
            HStack {
              Label("Subscription", systemImage: "shield.lefthalf.filled.badge.checkmark")
                .foregroundStyle(AegisColor.textPrimary)
              Spacer()
              Text(subscriptionTierLabel)
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.textSecondary)
                .accessibilityLabel("Current plan: \(subscriptionTierLabel)")
            }
            .frame(minHeight: 44)
          }
        }

        Section("Emergency SMS") {
          Button {
            showingPhoneSheet = true
          } label: {
            HStack {
              Label("Phone for emergency SMS", systemImage: "message.badge.filled.fill")
                .foregroundStyle(AegisColor.textPrimary)
              Spacer()
              Text(phoneDisplay)
                .font(AegisType.caption)
                .foregroundStyle(phoneIsSet ? AegisColor.textSecondary : AegisColor.textTertiary)
            }
          }
        } footer: {
          Text("Optional. Used only if we can't reach you in-app during a scam-in-progress.")
            .font(.footnote)
        }

        Section("Family Plan") {
          NavigationLink {
            FamilyPlanView()
          } label: {
            Label("Manage Family Plan", systemImage: "person.3.fill")
          }
        }

        Section("Guardian") {
          NavigationLink {
            GuardianEntryPoint()
          } label: {
            Label("Guardian Dashboard", systemImage: "shield.lefthalf.filled")
          }
        }

        Section("Pre-Attack Signal") {
          NavigationLink {
            BreachAlertsView()
          } label: {
            Label("Breach Alerts", systemImage: "exclamationmark.shield.fill")
          }
        }

        Section("Deepfake Defense") {
          NavigationLink {
            FamilyContactsView()
          } label: {
            Label("Family Contacts & Safe Words", systemImage: "person.crop.circle.badge.checkmark")
          }
        }

        Section("Learn & test") {
          Button {
            showingDemo = true
          } label: {
            Label("Try a demo call", systemImage: "play.circle.fill")
          }
        }

        Section("Recovery") {
          NavigationLink {
            RecoveryHistoryView()
              .biometricallyGated(reason: "Recovery history contains details about past scams. Unlock to view.")
          } label: {
            Label("Recovery History", systemImage: "cross.case.fill")
          }
        }

        Section("Privacy") {
          NavigationLink {
            ExportDataView()
              .biometricallyGated(reason: "Your data export contains decrypted personal information. Unlock to continue.")
          } label: {
            Label("Export My Data", systemImage: "arrow.down.doc.fill")
          }
          Link(destination: URL(string: "https://aegisdial.com/privacy")!) {
            Label("Privacy Policy", systemImage: "hand.raised.fill")
          }
          Link(destination: URL(string: "https://aegisdial.com/terms")!) {
            Label("Terms of Service", systemImage: "doc.plaintext.fill")
          }
        }

        Section("About") {
          NavigationLink {
            AboutView()
          } label: {
            Label("About AegisDial", systemImage: "info.circle.fill")
          }
          NavigationLink {
            SupportFormView()
          } label: {
            Label("Contact Support", systemImage: "envelope.fill")
          }
          NavigationLink {
            EnableExtensionsView()
          } label: {
            Label("Enable iOS Extensions", systemImage: "checkmark.circle.fill")
          }
        }

        Section {
          Button {
            AegisHaptic.medium.play()
            showingSignOutConfirm = true
          } label: {
            Label("Sign Out", systemImage: "arrow.right.square.fill")
          }
        }

        Section {
          Button(role: .destructive) {
            AegisHaptic.medium.play()
            showingDeleteSheet = true
          } label: {
            Label("Delete Account", systemImage: "person.crop.circle.badge.xmark.fill")
          }
        } footer: {
          Text("Permanently removes your account and every row of your data. This can't be undone.")
            .font(.footnote)
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(AegisColor.background)
      .navigationTitle("Settings")
    .preferredColorScheme(.dark)
    .sheet(isPresented: $showingDemo) {
      LiveShieldDemoView()
    }
    .sheet(isPresented: $showingDeleteSheet) {
      DeleteAccountSheet()
        .environment(auth)
    }
    .sheet(isPresented: $showingPhoneSheet) {
      PhoneNumberCaptureView(
        initialValue: phoneIsSet ? storedPhoneNumber : nil
      ) { newValue in
        storedPhoneNumber = newValue ?? ""
      }
    }
    .confirmationDialog(
      "Sign out?",
      isPresented: $showingSignOutConfirm,
      titleVisibility: .visible
    ) {
      Button("Sign Out", role: .destructive) { auth.signOut() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("You'll need to sign in again to view your data.")
    }
  }

  private var phoneIsSet: Bool {
    !storedPhoneNumber.trimmingCharacters(in: .whitespaces).isEmpty
  }

  /// Mask all but the country prefix and last 4 — "+1 415 ••• •••1234".
  /// Purely cosmetic; the server stores the full value.
  private var phoneDisplay: String {
    guard phoneIsSet else { return "Not set" }
    let raw = storedPhoneNumber
    let digitString = String(raw.filter { $0.isNumber })
    guard digitString.count >= 4 else { return raw }
    let last4 = String(digitString.suffix(4))
    let rest = digitString.dropLast(4)
    // US-style grouping if +1 / 11 digits; otherwise generic "•••• 1234".
    if raw.hasPrefix("+1") && digitString.count == 11 {
      let area = String(digitString.dropFirst().prefix(3))
      return "+1 \(area) ••• •••\(last4)"
    }
    let prefix = rest.count <= 3 ? String(rest) : "+" + String(rest.prefix(rest.count - 6))
    return "\(prefix) ••• •••\(last4)"
  }

  /// Short summary string shown in the Settings row secondary text.
  /// Detailed surface lives in SubscriptionStatusView.
  private var subscriptionTierLabel: String {
    switch subs.state {
    case .entitled:
      if subs.latestProductId == SubscriptionStore.recoverySessionID {
        return "Recovery · Active"
      }
      return "Pro · Active"
    case .notEntitled:
      return "Free"
    case .refreshing, .unknown:
      return "Checking…"
    case .purchasing:
      return "Processing…"
    case .error:
      return "Unavailable"
    }
  }
}

private extension AuthStore.AuthMethod {
  var label: String {
    switch self {
    case .apple: return "Apple ID"
    case .email: return "Email"
    }
  }
}
