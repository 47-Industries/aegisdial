import 'package:flutter/services.dart';

/// Bridge to iOS extensions (SMS Filter + Call Directory).
///
/// Writes scam data to the App Group shared container so the extensions
/// can read it. The extensions run in separate processes and can't
/// access Flutter's runtime — UserDefaults in the shared App Group
/// is the communication channel.
///
/// SMS Filter extension reads:
///   - aegis_scam_phrases: [String] — additional scam phrases beyond built-in
///   - aegis_blocked_senders: [String] — sender strings to auto-junk
///
/// Call Directory extension reads:
///   - aegis_blocked_numbers: [Int64] — E.164 numbers to block
///   - aegis_labeled_numbers: [{n: Int64, l: String}] — caller ID labels
class ExtensionBridgeService {
  ExtensionBridgeService._();
  static final ExtensionBridgeService instance = ExtensionBridgeService._();

  static const _channel = MethodChannel('aegisdial/extensions');

  /// Push scam phrases to the shared container. The SMS Filter extension
  /// merges these with its built-in phrase list.
  Future<bool> pushScamPhrases(List<String> phrases) async {
    try {
      final result = await _channel.invokeMethod<bool>(
        'pushScamPhrases',
        {'phrases': phrases},
      );
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Push blocked sender strings. The SMS Filter extension auto-junks
  /// any message whose sender contains one of these strings.
  Future<bool> pushBlockedSenders(List<String> senders) async {
    try {
      final result = await _channel.invokeMethod<bool>(
        'pushBlockedSenders',
        {'senders': senders},
      );
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Push blocked phone numbers for the Call Directory extension.
  /// Numbers must be in E.164 Int64 format (e.g. 18005551234).
  Future<bool> pushBlockedNumbers(List<int> numbers) async {
    try {
      final result = await _channel.invokeMethod<bool>(
        'pushBlockedNumbers',
        {'numbers': numbers},
      );
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Push labeled numbers for caller ID. Each entry is {number, label}.
  Future<bool> pushLabeledNumbers(List<Map<String, dynamic>> entries) async {
    try {
      final result = await _channel.invokeMethod<bool>(
        'pushLabeledNumbers',
        {'entries': entries},
      );
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Tell iOS to reload the Call Directory extension so new blocked/labeled
  /// numbers take effect immediately.
  Future<bool> reloadCallDirectory() async {
    try {
      final result = await _channel.invokeMethod<bool>('reloadCallDirectory');
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Check if the SMS Filter extension is enabled in iOS Settings.
  Future<bool> isSMSFilterEnabled() async {
    try {
      final result = await _channel.invokeMethod<bool>('isSMSFilterEnabled');
      return result ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Check Call Directory extension status.
  Future<String> callDirectoryStatus() async {
    try {
      final result =
          await _channel.invokeMethod<String>('callDirectoryStatus');
      return result ?? 'unknown';
    } on PlatformException {
      return 'unknown';
    }
  }
}

final extensionBridge = ExtensionBridgeService.instance;
