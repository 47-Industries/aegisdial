import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import '../services/live_shield_service.dart';
import '../widgets/live_shield_consent_v2_sheet.dart';
import 'recovery_chatbot_screen.dart';

class LiveShieldActiveScreen extends StatefulWidget {
  const LiveShieldActiveScreen({super.key});

  @override
  State<LiveShieldActiveScreen> createState() => _LiveShieldActiveScreenState();
}

enum _DemoPhase { idle, ringing, transcribing, verdict, done }
enum _LivePhase { idle, listening, stopped }

// A single demo scenario. Plays a 5-line transcript with a rising fraud
// score, then surfaces the v4 counter-script card (mid-call when the
// score crosses 60) and a "why this was a scam" panel on verdict.
//
// `playbookId` matches the canonical v4 backend playbook IDs (see
// `_formatPlaybookLabel`). When the live backend session returns its
// own counter_scripts (V4_PLAYBOOK_COACHING_ENABLED + ≥0.7 confidence),
// they overwrite the canned `counterScripts` here. Seeding them locally
// means demo mode renders the killer feature even when the v4 brain is
// dormant on the backend.
//
// `tellTales` is demo-only — it's the educational "why this is a scam"
// list that surfaces below the verdict. Real backend sessions don't
// produce these (yet) so they live on the client.
class _DemoScenario {
  final String name;
  final String number;
  final String playbookId;
  final List<String> lines;
  final List<int> scores;
  final List<String> counterScripts;
  final List<String> tellTales;
  const _DemoScenario({
    required this.name,
    required this.number,
    required this.playbookId,
    required this.lines,
    required this.scores,
    required this.counterScripts,
    required this.tellTales,
  });
}

const _kScenarios = [
  _DemoScenario(
    name: 'IRS Impersonation',
    number: '+1 (877) 234-5678',
    playbookId: 'irs_impersonation',
    lines: [
      'Hello, this is Agent Williams from the Internal Revenue Service.',
      'Your Social Security number has been suspended due to suspicious activity.',
      'A federal arrest warrant has been issued in your name.',
      'To avoid immediate arrest, press 1 or stay on the line.',
      'You owe \$4,280 in back taxes. Payment must be made via gift cards today.',
    ],
    scores: [12, 31, 58, 77, 94],
    counterScripts: [
      'Send me a notice in the mail. The IRS never demands payment by phone.',
      'Give me your name and badge number — I\'ll call the IRS at the official number to verify.',
      'I\'m hanging up. If this is real, you\'ll mail me a CP-14 notice.',
    ],
    tellTales: [
      'IRS contacts taxpayers by mail first — never by phone with arrest threats',
      'Demanded payment in gift cards — no government agency accepts gift cards',
      'Threatened immediate arrest — real federal warrants don\'t come with a phone option',
      'Caller ID can spoof any number, including "IRS"',
    ],
  ),
  _DemoScenario(
    name: 'Bank Fraud Alert',
    number: '+1 (800) 935-9935',
    playbookId: 'bank_impersonation',
    lines: [
      'This is the Wells Fargo fraud prevention team.',
      'We detected a \$2,400 unauthorized charge in Miami on your account.',
      'To protect your funds, we need to move your balance to a secure holding account.',
      'Please confirm your full debit card number and the CVV on the back.',
      'This hold is temporary — funds return within 24 hours once verified.',
    ],
    scores: [8, 28, 52, 79, 96],
    counterScripts: [
      'I\'ll hang up and call the number on the back of my card to verify.',
      'My bank already has my card number — they don\'t ask me for it.',
      'Send me a secure message in the banking app. I\'ll respond there.',
    ],
    tellTales: [
      'Asked for full card number + CVV — your bank already has this data on file',
      'Wanted to move funds to a "secure holding account" — real banks freeze fraud, they don\'t move money',
      'Used urgency to skip verification — real banks let you call back any time',
      'Spoofed the actual Wells Fargo fraud-line caller ID',
    ],
  ),
  _DemoScenario(
    name: 'Tech Support',
    number: '+1 (888) 277-4537',
    playbookId: 'tech_support_scam',
    lines: [
      'Hi, this is Apple Support calling about your Apple ID.',
      'We detected three unauthorized sign-ins from Russia and China.',
      'Your account will be permanently locked in 30 minutes unless we act now.',
      'I need you to install AnyDesk so our security team can remove the threat.',
      'Please also provide your Apple ID password so we can reset your 2FA today.',
    ],
    scores: [10, 24, 49, 73, 97],
    counterScripts: [
      'Apple never makes outbound support calls. I\'ll check my Apple ID at appleid.apple.com.',
      'I\'m not installing remote-access software for an unsolicited caller. Goodbye.',
      'Send me your case number in writing. I\'ll contact Apple Support directly.',
    ],
    tellTales: [
      'Apple does not make outbound support calls — verify any "Apple" contact at appleid.apple.com',
      'AnyDesk / TeamViewer install request — remote-access tools are how scammers drain accounts',
      'Demanded password to "fix" the issue — no legitimate company asks for your password',
      'Fake 30-minute lockout window to skip verification',
    ],
  ),
  _DemoScenario(
    name: 'Grandparent Scam',
    number: '+1 (305) 555-0184',
    playbookId: 'grandparent_scam',
    lines: [
      'Grandma? It\'s me. Don\'t tell mom and dad, but I\'m in trouble.',
      'I was in a car accident in Mexico and the police arrested me.',
      'My lawyer says we need \$3,000 in gift cards to make the charges go away.',
      'Please don\'t call mom — she\'ll be so upset. Just send the cards now.',
      'I\'m scared, grandma. The officer is letting me make one more call.',
    ],
    scores: [18, 42, 71, 86, 93],
    counterScripts: [
      'I\'m calling your parents to confirm. Stay on the line.',
      'Tell me the family code word we agreed on.',
      'What\'s the name of the police station and the case number? I\'ll send help directly.',
    ],
    tellTales: [
      'Wouldn\'t share name — real grandkids identify themselves',
      'Asked to keep it secret from parents — isolation tactic to prevent verification',
      'Demanded gift cards for bail — no court system accepts gift cards',
      'AI voice cloning makes these calls more believable — always verify on a second channel',
    ],
  ),
  _DemoScenario(
    name: 'Social Security',
    number: '+1 (800) 772-1213',
    playbookId: 'ssa_impersonation',
    lines: [
      'This is the Social Security Administration\'s fraud department.',
      'Your Social Security number has been linked to three crimes including drug trafficking.',
      'Your benefits will be suspended in 24 hours unless we verify your identity.',
      'I need your full SSN and date of birth to confirm you\'re not involved.',
      'To protect your funds, transfer them to our federal safe account today.',
    ],
    scores: [14, 38, 65, 82, 95],
    counterScripts: [
      'SSA does not suspend SSNs by phone. I\'ll check at ssa.gov/myaccount.',
      'Mail me the case file. I won\'t share my SSN with an unsolicited caller.',
      'I\'m reporting this call to oig.ssa.gov.',
    ],
    tellTales: [
      'Real SSNs cannot be "suspended" — that is not how Social Security works',
      'Asked for SSN + DOB — SSA already has these on file',
      'Threatened benefit suspension — SSA mails formal notices, never phones with threats',
      'Federal "safe account" is fictional — no government agency moves your money',
    ],
  ),
  _DemoScenario(
    name: 'Police Warrant',
    number: '+1 (212) 555-0193',
    playbookId: 'police_warrant_scam',
    lines: [
      'This is Detective Roberts with the county sheriff\'s office.',
      'You missed federal jury duty last month and a bench warrant has been issued.',
      'To avoid arrest at your home, you can post bond by phone today.',
      'I\'ll need a \$1,200 bond paid in Bitcoin or gift cards within the hour.',
      'Stay on the line — disconnecting will activate the warrant immediately.',
    ],
    scores: [16, 40, 68, 84, 96],
    counterScripts: [
      'Give me the case number. I\'ll call the court clerk directly.',
      'Police don\'t accept bonds over the phone. I\'m hanging up.',
      'If there\'s a warrant, mail it to me — I won\'t pay an unverified call.',
    ],
    tellTales: [
      'Police do not call about warrants — they show up in person or mail a summons',
      'No US court accepts bail in Bitcoin or gift cards',
      '"Disconnecting activates the warrant" — pressure tactic with no legal basis',
      'Real jury-duty failures result in a mailed notice, never a phone arrest threat',
    ],
  ),
  _DemoScenario(
    name: 'Utility Shutoff',
    number: '+1 (888) 555-0162',
    playbookId: 'utility_shutoff_scam',
    lines: [
      'This is Con Edison\'s payment department.',
      'Your account is two cycles overdue and shutoff is scheduled in 90 minutes.',
      'To prevent disconnection during this heatwave, please pay \$487 now.',
      'I can take payment by prepaid card — Vanilla, Green Dot, or MyVanilla.',
      'A technician is already en route — only payment will turn him around.',
    ],
    scores: [12, 36, 60, 78, 92],
    counterScripts: [
      'I\'ll call the number on my last bill to verify the balance.',
      'Utilities don\'t accept prepaid cards. I\'m hanging up.',
      'Send me a written shutoff notice — that\'s the legal requirement.',
    ],
    tellTales: [
      'Utility companies are legally required to send written shutoff notices',
      'Prepaid / gift cards are never accepted by real utility billing',
      '90-minute shutoff window doesn\'t exist — minimum notice is days',
      'Caller ID is easily spoofed to show the real utility\'s number',
    ],
  ),
  _DemoScenario(
    name: 'Lottery Winner',
    number: '+1 (876) 555-0100',
    playbookId: 'sweepstakes_lottery_scam',
    lines: [
      'Congratulations! You\'ve won the Publishers Clearing House \$2.5 million prize.',
      'To release the funds we need to verify your identity and tax info.',
      'There\'s a one-time processing fee of \$899 to cover federal tax withholding.',
      'Pay via Western Union or iTunes cards to your prize coordinator — me.',
      'Don\'t tell anyone yet — winners must keep it confidential for legal reasons.',
    ],
    scores: [10, 32, 58, 81, 94],
    counterScripts: [
      'Real sweepstakes don\'t ask winners to pay fees up front.',
      'Send me a written prize-claim form. I won\'t pay anything by phone.',
      'I never entered. I\'m hanging up.',
    ],
    tellTales: [
      'Legitimate lotteries deduct taxes from the prize — winners never pay up front',
      'Asking for iTunes cards / Western Union is a universal scam signal',
      '"Keep it confidential" isolates you from people who\'d verify',
      'If you didn\'t enter, you didn\'t win — period',
    ],
  ),
  _DemoScenario(
    name: 'Crypto Recovery',
    number: '+1 (650) 555-0143',
    playbookId: 'crypto_investment_scam',
    lines: [
      'Hi, I\'m calling from Binance Recovery Services.',
      'Our records show you lost \$4,200 in the recent Celsius collapse.',
      'I can recover 80% of that for you through our blockchain insurance program.',
      'Just send a \$500 retainer to this wallet address and I\'ll start the recovery.',
      'We\'ve helped 12,000 investors. The window closes today — act fast.',
    ],
    scores: [11, 34, 62, 79, 95],
    counterScripts: [
      'Recovery services that demand crypto up front are themselves the scam.',
      'I\'ll contact Binance support directly through binance.com.',
      'I\'m reporting this to ic3.gov.',
    ],
    tellTales: [
      'Real exchanges don\'t operate "recovery" services — that\'s a follow-on scam targeting prior victims',
      'Asks to send crypto to recover crypto — irreversible by design',
      '"Window closes today" — urgency to skip due diligence',
      'Targets people who already lost money in known collapses (Celsius, FTX, Voyager)',
    ],
  ),
];

class _DemoCall {
  final List<String> lines;
  final int score;
  final String scenarioName;
  _DemoCall(this.lines, this.score, this.scenarioName);
}

class _LiveShieldActiveScreenState extends State<LiveShieldActiveScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _wave;

  _DemoPhase _demoPhase = _DemoPhase.idle;
  _LivePhase _livePhase = _LivePhase.idle;
  bool _isLiveMode = false; // true = real mic, false = demo scenarios
  int _scenarioIndex = 0;
  final List<String> _transcript = [];
  int _fraudScore = 0;
  Timer? _demoTimer;
  final List<_DemoCall> _callHistory = [];

  // Speech-to-text for live mode
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _speechAvailable = false;
  String _currentPartial = ''; // partial recognition before finalization
  String? _lastDetectedType; // scam type label for live verdict

  // Backend integration state. When `_sessionId` is non-null the demo is
  // also driving a real /v1/live-shield session — the score we render is
  // what the v2 hybrid engine returned (regex + Claude). When null we
  // fall back to scripted scores so the demo still works for non-Pro
  // accounts, offline, or any backend hiccup.
  String? _sessionId;
  String? _coachingLine;
  // v4 — counter-script coaching surface. Populated when the backend's
  // playbook classifier locks on with ≥0.7 confidence AND
  // V4_PLAYBOOK_COACHING_ENABLED is on. iOS renders these as a numbered
  // card below the v2 coaching line.
  List<String> _counterScripts = const [];
  String? _v4PlaybookId;
  int _backendChunkSeq = 0;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
    _wave = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat();
  }

  @override
  void dispose() {
    _pulse.dispose();
    _wave.dispose();
    _demoTimer?.cancel();
    if (_speech.isListening) _speech.stop();
    super.dispose();
  }

  Future<void> _runDemo() async {
    if (_demoPhase != _DemoPhase.idle && _demoPhase != _DemoPhase.done) return;

    // Surface the v2 consent sheet on first run after install. If the
    // user declines, we still run the demo — the backend session just
    // opens as consent_version=1 (regex-only, no coaching line). The
    // decline path is intentional: we never block a user from seeing
    // the demo just because they don't want LLM coaching today.
    await showLiveShieldConsentV2Sheet(context);
    if (!mounted) return;

    final scenario = _kScenarios[_scenarioIndex];
    setState(() {
      _demoPhase = _DemoPhase.ringing;
      _transcript.clear();
      _fraudScore = 0;
      _coachingLine = null;
      _counterScripts = const [];
      _v4PlaybookId = null;
      _sessionId = null;
      _backendChunkSeq = 0;
    });
    HapticFeedback.heavyImpact();

    // Kick off a real backend session in parallel with the "ringing"
    // animation. If this Pro-gated call fails (non-Pro, offline, 5xx)
    // we just won't have a session_id and the demo runs in fallback
    // mode with scripted scores. Never blocks the user-facing flow.
    final startFuture = liveShield.start(peerNumber: scenario.number);

    await Future.delayed(const Duration(milliseconds: 1800));
    if (!mounted) return;
    final startResult = await startFuture;
    if (mounted && startResult != null) {
      _sessionId = startResult.sessionId;
    }
    setState(() => _demoPhase = _DemoPhase.transcribing);

    const delays = [0, 1400, 1600, 1500, 1700];
    for (int i = 0; i < scenario.lines.length; i++) {
      await Future.delayed(Duration(milliseconds: delays[i]));
      if (!mounted) return;
      final line = scenario.lines[i];
      setState(() {
        _transcript.add(line);
        // Optimistic: show scripted score immediately. If backend
        // returns one for this chunk we'll overwrite it below.
        _fraudScore = scenario.scores[i];
        // Surface the v4 counter-script card mid-call when the
        // scripted score crosses the same ≥0.7-confidence threshold
        // the real backend uses. This lets demo mode show the killer
        // feature even when V4_PLAYBOOK_COACHING_ENABLED is false on
        // the backend (current production state). If the backend IS
        // on and returns its own counter_scripts, the chunk handler
        // below overwrites with the live values.
        if (scenario.scores[i] >= 60 && _counterScripts.isEmpty) {
          _counterScripts = scenario.counterScripts;
          _v4PlaybookId = scenario.playbookId;
        }
      });
      HapticFeedback.selectionClick();

      // Send the chunk to the backend (if we got a session). Backend
      // computes its own score from the same line — if it differs from
      // the scripted score it's because the real v2 engine had a
      // different read, which is exactly what we want to surface.
      final sid = _sessionId;
      if (sid != null) {
        final chunkResult = await liveShield.sendChunk(
          sessionId: sid,
          seq: _backendChunkSeq++,
          text: line,
          speaker: 'caller',
        );
        if (chunkResult != null && mounted) {
          setState(() {
            _fraudScore = chunkResult.riskScore;
            if (chunkResult.coachingLine != null) {
              _coachingLine = chunkResult.coachingLine;
            }
            // v4 counter-scripts only update when the backend returns a
            // non-empty list — once the playbook locks on it tends to
            // stay locked for the rest of the call, so we don't want a
            // momentary null to erase the card mid-demo.
            if (chunkResult.v4CounterScripts.isNotEmpty) {
              _counterScripts = chunkResult.v4CounterScripts;
              _v4PlaybookId = chunkResult.v4PlaybookId;
            }
          });
        }
      }
    }

    await Future.delayed(const Duration(milliseconds: 600));
    if (!mounted) return;
    setState(() => _demoPhase = _DemoPhase.verdict);
    HapticFeedback.heavyImpact();
  }

  /// Hand off to the Recovery companion with v4 playbook context preloaded
  /// as the user's first message. The companion's `/v1/recovery/companion/
  /// quick` endpoint will then ground its first reply on the actual scam
  /// type instead of asking the user to re-explain everything. Falls back
  /// to a generic "I just got a scam call" prompt if v4 didn't lock onto
  /// a playbook (regex-only path, or score below the v4 threshold).
  void _openRecovery() {
    // Stop the active backend session before navigating — the recovery
    // screen runs in a separate scope and we don't want a stale Live
    // Shield session hanging open while the user is in recovery chat.
    final sid = _sessionId;
    if (sid != null) {
      liveShield.end(sessionId: sid, outcome: 'handed_off_to_recovery');
    }

    final playbookLabel = _v4PlaybookId != null
        ? _formatPlaybookLabel(_v4PlaybookId!)
        : null;
    final lastLines = _transcript
        .where((l) => l.trim().isNotEmpty)
        .toList()
        .reversed
        .take(3)
        .toList()
        .reversed
        .join(' · ');

    final preload = playbookLabel != null
        ? "I just got a $playbookLabel scam call. The scammer said: \"$lastLines\". What should I do first?"
        : "I just got a scam call. The caller said: \"$lastLines\". What should I do first?";

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => RecoveryChatbotScreen(initialContext: preload),
      ),
    );
  }

  void _dismissDemo() {
    if (_demoPhase == _DemoPhase.verdict) {
      // Close the backend session if one was opened. Use `user_hung_up`
      // because tapping "Block" on the verdict card is the closest
      // analogue to disengaging the call — and that's the outcome the
      // backend uses to fire the `call_blocked` analytic.
      final sid = _sessionId;
      if (sid != null) {
        liveShield.end(sessionId: sid, outcome: 'user_hung_up');
      }
      setState(() {
        _callHistory.insert(0, _DemoCall(
          List.from(_transcript), _fraudScore,
          _kScenarios[_scenarioIndex].name,
        ));
        _demoPhase = _DemoPhase.done;
        _transcript.clear();
        _fraudScore = 0;
        _coachingLine = null;
        _counterScripts = const [];
        _v4PlaybookId = null;
        _sessionId = null;
      });
      Future.delayed(const Duration(milliseconds: 400), () {
        if (mounted) setState(() => _demoPhase = _DemoPhase.idle);
      });
    }
  }

  // ── Live listening mode ──────────────────────────────────────────────────

  Future<void> _startListening() async {
    await showLiveShieldConsentV2Sheet(context);
    if (!mounted) return;

    if (!_speechAvailable) {
      _speechAvailable = await _speech.initialize(
        onError: (e) {
          if (!mounted) return;
          // speech_not_recognized is not a real error — just silence
          if (e.errorMsg == 'error_speech_timeout' ||
              e.errorMsg == 'error_no_match') {
            // Restart listening — the user may still be on the call
            if (_livePhase == _LivePhase.listening) _restartListening();
            return;
          }
        },
        onStatus: (status) {
          // Auto-restart when recognition completes a segment (iOS sends
          // 'notListening' after each final result). This keeps the mic
          // open continuously without the user having to re-tap.
          if (status == 'notListening' &&
              _livePhase == _LivePhase.listening &&
              mounted) {
            _restartListening();
          }
        },
      );
    }

    if (!_speechAvailable) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Microphone unavailable. Check Settings > Privacy > Microphone.',
            ),
          ),
        );
      }
      return;
    }

    setState(() {
      _isLiveMode = true;
      _livePhase = _LivePhase.listening;
      _demoPhase = _DemoPhase.idle;
      _transcript.clear();
      _fraudScore = 0;
      _coachingLine = null;
      _counterScripts = const [];
      _v4PlaybookId = null;
      _sessionId = null;
      _backendChunkSeq = 0;
      _currentPartial = '';
      _lastDetectedType = null;
    });
    HapticFeedback.heavyImpact();

    // Start a real backend session
    final startResult = await liveShield.start();
    if (mounted && startResult != null) {
      _sessionId = startResult.sessionId;
    }

    _beginSpeechRecognition();
  }

  void _beginSpeechRecognition() {
    _speech.listen(
      onResult: (result) {
        if (!mounted) return;
        setState(() {
          _currentPartial = result.recognizedWords;
        });
        if (result.finalResult && result.recognizedWords.trim().isNotEmpty) {
          _onFinalizedUtterance(result.recognizedWords.trim());
        }
      },
      listenFor: const Duration(seconds: 30),
      pauseFor: const Duration(seconds: 3),
      localeId: 'en_US',
      listenOptions: stt.SpeechListenOptions(
        partialResults: true,
        listenMode: stt.ListenMode.dictation,
      ),
    );
  }

  void _restartListening() {
    if (!mounted || _livePhase != _LivePhase.listening) return;
    // Small delay to avoid rapid restart loops
    Future.delayed(const Duration(milliseconds: 200), () {
      if (!mounted || _livePhase != _LivePhase.listening) return;
      _beginSpeechRecognition();
    });
  }

  Future<void> _onFinalizedUtterance(String text) async {
    setState(() {
      _transcript.add(text);
      _currentPartial = '';
    });
    HapticFeedback.selectionClick();

    // Send to backend for real scoring
    final sid = _sessionId;
    if (sid != null) {
      final chunkResult = await liveShield.sendChunk(
        sessionId: sid,
        seq: _backendChunkSeq++,
        text: text,
        speaker: 'caller',
      );
      if (chunkResult != null && mounted) {
        setState(() {
          _fraudScore = chunkResult.riskScore;
          if (chunkResult.coachingLine != null) {
            _coachingLine = chunkResult.coachingLine;
          }
          if (chunkResult.v4CounterScripts.isNotEmpty) {
            _counterScripts = chunkResult.v4CounterScripts;
            _v4PlaybookId = chunkResult.v4PlaybookId;
          }
          if (chunkResult.llmScamType != null) {
            _lastDetectedType = chunkResult.llmScamType;
          }
        });
      }
    }
  }

  Future<void> _stopListening() async {
    await _speech.stop();
    final sid = _sessionId;
    if (sid != null) {
      liveShield.end(sessionId: sid, outcome: 'user_hung_up');
    }
    if (!mounted) return;
    setState(() {
      _livePhase = _LivePhase.stopped;
      if (_transcript.isNotEmpty) {
        _callHistory.insert(0, _DemoCall(
          List.from(_transcript),
          _fraudScore,
          _lastDetectedType != null
              ? _formatPlaybookLabel(_lastDetectedType!)
              : 'Live call',
        ));
      }
    });
    HapticFeedback.heavyImpact();
    // Return to idle after brief pause
    Future.delayed(const Duration(milliseconds: 600), () {
      if (mounted) {
        setState(() {
          _livePhase = _LivePhase.idle;
          _isLiveMode = false;
        });
      }
    });
  }

  void _openRecoveryFromLive() {
    final sid = _sessionId;
    if (sid != null) {
      liveShield.end(sessionId: sid, outcome: 'handed_off_to_recovery');
    }
    _speech.stop();

    final playbookLabel = _v4PlaybookId != null
        ? _formatPlaybookLabel(_v4PlaybookId!)
        : _lastDetectedType != null
            ? _formatPlaybookLabel(_lastDetectedType!)
            : null;
    final lastLines = _transcript
        .where((l) => l.trim().isNotEmpty)
        .toList()
        .reversed
        .take(3)
        .toList()
        .reversed
        .join(' · ');

    final preload = playbookLabel != null
        ? "I just got a $playbookLabel scam call. The scammer said: \"$lastLines\". What should I do first?"
        : "I just got a scam call. The caller said: \"$lastLines\". What should I do first?";

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => RecoveryChatbotScreen(initialContext: preload),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isLive = _isLiveMode && _livePhase == _LivePhase.listening;
    return Scaffold(
      backgroundColor: AegisColors.background,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close_rounded, size: 24),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'LIVE SHIELD',
              style: tt.labelMedium?.copyWith(
                color: AegisColors.turquoise,
                letterSpacing: 2.5,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: isLive
                    ? AegisColors.success.withValues(alpha: 0.18)
                    : AegisColors.warning.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(4),
                border: Border.all(
                  color: isLive
                      ? AegisColors.success.withValues(alpha: 0.55)
                      : AegisColors.warning.withValues(alpha: 0.55),
                  width: 1,
                ),
              ),
              child: Text(
                isLive ? 'LIVE' : 'DEMO',
                style: tt.labelSmall?.copyWith(
                  color: isLive ? AegisColors.success : AegisColors.warning,
                  letterSpacing: 1.6,
                  fontWeight: FontWeight.w800,
                  fontSize: 10,
                ),
              ),
            ),
          ],
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 60, speed: 0.12),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.black.withValues(alpha: 0.3),
                    Colors.black.withValues(alpha: 0.92),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: ListView(
              padding: const EdgeInsets.only(top: 8, bottom: 28),
              children: [
                _StatusHeader(isLive: isLive),
                const SizedBox(height: 12),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: AegisColors.surfaceElevated.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: AegisColors.border,
                        width: 0.8,
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          isLive
                              ? Icons.mic_rounded
                              : Icons.info_outline_rounded,
                          color: isLive
                              ? AegisColors.success
                              : AegisColors.textTertiary,
                          size: 16,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            isLive
                                ? 'Listening via speakerphone. Put your call on speaker and AegisDial will analyze it live.'
                                : 'Sample call. Tap "Start listening" to analyze a real call on speakerphone.',
                            style: tt.bodySmall?.copyWith(
                              color: isLive
                                  ? AegisColors.success
                                  : AegisColors.textSecondary,
                              height: 1.3,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  height: 240,
                  child: AnimatedBuilder(
                    animation: _pulse,
                    builder: (context, _) {
                      return Center(
                        child: SizedBox(
                          width: 240,
                          height: 240,
                          child: CustomPaint(
                            painter: _PulseRingsPainter(_pulse.value),
                            child: Center(
                              child: Container(
                                width: 110,
                                height: 110,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  gradient: LinearGradient(
                                    begin: Alignment.topLeft,
                                    end: Alignment.bottomRight,
                                    colors: [
                                      AegisColors.turquoise.withValues(
                                          alpha: 0.4 + _pulse.value * 0.4),
                                      AegisColors.blue,
                                    ],
                                  ),
                                  boxShadow: [
                                    BoxShadow(
                                      color: AegisColors.turquoise
                                          .withValues(alpha: 0.5),
                                      blurRadius: 30,
                                      spreadRadius: 4,
                                    ),
                                  ],
                                ),
                                child: const Icon(
                                  Icons.shield_moon,
                                  color: Colors.black,
                                  size: 50,
                                ),
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
                _Waveform(controller: _wave),
                const SizedBox(height: 16),
                // Active call / demo panel
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 300),
                  child: isLive
                      ? _LiveCallCard(
                          key: const ValueKey('live-real'),
                          number: 'Speakerphone',
                          scenarioName: _lastDetectedType != null
                              ? _formatPlaybookLabel(_lastDetectedType!)
                              : 'Analyzing...',
                          lines: [
                            ..._transcript,
                            if (_currentPartial.isNotEmpty) _currentPartial,
                          ],
                          score: _fraudScore,
                          verdict: false,
                          coachingLine: _coachingLine,
                          counterScripts: _counterScripts,
                          v4PlaybookId: _v4PlaybookId,
                          tellTales: const [],
                          onBlock: _stopListening,
                          onAnswer: _stopListening,
                          onRecovery: _openRecoveryFromLive,
                          isLive: true,
                          currentPartial: _currentPartial,
                          onStop: _stopListening,
                        )
                      : _demoPhase == _DemoPhase.ringing
                          ? _RingingCard(
                              number: _kScenarios[_scenarioIndex].number,
                              key: const ValueKey('ring'),
                            )
                          : _demoPhase == _DemoPhase.transcribing ||
                                  _demoPhase == _DemoPhase.verdict
                              ? _LiveCallCard(
                                  key: const ValueKey('live'),
                                  number: _kScenarios[_scenarioIndex].number,
                                  scenarioName: _kScenarios[_scenarioIndex].name,
                                  lines: _transcript,
                                  score: _fraudScore,
                                  verdict: _demoPhase == _DemoPhase.verdict,
                                  coachingLine: _coachingLine,
                                  counterScripts: _counterScripts,
                                  v4PlaybookId: _v4PlaybookId,
                                  tellTales: _kScenarios[_scenarioIndex].tellTales,
                                  onBlock: _dismissDemo,
                                  onAnswer: _dismissDemo,
                                  onRecovery: _openRecovery,
                                )
                              : _IdleCard(
                                  key: const ValueKey('idle'),
                                  onRunDemo: _runDemo,
                                  onStartListening: _startListening,
                                  selectedIndex: _scenarioIndex,
                                  onSelectScenario: (i) =>
                                      setState(() => _scenarioIndex = i),
                                ),
                ),
                const SizedBox(height: 22),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Text(
                    'CALL HISTORY',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                if (_callHistory.isEmpty)
                  Container(
                    margin: const EdgeInsets.symmetric(horizontal: 20),
                    padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
                    decoration: BoxDecoration(
                      color: AegisColors.surface.withValues(alpha: 0.55),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AegisColors.border, width: 0.6),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.history_rounded,
                            color: AegisColors.textTertiary, size: 20),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'Run a demo below to see how AegisDial stops a scam call in real time.',
                            style: tt.bodySmall?.copyWith(
                              color: AegisColors.textTertiary,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ),
                  )
                else
                  ..._callHistory.map((c) => _CallHistoryTile(call: c)),
                const SizedBox(height: 14),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.lock_outline_rounded,
                        size: 14,
                        color: AegisColors.textTertiary,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          'Transcripts never leave your phone. Only the verdict (scam / safe) syncs.',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.textTertiary,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusHeader extends StatelessWidget {
  final bool isLive;
  const _StatusHeader({this.isLive = false});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final accent = isLive ? AegisColors.success : AegisColors.turquoise;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
        decoration: BoxDecoration(
          color: AegisColors.surface.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isLive
                ? AegisColors.success.withValues(alpha: 0.5)
                : AegisColors.border,
            width: isLive ? 1.2 : 0.6,
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: accent.withValues(alpha: 0.15),
                border: Border.all(color: accent, width: 1),
              ),
              child: Icon(
                isLive ? Icons.mic_rounded : Icons.graphic_eq_rounded,
                color: accent,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        isLive ? 'Listening live' : 'Shield is active',
                        style: tt.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: isLive
                              ? AegisColors.success.withValues(alpha: 0.18)
                              : AegisColors.warning.withValues(alpha: 0.18),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Text(
                          isLive ? 'LIVE' : 'DEMO',
                          style: TextStyle(
                            color: isLive
                                ? AegisColors.success
                                : AegisColors.warning,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.8,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    isLive
                        ? 'Analyzing speakerphone audio in real time. Keep the call on speaker.'
                        : 'Tap "Start listening" for a real call, or run a demo to see how it works.',
                    style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Waveform extends StatelessWidget {
  final AnimationController controller;
  const _Waveform({required this.controller});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return SizedBox(
          height: 30,
          child: CustomPaint(
            painter: _WaveformPainter(controller.value),
            size: const Size.fromHeight(30),
          ),
        );
      },
    );
  }
}

class _WaveformPainter extends CustomPainter {
  final double t;
  _WaveformPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 48;
    final barW = size.width / (bars * 2);
    final paint = Paint()
      ..color = AegisColors.turquoise
      ..strokeCap = StrokeCap.round
      ..strokeWidth = barW;
    final rng = Random(7);
    for (int i = 0; i < bars; i++) {
      final base = rng.nextDouble();
      final h = ((sin(t * 2 * pi + i * 0.4) + 1) / 2) * 0.6 + base * 0.4;
      final x = (i * 2 + 1) * barW;
      final hh = h * size.height;
      canvas.drawLine(
        Offset(x, size.height / 2 - hh / 2),
        Offset(x, size.height / 2 + hh / 2),
        paint..color = AegisColors.turquoise.withValues(alpha: 0.5 + h * 0.5),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WaveformPainter old) => old.t != t;
}

class _PulseRingsPainter extends CustomPainter {
  final double t;
  _PulseRingsPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    for (int i = 0; i < 3; i++) {
      final phase = ((t + i / 3) % 1.0);
      final r = 55 + phase * 65;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = AegisColors.turquoise.withValues(alpha: (1 - phase) * 0.5);
      canvas.drawCircle(c, r, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _PulseRingsPainter old) => old.t != t;
}

// ── Demo UI widgets ────────────────────────────────────────────────────────────

class _IdleCard extends StatelessWidget {
  final VoidCallback onRunDemo;
  final VoidCallback onStartListening;
  final int selectedIndex;
  final ValueChanged<int> onSelectScenario;
  const _IdleCard({
    super.key,
    required this.onRunDemo,
    required this.onStartListening,
    required this.selectedIndex,
    required this.onSelectScenario,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Ready to protect',
            style: tt.bodyMedium?.copyWith(
              color: AegisColors.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Put your call on speakerphone and tap "Start listening" below. AegisDial will transcribe and analyze in real time.',
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: onStartListening,
              icon: const Icon(Icons.mic_rounded, size: 20),
              label: const Text('Start listening'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AegisColors.turquoise,
                foregroundColor: Colors.black,
                minimumSize: const Size.fromHeight(52),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'OR TRY A DEMO',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
              fontSize: 10,
            ),
          ),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: List.generate(_kScenarios.length, (i) {
                final selected = i == selectedIndex;
                return Padding(
                  padding: EdgeInsets.only(right: i < _kScenarios.length - 1 ? 8 : 0),
                  child: GestureDetector(
                    onTap: () => onSelectScenario(i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 7),
                      decoration: BoxDecoration(
                        color: selected
                            ? AegisColors.turquoise.withValues(alpha: 0.15)
                            : AegisColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: selected
                              ? AegisColors.turquoise
                              : AegisColors.border,
                          width: selected ? 1.2 : 0.6,
                        ),
                      ),
                      child: Text(
                        _kScenarios[i].name,
                        style: TextStyle(
                          color: selected
                              ? AegisColors.turquoise
                              : AegisColors.textSecondary,
                          fontSize: 12,
                          fontWeight: selected
                              ? FontWeight.w700
                              : FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: onRunDemo,
              icon: const Icon(Icons.play_circle_outline_rounded, size: 17),
              label: const Text('Run demo — see a scam call stopped live'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AegisColors.turquoise,
                side: const BorderSide(color: AegisColors.turquoise, width: 0.8),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                textStyle: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RingingCard extends StatefulWidget {
  final String number;
  const _RingingCard({super.key, required this.number});

  @override
  State<_RingingCard> createState() => _RingingCardState();
}

class _RingingCardState extends State<_RingingCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ring;

  @override
  void initState() {
    super.initState();
    _ring = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ring.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: AegisColors.warning.withValues(alpha: 0.6),
          width: 1.2,
        ),
      ),
      child: Column(
        children: [
          AnimatedBuilder(
            animation: _ring,
            builder: (_, _) => Icon(
              Icons.phone_in_talk_rounded,
              size: 36,
              color: AegisColors.warning
                  .withValues(alpha: 0.5 + _ring.value * 0.5),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'Incoming call',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            widget.number,
            style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedBuilder(
                animation: _ring,
                builder: (_, _) => Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AegisColors.warning
                        .withValues(alpha: 0.4 + _ring.value * 0.6),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                'Analyzing caller…',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.warning,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _LiveCallCard extends StatelessWidget {
  final String number;
  final List<String> lines;
  final int score;
  final bool verdict;
  final String scenarioName;
  final String? coachingLine;
  final List<String> counterScripts;
  final String? v4PlaybookId;
  final List<String> tellTales;
  final VoidCallback onBlock;
  final VoidCallback onAnswer;
  final VoidCallback onRecovery;
  final bool isLive;
  final String? currentPartial;
  final VoidCallback? onStop;

  const _LiveCallCard({
    super.key,
    required this.number,
    required this.lines,
    required this.score,
    required this.verdict,
    required this.scenarioName,
    this.coachingLine,
    this.counterScripts = const [],
    this.v4PlaybookId,
    this.tellTales = const [],
    required this.onBlock,
    required this.onAnswer,
    required this.onRecovery,
    this.isLive = false,
    this.currentPartial,
    this.onStop,
  });

  Color get _scoreColor => score >= 70
      ? AegisColors.danger
      : score >= 40
          ? AegisColors.warning
          : AegisColors.success;

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      decoration: BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: verdict
              ? AegisColors.danger.withValues(alpha: 0.8)
              : AegisColors.border,
          width: verdict ? 1.5 : 0.6,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                const Icon(Icons.phone_in_talk_rounded,
                    size: 16, color: AegisColors.turquoise),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    number,
                    style: tt.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                // Fraud score badge
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _scoreColor.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    '$score% fraud',
                    style: TextStyle(
                      color: _scoreColor,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
          // v2 coaching banner — only present when the backend's LLM
          // returned a sanitized coaching line for this session. iOS
          // shows it above the transcript so the user has a concrete
          // line to say back ("Tell them you'll call back on the
          // official number...") at the moment they need it.
          if (coachingLine != null && coachingLine!.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              decoration: BoxDecoration(
                color: AegisColors.turquoise.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.turquoise.withValues(alpha: 0.35),
                  width: 0.8,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.auto_awesome_rounded,
                    size: 14,
                    color: AegisColors.turquoise,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'WHAT TO SAY',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.turquoise,
                            letterSpacing: 1.2,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          coachingLine!,
                          style: tt.bodySmall?.copyWith(
                            color: AegisColors.textPrimary,
                            height: 1.45,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          // v4 counter-script card — playbook-specific scripts the user
          // can read straight off the screen to disengage. Sourced from
          // the seeded `b4_playbooks.counter_scripts` array, top-N
          // strongest. Surfaces only when v4 classifier has locked on
          // ≥0.7 confidence AND backend's V4_PLAYBOOK_COACHING_ENABLED.
          if (counterScripts.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    AegisColors.blue.withValues(alpha: 0.14),
                    AegisColors.turquoise.withValues(alpha: 0.08),
                  ],
                ),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.blue.withValues(alpha: 0.35),
                  width: 0.8,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.menu_book_rounded,
                        size: 14,
                        color: AegisColors.blueAccent,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'SAY THIS TO MAKE THEM HANG UP',
                        style: tt.labelSmall?.copyWith(
                          color: AegisColors.blueAccent,
                          letterSpacing: 1.2,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (v4PlaybookId != null) ...[
                        const Spacer(),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: AegisColors.blue.withValues(alpha: 0.18),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            _formatPlaybookLabel(v4PlaybookId!),
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.blueAccent,
                              fontSize: 9,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 8),
                  for (int i = 0; i < counterScripts.length; i++)
                    Padding(
                      padding: EdgeInsets.only(
                          bottom: i == counterScripts.length - 1 ? 0 : 6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 18,
                            height: 18,
                            margin: const EdgeInsets.only(top: 1, right: 8),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: AegisColors.blue.withValues(alpha: 0.2),
                              border: Border.all(
                                color: AegisColors.blueAccent
                                    .withValues(alpha: 0.55),
                                width: 0.8,
                              ),
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              '${i + 1}',
                              style: TextStyle(
                                color: AegisColors.blueAccent,
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                                height: 1,
                              ),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              '"${counterScripts[i]}"',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textPrimary,
                                height: 1.45,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          // Transcript
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AegisColors.background.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'LIVE TRANSCRIPT',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    letterSpacing: 1.2,
                    fontSize: 9,
                  ),
                ),
                const SizedBox(height: 6),
                ...lines.map((l) => Padding(
                      padding: const EdgeInsets.only(bottom: 5),
                      child: Text(
                        '"$l"',
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textSecondary,
                          height: 1.4,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                    )),
              ],
            ),
          ),
          const SizedBox(height: 12),
          // Verdict banner
          if (verdict)
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 12),
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
              decoration: BoxDecoration(
                color: AegisColors.danger.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.danger.withValues(alpha: 0.5),
                  width: 0.8,
                ),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded,
                      color: AegisColors.danger, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'SCAM DETECTED',
                          style: TextStyle(
                            color: AegisColors.danger,
                            fontWeight: FontWeight.w800,
                            fontSize: 13,
                            letterSpacing: 0.8,
                          ),
                        ),
                        Text(
                          '$scenarioName · $score% confidence',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.danger.withValues(alpha: 0.8),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          // "Why this was a scam" insight panel — educational, demo-only.
          // Surfaces the specific signals that drove the verdict so the
          // user (or a family member watching the demo over their
          // shoulder) actually learns the pattern instead of just seeing
          // a red badge. Only renders when the scenario provides
          // tell-tales AND we've reached the verdict.
          if (verdict && tellTales.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
              decoration: BoxDecoration(
                color: AegisColors.surfaceElevated.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.border,
                  width: 0.6,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.lightbulb_outline_rounded,
                        size: 14,
                        color: AegisColors.warning,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'WHY THIS WAS A SCAM',
                        style: tt.labelSmall?.copyWith(
                          color: AegisColors.warning,
                          letterSpacing: 1.2,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  for (int i = 0; i < tellTales.length; i++)
                    Padding(
                      padding: EdgeInsets.only(
                          bottom: i == tellTales.length - 1 ? 0 : 6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 4,
                            height: 4,
                            margin: const EdgeInsets.only(top: 7, right: 10, left: 2),
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: AegisColors.warning,
                            ),
                          ),
                          Expanded(
                            child: Text(
                              tellTales[i],
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textSecondary,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          // Action buttons
          if (verdict) ...[
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: onBlock,
                          icon: const Icon(Icons.block_rounded, size: 16),
                          label: const Text('Block call'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AegisColors.danger,
                            foregroundColor: Colors.white,
                            padding:
                                const EdgeInsets.symmetric(vertical: 12),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: onAnswer,
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AegisColors.textSecondary,
                            side: const BorderSide(
                                color: AegisColors.border, width: 0.8),
                            padding:
                                const EdgeInsets.symmetric(vertical: 12),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                          child: const Text('Answer anyway'),
                        ),
                      ),
                    ],
                  ),
                  // v4 — if score is high enough that the caller may have
                  // already been pressured into sharing info or moving
                  // money, surface a direct hand-off to the Recovery
                  // companion preloaded with playbook context.
                  if (score >= 70) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: TextButton.icon(
                        onPressed: onRecovery,
                        icon: const Icon(
                          Icons.healing_rounded,
                          size: 16,
                          color: AegisColors.blueAccent,
                        ),
                        label: const Text(
                          'Get recovery help — talk to the AI companion',
                          style: TextStyle(
                            color: AegisColors.blueAccent,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          backgroundColor:
                              AegisColors.blueAccent.withValues(alpha: 0.08),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                            side: BorderSide(
                              color: AegisColors.blueAccent
                                  .withValues(alpha: 0.35),
                              width: 0.8,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ] else if (isLive) ...[
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: Column(
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: onStop,
                      icon: const Icon(Icons.stop_rounded, size: 18),
                      label: const Text('Stop listening'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AegisColors.danger,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                  ),
                  if (score >= 70) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: TextButton.icon(
                        onPressed: onRecovery,
                        icon: const Icon(
                          Icons.healing_rounded,
                          size: 16,
                          color: AegisColors.blueAccent,
                        ),
                        label: const Text(
                          'Get recovery help',
                          style: TextStyle(
                            color: AegisColors.blueAccent,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          backgroundColor:
                              AegisColors.blueAccent.withValues(alpha: 0.08),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                            side: BorderSide(
                              color: AegisColors.blueAccent
                                  .withValues(alpha: 0.35),
                              width: 0.8,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ] else
            const SizedBox(height: 14),
        ],
      ),
    );
  }
}

class _CallHistoryTile extends StatelessWidget {
  final _DemoCall call;
  const _CallHistoryTile({required this.call});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 0, 20, 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: AegisColors.danger.withValues(alpha: 0.3),
          width: 0.6,
        ),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(7),
            decoration: BoxDecoration(
              color: AegisColors.danger.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.block_rounded,
                color: AegisColors.danger, size: 16),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${call.scenarioName} · BLOCKED',
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                Text(
                  '${call.score}% fraud score · demo',
                  style: tt.labelSmall
                      ?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ),
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AegisColors.danger.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              '${call.score}%',
              style: TextStyle(
                color: AegisColors.danger,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// Convert v4 playbook id like 'irs_impersonation' to a short display
// label for the counter-script card tag — 'IRS' / 'BANK' / etc. If the
// id isn't in the canonical short-labels map we fall back to the full
// title-cased name truncated to 18 chars.
String _formatPlaybookLabel(String playbookId) {
  const shortLabels = <String, String>{
    'irs_impersonation': 'IRS',
    'ssa_impersonation': 'SSA',
    'medicare_impersonation': 'MEDICARE',
    'bank_impersonation': 'BANK',
    'tech_support_scam': 'TECH SUPPORT',
    'grandparent_scam': 'GRANDPARENT',
    'police_warrant_scam': 'POLICE',
    'utility_shutoff_scam': 'UTILITY',
    'romance_scam': 'ROMANCE',
    'sweepstakes_lottery_scam': 'LOTTERY',
    'gift_card_payment_scam': 'GIFT CARD',
    'crypto_investment_scam': 'CRYPTO',
    'charity_disaster_scam': 'CHARITY',
    'job_offer_scam': 'JOB OFFER',
  };
  final hit = shortLabels[playbookId];
  if (hit != null) return hit;
  final cleaned = playbookId.replaceAll('_', ' ').toUpperCase();
  return cleaned.length > 18 ? '${cleaned.substring(0, 17)}…' : cleaned;
}
