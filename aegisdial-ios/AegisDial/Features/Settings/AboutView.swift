import SwiftUI

// About screen — app version, build, third-party licenses, contact.
// Apple's App Review checks that shipping apps disclose attribution
// for third-party libraries (we use a handful). This view satisfies
// that AND gives a quick "what version am I on?" for support tickets.

struct AboutView: View {
  private let marketingVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
  private let buildNumber = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"

  var body: some View {
    List {
      Section {
        hero
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
      }

      Section("Version") {
        LabeledContent("Marketing version") { Text(marketingVersion) }
        LabeledContent("Build") { Text(buildNumber) }
        LabeledContent("Bundle ID") { Text("com.fortyseven.aegisdial").font(AegisType.mono) }
      }

      Section("Legal") {
        if let url = URL(string: "https://aegisdial.com/privacy") {
          Link(destination: url) {
            Label("Privacy Policy", systemImage: "hand.raised.fill")
          }
        }
        if let url = URL(string: "https://aegisdial.com/terms") {
          Link(destination: url) {
            Label("Terms of Service", systemImage: "doc.plaintext.fill")
          }
        }
      }

      Section("Contact") {
        if let url = URL(string: "mailto:support@aegisdial.com") {
          Link(destination: url) {
            Label("support@aegisdial.com", systemImage: "envelope.fill")
          }
        }
        if let url = URL(string: "mailto:privacy@aegisdial.com") {
          Link(destination: url) {
            Label("privacy@aegisdial.com", systemImage: "lock.fill")
          }
        }
      }

      Section("Open source libraries") {
        ForEach(licenses, id: \.name) { lib in
          VStack(alignment: .leading, spacing: 4) {
            Text(lib.name).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
            Text(lib.license).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
          }
          .padding(.vertical, 4)
        }
      } footer: {
        Text("AegisDial builds on many open-source projects. Licenses are reproduced in full in the project repository.")
          .font(.footnote)
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("About")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var hero: some View {
    VStack(spacing: AegisSpacing.m) {
      Image("LaunchLogo")
        .resizable()
        .scaledToFit()
        .frame(width: 84, height: 84)
        .accessibilityHidden(true)
      Text("AegisDial")
        .font(.system(size: 26, weight: .bold))
        .foregroundStyle(AegisColor.textPrimary)
      Text("Bank-grade live call protection.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
      Text("© 2026 AegisDial")
        .font(.caption2)
        .foregroundStyle(AegisColor.textTertiary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, AegisSpacing.l)
  }

  // Kept deliberately short — expand as you add deps. Licenses
  // auto-generated from Swift Package Manager aren't available in
  // SwiftUI without a build script; this is the manual maintainer list.
  private struct Lib { let name: String; let license: String }
  private let licenses: [Lib] = [
    .init(name: "Apple on-device Speech framework", license: "Apple SDK, bundled"),
    .init(name: "Apple IdentityLookup framework", license: "Apple SDK, bundled"),
  ]
}
