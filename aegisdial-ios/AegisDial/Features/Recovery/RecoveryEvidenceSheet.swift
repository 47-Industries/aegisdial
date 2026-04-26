import SwiftUI
import PhotosUI
import CryptoKit
import UIKit

// Evidence locker for a recovery session. Users capture any of:
//   - Notes (what was said, when)
//   - Amounts (dollars lost)
//   - Photos / screenshots
//   - Phone numbers the scammer used
//   - Crypto wallet addresses
//   - Bank account numbers
//   - Transaction confirmations
//
// Images are compressed + hashed on-device; only a hash + caption go
// to the backend. The original bytes stay in the app's document dir
// and are referenced via an identifier we control.

struct RecoveryEvidenceSheet: View {
  @Environment(\.dismiss) private var dismiss
  let sessionId: String

  @State private var items: [APIClient.EvidenceItem] = []
  @State private var loading: Bool = true
  @State private var error: String?

  @State private var adding: AddKind?
  @State private var pickerSelection: [PhotosPickerItem] = []
  @State private var photoCaption: String = ""
  @State private var photoSaving: Bool = false
  @State private var photoError: String?
  @State private var showingPhotoCaptionSheet: Bool = false
  @State private var pendingPhotos: [PreparedPhoto] = []

  enum AddKind: String, Identifiable {
    case note, amount, phone, wallet, account, transaction, photo
    var id: String { rawValue }
    var label: String {
      switch self {
      case .note:        return "Note"
      case .amount:      return "Amount lost"
      case .phone:       return "Phone number"
      case .wallet:      return "Crypto wallet"
      case .account:     return "Bank / routing"
      case .transaction: return "Transaction ID"
      case .photo:       return "Photo / screenshot"
      }
    }
    var icon: String {
      switch self {
      case .note:        return "square.and.pencil"
      case .amount:      return "dollarsign.circle.fill"
      case .phone:       return "phone.fill"
      case .wallet:      return "bitcoinsign.circle"
      case .account:     return "number"
      case .transaction: return "doc.text.magnifyingglass"
      case .photo:       return "photo.on.rectangle.angled"
      }
    }
  }

  // Prepared image ready for upload: the bytes stay on-device (written
  // to the app's documents dir keyed by SHA-256). Only the hash +
  // dimensions + caption ever leave the phone.
  struct PreparedPhoto: Identifiable, Hashable {
    let id = UUID()
    let sha256Hex: String
    let width: Int
    let height: Int
    let byteCount: Int
    let localFilename: String
  }

  // Upload ceiling. Aging users often send 10+ blurry screenshots — we
  // cap combined payload so we never OOM resize or blow the 4MB request.
  private static let maxPhotos: Int = 3
  private static let maxCombinedBytes: Int = 4 * 1024 * 1024
  private static let maxPhotoEdge: CGFloat = 1024

  var body: some View {
    NavigationStack {
      List {
        Section {
          addRow(.note)
          addRow(.amount)
          addRow(.phone)
          addRow(.wallet)
          addRow(.account)
          addRow(.transaction)
          photoPickerRow
        } header: {
          Text("Add evidence").textCase(nil)
        } footer: {
          Text("Banks, police, and insurance all ask for specifics later. Save them now while it's fresh. Photos stay on your phone — we only send a fingerprint so you can reference them in a report.")
            .font(.footnote)
        }

        if let photoError {
          Section { ErrorBanner(message: photoError) }
        }

        if let err = error {
          Section { ErrorBanner(message: err) { Task { await load() } } }
        }

        if !items.isEmpty {
          Section("Saved") {
            ForEach(items) { item in
              evidenceRow(item)
                .swipeActions {
                  Button(role: .destructive) {
                    Task { await delete(item) }
                  } label: { Label("Delete", systemImage: "trash") }
                }
            }
          }
        } else if !loading && error == nil {
          Section {
            EmptyStateBlock(
              icon: "archivebox",
              title: "Nothing saved yet",
              body: "Add a note, an amount, or the scammer's phone number above."
            )
          }
        }
      }
      .navigationTitle("Evidence locker")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
      .task { await load() }
      .sheet(item: $adding) { kind in
        AddEvidenceSheet(kind: kind, sessionId: sessionId) { new in
          items.insert(new, at: 0)
        }
      }
      .onChange(of: pickerSelection) { _, newItems in
        guard !newItems.isEmpty else { return }
        Task { await preparePhotos(from: newItems) }
      }
      .sheet(isPresented: $showingPhotoCaptionSheet, onDismiss: {
        pendingPhotos = []
        photoCaption = ""
        pickerSelection = []
      }) {
        photoCaptionSheet
      }
    }
  }

  // MARK: - Photo picker

  private var photoPickerRow: some View {
    PhotosPicker(
      selection: $pickerSelection,
      maxSelectionCount: Self.maxPhotos,
      matching: .images
    ) {
      Label {
        HStack(spacing: 4) {
          Text(AddKind.photo.label)
          if photoSaving {
            ProgressView().scaleEffect(0.7).padding(.leading, 4)
          }
        }
      } icon: {
        Image(systemName: AddKind.photo.icon)
      }
    }
    .disabled(photoSaving)
  }

  @ViewBuilder
  private var photoCaptionSheet: some View {
    NavigationStack {
      Form {
        Section {
          ForEach(pendingPhotos) { p in
            HStack(alignment: .top) {
              Image(systemName: "photo.fill").foregroundStyle(AegisColor.accent)
              VStack(alignment: .leading, spacing: 2) {
                Text("\(p.width) × \(p.height) px")
                  .font(AegisType.caption)
                  .foregroundStyle(AegisColor.textPrimary)
                Text(byteCountLabel(p.byteCount))
                  .font(AegisType.caption)
                  .foregroundStyle(AegisColor.textTertiary)
              }
            }
          }
        } header: {
          Text("\(pendingPhotos.count) image\(pendingPhotos.count == 1 ? "" : "s") ready to save")
            .textCase(nil)
        }
        Section {
          TextEditor(text: $photoCaption)
            .frame(minHeight: 100)
            .scrollContentBackground(.hidden)
        } header: {
          Text("Describe what's in the picture").textCase(nil)
        } footer: {
          Text("Short note like \"fake IRS text\" or \"wire confirmation\" — this is what investigators see.")
            .font(.footnote)
        }
      }
      .navigationTitle(AddKind.photo.label)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { showingPhotoCaptionSheet = false }
            .disabled(photoSaving)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(photoSaving ? "…" : "Save") { Task { await savePhotos() } }
            .disabled(photoSaving || pendingPhotos.isEmpty || photoCaption.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
    }
  }

  private func preparePhotos(from picked: [PhotosPickerItem]) async {
    photoSaving = true
    photoError = nil
    defer { photoSaving = false }
    var prepared: [PreparedPhoto] = []
    var combined: Int = 0
    for item in picked.prefix(Self.maxPhotos) {
      do {
        guard let data = try await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else {
          continue
        }
        let resized = resize(image, maxEdge: Self.maxPhotoEdge)
        guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { continue }
        if combined + jpeg.count > Self.maxCombinedBytes {
          photoError = "Too much — keep it to under 4 MB across photos."
          break
        }
        combined += jpeg.count
        let digest = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        let filename = "evidence-\(digest).jpg"
        try writeLocal(jpeg, filename: filename)
        prepared.append(PreparedPhoto(
          sha256Hex: digest,
          width: Int(resized.size.width),
          height: Int(resized.size.height),
          byteCount: jpeg.count,
          localFilename: filename
        ))
      } catch {
        photoError = error.localizedDescription
      }
    }
    if prepared.isEmpty {
      if photoError == nil { photoError = "Couldn't read that image." }
      return
    }
    pendingPhotos = prepared
    photoCaption = ""
    showingPhotoCaptionSheet = true
  }

  private func savePhotos() async {
    photoSaving = true
    defer { photoSaving = false }
    let caption = photoCaption.trimmingCharacters(in: .whitespacesAndNewlines)
    for p in pendingPhotos {
      do {
        let payload: [String: Any] = [
          "sha256": p.sha256Hex,
          "width": p.width,
          "height": p.height,
          "bytes": p.byteCount,
          "local_filename": p.localFilename,
          "caption": caption
        ]
        let item = try await APIClient.shared.recoveryEvidenceAdd(
          sessionId: sessionId,
          kind: "photo",
          payload: payload
        )
        items.insert(item, at: 0)
      } catch {
        photoError = error.localizedDescription
        return
      }
    }
    showingPhotoCaptionSheet = false
  }

  private func resize(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
    let w = image.size.width
    let h = image.size.height
    let longest = max(w, h)
    guard longest > maxEdge else { return image }
    let scale = maxEdge / longest
    let newSize = CGSize(width: w * scale, height: h * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: newSize))
    }
  }

  private func writeLocal(_ data: Data, filename: String) throws {
    let dir = try FileManager.default
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("recovery-evidence", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: dir.appendingPathComponent(filename), options: .atomic)
  }

  private func byteCountLabel(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }

  private func addRow(_ kind: AddKind) -> some View {
    Button {
      adding = kind
    } label: {
      Label(kind.label, systemImage: kind.icon)
    }
  }

  private func evidenceRow(_ item: APIClient.EvidenceItem) -> some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: iconFor(kind: item.kind))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(item.kind.capitalized).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
        Text(primaryDisplay(item))
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
          .lineLimit(4)
      }
    }
    .padding(.vertical, 2)
  }

  private func iconFor(kind: String) -> String {
    AddKind(rawValue: kind)?.icon ?? "archivebox.fill"
  }

  private func primaryDisplay(_ item: APIClient.EvidenceItem) -> String {
    if let text = item.payload["text"]?.value as? String { return text }
    if let amount = item.payload["amount_usd"]?.value as? Double { return String(format: "$%.2f", amount) }
    if let amountInt = item.payload["amount_usd"]?.value as? Int { return String(format: "$%.2f", Double(amountInt)) }
    if let phone = item.payload["phone"]?.value as? String { return phone }
    if let wallet = item.payload["address"]?.value as? String { return wallet }
    if item.kind == "photo" {
      let caption = (item.payload["caption"]?.value as? String) ?? ""
      let w = (item.payload["width"]?.value as? Int) ?? 0
      let h = (item.payload["height"]?.value as? Int) ?? 0
      if !caption.isEmpty {
        return w > 0 && h > 0 ? "\(caption) — \(w)×\(h)" : caption
      }
      if w > 0 && h > 0 { return "Image \(w)×\(h)" }
      return "(image saved locally)"
    }
    return "(saved)"
  }

  private func load() async {
    loading = true
    defer { loading = false }
    error = nil
    do {
      items = try await APIClient.shared.recoveryEvidenceList(sessionId: sessionId)
    } catch let err {
      error = err.localizedDescription
    }
  }

  private func delete(_ item: APIClient.EvidenceItem) async {
    do {
      try await APIClient.shared.recoveryEvidenceDelete(sessionId: sessionId, evidenceId: item.id)
      items.removeAll { $0.id == item.id }
    } catch let err {
      error = err.localizedDescription
    }
  }
}

// MARK: - Add sheet (one per kind)

private struct AddEvidenceSheet: View {
  let kind: RecoveryEvidenceSheet.AddKind
  let sessionId: String
  let onAdded: (APIClient.EvidenceItem) -> Void
  @Environment(\.dismiss) private var dismiss

  @State private var text: String = ""
  @State private var amount: String = ""
  @State private var saving: Bool = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          switch kind {
          case .note:
            TextEditor(text: $text).frame(minHeight: 140).scrollContentBackground(.hidden)
          case .amount:
            TextField("0.00", text: $amount)
              .keyboardType(.decimalPad)
          case .phone:
            TextField("+1 555 123 4567", text: $text).keyboardType(.phonePad)
          case .wallet:
            TextField("Wallet address", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
          case .account:
            TextField("Account / routing", text: $text).keyboardType(.numberPad)
          case .transaction:
            TextField("Confirmation / transaction ID", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
          case .photo:
            // Photos use a PhotosPicker on the parent — this sheet is
            // never invoked for .photo. Render nothing to keep the
            // switch exhaustive.
            EmptyView()
          }
        } footer: {
          if kind == .note {
            Text("Include what they said, any pressure tactics, time of day. Be as specific as you can.")
              .font(.footnote)
          }
        }
        if let error {
          Section { ErrorBanner(message: error) }
        }
      }
      .navigationTitle(kind.label)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(saving ? "…" : "Save") { Task { await save() } }
            .disabled(saving || !canSave)
        }
      }
    }
  }

  private var canSave: Bool {
    if kind == .amount { return Double(amount) != nil }
    return !text.trimmingCharacters(in: .whitespaces).isEmpty
  }

  private func save() async {
    saving = true
    defer { saving = false }
    var payload: [String: Any] = [:]
    switch kind {
    case .amount:
      payload["amount_usd"] = Double(amount) ?? 0
    case .note:
      payload["text"] = text
    case .phone:
      payload["phone"] = text
    case .wallet:
      payload["address"] = text
    case .account:
      payload["account_identifier"] = text
    case .transaction:
      payload["transaction_id"] = text
    case .photo:
      // Unreachable — photos are saved from the parent's PhotosPicker
      // flow, not this sheet.
      return
    }
    do {
      let item = try await APIClient.shared.recoveryEvidenceAdd(
        sessionId: sessionId,
        kind: kind.rawValue,
        payload: payload
      )
      onAdded(item)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

struct FamilyNotifyToast: View {
  let deliveredCount: Int
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "paperplane.fill")
        .foregroundStyle(AegisColor.verdictTrusted)
        .accessibilityHidden(true)
      Text(deliveredCount > 0
           ? "Family alert sent to \(deliveredCount) guardian\(deliveredCount == 1 ? "" : "s")"
           : "No guardians found — invite someone to Family Plan first")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
      Button(action: onDismiss) {
        Image(systemName: "xmark").foregroundStyle(AegisColor.textSecondary)
      }
      .accessibilityLabel("Dismiss")
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surfaceElevated)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
        .stroke(AegisColor.verdictTrusted.opacity(0.4), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .padding(.horizontal, AegisSpacing.l)
    .shadow(color: .black.opacity(0.25), radius: 12)
  }
}
