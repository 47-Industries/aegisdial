import SwiftUI

// Sheet presented from onboarding. Toggle between Sign In and Sign Up with
// a segmented control. Inline validation, clean field styling, Done button
// transitions through `.isLoading`.

struct EmailAuthView: View {
  enum Mode: String, CaseIterable, Identifiable {
    case signIn = "Sign In"
    case signUp = "Sign Up"
    var id: String { rawValue }
  }

  @Environment(AuthStore.self) private var auth
  @Environment(\.dismiss) private var dismiss

  @State var mode: Mode
  @State private var email: String = ""
  @State private var password: String = ""
  @State private var displayName: String = ""
  @State private var birthYear: Int = Calendar.current.component(.year, from: Date()) - 25
  // NOTE: aging-parent DynamicType pass 2026-04-19
  // Primary CTA is opacity-gated via `isValid`, which is silent — older users
  // blur the field and wonder why nothing happens. Show an inline hint after
  // the first blur if the email isn't plausible.
  @State private var showEmailHint: Bool = false
  @State private var hasBlurredEmail: Bool = false
  @FocusState private var focused: Field?

  enum Field { case email, password, name }

  // iOS-side minimum age, mirrored from backend `MIN_AGE_YEARS`. Keeps the
  // UI honest (disabled button + inline error) rather than waiting for a 403.
  private static let minimumAge = 13
  private var currentYear: Int { Calendar.current.component(.year, from: Date()) }
  private var birthYearValid: Bool { currentYear - birthYear >= Self.minimumAge }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          Picker("", selection: $mode) {
            ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
          .padding(.top, AegisSpacing.m)

          VStack(spacing: AegisSpacing.m) {
            if mode == .signUp {
              field(
                icon: "person.fill",
                placeholder: "Name",
                text: $displayName,
                contentType: .name,
                focusedValue: .name
              )
              .transition(.opacity.combined(with: .move(edge: .top)))
            }
            field(
              icon: "envelope.fill",
              placeholder: "Email",
              text: $email,
              contentType: .emailAddress,
              keyboard: .emailAddress,
              focusedValue: .email
            )
            // NOTE: aging-parent DynamicType pass 2026-04-19
            // Inline hint — visible after the user has blurred the email
            // field once and it still doesn't contain "@". Keeps the silent
            // CTA from leaving users stuck.
            if showEmailHint {
              Label("Please include an @ sign.", systemImage: "exclamationmark.circle.fill")
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.verdictSuspicious)
                .padding(.leading, AegisSpacing.xs)
                .transition(.opacity)
            }
            field(
              icon: "lock.fill",
              placeholder: mode == .signUp ? "Create a password (min 8)" : "Password",
              text: $password,
              contentType: mode == .signUp ? .newPassword : .password,
              isSecure: true,
              focusedValue: .password
            )
            if mode == .signUp {
              birthYearPicker
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
          }
          .animation(AegisMotion.snappy, value: mode)

          primaryButton
            .padding(.top, AegisSpacing.s)

          if case .error(let message) = auth.state {
            Text(message)
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.verdictSpoofHigh)
              .padding(.top, AegisSpacing.xs)
              .transition(.opacity)
          }
        }
        .padding(.horizontal, AegisSpacing.l)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(AegisColor.background)
      .navigationTitle(mode == .signUp ? "Create Account" : "Welcome Back")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
      // NOTE: aging-parent DynamicType pass 2026-04-19
      // First blur of email triggers the hint if it's missing "@"; typing
      // clears the hint as soon as the user starts fixing it.
      .onChange(of: focused) { oldValue, newValue in
        if oldValue == .email, newValue != .email {
          hasBlurredEmail = true
          withAnimation(AegisMotion.snappy) {
            showEmailHint = !email.contains("@")
          }
        }
      }
      .onChange(of: email) { _, _ in
        if hasBlurredEmail {
          withAnimation(AegisMotion.snappy) {
            showEmailHint = !email.contains("@")
          }
        }
      }
    }
    .preferredColorScheme(.dark)
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Clamp the auth sheet at AX3 so the segmented picker + keyboard still
    // leave the primary CTA visible at large accessibility sizes.
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
  }

  private var isValid: Bool {
    let emailOK = email.contains("@") && email.contains(".") && email.count > 5
    let pwOK = password.count >= (mode == .signUp ? 8 : 1)
    let ageOK = mode == .signIn || birthYearValid
    return emailOK && pwOK && ageOK
  }

  private var birthYearPicker: some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "calendar")
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(AegisColor.textTertiary)
        .frame(width: 22)
      Text("Birth year")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
      Picker("Birth year", selection: $birthYear) {
        ForEach((1900...currentYear).reversed(), id: \.self) { y in
          Text(String(y)).tag(y)
        }
      }
      .pickerStyle(.menu)
      .tint(AegisColor.accent)
    }
    .padding(.horizontal, AegisSpacing.m)
    .frame(height: 56)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
        .stroke(AegisColor.hairlineStrong, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .accessibilityHint("AegisDial requires users to be \(Self.minimumAge) or older.")
  }

  private var primaryButton: some View {
    Button {
      AegisHaptic.medium.play()
      let lowered = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      Track.event(.authEmailSubmitted, ["mode": mode == .signUp ? "signup" : "signin"])
      Task {
        switch mode {
        case .signIn:
          await auth.signInWithEmail(email: lowered, password: password)
        case .signUp:
          await auth.signUpWithEmail(
            email: lowered,
            password: password,
            displayName: trimmedName.isEmpty ? nil : trimmedName,
            dobYear: birthYear
          )
        }
      }
    } label: {
      HStack(spacing: AegisSpacing.s) {
        if case .signingIn = auth.state {
          ProgressView().tint(.black)
        } else {
          Text(mode == .signUp ? "Create Account" : "Sign In")
            .font(AegisType.bodyBold)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      .opacity(isValid ? 1 : 0.4)
    }
    .disabled(!isValid)
  }

  @ViewBuilder
  private func field(
    icon: String,
    placeholder: String,
    text: Binding<String>,
    contentType: UITextContentType,
    keyboard: UIKeyboardType = .default,
    isSecure: Bool = false,
    focusedValue: Field
  ) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: icon)
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(AegisColor.textTertiary)
        .frame(width: 22)
      Group {
        if isSecure {
          SecureField(placeholder, text: text)
        } else {
          TextField(placeholder, text: text)
        }
      }
      .textContentType(contentType)
      .keyboardType(keyboard)
      .textInputAutocapitalization(contentType == .name ? .words : .never)
      .autocorrectionDisabled()
      .font(AegisType.body)
      .foregroundStyle(AegisColor.textPrimary)
      .tint(AegisColor.accent)
      .focused($focused, equals: focusedValue)
    }
    .padding(.horizontal, AegisSpacing.m)
    .frame(height: 56)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
        .stroke(focused == focusedValue ? AegisColor.accent.opacity(0.6) : AegisColor.hairlineStrong, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .animation(AegisMotion.snappy, value: focused)
  }
}
