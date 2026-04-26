import SwiftUI

// Family Contacts list — the deepfake-defense roster. Users pre-register
// each trusted contact with a shared safe word. When a shielded call
// detects an emergency-relative pattern, the live panel pulls from this
// list to suggest callback + verify actions.

struct FamilyContactsView: View {
  @State private var contacts: [FamilyContact] = []
  @State private var loading: Bool = true
  @State private var error: String?
  @State private var showingAdd: Bool = false
  @State private var editingContact: FamilyContact?

  var body: some View {
    List {
      if let err = error {
        Section { ErrorBanner(message: err) { Task { await reload() } } }
      }
      Section {
        if contacts.isEmpty && !loading && error == nil {
          EmptyStateBlock(
            icon: "person.crop.circle.badge.plus",
            title: "No trusted contacts yet",
            body: "Add family members with a shared safe word so you can verify a call that claims to be them.",
            cta: ("Add first contact", { showingAdd = true })
          )
        }
        ForEach(contacts) { c in
          NavigationLink {
            FamilyContactEditView(contact: c) { updated in
              if let updated {
                if let idx = contacts.firstIndex(where: { $0.id == updated.id }) {
                  contacts[idx] = updated
                } else {
                  contacts.append(updated)
                }
              } else {
                contacts.removeAll { $0.id == c.id }
              }
            }
          } label: {
            contactRow(c)
          }
          // NOTE: aging-parent DynamicType pass 2026-04-19
          // VoiceOver previously announced each leaf element (icon, name,
          // phone, safe-word badge) as a separate focus stop, which meant
          // older users had to swipe four times per contact. Combine into
          // one element with a synthesized label summarizing identity,
          // relationship, and guardian status.
          .accessibilityElement(children: .combine)
          .accessibilityLabel(Self.accessibilityLabel(for: c))
        }
      } footer: {
        if contacts.isEmpty && !loading {
          Text("Add trusted contacts so we can verify calls that claim to be family.")
            .font(.footnote)
            .foregroundStyle(AegisColor.textSecondary)
        }
      }
    }
    .navigationTitle("Family Contacts")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button { showingAdd = true } label: { Image(systemName: "plus") }
      }
    }
    .sheet(isPresented: $showingAdd) {
      FamilyContactEditView(contact: nil) { created in
        if let created {
          contacts.append(created)
          contacts.sort { lhs, rhs in
            // Match the backend's ORDER BY: guardians first, then name ASC.
            if lhs.isGuardian != rhs.isGuardian { return lhs.isGuardian }
            return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
          }
        }
      }
    }
    .task { await reload() }
    .refreshable { await reload() }
  }

  private func contactRow(_ c: FamilyContact) -> some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: c.isGuardian ? "shield.checkerboard" : "person.fill")
        .font(.system(size: 20))
        .foregroundStyle(c.isGuardian ? AegisColor.verdictTrusted : AegisColor.accent)
        .frame(width: 36, height: 36)
        .background(AegisColor.surfaceElevated)
        .clipShape(Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text(c.displayName).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
        HStack(spacing: 6) {
          Text(c.phone).font(AegisType.caption.monospaced()).foregroundStyle(AegisColor.textSecondary)
          if c.hasSafeWord {
            Label("Safe word", systemImage: "key.fill")
              .font(.caption2)
              .foregroundStyle(AegisColor.verdictTrusted)
          }
        }
      }
      Spacer()
    }
  }

  private func reload() async {
    loading = true
    defer { loading = false }
    do {
      contacts = try await APIClient.shared.listFamilyContacts()
    } catch {
      self.error = error.localizedDescription
    }
  }

  // NOTE: aging-parent DynamicType pass 2026-04-19
  // Summarize a FamilyContact row for VoiceOver. The FamilyContact schema
  // doesn't carry a live guardian-alert count (that lives server-side in
  // guardian_alerts), so we synthesize a guardian-status phrase from the
  // `isGuardian` flag. If/when a cached alert count is exposed on the row
  // (reviewer note — see backend TODO), swap the phrase for the real number.
  private static func accessibilityLabel(for c: FamilyContact) -> String {
    var parts: [String] = [c.displayName]
    if let rel = c.relationship, !rel.isEmpty {
      parts.append(rel)
    }
    parts.append(c.isGuardian ? "guardian" : "trusted contact")
    if c.hasSafeWord {
      parts.append("safe word saved")
    }
    return parts.joined(separator: ", ")
  }
}
