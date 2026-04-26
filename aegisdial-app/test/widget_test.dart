import 'package:flutter_test/flutter_test.dart';

import 'package:aegisdial_app/main.dart';

void main() {
  testWidgets('Welcome screen renders brand', (WidgetTester tester) async {
    await tester.pumpWidget(const AegisDialApp());
    await tester.pump();
    expect(find.text('AegisDial'), findsOneWidget);
    expect(find.text('Get Started'), findsOneWidget);
  });
}
