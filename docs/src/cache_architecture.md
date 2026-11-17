# Redis Cache Architecture

## Introduction

TaskMinder uses one Redis instance (`redisClient`) for five things:

1. **Data cache**: read-through caches of database query results, namespaced under `cache:`.
2. **Auth gates**: short-lived existence/validity flags that throttle account/class checks.
3. **Sessions**: the `express-session` store plus a per-class reverse index.
4. **Job queue**: a list used to hand file-processing jobs to a worker.
5. **Locks and rate limits**: short-lived locks and fixed-window counters used by the reporting and moderation flow.

The connection, key-prefix constants, lock helper (`acquireLock`), and queue helpers live in `backend/src/config/redis.ts`.

---

## Key Naming Conventions

### Data cache keys

All data-cache keys are built by `generateCacheKey(baseKey, classId, accountId?)`:

```
cache:<baseKey>:<classId>                  // shared (class-wide) partition
cache:<baseKey>:<classId>:acc:<accountId>  // personal (per-account) partition
```

- `<baseKey>` is one of the `CACHE_KEY_PREFIXES` values (see table below).
- The `:acc:<accountId>` suffix only applies to caches with a personal partition (currently homework and events).
- Omitting `accountId` addresses the shared partition; passing it addresses one account's personal partition.
- Exception: for substitutions, `<classId>` actually holds `dsbMobileUser` (the DSB Mobile login), since substitution data is keyed per school, not per class. `site_statistics` is a further exception; see below.

### Other namespaces

| Namespace          | Pattern                       | Built by                          |
| :----------------- | :----------------------------- | :-------------------------------- |
| Auth gate (user)   | `auth_user:<accountId>`       | inline in access middleware       |
| Auth gate (class)  | `auth_class:<classId>`        | inline in access middleware       |
| Session payload    | `sess:<sid>`                  | `RedisStore` (`prefix` = `sess:`) |
| Class session set  | `class_sessions:<classId>`    | `RedisStore`                      |
| Job queue          | `file_processing_queue`       | `QUEUE_KEYS`                      |
| Lock               | `report_lock:…`, `moderation_lock:…` | inline in `report.service.ts` / `moderation.service.ts`, via `acquireLock` |
| Rate-limit counter | `report_class:…`, `report_notify:operator`, `report_mail:…`, `report_mail_ip:…` | inline in `report.service.ts` |

---

## 1. Data Cache

Read-through, write-on-miss caches of Prisma query results. A hit returns the parsed JSON directly; a miss queries the database, writes the result back with a TTL, then returns it. BigInt values are serialized to strings via a custom replacer.

| Base key             | Full key                                       | Value                  | TTL          |
| :------------------- | :--------------------------------------------- | :---------------------- | :----------- |
| `homework_data`      | `cache:homework_data:<classId>`[`:acc:<id>`]   | JSON array of rows     | 3600 s       |
| `event_data`         | `cache:event_data:<classId>`[`:acc:<id>`]      | JSON array of rows     | 3600 s       |
| `event_type_data`    | `cache:event_type_data:<classId>`              | JSON array of rows     | 3600 s       |
| `event_type_styles`  | `cache:event_type_styles:<classId>`            | Rendered CSS string    | 3600 s       |
| `subject_data`       | `cache:subject_data:<classId>`                 | JSON array of rows     | 3600 s       |
| `lesson_data`        | `cache:lesson_data:<classId>`                  | JSON array of rows     | 3600 s       |
| `teams_data`         | `cache:teams_data:<classId>`                   | JSON array of rows     | 3600 s       |
| `upload_metadata`    | `cache:upload_metadata:<classId>`              | JSON array of rows     | 3600 s       |
| `upload_requests`    | `cache:upload_requests:<classId>`              | JSON array of rows     | 3600 s       |
| `substitutions_data` | `cache:substitutions_data:<dsbMobileUser>`     | `{ data, timestamp }`  | 60 s / 600 s |
| `site_statistics`    | `cache:site_statistics`                        | JSON object            | 300 s        |
| `reported_ids`       | `cache:reported_ids:<classId>`                 | `{ homework, event, upload }`, each an array of ids | 3600 s |

The standard TTL (`cacheExpiration`) is 3600 s (60 min). Three keys deviate:

- `event_type_styles` stores a pre-rendered CSS string rather than a row array, so it can be served straight to the client.
- `substitutions_data` uses stale-serve and a variable TTL; see below.
- `site_statistics` is a single global key with no `<classId>` slot, built directly (`` cache:${CACHE_KEY_PREFIXES.STATISTICS} ``) rather than via `generateCacheKey`, since `/stats` aggregates across the whole database rather than one class. Its 300 s TTL (`statisticsCacheExpiration`) matches the route's `Cache-Control: public, max-age=300` header, so server- and client-side staleness stay in sync. Like substitutions, it is never explicitly invalidated: class/homework/event writes happen across too many unrelated code paths for a targeted `del` to be worthwhile, so it relies on the TTL alone.

### Personal vs. shared partitioning (homework & events)

Homework and events are split into two partitions: a shared partition (`accountId` = `null`, team-scoped, one key per class) and a personal partition (one key per account, `:acc:<accountId>`).

The read path fetches both partitions, merges them, and re-sorts to preserve the canonical ordering. Anonymous/account-less viewers only ever receive the shared partition. Writes invalidate only the partition they touched: the shared key when `accountId` is `null`, otherwise just the affected account's personal key, keeping cache busts surgical.

Cache writes (`updateCacheData`) and invalidations (`invalidateCache`) log Redis errors instead of throwing, so a Redis failure degrades to a cache miss rather than failing the request.

### Reported flags (homework, events, uploads)

List caches never hold the reported state. `reported_ids` stores per class the ids with an open report. On each read, `flagReportedItems` (`report.service.ts`) adds `isReported` and strips private author ids (`authorKeys`), so those can stay in the shared caches.

Filing or deciding a report calls `refreshReportedFlags`: deletes `reported_ids` and emits a socket event so clients reload. List caches are untouched; `reported_ids` is not in class cleanup and expires by TTL.

### Substitutions cache

Substitution data is fetched from the external DSB Mobile service and relies entirely on TTL, stale-serve, and prefetch rather than explicit invalidation:

- **Value envelope**: `{ data, timestamp }` rather than a bare array, so freshness can be evaluated independently of the Redis TTL. Outside the peak window an entry older than 600 s (by `timestamp`) is treated as expired and refreshed on demand.
- **Variable TTL**: 60 s during the peak window (weekdays 06:00-09:00 local), 600 s otherwise. The prefetch job always writes with 60 s.
- **Stale-serve**: if a live fetch from DSB Mobile fails, the previously cached entry is served instead of erroring.
- **Prefetch**: a background job warms the cache for every DSB-activated school (deduplicated by `dsbMobileUser`, processed in batches of 5) so peak-time reads hit a warm cache.

---

## 2. Auth Gates

Negative-lookup-avoidance flags that throttle "does this account/class still exist?" checks to once per 15 minutes instead of once per request. On a miss, the middleware queries Postgres to confirm existence (and, for accounts, that `deletedAt` is `null`), then writes the flag.

| Key                     | Value    | TTL    | Explicit invalidation                                    |
| :----------------------- | :------- | :----- | :--------------------------------------------------------- |
| `auth_user:<accountId>` | `"true"` | 15 min | Deleted on account deletion (`account.service.ts`), on ban (`moderation.service.ts`), and for accounts removed from a class (`class.service.ts`) |
| `auth_class:<classId>`  | `"true"` | 15 min | Deleted on class deletion and member removal (`class.service.ts`) and class cleanup (`db.cleanup.ts`) |

The flag is only written after the checks on a miss pass: the account must exist, have `deletedAt = null`, and not be banned (`assertNotBanned`). A banned account therefore never gets a flag, and banning deletes an existing one so the ban takes effect immediately instead of up to 15 minutes later. A soft-delete (`deletedAt`) without an accompanying `del` only takes effect once the flag expires, so a soft-deleted account can keep passing the gate for up to 15 minutes. Hard deletes invalidate the gate explicitly.

---

## 3. Sessions

The `express-session` store is implemented by `RedisStore` in `backend/src/config/redis.session.ts`.

| Key                        | Type          | Contents                              | TTL                          |
| :-------------------------- | :------------ | :------------------------------------- | :----------------------------- |
| `sess:<sid>`               | String (JSON) | Serialized `SessionData`              | Follows cookie expiry; default 30 days |
| `class_sessions:<classId>` | Set           | Session keys belonging to one class   | Raised to at least the longer of the session TTL and 30 days |

`class_sessions:<classId>` is a reverse index that lets the application find and destroy all sessions for a given class (e.g. on class cleanup or when members are kicked). A session `set` adds the key to its class set (and removes it from the previous class's set if the session switched class), `destroy` removes it, and `touch` only refreshes TTLs. The set's TTL is only ever raised (never shortened) to at least the longer of the session TTL and the 30-day default, and stale members are lazily pruned when the set is read (`getClassSessionKeys`).

---

## 4. Job Queue

| Key                     | Type | Operations                                            |
| :------------------------ | :--- | :------------------------------------------------------ |
| `file_processing_queue` | List | `lPush` (enqueue), `rPop` (dequeue, FIFO), `lLen` (length) |

Producers enqueue file-processing jobs with `queueJob`; the upload worker drains them with `dequeueJob`. Jobs are JSON-serialized.

---

## 5. Locks and Rate Limits

**Locks**: `acquireLock(key, ttl)` uses `SET key 1 EX <ttl> NX`; the holder deletes the key in `finally`, the TTL only covers a crash.

| Key                                                 | TTL  | Protects                          | On contention       |
| :-------------------------------------------------- | :--- | :-------------------------------- | :------------------ |
| `report_lock:<reporterKey>:<targetType>:<targetId>` | 10 s | Duplicate report by same reporter | Treated as reported |
| `moderation_lock:<targetType>:<targetId>`           | 60 s | Double resolve of a report        | `409 Conflict`      |

**Rate limits**: fixed window (`INCR`, then `EXPIRE <window> NX`). Over-limit requests still count. Emails and IPs are hashed before use in keys.

| Key                         | Limit     | When exceeded                            |
| :-------------------------- | :-------- | :--------------------------------------- |
| `report_class:<classId>`    | 30 / hour | `429`                                    |
| `report_notify:operator`    | 20 / hour | No operator mail (still in daily digest) |
| `report_mail:<hash(email)>` | 3 / day   | Report filed without contact address     |
| `report_mail_ip:<hash(ip)>` | 5 / day   | Same                                     |
| `report_mail:total`         | 50 / day  | Same                                     |
