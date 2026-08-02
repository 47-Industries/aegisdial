import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';
import { subscribe, type FamilyStreamFrame } from '../services/familyTranscriptStream.js';
import { familyPlanMembersFor } from '../services/guardianAlerts.js';

// Live Shield v3 — family-transcript SSE route (Gap #2).
//
// One-paragraph: a watching family member (the adult child / spouse
// on Mom's family_plan) opens an EventSource connection to this
// endpoint and receives a live stream of (1) transcript chunks from
// Mom's call and (2) system_event markers (B3/B4 takeovers, family-
// alert dispatch, safety-contact lifecycle). The connection stays
// open until Mom's call ends OR the client disconnects.
//
// Authentication: requireAppUser (signed in) + the subject must be a
// guardian-tier relationship — requester is on the same family_plan
// as subject (subject is plan owner ↔ requester is member, OR
// requester is plan owner ↔ subject is member). The subject can also
// subscribe to their own stream (used by the post-call recap UI's
// "replay" path, and useful for testing).
//
// Transport: SSE (Server-Sent Events). Single GET, long-lived response
// with `content-type: text/event-stream`. Each event is a
// `data: <json>\n\n` frame. Heartbeat every 30s so the client can
// detect a dead connection (most managed load balancers — Railway
// included — idle out at 60s without bytes on the wire).
// Resume on disconnect is the client's responsibility (browser
// EventSource auto-reconnects; iOS clients can rely on Last-Event-ID).
//
// Scale: in-process pub-sub via services/familyTranscriptStream.ts.
// Sessions are session-affinity-pinned via v2 routing; the family
// viewer's EventSource connection should land on the same pod via
// subject_user_id → pod hash. Multi-pod degraded mode: cross-pod
// subscribers get system_events (DB-replicated through the existing
// metric/event tables) but not live text. Acceptable; revisit at scale.

const ParamsSchema = z.object({
  subject_user_id: z.string().uuid(),
});

export async function familyTranscriptStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/family/transcript-stream/:subject_user_id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const parsed = ParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_params' });
      }
      const subjectUserId = parsed.data.subject_user_id;
      const requester = req.appUser!;

      // Auth: requester must be on subject's family plan (anywhere
      // on it — owner, fellow member, plan they own with subject as
      // member) OR be the subject themselves. The owner-self case
      // lets users replay their own recaps; the family case is the
      // actual feature.
      //
      // HIGH-3 adversarial fix: use `familyPlanMembersFor` (broader
      // set) instead of `guardianUserIdsFor` (narrower — misses
      // sibling members). Previously, if Dad owns the plan and
      // Mom + Son are both members, Son hitting this endpoint to
      // watch Mom's stream got a 403 because `guardianUserIdsFor(Mom)`
      // only returned `[Dad]`. Now both Dad AND Son are recognized.
      let allowed = requester.id === subjectUserId;
      if (!allowed) {
        const family = await familyPlanMembersFor(subjectUserId);
        allowed = family.includes(requester.id);
      }
      if (!allowed) {
        emitMetric('v3.family_stream.unauthorized_attempt', {});
        return reply.code(403).send({ error: 'not_on_family_plan' });
      }

      // SSE headers. `text/event-stream` is the wire format the
      // browser EventSource / NSURLSession SSE handlers expect.
      // `cache-control: no-cache` is mandatory — middleboxes will
      // otherwise buffer the stream and break liveness. `connection:
      // keep-alive` keeps the TCP socket open. `x-accel-buffering:
      // no` is an Nginx hint (no-op behind Fly, harmless).
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.hijack();

      let frameId = 0;
      let closed = false;

      // Write an event to the wire. Each frame has an `id:` for SSE
      // Last-Event-ID resume semantics (today: best-effort per-
      // connection counter; v3.5 will switch to a transcript-event
      // session-stable seq for true resume), an `event:` type so
      // the client's EventSource.addEventListener(type, ...) works,
      // and a `data:` JSON payload.
      //
      // L-3 adversarial fix: build the full frame as one string and
      // single-write it. Three sequential writes (id / event / data)
      // could ship a partial frame if the second write threw — the
      // SSE client would see `id:\nevent:\n` with no data, and parse
      // behavior is undefined. Atomic now.
      const writeFrame = (frame: FamilyStreamFrame): void => {
        if (closed) return;
        try {
          frameId++;
          const buf =
            `id: ${frameId}\n` +
            `event: ${frame.type}\n` +
            `data: ${JSON.stringify(frame)}\n\n`;
          reply.raw.write(buf);
        } catch (err) {
          // Underlying socket gone (peer hung up between checks).
          // The 'close' handler below will fire shortly; until then,
          // skip writes silently.
          closed = true;
          emitMetric('v3.family_stream.write_failed', {});
          // eslint-disable-next-line no-console
          console.error('[familyTranscriptStream] write failed', {
            subject_user_id: subjectUserId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };

      // Initial frame: hello + server time so the client can sync
      // clocks for transcript display offsets.
      writeFrame({
        type: 'heartbeat',
        subject_user_id: subjectUserId,
        at: new Date().toISOString(),
      });

      // Register the subscriber. The unsubscribe fn is the cleanup.
      const unsubscribe = subscribe(subjectUserId, writeFrame);

      // Heartbeat every 30 seconds. Lets the client detect a dead
      // connection (Fly's idle-timeout is 60s; 30s gives a 2× margin).
      // Use unref() so the timer doesn't keep the process alive past
      // SIGTERM if every connection is closed.
      //
      // H-2 adversarial fix: write the heartbeat DIRECTLY via
      // writeFrame() instead of calling publish() — the latter fans
      // out to every subscriber on the subject, producing N×N
      // amplification with cross-connection state leak (viewer A's
      // heartbeat timer would write to viewer B's socket, making
      // "stream alive" indistinguishable from "another viewer is
      // alive"). Per-connection writeFrame is the correct shape.
      const heartbeat = setInterval(() => {
        writeFrame({
          type: 'heartbeat',
          subject_user_id: subjectUserId,
          at: new Date().toISOString(),
        });
      }, 30_000);
      heartbeat.unref();

      // Connection close — both ends. The cleanup MUST fire whether
      // the client disconnected gracefully OR the socket errored.
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          /* socket already closed */
        }
        emitMetric('v3.family_stream.connection_closed', {});
      };

      reply.raw.on('close', cleanup);
      reply.raw.on('error', cleanup);

      emitMetric('v3.family_stream.connection_opened', {});

      // Returning from the handler doesn't end the response here —
      // we hijacked above. The response stays open until the cleanup
      // fires on socket close.
    },
  );
}
