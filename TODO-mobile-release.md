# TaskMinder mobile release plan
The iOS Swift project lives in a separate repository.

## Release path

| Step | Scope | Status |
|------|-------|--------|
| v2.4.0 (web/backend) | Reports and moderation. Required before any public iOS build. | Backend and moderation panel on `feat/moderation-reports`; in-app report UI open |
| Public beta (iOS app, no notifications) | TestFlight external testing. Web-app hardening for the iOS shell ships in 2.4.x/2.5.0 web releases (version TBD). | Not started |
| Store release, v2.5.0 (iOS app, with notifications) | Public App Store listing in Germany, including push notifications through APNs. | Not started |

## Decisions

- Ship reports and moderation in v2.4.0 (before any public iOS build)
- Launch on the iOS App Store first
- Initial store country: Germany, do not launch globally by default
- OS support policy: iOS versions (N and N-1). As of September 2026, that means iOS 26+; re-evaluate (?)
- TaskMinder remains free on web and iOS. No paid tiers, subscriptions, in-app purchases, or StoreKit.
- Validation is manual through TestFlight. No automated iOS test suite is planned for v1.
- Run the public beta without notifications to validate beta review, installation, reliability
- Ship the store release (v2.5.0) with notifications. Send notifications directly through APNs

## Open Decisions
- [ ] Name one person as iOS release owner and a backup. The owner coordinates App Store Connect, signing keys, submissions, and incidents.
- [ ] Load the live app from `https://app.taskminder.de`; do not package a `file://` copy or add a custom URL scheme. Keep the web app available.
- [ ] Keep the native bridge small and versioned. Web/backend releases must remain compatible with the oldest supported app version.
- [ ] Decide back navigation in the iOS app. Once the web app treats the native shell as standalone, it replaces history entries instead of pushing them (`frontend/src/snippets/loadingBar/loadingBar.ts:105`), so iOS swipe-back has nothing to return to. Define what back does before enabling standalone mode in the shell.

## Product scope

- [ ] Use a persistent `WKWebView` with native offline/retry screens.
- [ ] Make the app meaningfully app-like rather than a bare website wrapper: integrate platform navigation, sharing/copying, files/downloads, PDF viewing, external links, Universal Links, keyboard/insets, accessibility, and release logging.
- [ ] Beta builds: no notification entitlements, permissions, SDK setup, native handlers, settings, toggles, screenshots, store copy, or privacy declarations. Store release: add them as described in section 3. Do not add browser Web Push.
- [ ] Keep anonymous class sessions and signed-in account flows working exactly as on the web.
- [ ] Add durable routes for homework and events. None exist yet (only `/join` and the uploads query parameter). Universal Links must open the correct item after cold start or login, with a safe fallback if access is gone; the same routes are the notification deep links of the store release.

## 1. Account and App Store setup

- [ ] Verify the chosen Apple Developer account type, identity, legal name, and public seller name. Record the release owner, backup, and key-rotation process.
- [ ] Reserve the iOS bundle ID. Create the app record and signing credentials; store keys securely. Create the APNs key when notification work begins after the beta. The iOS project currently uses `com.mingqili.TaskMinder`; a bundle ID cannot change once the app record exists, so choose it deliberately (for example `de.taskminder.app`).
- [ ] Build with the SDK accepted at submission. The current requirement is the iOS 26 SDK or later; recheck before upload. This build requirement is separate from the minimum supported OS version above.
- [ ] Decide whether iOS supports iPhone only or iPhone and iPad. Match screenshots and layouts to that choice. The Xcode project currently targets both (`TARGETED_DEVICE_FAMILY = "1,2"`).
- [ ] Prepare a populated review account and example class with safe data. Document sign-in, class membership, offline behavior, file handling, sharing, reporting, and deep-link review steps (TestFlight external testing also requires beta app review).

## 2. WebView and web-app hardening (beta gate)

- [ ] iOS: use one persistent `WKWebView` for `https://app.taskminder.de/main`, with `WKAppBoundDomains`, restricted navigation, and default persistent website data. Verify Service Worker, Cache API, IndexedDB, login persistence, and warm offline reload.
- [ ] Support `/join`, `/main`, homework, events, uploads, settings, PJAX/history, back navigation, socket reconnect, external links, downloads, PDFs, file selection, upload progress, session expiry, account switching, app termination, maintenance, and cold/warm offline launch.
- [ ] Keep native app sessions independent from Safari or other browsers. Preserve only the WebView's own storage.
- [ ] Block release until private offline data is isolated by account and class. v2.3.3 clears the API cache and the request queue whenever the account or class changes (`syncOfflineIdentity`, `frontend/src/global/global.ts:1379`). Still open: cache names are app-version-only (`"core-v"`/`"api-v"` + version, `frontend/src/sw.ts:182-183`), so isolation depends on that check running; move to per-identity cache names or equivalent and verify account switching in the web app and the iOS app.
- [ ] Make queued writes in `frontend/src/global/global.ts` identity-safe. v2.3.3 discards the queue when the account or class changes. Still open: tag each queued write with its account/class (`queueRequest`, `global.ts:776`), surface discarded or failed writes, and make sure the in-memory `csrfToken` is still valid for the session at replay time (`ajax()` already overwrites the stored `X-CSRF-Token` and `X-API-Version` headers with current values). Queues replay only while the web/app page runs.
- [ ] Exclude session and CSRF routes from private caching and audit every cached API route. `/csrf-token` is cached as an API route (`frontend/src/sw.ts:65`); `ajax()` needs a token before it can queue offline, so change this together with the queue replay. Done in v2.3.3: outdated-cache cleanup removes only TaskMinder-owned caches (`removeOutdatedCaches`, `sw.ts:79`).
- [ ] Keep service-worker behavior compatible across active pages, maintenance, backend changes, and at least two web deployments.
- [ ] Detect the signed-in native bridge only on the trusted origin. Hide web install prompts and donation/payment links inside the iOS shell without changing the normal web experience.
- [ ] Treat the iOS shell as standalone in the web app. `isStandalone` (`frontend/src/global/global.ts:39`) checks `display-mode: standalone`, which is false inside `WKWebView`. Inside the app, internal links then open via `window.open` (`richTextarea.ts:55`, `fileViewer.ts:271`), page navigation pushes history entries instead of replacing them (`loadingBar.ts:105`), and Settings shows the iOS add-to-Home-Screen notice (`frontend/src/pages/settings/settings.ts:958`). Detect the shell through the bridge on the trusted origin; a user-agent suffix is acceptable only for cosmetic switches.
- [ ] Serve `/.well-known/apple-app-site-association` as `application/json` on `app.taskminder.de`, without redirects. `nginx.config.template` currently has only an `acme-challenge` location under `/.well-known/`. Needs the Apple team ID.
- [ ] Manually test all core flows on physical devices for every supported iOS version before submission.

## 3. Notifications (store release gate, after the beta)

Starts after the public beta. Required for the store release (v2.5.0); ship it with matching privacy disclosures, review notes, operations, and tests.

- [ ] Add per-installation records: account, installation ID, encrypted APNs token and lookup hash, enabled state, environment (sandbox/production), locale/time zone, app/bridge version, last seen, and failure status. Support multiple devices and delete records with the account.
- [ ] Add authenticated, CSRF-protected register/update/unregister endpoints. Bind tokens to the current account; refresh on launch/token rotation and disable on logout, account switch, class exit, deletion, or opt-out.
- [ ] Add app-only settings: explanation, enable action, OS permission state, category toggles, and a system-settings link after denial. Show no dead toggle on the website.
- [ ] Define recipients server-side at send time: shared/personal scope, class/team membership, author suppression, deduplication, removals, bans, and permission changes.
- [ ] Use a durable outbox after the database commit. Send with retry/backoff, idempotency, rate limits, invalid-token cleanup, and metrics. Push failure must not fail item creation.
- [ ] Use generic lock-screen text with no names, class details, descriptions, or filenames. Include only an opaque item ID/type and recheck authorization when opened; open the durable homework/event routes.
- [ ] Store preferences per account and delivery state per installation. Decide whether the first notification release needs quiet hours; if so, use the user's time zone and handle daylight-saving changes.
- [ ] Test denial/revocation, multiple devices, rotation, duplicates, offline devices, deleted items, removed or banned members, logout, account deletion, and stale app versions.
- [ ] Document APNs key access, token retention, alerts, and a global push kill switch.

## 4. iOS app

Current project state (November 2026): the Xcode project is a stub. It loads the landing page `https://taskminder.de` instead of `/main`, calls `load()` on every SwiftUI `updateUIView`, uses an unconfigured `WKWebView()`, sets the deployment target to iOS 26.2, uses a generated Info.plist, has no entitlements file, and has no app icon images.

- [ ] Set the deployment target to iOS 26.0 to match the OS support policy.
- [ ] Add a real Info.plist file next to the generated settings: `WKAppBoundDomains` is an array and cannot be set through `INFOPLIST_KEY_*` build settings. List every host the WebView loads (production, plus staging if Debug builds point there); the maximum is 10 domains.
- [ ] Add `NSCameraUsageDescription` in German. The WebView file picker offers "Take Photo", and the app crashes without this key.
- [ ] Add an entitlements file with the Associated Domains entitlement `applinks:app.taskminder.de`.
- [ ] Handle `<a download href="blob:…">` with `WKDownload` and pass the file to the share sheet or QuickLook. This covers the `.ics` export (`frontend/src/pages/events/events.ts:438-442`) and the upload download button (`frontend/src/pages/uploads/uploads.ts:548`).
- [ ] Reload the page in `webViewWebContentProcessDidTerminate`. Observe `WKWebView.themeColor` to color the status bar and the area behind the page.
- [ ] Show the native retry screen when a main-frame navigation returns the service-worker offline page (status 503 with `X-TaskMinder-Offline: 1`).
- [ ] If the app sets `applicationNameForUserAgent`, keep the default `Mobile/15E148` token (for example `Mobile/15E148 TaskMinderiOS/<version>`); the property replaces the default instead of appending to it.
- [ ] Build a SwiftUI shell around one `WKWebView`. Restrict navigation and bridge messages to the trusted main frame; open outside links in Safari or `SFSafariViewController`.
- [ ] Bridge only platform/version data, sharing, and incoming Universal Links (store release: also notification state and token registration). Validate origin and message shape.
- [ ] Queue Universal Link targets until the WebView and login are ready. Never show private content before authorization.
- [ ] Beta builds: no push-notification entitlement, APNs registration, authorization prompts, or notification handlers. Store release: add them with the settings and handlers from section 3.
- [ ] Implement loading/offline/retry states, navigation, sharing/copying, files/downloads, PDF preview, keyboard, safe areas, accessibility, signing, icon, launch appearance, and release logging.
- [ ] If App Review rejects the wrapper under rule 4.2, add a useful native feature such as a next-item widget or quick action rather than a cosmetic screen.

## 5. Policy, privacy, and safety

- [ ] Block any public build until users can report content and users in-app. v2.4.0 (`feat/moderation-reports`) has the backend: reports on homework, events, uploads, accounts, and the class (anonymous sessions allowed, rate-limited), bans, statements of reasons, author/last-editor tracking, Resend mails, and the password-protected moderation panel at `/moderation`. Still open: the in-app report UI (nothing in the app calls `/api/reports` yet), a visible support contact, and a workable block/hide design for shared class data.
- [ ] Require current terms for user-generated content and keep suitable upload filtering, rate limits, audit data, and response procedures. v2.4.0 adds a reports, moderation, and appeal section to the terms.
- [ ] Have a qualified reviewer check the target age, the existing "16 or parental permission" rule, App Store age rating/audience declarations, minors, teacher names, files, parental consent, and German/EU data protection.
- [ ] Update the privacy policy and in-app text for the real data flow, including Apple processing, purpose, retention, deletion, and international transfers. v2.4.0 adds reports/moderation and Resend sections. Beta: do not declare APNs token collection. Store release: declare it. Correct any claim that data never reaches third parties; complete Apple App Privacy from the real data flow.
- [ ] Account deletion must address shared content and stay easy to find in-app (required by the App Store). Once notifications exist, deletion must also remove push installations.
- [ ] Remove or externally open Ko-fi/donation links where required. Keep all digital features free. The in-app navbar links to Ko-fi (`frontend/src/snippets/navbar/navbar.html:123`).
- [ ] Check AGPL-3.0-only and third-party asset obligations for the iOS repository and App Store distribution.
- [ ] Complete Apple EU DSA trader status, export/encryption answers, support/privacy URLs, content rights, and permission disclosures. Recheck all App Store rules at submission.
- [ ] Prepare reviewer notes explaining the recurring school-organizer use, concrete native integrations, reporting/moderation, and demo login. Explain why the app is useful as an installed mobile experience and not merely a repackaged website.

## 6. Beta and release gates

### Public beta (no notifications)

- [ ] v2.4.0 is live, including the in-app report UI.
- [ ] Run TestFlight external testing. Track crashes, offline behavior, deep links, file handling, auth/session issues, and reviewer-facing problems.
- [ ] Test current and oldest supported iOS versions on physical devices, including slow/no network, app termination, account switching, and expired sessions.
- [ ] Block the beta if any offline data or queued write can cross accounts/classes/teams.
- [ ] Run backend/frontend builds, lint, and migrations. Keep rollback instructions and deploy compatible web/backend changes before dependent app binaries.

### Store release (v2.5.0, with notifications)

- [ ] Section 3 is done and tested on physical devices, including the push kill switch.
- [ ] Prepare German App Store text, real screenshots (including notification settings), age rating, App Privacy answers (including APNs tokens), support links, release notes, and reviewer instructions.
- [ ] Use phased release. Monitor reviews, crashes, offline failures, auth failures, deep-link failures, push delivery failures, and support reports.
- [ ] Release is complete only when the Germany App Store listing is live, production deep links, notifications and account deletion work, moderation reports reach the operator, no private offline data or queued write can cross identities, and the web app still works.
