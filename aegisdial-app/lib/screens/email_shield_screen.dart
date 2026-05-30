import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';

class EmailShieldScreen extends StatefulWidget {
  const EmailShieldScreen({super.key});

  @override
  State<EmailShieldScreen> createState() => _EmailShieldScreenState();
}

class _EmailShieldScreenState extends State<EmailShieldScreen> {
  List<_EmailAccount>? _accounts;
  bool _loading = true;
  String? _error;
  bool _linking = false;

  bool get _isGuest =>
      auth.session == null || auth.session?.userId == 'guest';

  @override
  void initState() {
    super.initState();
    _loadAccounts();
  }

  Future<void> _loadAccounts() async {
    if (_isGuest) {
      setState(() => _loading = false);
      return;
    }
    try {
      final res = await api.get('/v1/email/accounts');
      if (!mounted) return;
      final list = (res['accounts'] as List<dynamic>?)
              ?.map((e) => _EmailAccount.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [];
      setState(() {
        _accounts = list;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (e.statusCode == 403) {
          _accounts = [];
        } else {
          _error = e.message;
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load email accounts.';
      });
    }
  }

  Future<void> _linkAccount(String provider) async {
    setState(() => _linking = true);
    try {
      final res = await api.post('/v1/email/accounts/oauth/init', {
        'provider': provider,
      });
      final url = res['authorize_url'] as String?;
      if (url != null && mounted) {
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      final msg = e.statusCode == 503
          ? 'Email Shield is not yet configured. Coming soon.'
          : e.message;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg)),
      );
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not start email linking.')),
        );
      }
    }
    if (mounted) setState(() => _linking = false);
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Email Shield')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            accent: AegisColors.blueAccent,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.blueAccent.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.email_outlined,
                        color: AegisColors.blueAccent,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Email compromise detection',
                        style: tt.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'Link your email to scan for signs of compromise — suspicious forwarding rules, unusual sent activity, and unauthorized access patterns.',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),

          if (_loading)
            const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: CircularProgressIndicator(
                    color: AegisColors.turquoise, strokeWidth: 2),
              ),
            )
          else if (_error != null)
            _InfoCard(
              icon: Icons.error_outline_rounded,
              color: AegisColors.danger,
              text: _error!,
            )
          else ...[
            // Linked accounts
            Text(
              'LINKED ACCOUNTS',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.6,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            if (_accounts != null && _accounts!.isNotEmpty)
              ..._accounts!.map((a) => _AccountTile(account: a))
            else
              _InfoCard(
                icon: Icons.link_off_rounded,
                color: AegisColors.textTertiary,
                text: 'No email accounts linked yet. Connect your Gmail or Outlook to start scanning.',
              ),
            const SizedBox(height: 16),

            // Link buttons
            Text(
              'CONNECT AN ACCOUNT',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.6,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            _LinkButton(
              icon: Icons.mail_rounded,
              label: 'Connect Gmail',
              subtitle: 'Google OAuth — read-only access',
              loading: _linking,
              onTap: () => _linkAccount('gmail'),
            ),
            const SizedBox(height: 8),
            _LinkButton(
              icon: Icons.business_rounded,
              label: 'Connect Outlook',
              subtitle: 'Microsoft OAuth — read-only access',
              loading: _linking,
              onTap: () => _linkAccount('microsoft'),
            ),

            const SizedBox(height: 24),
            Text(
              'WHAT WE CHECK',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.6,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 10),
            const _CheckItem(
              icon: Icons.forward_to_inbox_rounded,
              title: 'Forwarding rules',
              detail: 'Detects if someone added a rule to silently forward your mail.',
            ),
            const _CheckItem(
              icon: Icons.send_rounded,
              title: 'Unusual sent activity',
              detail: 'Flags emails sent from your account that you didn\'t write.',
            ),
            const _CheckItem(
              icon: Icons.vpn_key_rounded,
              title: 'Access patterns',
              detail: 'Identifies sign-ins from unfamiliar locations or devices.',
            ),

            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.lock_outline_rounded,
                    size: 12, color: AegisColors.textTertiary),
                const SizedBox(width: 6),
                Text(
                  'Read-only access. We never send, delete, or modify your email.',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _EmailAccount {
  final String id;
  final String provider;
  final String email;
  final String status;

  _EmailAccount({
    required this.id,
    required this.provider,
    required this.email,
    required this.status,
  });

  factory _EmailAccount.fromJson(Map<String, dynamic> j) => _EmailAccount(
        id: (j['id'] as String?) ?? '',
        provider: (j['provider'] as String?) ?? '',
        email: (j['email'] as String?) ?? '',
        status: (j['status'] as String?) ?? 'active',
      );
}

class _AccountTile extends StatelessWidget {
  final _EmailAccount account;
  const _AccountTile({required this.account});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isGmail = account.provider == 'gmail';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AegisColors.blueAccent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isGmail ? Icons.mail_rounded : Icons.business_rounded,
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
                  account.email,
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                Text(
                  account.provider == 'gmail' ? 'Gmail' : 'Outlook',
                  style: tt.labelSmall
                      ?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ),
          const Icon(Icons.check_circle_outline,
              color: AegisColors.success, size: 18),
        ],
      ),
    );
  }
}

class _LinkButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final String subtitle;
  final bool loading;
  final VoidCallback onTap;

  const _LinkButton({
    required this.icon,
    required this.label,
    required this.subtitle,
    required this.loading,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: loading ? null : onTap,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AegisColors.surface.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: AegisColors.blueAccent.withValues(alpha: 0.35),
              width: 0.8,
            ),
          ),
          child: Row(
            children: [
              Icon(icon, color: AegisColors.blueAccent, size: 22),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: tt.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: tt.labelSmall?.copyWith(
                        color: AegisColors.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
              if (loading)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    color: AegisColors.blueAccent,
                    strokeWidth: 2,
                  ),
                )
              else
                const Icon(Icons.chevron_right_rounded,
                    color: AegisColors.textTertiary, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _CheckItem extends StatelessWidget {
  final IconData icon;
  final String title;
  final String detail;
  const _CheckItem({
    required this.icon,
    required this.title,
    required this.detail,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: AegisColors.blueAccent, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    height: 1.35,
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

class _InfoCard extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;
  const _InfoCard({
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
