import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Direct unit test on the apns2 Notification surface to lock in the
// path Phase 5 depends on. The original Phase 5 fix went through a
// `notif.toJSON.bind(notif)` override that doesn't exist on the apns2
// class — it threw TypeError synchronously inside the send loop and
// silently bricked every shield_takeover / block_retry push. The
// regression went undetected because no unit test inspected the
// wire-format the library actually emits.
//
// This test runs against the real apns2 module to catch a future
// version that breaks the `aps` constructor-options contract we now
// depend on.

import { Notification, Priority } from 'apns2';

describe('apns2 Notification — Phase 5 wire-format contract', () => {
  it('passes options.aps through buildApnsOptions onto the wire', () => {
    const notif = new Notification('abc123', {
      alert: { title: 'STOP', body: 'They are lying' },
      topic: 'com.aegisdial.app',
      sound: 'default',
      badge: 1,
      threadId: 'guardian-shield_takeover',
      data: { kind: 'shield_takeover' },
      aps: {
        'interruption-level': 'critical',
        'relevance-score': 1.0,
      },
      priority: Priority.immediate,
    });

    const built = notif.buildApnsOptions();

    // Critical assertion: the interruption-level + relevance-score we
    // pass via the constructor's `aps` option survive into the
    // top-level aps object that apns2 stringifies onto the HTTP/2
    // body. Without this, Apple defaults the lock-screen UX to
    // "active" and Mom on Silent/DND never sees the takeover.
    assert.equal(
      (built.aps as Record<string, unknown>)['interruption-level'],
      'critical',
      'aps.interruption-level must round-trip from options',
    );
    assert.equal(
      (built.aps as Record<string, unknown>)['relevance-score'],
      1.0,
      'aps.relevance-score must round-trip from options',
    );

    // The other typed fields land in their documented slots:
    assert.deepEqual(built.aps.alert, { title: 'STOP', body: 'They are lying' });
    assert.equal(built.aps['thread-id'], 'guardian-shield_takeover');
    assert.equal(built.aps.badge, 1);
    assert.equal(built.aps.sound, 'default');

    // data fields flatten to the top of the payload (NOT under aps).
    assert.equal((built as unknown as Record<string, unknown>).kind, 'shield_takeover');

    // The notif has the high-priority getter wired (Priority.immediate
    // is the default; we still want to assert the value is correct
    // because apns2's send path branches on it).
    assert.equal(notif.priority, Priority.immediate);
  });

  it('omits aps overrides when no options.aps provided', () => {
    const notif = new Notification('abc123', {
      alert: { title: 'Block retry', body: 'blocked' },
      topic: 'com.aegisdial.app',
    });
    const built = notif.buildApnsOptions();
    assert.equal(
      (built.aps as Record<string, unknown>)['interruption-level'],
      undefined,
      'aps.interruption-level should be absent when not passed',
    );
    assert.equal(
      (built.aps as Record<string, unknown>)['relevance-score'],
      undefined,
      'aps.relevance-score should be absent when not passed',
    );
  });

  it('exposes Priority.throttled (5) for power-conserving delivery', () => {
    // A2 block_retry pushes use priority=5 in our payload contract.
    // Validate that apns2's Priority enum matches the wire value we
    // promise iOS clients in the documentation block atop apns.ts.
    assert.equal(Priority.immediate, 10);
    assert.equal(Priority.throttled, 5);
  });
});
