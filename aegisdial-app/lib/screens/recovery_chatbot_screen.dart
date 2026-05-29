import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../services/trial_service.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import '../services/purchase_service.dart';
import '../widgets/bank_lookup_sheet.dart';
import 'paywall_screen.dart';
import 'recovery_screen.dart';

class RecoveryChatbotScreen extends StatefulWidget {
  /// Optional context the caller wants the companion to ground its first
  /// reply in — used by Live Shield to hand off a just-ended call without
  /// making the user re-explain what happened. When set, the chat skips
  /// the generic greeting and immediately fires a backend call with this
  /// as the first user message.
  final String? initialContext;

  const RecoveryChatbotScreen({super.key, this.initialContext});

  @override
  State<RecoveryChatbotScreen> createState() => _RecoveryChatbotScreenState();
}

class _ChatMessage {
  final bool fromUser;
  final bool isLimit;
  final String text;
  const _ChatMessage({
    required this.fromUser,
    required this.text,
    this.isLimit = false,
  });

  Map<String, dynamic> toJson() => {'u': fromUser, 't': text};
  factory _ChatMessage.fromJson(Map<String, dynamic> j) => _ChatMessage(
        fromUser: j['u'] as bool,
        text: j['t'] as String,
      );
}

class _RecoveryChatbotScreenState extends State<RecoveryChatbotScreen> {
  static const _kChatKey = 'recovery_chat_history_v1';
  static const _kMaxMessages = 60;

  static const _quickPrompts = [
    'I just got scammed',
    'I sent money',
    'They got my passwords',
    'I\'m scared to tell my family',
    'What do I do first?',
  ];

  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_ChatMessage> _messages = [];
  bool _sending = false;

  bool _trialActive = true;
  bool _isPro = false;
  int _daysLeft = TrialService.trialDays;
  int _messagesLeft = TrialService.dailyLimit;

  bool get _isGuest =>
      auth.session == null || auth.session?.userId == 'guest';

  @override
  void initState() {
    super.initState();

    // Seed the greeting — generic if the user opened recovery cold, or
    // a Live-Shield-aware acknowledgment if they were routed here with
    // v4 playbook context from a just-ended call.
    final preload = widget.initialContext;
    final hasPreload = preload != null && preload.trim().isNotEmpty;
    _messages.add(_ChatMessage(
      fromUser: false,
      text: hasPreload
          ? "I saw Live Shield just caught something. Let's work through it together — I'll handle the steps, you focus on staying calm. Sending what we know now…"
          : "I'm here. Take a breath — you're not alone, and what happened isn't your fault.\n\nWhen you're ready, tell me what just happened. The more detail you share, the better I can help you stop the bleeding and figure out the next move.",
    ));

    _loadTrial();
    // Skip restoring stale chat history when we were handed a preload —
    // the hand-off greeting + just-detected scam is a fresh session and
    // we don't want old conversations bleeding in behind it. The user
    // can still see prior history if they come back to recovery cold.
    if (!hasPreload) _loadChat();
    PurchaseService.addListener(_onEntitlementUpdate);

    // v4 hand-off — fire the preload as the first user message so the
    // companion's first real reply is grounded on the detected scam type
    // instead of asking the user to re-explain what happened.
    if (hasPreload) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _send(preload);
      });
    }
  }

  void _onEntitlementUpdate(bool isPro) {
    if (!mounted) return;
    setState(() {
      _isPro = isPro;
      if (isPro) {
        _trialActive = true;
        _messagesLeft = 999;
      }
    });
  }

  @override
  void dispose() {
    PurchaseService.removeListener(_onEntitlementUpdate);
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadChat() async {
    if (_isGuest) return;
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kChatKey);
    if (raw == null) return;
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      final loaded = list
          .map((e) => _ChatMessage.fromJson(e as Map<String, dynamic>))
          .toList();
      if (loaded.isNotEmpty && mounted) {
        setState(() {
          _messages
            ..clear()
            ..addAll(loaded);
        });
        WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
      }
    } catch (_) {}
  }

  Future<void> _saveChat() async {
    if (_isGuest) return;
    final p = await SharedPreferences.getInstance();
    final toSave = _messages
        .where((m) => !m.isLimit)
        .take(_kMaxMessages)
        .map((m) => m.toJson())
        .toList();
    await p.setString(_kChatKey, jsonEncode(toSave));
  }

  Future<void> _clearChat() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kChatKey);
    setState(() {
      _messages
        ..clear()
        ..add(const _ChatMessage(
          fromUser: false,
          text:
              "I'm here. Take a breath — you're not alone, and what happened isn't your fault.\n\nWhen you're ready, tell me what just happened. The more detail you share, the better I can help you stop the bleeding and figure out the next move.",
        ));
    });
  }

  Future<void> _loadTrial() async {
    if (_isGuest) {
      // Guests always see a clean 7-day trial — nothing persisted.
      if (mounted) {
        setState(() {
          _trialActive = true;
          _isPro = false;
          _daysLeft = TrialService.trialDays;
          _messagesLeft = TrialService.dailyLimit;
        });
      }
      return;
    }
    final active = await TrialService.isTrialActive();
    final days = await TrialService.daysRemaining();
    final msgs = await TrialService.messagesRemainingToday();
    // Pro can come from either side: RevenueCat (Apple IAP) or the
    // backend session tier (Stripe sub, admin grant, or a Pro entitlement
    // synced from server). RevenueCat is the authoritative iOS source
    // when it's configured, but until Jesiah sets the API key it returns
    // false for everyone — so we OR in the backend tier as a safety net.
    final rcPro = await PurchaseService.isPro();
    final tier = auth.session?.tier;
    final serverPro = tier == 'pro' || tier == 'in_grace';
    final pro = rcPro || serverPro;
    if (!mounted) return;
    setState(() {
      _isPro = pro;
      _trialActive = pro || active;
      _daysLeft = days;
      _messagesLeft = pro ? 999 : msgs;
    });
    if (!pro && !active) _showPaywall(PaywallReason.trialExpired);
  }

  Future<void> _showPaywall(PaywallReason reason) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => PaywallScreen(reason: reason)),
    );
    _loadTrial();
  }


  Future<void> _send([String? text]) async {
    final value = (text ?? _input.text).trim();
    if (value.isEmpty || _sending) return;
    FocusManager.instance.primaryFocus?.unfocus();

    if (!_trialActive) {
      _showPaywall(PaywallReason.trialExpired);
      return;
    }

    if (_messagesLeft <= 0) {
      setState(() {
        _messages.add(const _ChatMessage(
          fromUser: false,
          isLimit: true,
          text:
              "You've used all 10 free messages for today. Upgrade to Pro for unlimited daily access.",
        ));
      });
      _scrollToBottom();
      _showPaywall(PaywallReason.dailyLimitReached);
      return;
    }

    setState(() {
      _messages.add(_ChatMessage(fromUser: true, text: value));
      _input.clear();
      _sending = true;
    });
    _scrollToBottom();

    if (!_isGuest) await TrialService.recordMessage();

    final reply = await _callBackend(value);
    if (!mounted) return;

    final msgs = _isGuest
        ? TrialService.dailyLimit
        : await TrialService.messagesRemainingToday();
    setState(() {
      _messages.add(_ChatMessage(fromUser: false, text: reply));
      _sending = false;
      _messagesLeft = msgs;
    });
    _scrollToBottom();
    _saveChat();
  }

  Future<String> _callBackend(String message) async {
    // Guest sessions have no real auth token — fall back to local responses.
    final session = auth.session;
    if (session == null || session.userId == 'guest') {
      return _respond(message);
    }

    final history = _messages
        .where((m) => !m.isLimit)
        .map((m) => {'role': m.fromUser ? 'user' : 'assistant', 'content': m.text})
        .toList();

    try {
      final res = await api.post('/v1/recovery/companion/quick', {
        'message': message,
        'history': history,
      });
      return (res['reply'] as String?) ?? _respond(message);
    } on ApiException catch (e) {
      if (e.statusCode == 429) {
        // Server-side daily limit hit (should match client limit, edge case).
        return "You've reached today's message limit. Upgrade to Pro for unlimited access.";
      }
      // Other API errors → fall back to local pattern responses, but
      // prefix so the user knows we lost the AI coach. Silent fallback
      // makes a real outage look identical to a working backend.
      return '⚠️ Offline — using local guidance.\n\n${_respond(message)}';
    } catch (_) {
      return '⚠️ Offline — using local guidance.\n\n${_respond(message)}';
    }
  }

  String _respond(String input) {
    final l = input.toLowerCase();
    if (l.contains('sent money') ||
        l.contains('wired') ||
        l.contains('zelle') ||
        l.contains('venmo') ||
        l.contains('cashapp') ||
        l.contains('transfer')) {
      return "OK — money moved is the most time-sensitive part, so we'll handle that first.\n\n1. Call your bank's fraud line right now (the number on the back of your card). Tell them you sent money under fraudulent pretenses and ask them to attempt a recall.\n2. While you're on hold, write down the amount, the date and time, and the name / account / phone number you sent it to.\n3. After the bank, file an FBI IC3 report at ic3.gov — banks and law enforcement reference it.\n\nWant me to walk you through the bank call when you're ready?";
    }
    if (l.contains('gift card')) {
      return "Gift cards are designed to be hard to recover, but it's not over.\n\n1. Don't throw the cards out — keep them and the receipts.\n2. Call the gift-card brand's fraud line right now (Apple, Target, Google Play, Amazon all have one). Read the card number and ask them to freeze the balance.\n3. Tell me which brand it was and I'll give you the exact number.\n\nThen we file an FTC report and an FBI IC3 report. You did the right thing reaching out.";
    }
    if (l.contains('crypto') ||
        l.contains('bitcoin') ||
        l.contains('btc') ||
        l.contains('eth') ||
        l.contains('usdt')) {
      return "Crypto is harder to claw back, but the trace data is gold for law enforcement — and a real FBI IC3 report can help.\n\n1. Save every transaction hash, wallet address, and screenshot before you do anything else.\n2. File an FBI IC3 report at ic3.gov — pig-butchering tracebacks are an active priority.\n3. Important: anyone who DMs you offering 'crypto recovery' for a fee is a second scam. Do not pay them.\n\nDo you want help drafting the IC3 report?";
    }
    if (l.contains('password') ||
        l.contains('login') ||
        l.contains('credentials') ||
        l.contains('access')) {
      return "Got it. If they have credentials, we lock the doors before anything else.\n\n1. Use a different device (your phone if they were on your laptop, or vice versa) so any malware can't intercept.\n2. Change your email password first — that's the master key to everything else.\n3. Then change your bank, then anything else with payment info on file.\n4. Turn on two-factor as you go. Authenticator app is better than SMS.\n\nWhich account did they get into? I can give you the exact recovery URL.";
    }
    if (l.contains('ssn') ||
        l.contains('social security') ||
        l.contains('identity') ||
        l.contains('id number')) {
      return "If they have your SSN, we treat this as identity theft. The damage isn't immediate but the fix is time-sensitive.\n\n1. Place a free fraud alert with one of the three credit bureaus — they're required to notify the other two. Equifax, Experian, or TransUnion.\n2. Freeze your credit at all three. It's free and stops new accounts being opened.\n3. File an FTC identity-theft report at IdentityTheft.gov — that doc is what you'll show banks and bureaus.\n4. Pull your credit report at annualcreditreport.com to see if anything's already opened.\n\nWalk through it with me, one step at a time?";
    }
    if (l.contains('family') ||
        l.contains('embarrass') ||
        l.contains('ashamed') ||
        l.contains('stupid') ||
        l.contains('dumb')) {
      return "Hear me on this: scammers do this for a living. They run scripts engineered by psychologists. Smart, careful people get hit every single day — including bank executives, doctors, and law-enforcement officers. Falling for one is not a measure of your intelligence.\n\nTelling someone you trust today, even just one person, is one of the most protective things you can do. Isolation is what scammers count on.\n\nIf saying it out loud feels too hard, would it help if we drafted a short message together that you could send to a family member?";
    }
    if (l.contains('what do i do') ||
        l.contains('what should i do') ||
        l.contains('first') ||
        l.contains('start') ||
        l.contains('help')) {
      return "We'll do this in order. The first 60 minutes matter most.\n\n1. Stop all contact with the scammer — no replies, no calls back. Block them.\n2. Tell me what they got: money, passwords, identity info, or just talked to you. That changes the next steps.\n3. We'll work through bank → credit → reports → family loop-in.\n\nWhich of those happened? Money, passwords, or identity info?";
    }
    if (l.contains('scammed') || l.contains('scam') || l.contains('fraud')) {
      return "I'm sorry that happened. You did the right thing reaching out — most people freeze for hours or days, and you're here.\n\nA few questions so I can help you fast:\n\n1. Did money leave your account? If yes, how — wire, Zelle, gift card, crypto, check?\n2. Did you give them any passwords, your SSN, or remote access to a device?\n3. Roughly how long ago did it happen?\n\nYou can answer one at a time — no rush.";
    }
    return "Tell me a little more so I can help you precisely. A few things that matter most:\n\n• Did money move, and through what (bank, Zelle, gift card, crypto)?\n• Did they get any passwords, your SSN, or access to a device?\n• How long ago did this happen?\n\nThe answers shape what we do in the next 30 minutes.";
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: Column(
          children: [
            Text(
              'Recovery companion',
              style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 2),
            Text(
              _isPro
                  ? 'AI-powered fraud recovery'
                  : 'Fraud-recovery guide',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 0.4,
              ),
            ),
          ],
        ),
        actions: [
          // Bank fraud-line jumper — high-frequency action when the
          // user is mid-crisis ("I just sent money via Chase"). Lives
          // in the app bar so it's reachable without scrolling through
          // the chat thread.
          IconButton(
            icon: const Icon(Icons.phone_in_talk_rounded, size: 20),
            color: AegisColors.turquoise,
            tooltip: "Find your bank's fraud line",
            onPressed: () => showBankLookupSheet(context),
          ),
          if (_messages.length > 1)
            IconButton(
              icon: const Icon(Icons.add_comment_outlined, size: 20),
              color: AegisColors.textTertiary,
              tooltip: 'New session',
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    backgroundColor: AegisColors.surface,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(18)),
                    title: const Text('Start a new session?'),
                    content: const Text(
                      'This clears the current conversation. Your prior history will be gone.',
                      style: TextStyle(
                          color: AegisColors.textSecondary, height: 1.5),
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.of(ctx).pop(false),
                        child: const Text('Keep it'),
                      ),
                      ElevatedButton(
                        onPressed: () => Navigator.of(ctx).pop(true),
                        style: ElevatedButton.styleFrom(
                          minimumSize: const Size(0, 44),
                          backgroundColor: AegisColors.turquoise,
                          foregroundColor: Colors.black,
                        ),
                        child: const Text('New session'),
                      ),
                    ],
                  ),
                );
                if (ok == true) _clearChat();
              },
            ),
          IconButton(
            icon: const Icon(Icons.history_rounded, size: 20),
            color: AegisColors.textTertiary,
            tooltip: 'Past sessions',
            onPressed: _isGuest
                ? null
                : () => showModalBottomSheet(
                      context: context,
                      isScrollControlled: true,
                      backgroundColor: AegisColors.surface,
                      shape: const RoundedRectangleBorder(
                        borderRadius:
                            BorderRadius.vertical(top: Radius.circular(20)),
                      ),
                      builder: (_) => const _PastSessionsSheet(),
                    ),
          ),
          IconButton(
            icon: const Icon(Icons.info_outline_rounded, size: 20),
            color: AegisColors.textTertiary,
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const RecoveryScreen()),
            ),
            tooltip: 'Scam types & resources',
          ),
        ],
      ),
      body: Column(
        children: [
          _TrialBanner(
            active: _trialActive,
            isPro: _isPro,
            daysLeft: _daysLeft,
            messagesLeft: _messagesLeft,
            onUpgrade: () => _showPaywall(
              _trialActive
                  ? PaywallReason.dailyLimitReached
                  : PaywallReason.trialExpired,
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: _messages.length + (_sending ? 1 : 0),
              itemBuilder: (context, idx) {
                if (idx == _messages.length) return const _TypingBubble();
                return _Bubble(message: _messages[idx]);
              },
            ),
          ),
          if (_messages.length <= 1) _QuickPromptStrip(onTap: _send),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              decoration: const BoxDecoration(
                color: AegisColors.surface,
                border: Border(
                  top: BorderSide(color: AegisColors.border, width: 0.6),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      textCapitalization: TextCapitalization.sentences,
                      style: tt.bodyMedium,
                      decoration: InputDecoration(
                        hintText: 'Tell me what happened…',
                        hintStyle: tt.bodyMedium
                            ?.copyWith(color: AegisColors.textTertiary),
                        filled: true,
                        fillColor: AegisColors.surfaceElevated,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 12,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide: BorderSide.none,
                        ),
                      ),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Material(
                    color: AegisColors.turquoise,
                    borderRadius: BorderRadius.circular(14),
                    child: InkWell(
                      onTap: _sending ? null : () => _send(),
                      borderRadius: BorderRadius.circular(14),
                      child: const Padding(
                        padding: EdgeInsets.all(12),
                        child: Icon(
                          Icons.arrow_upward_rounded,
                          color: Colors.black,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TrialBanner extends StatelessWidget {
  final bool active;
  final bool isPro;
  final int daysLeft;
  final int messagesLeft;
  final VoidCallback onUpgrade;

  const _TrialBanner({
    required this.active,
    required this.isPro,
    required this.daysLeft,
    required this.messagesLeft,
    required this.onUpgrade,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;

    if (isPro) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        color: AegisColors.success.withValues(alpha: 0.08),
        child: Row(
          children: [
            const Icon(Icons.workspace_premium_rounded,
                size: 13, color: AegisColors.success),
            const SizedBox(width: 6),
            Text(
              'AegisDial Pro · Unlimited',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.success,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      );
    }

    if (!active) {
      return GestureDetector(
        onTap: onUpgrade,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          color: AegisColors.danger.withValues(alpha: 0.15),
          child: Row(
            children: [
              const Icon(Icons.lock_outline_rounded,
                  size: 14, color: AegisColors.danger),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Free trial ended · Upgrade to continue',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.danger,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                'Upgrade',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.danger,
                  fontWeight: FontWeight.w700,
                  decoration: TextDecoration.underline,
                  decorationColor: AegisColors.danger,
                ),
              ),
            ],
          ),
        ),
      );
    }

    final lowMessages = messagesLeft <= 3;
    final accent = lowMessages ? AegisColors.warning : AegisColors.turquoise;

    return GestureDetector(
      onTap: onUpgrade,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        color: accent.withValues(alpha: 0.08),
        child: Row(
          children: [
            Icon(Icons.access_time_rounded, size: 13, color: accent),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'Free trial · $daysLeft day${daysLeft == 1 ? '' : 's'} left · $messagesLeft message${messagesLeft == 1 ? '' : 's'} today',
                style: tt.labelSmall?.copyWith(
                  color: accent,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            Text(
              'Upgrade',
              style: tt.labelSmall?.copyWith(
                color: accent,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuickPromptStrip extends StatelessWidget {
  final ValueChanged<String> onTap;
  const _QuickPromptStrip({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: SizedBox(
        height: 38,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: _RecoveryChatbotScreenState._quickPrompts.length,
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (context, i) {
            final label = _RecoveryChatbotScreenState._quickPrompts[i];
            return Material(
              color: AegisColors.surface,
              borderRadius: BorderRadius.circular(20),
              child: InkWell(
                borderRadius: BorderRadius.circular(20),
                onTap: () => onTap(label),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AegisColors.border, width: 0.6),
                  ),
                  child: Text(
                    label,
                    style: const TextStyle(
                      color: AegisColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Heuristic: does this bot reply talk about calling a bank's fraud
/// line? When it does we render a "Find fraud line" tap-action below
/// the bubble so the user doesn't have to scroll to the app-bar icon
/// mid-crisis. Kept deliberately loose — false positives just show a
/// chip the user can ignore, false negatives are the real failure
/// mode (the action stays buried in the app bar).
bool _shouldShowBankChip(String botText) {
  final l = botText.toLowerCase();
  if (l.contains("fraud line") || l.contains("fraud number")) return true;
  if (l.contains("call your bank")) return true;
  if (l.contains("back of your card")) return true;
  if (l.contains("your bank") && (l.contains("call") || l.contains("phone"))) {
    return true;
  }
  return false;
}

class _Bubble extends StatelessWidget {
  final _ChatMessage message;
  const _Bubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isUser = message.fromUser;

    if (message.isLimit) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AegisColors.warning.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: AegisColors.warning.withValues(alpha: 0.4),
              width: 0.8,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.bolt_rounded,
                color: AegisColors.warning,
                size: 16,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  message.text,
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.45,
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment:
            isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser)
            Container(
              width: 30,
              height: 30,
              margin: const EdgeInsets.only(right: 8, top: 2),
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                gradient: AegisColors.heroGradient,
              ),
              child: const Icon(
                Icons.shield_moon,
                size: 16,
                color: Colors.black,
              ),
            ),
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.78,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser
                    ? AegisColors.turquoise.withValues(alpha: 0.18)
                    : AegisColors.surface.withValues(alpha: 0.85),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(isUser ? 16 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 16),
                ),
                border: Border.all(
                  color: isUser
                      ? AegisColors.turquoise.withValues(alpha: 0.4)
                      : AegisColors.border,
                  width: 0.6,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    message.text,
                    style: tt.bodyMedium?.copyWith(
                      color: AegisColors.textPrimary,
                      height: 1.45,
                    ),
                  ),
                  if (!isUser && _shouldShowBankChip(message.text)) ...[
                    const SizedBox(height: 10),
                    InkWell(
                      borderRadius: BorderRadius.circular(999),
                      onTap: () => showBankLookupSheet(context),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: AegisColors.turquoise.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: AegisColors.turquoise.withValues(alpha: 0.4),
                            width: 0.8,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.phone_in_talk_rounded,
                                color: AegisColors.turquoise, size: 14),
                            const SizedBox(width: 6),
                            Text(
                              "Find your bank's fraud line",
                              style: tt.labelMedium?.copyWith(
                                color: AegisColors.turquoise,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TypingBubble extends StatelessWidget {
  const _TypingBubble();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 30,
            height: 30,
            margin: const EdgeInsets.only(right: 8, top: 2),
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: AegisColors.heroGradient,
            ),
            child: const Icon(
              Icons.shield_moon,
              size: 16,
              color: Colors.black,
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: const SizedBox(
              width: 36,
              height: 14,
              child: _Dots(),
            ),
          ),
        ],
      ),
    );
  }
}

class _Dots extends StatefulWidget {
  const _Dots();
  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final phase = (_c.value + i * 0.2) % 1.0;
            final scale = 0.5 + (1 - (phase * 2 - 1).abs()) * 0.5;
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Transform.scale(
                scale: scale,
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: const BoxDecoration(
                    color: AegisColors.turquoise,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}

class _PastSessionsSheet extends StatefulWidget {
  const _PastSessionsSheet();

  @override
  State<_PastSessionsSheet> createState() => _PastSessionsSheetState();
}

class _PastSessionsSheetState extends State<_PastSessionsSheet> {
  List<Map<String, dynamic>>? _sessions;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await api.get('/v1/recovery/sessions');
      if (!mounted) return;
      setState(() {
        _sessions = (res['sessions'] as List<dynamic>?)
                ?.cast<Map<String, dynamic>>() ??
            [];
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load sessions.';
        _loading = false;
      });
    }
  }

  String _formatDate(String? iso) {
    if (iso == null) return '';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return iso;
    final diff = DateTime.now().difference(dt);
    if (diff.inDays == 0) return 'Today';
    if (diff.inDays == 1) return 'Yesterday';
    if (diff.inDays < 30) return '${diff.inDays}d ago';
    return '${dt.month}/${dt.day}/${dt.year}';
  }

  String _scamLabel(String? type) {
    if (type == null || type.isEmpty) return 'Unknown scam';
    return type
        .replaceAll('_', ' ')
        .replaceFirstMapped(RegExp(r'^.'), (m) => m[0]!.toUpperCase());
  }

  Color _statusColor(String status) => switch (status) {
        'active' => AegisColors.turquoise,
        'completed' => AegisColors.success,
        'abandoned' => AegisColors.textTertiary,
        _ => AegisColors.warning,
      };

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return DraggableScrollableSheet(
      initialChildSize: 0.55,
      minChildSize: 0.3,
      maxChildSize: 0.85,
      expand: false,
      builder: (_, scroll) => Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: AegisColors.textTertiary,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
            child: Text(
              'Past Sessions',
              style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(32),
              child: CircularProgressIndicator(
                  color: AegisColors.turquoise, strokeWidth: 2),
            )
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.all(32),
              child: Text(
                _error!,
                style: tt.bodySmall
                    ?.copyWith(color: AegisColors.textTertiary),
                textAlign: TextAlign.center,
              ),
            )
          else if (_sessions!.isEmpty)
            Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                children: [
                  const Icon(Icons.healing_rounded,
                      color: AegisColors.textTertiary, size: 32),
                  const SizedBox(height: 10),
                  Text(
                    'No sessions yet',
                    style: tt.bodyMedium
                        ?.copyWith(color: AegisColors.textSecondary),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'When you start a recovery session, it will appear here.',
                    style: tt.bodySmall
                        ?.copyWith(color: AegisColors.textTertiary),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            )
          else
            Expanded(
              child: ListView.builder(
                controller: scroll,
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                itemCount: _sessions!.length,
                itemBuilder: (_, i) {
                  final s = _sessions![i];
                  final status = (s['status'] as String?) ?? 'active';
                  return Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AegisColors.surfaceElevated,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                          color: AegisColors.border, width: 0.6),
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: _statusColor(status)
                                .withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Icon(
                            status == 'completed'
                                ? Icons.check_circle_outline
                                : status == 'active'
                                    ? Icons.play_circle_outline
                                    : Icons.cancel_outlined,
                            color: _statusColor(status),
                            size: 18,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                _scamLabel(s['scam_type'] as String?),
                                style: tt.bodySmall?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Row(
                                children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: _statusColor(status)
                                          .withValues(alpha: 0.14),
                                      borderRadius:
                                          BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      status.toUpperCase(),
                                      style: TextStyle(
                                        color: _statusColor(status),
                                        fontSize: 9,
                                        fontWeight: FontWeight.w700,
                                        letterSpacing: 0.6,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    _formatDate(
                                        s['started_at'] as String?),
                                    style: tt.labelSmall?.copyWith(
                                      color: AegisColors.textTertiary,
                                      fontSize: 10,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
