import Foundation

// Lightweight Codable wrapper for heterogeneous JSON values. Used in
// evidence payload (user notes, amounts, wallet addresses — each row
// has a different shape). Decodes strings, numbers, bools, null,
// nested arrays and objects. Not a full JSONValue — just enough.

public struct AnyCodable: Codable, Hashable, Sendable {
  public let value: Any

  public init(_ value: Any) { self.value = value }

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { value = NSNull() }
    else if let b = try? c.decode(Bool.self) { value = b }
    else if let i = try? c.decode(Int.self)  { value = i }
    else if let d = try? c.decode(Double.self) { value = d }
    else if let s = try? c.decode(String.self) { value = s }
    else if let a = try? c.decode([AnyCodable].self) { value = a.map(\.value) }
    else if let o = try? c.decode([String: AnyCodable].self) {
      value = o.mapValues(\.value)
    }
    else { value = NSNull() }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch value {
    case is NSNull: try c.encodeNil()
    case let b as Bool: try c.encode(b)
    case let i as Int: try c.encode(i)
    case let d as Double: try c.encode(d)
    case let s as String: try c.encode(s)
    case let a as [Any]: try c.encode(a.map(AnyCodable.init))
    case let o as [String: Any]: try c.encode(o.mapValues(AnyCodable.init))
    default: try c.encodeNil()
    }
  }

  public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
    switch (lhs.value, rhs.value) {
    case (is NSNull, is NSNull): return true
    case (let a as Bool, let b as Bool): return a == b
    case (let a as Int, let b as Int): return a == b
    case (let a as Double, let b as Double): return a == b
    case (let a as String, let b as String): return a == b
    default: return false
    }
  }

  public func hash(into hasher: inout Hasher) {
    switch value {
    case let b as Bool: hasher.combine(b)
    case let i as Int: hasher.combine(i)
    case let d as Double: hasher.combine(d)
    case let s as String: hasher.combine(s)
    default: hasher.combine(0)
    }
  }
}

// Sugar: treat `[String: AnyCodable]` like a regular dictionary of Any
// for callers that want primary values without unwrapping.
public extension Dictionary where Key == String, Value == AnyCodable {
  subscript(any key: String) -> Any? {
    get { self[key]?.value }
  }
}
