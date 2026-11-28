# Security review 8: email notifications (684fa5b..7f106cd)

## Decisions: fix all of the following

1. **M1** sender.ts:71-73: mark a failure permanent only when it concerns this message or recipient (EENVELOPE on RCPT, EMESSAGE/DATA 5xx). EAUTH, ENOAUTH, ETLS, EPROTOCOL, ECONNECTION, 530, and 550/553 to MAIL FROM are retried whatever the reply code. Stop the client's batch after the first EAUTH (leave the rest queued). Test with the real nodemailer shape `{ code: 'EAUTH', responseCode: 535, permanent: true }`.
2. **L1** email-worker.service.ts:314-327: re-read the organization switch and entitlements inside each row's prepare transaction (or at least per claimed batch), so switching off, a module off or a suspension takes effect mid-run.
3. **L2** unsubscribe-token.ts / email-preferences.service.ts: add an issue time to the token; refuse a token issued before the person last switched that kind back on. Also write an in-app notice to the person when a link switched something off.
4. **L3** 0046_email.sql:58,62: unique (tenant_id, id) on notifications (index built concurrently) and email_queue; make both foreign keys composite. New migration, additive.
5. **L4** email-worker.service.ts:318,328: catch and log queueDigests on its own; run purge in finally / as its own step per client.
6. **Note** leases: use the database's now() for claimedUntil and the lapsed-claim test.
7. **Note** backgroundContextOf: move to a provider exported only to EmailModule.

Accepted as specified: the sentinel subject names the classification; immediate emails do not re-check access.

## Findings (summary of Rima's report)
- M1: a refused SMTP login (535 EAUTH, permanent: true) fails every queued email at its first attempt, with no retry, including sentinel alerts.
- L1: switch, entitlements read once per client run; a long 07:00 run keeps sending after email is switched off.
- L2: unsubscribe link replayable for 90 days, even after the person turns emails back on.
- L3: single-column FKs email_queue.notification_id and email_outbox.queue_id can point into another tenant (FK checks bypass RLS); tested and accepted.
- L4: a failing queueDigests stops that client's immediate sending and its 30-day purge.
- Sound: RLS and grants on all four tables, worker per-tenant scoping, HMAC token (timing-safe, strict parse), unsubscribe pages (no change on GET, strict headers), form-body exception, content rules, digest runs as the person, address and header handling, SMTP TLS, logs, misconfiguration, exactly-once guards, retention, audit, permissions, no secrets.
- Not checked: live SMTP, Next.js rewrite header pass-through, reverse-proxy logs holding tokens, large-client load.
