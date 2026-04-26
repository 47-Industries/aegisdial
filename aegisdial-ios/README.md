# AegisDial iOS

SwiftUI app + Live Caller ID Lookup extension for the AegisDial consumer phone-safety product.

## You need a Mac to build this

Xcode only runs on macOS. If you don't have one:
- **MacinCloud** or **MacStadium** — rent a Mac in the cloud, ~$10–30/mo
- **Xcode Cloud** — Apple's CI/CD, free tier covers a small app, builds + TestFlight distribution (no interactive debugging)
- **Borrow a Mac** for an afternoon to run the simulator

On a Mac, you need Xcode 16+ (for iOS 18 Live Caller ID Lookup) and one dev-time tool: [XcodeGen](https://github.com/yonaskolb/XcodeGen).

## First-time setup

```bash
brew install xcodegen
cd aegisdial-ios
xcodegen generate
open AegisDial.xcodeproj
```

In Xcode:
1. Select the `AegisDial` project in the navigator → `Signing & Capabilities`
2. Team: pick your Apple Developer team. Bundle ID is `com.aegisdial.app`.
3. Capabilities enabled: `Sign In with Apple`, `App Attest`, `Live Caller ID Lookup (extension)`
4. Set backend URL in `AegisDial/Networking/Endpoint.swift` → `APIConfig.baseURL`
5. Build + Run on a device or simulator.

## Architecture

```
AegisDial/                          Main app (SwiftUI, iOS 18+)
├── App/                            Entry point, root view
├── Theme/                          Design tokens: color, motion, type
├── Networking/                     APIClient + generated types
├── Auth/                           3 sign-in methods + App Attest
└── Features/                       Onboarding · Home · Verdict · Settings
CallerIDExtension/                  Live Caller ID Lookup Extension target
```

## Sign-in methods

Three user-facing options:
1. **Sign in with Apple** (required by App Store when any third-party auth is offered)
2. **Email + password** (for people outside the Apple ecosystem)
3. **Continue as Guest** (anonymous, device-ID bound, free tier only)

App Attest runs silently on top of all three — every backend call is signed with a hardware-attested key so the backend can reject forged clients.

## Backend

Requires the AegisDial backend running at `APIConfig.baseURL`. For local dev, use your Mac's IP (e.g., `http://192.168.86.41:3000`) so the iOS device on the same WiFi can reach it.
