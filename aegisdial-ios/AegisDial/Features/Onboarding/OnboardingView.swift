import SwiftUI
import AuthenticationServices

// Root onboarding screen. Big hero, animated glow. Three sign-in options
// surfaced as equal citizens visually, with Sign in with Apple as the
// topmost CTA because Apple requires it to be at least as prominent as any
// other sign-in method per App Store guidelines.

struct OnboardingView: View {
  @Environment(AuthStore.self) private var auth
  @State private var showingEmailSheet = false
  @State private var emailMode: EmailAuthView.Mode = .signIn
  @State private var glow = false
  @State private var pendingApple: (idToken: String, name: String?)?
  @State private var showingAppleAgeSheet = false
  @State private var appleBirthYear: Int = Calendar.current.component(.year, from: Date()) - 25

  var body: some View {
    ZStack {
      background

      VStack(spacing: 0) {
        Spacer(minLength: 40)
        hero
          .padding(.top, AegisSpacing.xxl)

        Spacer()

        VStack(spacing: AegisSpacing.m) {
          appleButton
          emailButton
          legalFooter
        }
        .padding(.horizontal, AegisSpacing.l)
        .padding(.bottom, AegisSpacing.xl)
      }
    }
    .onAppear {
      withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) { glow.toggle() }
      Track.event(.onboardingStarted)
    }
    .sheet(isPresented: $showingEmailSheet) {
      EmailAuthView(mode: emailMode)
        .environment(auth)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thickMaterial)
    }
    .sheet(isPresented: $showingAppleAgeSheet) {
      // NOTE: aging-parent DynamicType pass 2026-04-19
      // Clamp the age-gate sheet at AX3 so the picker + CTA stay on-screen.
      appleAgeSheet
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .presentationBackground(.thickMaterial)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Hero copy is the first impression for 65+ users; allow the largest
    // accessibility sizes but let minimumScaleFactor prevent overflow.
    .dynamicTypeSize(...DynamicTypeSize.accessibility5)
  }

  // MARK: - Sections

  private var background: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      RadialGradient(
        colors: [AegisColor.accentGlow.opacity(glow ? 0.55 : 0.25), .clear],
        center: .topTrailing,
        startRadius: 10,
        endRadius: 480
      )
      .blendMode(.screen)
      .ignoresSafeArea()
      RadialGradient(
        colors: [AegisColor.verdictTrusted.opacity(glow ? 0.20 : 0.10), .clear],
        center: .bottomLeading,
        startRadius: 10,
        endRadius: 420
      )
      .blendMode(.screen)
      .ignoresSafeArea()
    }
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Image(systemName: "shield.lefthalf.filled.badge.checkmark")
        .font(.system(size: 56, weight: .light))
        .foregroundStyle(AegisColor.accent.gradient)
        .symbolEffect(.pulse, options: .repeating)
        .shadow(color: AegisColor.accentGlow, radius: 24)

      Text("AegisDial")
        .font(AegisType.display)
        .foregroundStyle(AegisColor.textPrimary)

      // NOTE: aging-parent DynamicType pass 2026-04-19
      // Hero subtitle: no token sits between heading(22) and title(34) for
      // a semibold/medium 24pt subtitle, so preserve the hardcoded size and
      // let it scale + shrink instead of truncating at AX3-AX5.
      Text("Bank-grade live\ncall protection.")
        .font(.system(size: 24, weight: .medium, design: .rounded))
        .foregroundStyle(AegisColor.textSecondary)
        .lineSpacing(4)
        .minimumScaleFactor(0.7)
        .fixedSize(horizontal: false, vertical: true)

      Text("Subscribers only. No trials, no ads, no data sold.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.top, AegisSpacing.xs)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, AegisSpacing.l)
  }

  private var appleButton: some View {
    SignInWithAppleButton(.signIn) { request in
      Track.event(.authAppleTapped)
      request.requestedScopes = [.email, .fullName]
    } onCompletion: { result in
      handleApple(result)
    }
    .signInWithAppleButtonStyle(.white)
    .frame(height: 56)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var emailButton: some View {
    Button {
      AegisHaptic.light.play()
      Track.event(.authEmailTapped)
      emailMode = .signIn
      showingEmailSheet = true
    } label: {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "envelope.fill")
        Text("Continue with Email").font(AegisType.bodyBold)
      }
      .frame(maxWidth: .infinity, minHeight: 56)
      .foregroundStyle(AegisColor.textPrimary)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var legalFooter: some View {
    Text("By continuing you agree to our Terms and Privacy Policy. AegisDial never sells your lookup history.")
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .multilineTextAlignment(.center)
      .padding(.top, AegisSpacing.s)
  }

  // MARK: - Apple flow

  private func handleApple(_ result: Result<ASAuthorization, Error>) {
    switch result {
    case .success(let authorization):
      guard
        let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
        let tokenData = cred.identityToken,
        let idToken = String(data: tokenData, encoding: .utf8)
      else {
        auth.state = .error("Apple sign-in returned no identity token.")
        return
      }
      let name = [cred.fullName?.givenName, cred.fullName?.familyName]
        .compactMap { $0 }
        .joined(separator: " ")
      AegisHaptic.success.play()
      // Apple never returns DOB. For new signups the backend needs dob_year;
      // so we always surface the age sheet first. Returning users are
      // identified by apple_sub on the server — if the row already exists
      // the server ignores dob_year entirely, so this is safe to ask every
      // time. The sheet is fast (one picker, one button) and only appears
      // after the Apple system dialog.
      pendingApple = (idToken, name.isEmpty ? nil : name)
      showingAppleAgeSheet = true
    case .failure(let err):
      auth.state = .error(err.localizedDescription)
      AegisHaptic.error.play()
    }
  }

  private var appleAgeSheet: some View {
    let currentYear = Calendar.current.component(.year, from: Date())
    let minAge = 13
    let valid = currentYear - appleBirthYear >= minAge
    return VStack(alignment: .leading, spacing: AegisSpacing.l) {
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        // NOTE: aging-parent DynamicType pass 2026-04-19
        Text("Quick check")
          .font(.system(size: 24, weight: .semibold, design: .rounded))
          .minimumScaleFactor(0.7)
          .foregroundStyle(AegisColor.textPrimary)
        Text("AegisDial is for users aged \(minAge) or older. Your birth year stays on our server only.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
      }
      HStack {
        Text("Birth year")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
        Spacer()
        Picker("Birth year", selection: $appleBirthYear) {
          ForEach((1900...currentYear).reversed(), id: \.self) { y in
            Text(String(y)).tag(y)
          }
        }
        .pickerStyle(.menu)
        .tint(AegisColor.accent)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      Button {
        guard let p = pendingApple else { return }
        Track.event(.authAppleAgeSubmitted, ["birth_year": appleBirthYear])
        showingAppleAgeSheet = false
        Task {
          await auth.signInWithApple(idToken: p.idToken, displayName: p.name, dobYear: appleBirthYear)
          pendingApple = nil
        }
      } label: {
        Text("Continue")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 52)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          .opacity(valid ? 1 : 0.4)
      }
      .disabled(!valid)
      Spacer(minLength: 0)
    }
    .padding(AegisSpacing.l)
  }
}

#Preview {
  OnboardingView()
    .environment(AuthStore())
    .preferredColorScheme(.dark)
}
