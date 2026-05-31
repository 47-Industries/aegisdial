import 'api_service.dart';

class GuardianService {
  GuardianService._();
  static final GuardianService instance = GuardianService._();

  Future<Map<String, dynamic>?> respondToChallenge({
    required String challengeId,
    required String answer,
  }) async {
    try {
      final res = await api.post(
        '/v1/guardian/challenge/$challengeId/respond',
        {'answer': answer},
      );
      return res;
    } on ApiException {
      rethrow;
    } catch (_) {
      return null;
    }
  }
}

final guardianService = GuardianService.instance;
