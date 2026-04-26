import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Compile-time-injected API URL. Codemagic passes via --dart-define=API_URL=...
const String kApiUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'https://aegisdial-production.fly.dev',
);

class ApiException implements Exception {
  final int statusCode;
  final String message;
  final String? code;
  ApiException(this.statusCode, this.message, {this.code});
  @override
  String toString() => 'ApiException($statusCode, $message)';
}

class ApiService {
  ApiService._();
  static final ApiService instance = ApiService._();

  String? _token;
  String get baseUrl => kApiUrl;

  void setToken(String? token) {
    _token = token;
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  Future<Map<String, dynamic>> get(String path) async {
    final res = await http
        .get(Uri.parse('$baseUrl$path'), headers: _headers)
        .timeout(const Duration(seconds: 20));
    return _handle(res);
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl$path'),
          headers: _headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 20));
    return _handle(res);
  }

  Map<String, dynamic> _handle(http.Response res) {
    Map<String, dynamic> body = {};
    try {
      if (res.body.isNotEmpty) {
        final decoded = jsonDecode(res.body);
        if (decoded is Map<String, dynamic>) body = decoded;
      }
    } catch (_) {}

    if (res.statusCode >= 200 && res.statusCode < 300) return body;

    final code = body['error']?.toString();
    final msg = body['message']?.toString() ??
        switch (res.statusCode) {
          401 => 'Session expired. Please sign in again.',
          403 => 'Permission denied.',
          404 => 'Not found.',
          429 => 'Too many requests. Try again in a moment.',
          >= 500 => 'Server error. Please try again.',
          _ => body['error']?.toString() ?? 'Request failed (${res.statusCode}).',
        };
    throw ApiException(res.statusCode, msg, code: code);
  }
}

final api = ApiService.instance;
