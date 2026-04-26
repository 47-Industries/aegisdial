import Foundation

enum APIConfig {
  // Local-dev default. When running the app on a physical device on the same
  // WiFi as your Mac, change this to your Mac's IP — e.g. http://192.168.86.41:3000.
  // For production builds you can flip this via xcconfig or an Info.plist key.
  #if DEBUG
  static let baseURL = URL(string: "http://127.0.0.1:3000")!
  #else
  static let baseURL = URL(string: "https://api.aegisdial.com")!
  #endif

  static let timeout: TimeInterval = 10
  static let bundleID = "com.aegisdial.app"

  // APNs topic environment. DEBUG builds use sandbox (development push
  // key), release builds use production.
  #if DEBUG
  static let pushEnvironment = "sandbox"
  #else
  static let pushEnvironment = "production"
  #endif
}
