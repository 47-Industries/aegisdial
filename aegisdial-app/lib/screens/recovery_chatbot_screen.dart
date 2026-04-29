import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class RecoveryChatbotScreen extends StatefulWidget {
  const RecoveryChatbotScreen({super.key});

  @override
  State<RecoveryChatbotScreen> createState() => _RecoveryChatbotScreenState();
}

class _ChatMessage {
  final bool fromUser;
  final String text;
  const _ChatMessage({required this.fromUser, required this.text});
}

class _RecoveryChatbotScreenState extends State<RecoveryChatbotScreen> {
  static const _quickPrompts = [
    'I just got scammed',
    'I sent money',
    'They got my passwords',
    'I\'m scared to tell my family',
    'What do I do first?',
  ];

  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_ChatMessage> _messages = [
    const _ChatMessage(
      fromUser: false,
      text:
          "I'm here. Take a breath — you're not alone, and what happened isn't your fault.\n\nWhen you're ready, tell me what just happened. The more detail you share, the better I can help you stop the bleeding and figure out the next move.",
    ),
  ];
  bool _sending = false;

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send([String? text]) async {
    final value = (text ?? _input.text).trim();
    if (value.isEmpty || _sending) return;
    setState(() {
      _messages.add(_ChatMessage(fromUser: true, text: value));
      _input.clear();
      _sending = true;
    });
    _scrollToBottom();

    await Future.delayed(const Duration(milliseconds: 750));
    if (!mounted) return;
    setState(() {
      _messages.add(_ChatMessage(fromUser: false, text: _respond(value)));
      _sending = false;
    });
    _scrollToBottom();
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
              'AI-first · Claude Sonnet 4.6',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 0.4,
              ),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: _messages.length + (_sending ? 1 : 0),
              itemBuilder: (context, idx) {
                if (idx == _messages.length) {
                  return const _TypingBubble();
                }
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
                    border: Border.all(
                      color: AegisColors.border,
                      width: 0.6,
                    ),
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

class _Bubble extends StatelessWidget {
  final _ChatMessage message;
  const _Bubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isUser = message.fromUser;
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
              padding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
              child: Text(
                message.text,
                style: tt.bodyMedium?.copyWith(
                  color: AegisColors.textPrimary,
                  height: 1.45,
                ),
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
            padding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
