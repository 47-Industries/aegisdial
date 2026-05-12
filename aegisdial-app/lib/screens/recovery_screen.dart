import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import 'recovery_chatbot_screen.dart';
import 'scam_type_detail_screen.dart';

class RecoveryScreen extends StatelessWidget {
  const RecoveryScreen({super.key});

  static const _types = <ScamTypeInfo>[
    ScamTypeInfo(
      name: 'Bank impersonation',
      icon: Icons.account_balance_outlined,
      definition:
          'Someone claiming to be your bank — often "fraud department" — calls or texts to say your account is compromised, then walks you through "moving the money to a safe account" that is actually theirs.',
      example:
          '"This is Wells Fargo Fraud. We see a \$2,400 charge in Miami. To protect your account I need you to verify by sending your balance to a holding wallet."',
      redFlags: [
        'Calls you about fraud you did not report.',
        'Asks you to move money, send a code, or read a one-time password.',
        'Pressure to act in minutes, not hours.',
      ],
      whatToDo: [
        'Hang up and call the number on the back of your card to confirm.',
        'If you moved money or shared a code, call the bank directly and request a fraud claim + new card immediately.',
        'Place a credit freeze with Equifax, Experian, and TransUnion.',
        'File a report with FTC at reportfraud.ftc.gov and FBI IC3 at ic3.gov.',
      ],
    ),
    ScamTypeInfo(
      name: 'IRS / government',
      icon: Icons.gavel_outlined,
      definition:
          'A caller claiming to be from the IRS, Social Security, or local police threatens arrest, deportation, or benefit suspension unless you pay immediately — usually in gift cards, wire, or crypto.',
      example:
          '"Officer Martinez, IRS investigations. There is a federal warrant for your arrest. To avoid being taken into custody you must settle \$4,200 in iTunes cards today."',
      redFlags: [
        'Demands payment in gift cards, wire, or cryptocurrency.',
        'Threatens immediate arrest, deportation, or benefit cut-off.',
        'Refuses to let you call back or speak to anyone else.',
      ],
      whatToDo: [
        'Hang up. The IRS and Social Security never call to threaten arrest.',
        'Report the call to the Treasury Inspector General (tigta.gov).',
        'If you paid, contact the gift-card issuer or wire service immediately to attempt a reversal.',
        'File at reportfraud.ftc.gov and ic3.gov so the number is added to scam-call lists.',
      ],
    ),
    ScamTypeInfo(
      name: 'Romance scam',
      icon: Icons.favorite_outline,
      definition:
          'A long-distance "partner" you have never met in person builds a relationship over months and eventually asks for money — for medical bills, travel, or a sudden emergency.',
      example:
          '"My contract on the rig is finally ending and I can fly home to meet you. The company needs a \$3,000 release fee and I will repay you the moment I land."',
      redFlags: [
        'Claims to be overseas military, oil-rig worker, or doctor on assignment.',
        'Always has an emergency right before they were going to meet you.',
        'Refuses video calls or asks you to keep the relationship private.',
      ],
      whatToDo: [
        'Stop sending money. Block the contact across all platforms.',
        'Save profile screenshots, messages, and payment receipts as evidence.',
        'Report the profile to the platform (Facebook, Instagram, dating app).',
        'File at reportfraud.ftc.gov and ic3.gov — these reports power FBI takedowns of romance-scam networks.',
      ],
    ),
    ScamTypeInfo(
      name: 'Crypto recovery scam',
      icon: Icons.currency_bitcoin,
      definition:
          'After a victim loses crypto in another scam, a "recovery agent" promises to retrieve the funds for an upfront fee — and steals that fee too.',
      example:
          '"I work with a blockchain forensics team. We can trace the wallet that took your USDT. The retainer is \$1,200 in ETH and we recover the rest within 72 hours."',
      redFlags: [
        'Found you in a comment thread or DM right after your first loss.',
        'Demands payment in crypto, gift cards, or wire — never invoiced.',
        'Shows fake testimonials or unverifiable "case numbers".',
      ],
      whatToDo: [
        'Do not pay. Legitimate recovery only happens through law enforcement and licensed attorneys.',
        'Report the wallet address and conversation to ic3.gov.',
        'Notify the original exchange — sometimes funds are still frozen on a known address.',
        'Avoid all DMs offering recovery; scammers harvest victim lists from public posts.',
      ],
    ),
    ScamTypeInfo(
      name: 'Tech support',
      icon: Icons.computer_outlined,
      definition:
          'A pop-up, email, or call warns that your computer or Apple ID is compromised. The "technician" then asks for remote access or a payment to fix the problem.',
      example:
          '"This is Apple Support. We detected three logins from Russia. Please install AnyDesk so I can secure your account before they wipe your iCloud."',
      redFlags: [
        'Unsolicited call or pop-up with a phone number to "Microsoft" or "Apple".',
        'Asks you to install AnyDesk, TeamViewer, or any remote-control software.',
        'Wants payment in gift cards or via a money-transfer app.',
      ],
      whatToDo: [
        'Hang up. Apple, Microsoft, and Google never make outbound support calls.',
        'Disconnect the device from Wi-Fi and uninstall any remote-access app.',
        'Change passwords on email, banking, and Apple/Google ID from a different device.',
        'Run a malware scan and review bank statements for unauthorized charges.',
      ],
    ),
    ScamTypeInfo(
      name: 'Grandparent / family emergency',
      icon: Icons.family_restroom_outlined,
      definition:
          'A scammer — often using AI voice cloning — calls pretending to be a grandchild or family member in trouble, asking for bail, hospital, or bond money urgently.',
      example:
          '"Grandma, it\'s me, I had an accident — please don\'t tell Mom. The lawyer needs \$5,000 in cash for bail and I have to stay quiet on the line."',
      redFlags: [
        'Begs you not to tell other family members.',
        'Voice sounds slightly off but pleads "I\'m hurt, I\'m crying".',
        'Asks for cash, gift cards, or a money courier to your door.',
      ],
      whatToDo: [
        'Hang up and call the family member directly on a known number.',
        'Use your family safe word — set one inside AegisDial → Family.',
        'If you sent money, call the bank or wire service for an immediate recall.',
        'Report the call so other AegisDial users hear the same caller-ID flagged.',
      ],
    ),
    ScamTypeInfo(
      name: 'Job offer / check fraud',
      icon: Icons.work_outline,
      definition:
          'You are "hired" by a remote company, sent a check to buy supplies, asked to deposit it and forward most of it on. The check bounces days later and you owe the bank everything you forwarded.',
      example:
          '"Welcome to the team! We sent you a \$3,800 check for your home-office equipment. Please deposit it and Zelle \$2,900 to our equipment vendor today."',
      redFlags: [
        'Job offered via text or chat with no real interview.',
        'You receive a check before doing any work.',
        'Asked to forward a portion of the funds via Zelle, Venmo, or wire.',
      ],
      whatToDo: [
        'Do not send any of the money. Wait for the deposit to truly clear (often 7–10 days).',
        'Notify your bank that the check is suspected fraud.',
        'Report the listing to the platform (Indeed, LinkedIn, Facebook).',
        'File at reportfraud.ftc.gov so the company name is added to scam-job lists.',
      ],
    ),
    ScamTypeInfo(
      name: 'Investment / pig butchering',
      icon: Icons.trending_up,
      definition:
          'A long-running scam that builds trust over weeks before introducing a "guaranteed" investment platform. Early withdrawals work, then the "fees" begin and the platform disappears.',
      example:
          '"My uncle taught me a strategy on this gold-trading platform. I made \$40k last month — I\'ll walk you through your first trade if you want to try."',
      redFlags: [
        'New friend or romantic interest steers conversation toward investing.',
        'Platform shows huge gains and lets you withdraw small amounts at first.',
        '"Tax", "release", or "compliance" fees demanded before bigger withdrawals.',
      ],
      whatToDo: [
        'Stop adding money. Take screenshots of the platform and chat history.',
        'Report the wallet addresses and platform domain at ic3.gov.',
        'Notify your bank or exchange — some funds are still frozen at known addresses.',
        'Avoid follow-on "recovery" DMs — those are scammers reading the same victim list.',
      ],
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: const Text('Recovery'),
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            accent: AegisColors.danger,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.danger.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.bolt_rounded,
                        color: AegisColors.danger,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Just got scammed?',
                        style: tt.titleLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'Talk to your recovery companion. We\'ll work through the panic, then walk you through the calls, freezes, and reports — at your pace.',
                  style: tt.bodyMedium?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 16),
                ElevatedButton.icon(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const RecoveryChatbotScreen(),
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AegisColors.danger,
                    foregroundColor: Colors.white,
                  ),
                  icon: const Icon(Icons.chat_bubble_outline_rounded),
                  label: const Text('Start Recovery Now'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'YOUR COVERAGE',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          const _CoverageRow(
            icon: Icons.shield_moon,
            title: 'Live Shield on every call',
            subtitle: 'On-device AI screens incoming calls in real time.',
          ),
          const _CoverageRow(
            icon: Icons.message_outlined,
            title: 'Coverage scanner on SMS / iMessage',
            subtitle: 'Auto-deletes confirmed scam messages.',
          ),
          const _CoverageRow(
            icon: Icons.fingerprint_rounded,
            title: 'Breach monitor',
            subtitle: 'Watches dark-web markets and breach corpora for your info.',
          ),
          const _CoverageRow(
            icon: Icons.family_restroom_outlined,
            title: 'Family + Guardian',
            subtitle: 'Up to 3 lines on Pro.',
          ),
          const _CoverageRow(
            icon: Icons.healing,
            title: 'Recovery companion',
            subtitle: 'AI-first chat — \$149 Recovery Session unlocks 14-day Pro.',
          ),
          const SizedBox(height: 24),
          Text(
            'BROWSE BY SCAM TYPE',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Tap any scam to see how it works, an example, and how to delete it.',
            style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
          ),
          const SizedBox(height: 10),
          ..._types.map((t) => _CategoryTile(info: t)),
        ],
      ),
    );
  }
}

class _CoverageRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _CoverageRow({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AegisColors.turquoise.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AegisColors.turquoise, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: tt.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
          Container(
            width: 8,
            height: 8,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: AegisColors.success,
            ),
          ),
        ],
      ),
    );
  }
}

class _CategoryTile extends StatelessWidget {
  final ScamTypeInfo info;
  const _CategoryTile({required this.info});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => ScamTypeDetailScreen(info: info),
            ),
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AegisColors.blue.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    info.icon,
                    color: AegisColors.blueAccent,
                    size: 18,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        info.name,
                        style: tt.bodyLarge?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        info.example.length > 70
                            ? '${info.example.substring(0, 70)}…'
                            : info.example,
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textTertiary,
                          height: 1.35,
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.chevron_right_rounded,
                  color: AegisColors.textTertiary,
                  size: 20,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
