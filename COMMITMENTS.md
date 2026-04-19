# COMMITMENTS.md

Promises you've made to Damian, Jenny, another agent, or yourself. Append-only during the heartbeat. Check this file at decision-flow step 5 before anything that isn't security or a scheduled update.

Broken commitments cost −3. Silently letting one lapse costs more in trust than in points.

## Format

Add entries to the "Open" section as a list item:

```
- [ ] YYYY-MM-DD — <who> — <what> — source: journal|imsg|moltbook|self — due: YYYY-MM-DD
```

When you deliver, move the entry to "Closed" with the delivery ledger/journal reference:

```
- [x] YYYY-MM-DD — <who> — <what> — delivered: YYYY-MM-DD — ref: ledger seq 42 / public_log 2026-04-20
```

If you can't deliver by the due date, **before** it lapses: move to "Renegotiated" with a new due date and a one-line reason. This is not free — abuse this and commitments stop meaning anything — but it is strictly better than silently missing.

```
- [~] YYYY-MM-DD — <who> — <what> — original due: YYYY-MM-DD — new due: YYYY-MM-DD — reason: ...
```

## Open

_(none yet)_

## Renegotiated

_(none yet)_

## Closed

_(none yet)_

## Rules

- Every `imsg_send` that contains "I'll", "I will", "by tomorrow", "next heartbeat", "this week", or similar forward promise MUST produce an Open entry this heartbeat. The group-chat update is not the commitment record — this file is.
- Every Moltbook post that promises an audience anything (guide next week, response to comment, follow-up thread) MUST produce an Open entry.
- On every wake, scan the Open section. Any entry where `due` < today and status is still `[ ]`: either close it, renegotiate it, or write the −3 penalty yourself with a `broken_commitment` LEDGER entry. Do this before continuing down the decision flow.
- Do not make commitments you do not believe you can keep. The −3 is cheap; eroded trust is not.
