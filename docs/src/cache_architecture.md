# Redis Cache Architecture

## Introduction

TaskMinder uses one Redis instance (`redisClient`) for:

1. **Data cache**: read-through caches of database query results, namespaced under `cache:`.
2. **Auth gates**: short-lived flags that throttle account/class existence checks.
3. **Sessions**: the `express-session` store plus a per-class reverse index.
4. **Job queue**: a list that hands file-processing jobs to a worker.
5. **Locks and rate limits**: used by the reporting and moderation flow.

The connection, key-prefix constants, lock helpers (`acquireLock`, `releaseLock`) and queue helpers live in `backend/src/config/redis.ts`; the session middlewares and the moderation session store in `backend/src/config/session.ts`.

---

## Key Naming Conventions

Data-cache keys are built by `generateCacheKey(baseKey, classId, accountId?)`:

```
cache:<baseKey>:<classId>                  // shared (class-wide) partition
cache:<baseKey>:<classId>:acc:<accountId>  // personal (per-account) partition
```

- `<baseKey>` is a `CACHE_KEY_PREFIXES` value (see section 1).
- Only homework and events have a personal partition; omitting `accountId` addresses the shared one.
- Exceptions: for substitutions `<classId>` holds `dsbMobileUser` (data is per school), and `site_statistics` has no `<classId>` slot.

| Namespace          | Pattern                                | Built by                                |
| :----------------- | :------------------------------------- | :-------------------------------------- |
| Auth gate (user)   | `auth_user:<accountId>`                | access middleware                       |
| Auth gate (class)  | `auth_class:<classId>`                 | access middleware                       |
| Session payload    | `sess:<sid>`                           | `RedisStore` (`prefix` = `sess:`)       |
| Moderation session | `mod_sess:<sid>`                       | `RedisStore` (`prefix` = `mod_sess:`)   |
| Class session set  | `class_sessions:<classId>`             | `RedisStore`                            |
| Job queue          | `file_processing_queue`                | `QUEUE_KEYS`                            |
| Lock               | `mail_queue_lock`                      | `acquireLock` in the mail queue         |
| Rate-limit counter | `report_notify:operator`, `report_mail:…` | `report.service.ts`                  |
| Mail budget        | `mail_budget:<YYYY-MM-DD>`             | `sendMail` in `config/mail.ts`          |

---

## 1. Data Cache

Read-through, write-on-miss caches of Prisma results: a hit returns the parsed JSON, a miss queries the database, writes the result with a TTL and returns it. BigInt values are serialized to strings via a custom replacer.

| Base key             | Full key                                     | Value                 | TTL          |
| :------------------- | :------------------------------------------- | :-------------------- | :----------- |
| `homework_data`      | `cache:homework_data:<classId>`[`:acc:<id>`] | JSON array of rows    | 3600 s       |
| `event_data`         | `cache:event_data:<classId>`[`:acc:<id>`]    | JSON array of rows    | 3600 s       |
| `event_type_data`    | `cache:event_type_data:<classId>`            | JSON array of rows    | 3600 s       |
| `event_type_styles`  | `cache:event_type_styles:<classId>`          | Rendered CSS string   | 3600 s       |
| `subject_data`       | `cache:subject_data:<classId>`               | JSON array of rows    | 3600 s       |
| `lesson_data`        | `cache:lesson_data:<classId>`                | JSON array of rows    | 3600 s       |
| `teams_data`         | `cache:teams_data:<classId>`                 | JSON array of rows    | 3600 s       |
| `upload_metadata`    | `cache:upload_metadata:<classId>`            | JSON array of rows    | 3600 s       |
| `upload_requests`    | `cache:upload_requests:<classId>`            | JSON array of rows    | 3600 s       |
| `substitutions_data` | `cache:substitutions_data:<dsbMobileUser>`   | `{ data, timestamp }` | 60 s / 600 s |
| `site_statistics`    | `cache:site_statistics`                      | JSON object           | 300 s        |

The standard TTL (`cacheExpiration`) is 3600 s. Three keys deviate:

- `event_type_styles` stores a pre-rendered CSS string that is served straight to the client.
- `substitutions_data` uses stale-serve and a variable TTL (below).
- `site_statistics` is one global key, built directly (`` cache:${CACHE_KEY_PREFIXES.STATISTICS} ``) because `/stats` aggregates the whole database. Its 300 s TTL (`statisticsCacheExpiration`) matches the route's `Cache-Control: public, max-age=300`. It is never invalidated explicitly: the writes that change it are spread over too many code paths, so it relies on the TTL.

`updateCacheData` and `invalidateCache` log Redis errors instead of throwing, so a Redis failure degrades to a cache miss rather than a failed request.

### Personal vs. shared partitions (homework and events)

The shared partition (`accountId` = `null`, team-scoped) has one key per class; the personal partition has one key per account. Reads fetch both, merge and re-sort to the canonical order; anonymous viewers only get the shared one. Writes invalidate only the partition they touched.

### Author ids (homework, events, uploads)

`authorAccountId` and `lastEditorAccountId` (homework, events) and `lastEditorAccountId` (uploads) are left out of every query by a global `omit` on the Prisma client (`config/prisma.ts`), so they are never cached or returned. Only queries that `select` them (reports) read them. No list response says whether an item has an open report; only the moderation panel shows reports.

### Substitutions cache

Data comes from the external DSB Mobile service and relies on TTL, stale-serve and prefetch, not explicit invalidation:

- **Envelope**: `{ data, timestamp }`, so freshness is judged independently of the Redis TTL. Outside the peak window an entry older than 600 s is refreshed on demand.
- **Variable TTL**: 60 s in the peak window (weekdays 06:00-09:00 local), 600 s otherwise. The prefetch job always writes 60 s.
- **Stale-serve**: if a live fetch fails, the cached entry is served instead of an error.
- **Prefetch**: a background job warms every DSB-activated school (deduplicated by `dsbMobileUser`, batches of 5) before peak reads.

---

## 2. Auth Gates

Flags that reduce "does this account/class still exist?" checks to once per 15 minutes. On a miss the middleware queries Postgres, then writes the flag.

| Key                     | Value    | TTL    | Explicit invalidation |
| :---------------------- | :------- | :----- | :-------------------- |
| `auth_user:<accountId>` | `"true"` or `"banned"` | 15 min | Account deletion (`account.service.ts`), ban and unban (`moderation.service.ts`), removal from a class (`class.service.ts`) |
| `auth_class:<classId>`  | `"true"` | 15 min | Class deletion and member removal (`class.service.ts`), class cleanup (`db.cleanup.ts`) |

Only `"true"` passes the gate. The flag is written only when the account exists, has `deletedAt = null` and is not banned (`assertNotBanned`), and only with `NX`. A ban overwrites the key with `"banned"` (15 min), so a request that read the account before the ban committed cannot write `"true"` back afterwards; the ban applies at once. Unbanning deletes the marker. A soft-delete without a `del` only takes effect when the flag expires, so such an account can pass the gate for up to 15 minutes; hard deletes invalidate explicitly.

---

## 3. Sessions

`RedisStore` in `backend/src/config/redis.session.ts` implements the `express-session` store.

| Key                        | Type          | Contents                                         | TTL                                                |
| :------------------------- | :------------ | :----------------------------------------------- | :------------------------------------------------- |
| `sess:<sid>`               | String (JSON) | Serialized `SessionData`                         | Cookie expiry; default 30 days                     |
| `class_sessions:<classId>` | Set           | Session keys of one class                        | Raised to at least the longer of session TTL and 30 days |
| `mod_sess:<sid>`           | String (JSON) | Moderation panel session (login end, CSRF token) | Cookie expiry; 3 hours                             |

The moderation panel (`/moderation`) has its own store and cookie (`TaskMinderModeration`, path `/moderation`, `SameSite=Strict`, 3 hours), so moderator rights never ride on the 30-day app session. Its sessions have no class and are in no class set.

`class_sessions:<classId>` is a reverse index for finding and destroying all sessions of a class (class cleanup, kicked members). `set` adds the key (and removes it from the previous class's set on a class switch), `destroy` removes it, `touch` only refreshes TTLs. The set's TTL is only raised, never shortened, and stale members are pruned lazily when read (`getClassSessionKeys`).

---

## 4. Job Queue

`file_processing_queue` is a list: `lPush` enqueues, `rPop` dequeues (FIFO), `lLen` gives the length. Producers call `queueJob`, the upload worker drains with `dequeueJob`; jobs are JSON.

---

## 5. Locks and Rate Limits

**Locks**: `acquireLock(key, ttl)` runs `SET key <random token> EX <ttl> NX` and returns the token. The holder frees it in `finally` with `releaseLock(key, token)`, a Lua script that deletes the key only while it still holds the token, so a holder that outran the TTL cannot free the next holder's lock. `releaseLock` never throws (it logs), so it cannot hide the holder's own error. The TTL only covers a crash or a failed release.

| Key               | TTL   | Protects                                   | On contention                        |
| :---------------- | :---- | :----------------------------------------- | :----------------------------------- |
| `mail_queue_lock` | 5 min | Two mail queue runs sending one mail twice | Run skipped, next one a minute later |

Reports and decisions need no lock. A partial unique index on open reports (`reporterKey`, `targetType`, `targetId`) refuses a second open report by the same reporter, which is then treated as reported. A decision resolves its reports with a conditional update (`resolvedAt` still empty) as first step of its transaction, so a parallel decision on one of them waits for that row, finds it resolved and gets `410 Gone`.

**Rate limits**: fixed window, `INCR` and `EXPIRE <window> NX` in one `MULTI`, so a crash cannot leave a counter without expiry. Over-limit requests still count. Emails are hashed in keys.

| Key                         | Limit    | When exceeded                                                               |
| :-------------------------- | :------- | :-------------------------------------------------------------------------- |
| `report_mail:<hash(email)>` | 3 / day  | Report filed with no contact address (reporters can enter any address)      |
| `report_notify:operator`    | 50 / day | No operator mail (still in digest)                                          |

`POST /api/reports` itself is limited in memory by `express-rate-limit`: 5 per minute per reporter (account or session), and 60 per minute per IP as a backstop against new anonymous sessions.

Everything else is bounded by the mail budget below (Brevo's free plan, 300 a day); reporter mails past it wait in the queue.

**Mail budget**: `sendMail` counts every mail in `mail_budget:<UTC date>` (expires after 2 days) and refuses past 300. Receipts and decision mails to reporters are not sent directly: they are queued in the `mailQueue` table in the same transaction as the report or decision and sent by `processMailQueue` (every minute and right after queueing). A mail refused by the budget or failed (Brevo error, also Brevo's own daily quota) is tried again an hour later, and dropped with an error log once it has failed for 7 days. Operator mails and the digest are sent directly and only logged when they fail, since the digest covers them.
