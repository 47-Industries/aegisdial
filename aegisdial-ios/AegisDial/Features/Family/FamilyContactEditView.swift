import SwiftUI

// Add / edit one family contact. Safe word and challenge answer inputs
// are never pre-filled on edit (they're server-side bcrypt hashes and
// only writable, not readable). Clearing the field and saving deletes
// the stored hash; typing a new one rotates it.

struct FamilyContactEditView: View {
  let contact: FamilyContact?
  let onChanged: (FamilyContact?) -> Void
  @Environment(\.dismiss) private var dismiss

  // "" means "unset" — Picker renders "Not specified", save sends null.
  @State private var name: String = ""
  @State private var phone: String = ""
  @State private var relationship: String = ""
  @State private var isGuardian: Bool = false
  @State private var showingContactPicker: Bool = false
  @State private var safeWord: String = ""
  @State private var rotateSafeWord: Bool = false
  @State private var challengePrompt: String = ""
  @State private var challengeAnswer: String = ""
  @State private var rotateChallenge: Bool = false
  @State private var notes: String = ""
  @State private var saving: Bool = false
  @State private var error: String?

  private let relationshipOptions: [String] = [
    "parent","child","spouse","sibling","grandparent","grandchild",
    "friend","bank","doctor","attorney","other",
  ]

  var body: some View {
    NavigationStack {
      Form {
        Section("Contact") {
          // Only show "Pick from Contacts" for new records — editing an
          // existing contact, the user already chose a name and number.
          if contact == nil {
            Button {
              showingContactPicker = true
            } label: {
              Label("Pick from Contacts", systemImage: "person.crop.circle.badge.plus")
            }
            .accessibilityLabel("Pick from your iOS contacts")
          }
          TextField("Name (e.g. \"Tommy grandson\")", text: $name)
            .textInputAutocapitalization(.words)
          TextField("+1 555 123 4567", text: $phone)
            .keyboardType(.phonePad)
          Picker("Relationship", selection: $relationship) {
            Text("Not specified").tag("")
            ForEach(relationshipOptions, id: \.self) { r in
              Text(r.capitalized).tag(r)
            }
          }
          Toggle("Guardian (notify in emergencies)", isOn: $isGuardian)
        }
        Section("Safe word") {
          if contact?.hasSafeWord == true && !rotateSafeWord {
            HStack {
              Label("Saved", systemImage: "key.fill")
                .foregroundStyle(AegisColor.verdictTrusted)
              Spacer()
              Button("Change") { rotateSafeWord = true }
            }
          } else {
            SecureField("Share this with them in person", text: $safeWord)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            Text("We store a one-way hash. You can verify it during a shielded call.")
              .font(.caption)
              .foregroundStyle(AegisColor.textSecondary)
          }
        }
        Section("Challenge question (optional)") {
          if contact?.hasChallenge == true && !rotateChallenge {
            HStack {
              Label("Saved", systemImage: "puzzlepiece.fill")
                .foregroundStyle(AegisColor.verdictTrusted)
              Spacer()
              Button("Change") { rotateChallenge = true }
            }
          } else {
            TextField("Prompt (e.g. \"goldfish name\")", text: $challengePrompt)
              .textInputAutocapitalization(.sentences)
            SecureField("Answer", text: $challengeAnswer)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
          }
        }
        Section("Notes") {
          TextField("Optional", text: $notes, axis: .vertical)
            .lineLimit(3, reservesSpace: true)
        }
        if let error {
          Section {
            Text(error).foregroundStyle(AegisColor.verdictSpoofHigh)
          }
        }
        if contact != nil {
          Section {
            Button(role: .destructive) {
              Task { await deleteContact() }
            } label: {
              Label("Delete contact", systemImage: "trash")
            }
          }
        }
      }
      .navigationTitle(contact == nil ? "Add contact" : "Edit contact")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(saving ? "…" : "Save") { Task { await save() } }
            .disabled(saving || name.isEmpty || phone.isEmpty)
        }
      }
      .task { prefill() }
      .sheet(isPresented: $showingContactPicker) {
        ContactPickerCoordinator { pickedName, pickedPhone in
          if !pickedName.isEmpty { name = pickedName }
          if !pickedPhone.isEmpty { phone = pickedPhone }
          showingContactPicker = false
        }
        .ignoresSafeArea()
      }
    }
  }

  private func prefill() {
    guard let c = contact else { return }
    name = c.displayName
    phone = c.phone
    relationship = c.relationship ?? "" // empty-string means "unset"
    isGuardian = c.isGuardian
    challengePrompt = c.challengePrompt ?? ""
    notes = c.notes ?? ""
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      if let c = contact {
        var patch: [String: Any] = [
          "display_name": name,
          "phone": phone,
          "relationship": relationship.isEmpty ? NSNull() : relationship,
          "is_guardian": isGuardian,
          "challenge_prompt": challengePrompt.isEmpty ? NSNull() : challengePrompt,
          "notes": notes.isEmpty ? NSNull() : notes,
        ]
        if rotateSafeWord || contact?.hasSafeWord == false {
          patch["safe_word"] = safeWord.isEmpty ? NSNull() : safeWord
        }
        if rotateChallenge || contact?.hasChallenge == false {
          patch["challenge_answer"] = challengeAnswer.isEmpty ? NSNull() : challengeAnswer
        }
        let updated = try await APIClient.shared.updateFamilyContact(id: c.id, patch: patch)
        onChanged(updated)
      } else {
        let created = try await APIClient.shared.createFamilyContact(
          displayName: name,
          phone: phone,
          relationship: relationship.isEmpty ? nil : relationship,
          isGuardian: isGuardian,
          safeWord: safeWord.isEmpty ? nil : safeWord,
          challengePrompt: challengePrompt.isEmpty ? nil : challengePrompt,
          challengeAnswer: challengeAnswer.isEmpty ? nil : challengeAnswer,
          notes: notes.isEmpty ? nil : notes
        )
        onChanged(created)
      }
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func deleteContact() async {
    guard let c = contact else { return }
    saving = true
    defer { saving = false }
    do {
      try await APIClient.shared.deleteFamilyContact(id: c.id)
      onChanged(nil)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}
