# Release Notes

All changes are grouped by type and the latest version appears first.

---

## \[v2.3.2] - 2026-09-??

### Fixed
* fix(statistics): keep homework and event totals at their historical maximum after records are deleted
* fix(homework): keep homework personal for logged-in members without edit permission, even when a lesson team is autoselected
* fix(upload): improve PDF sanitization compatibility by converting uploads to PDF/A-2 with RGB blending

### Changed
* chore(upload): add detailed diagnostics when PDF sanitization fails

---

## \[v2.3.1] - 2026-09-15

### Added
* feat(subject): allow class managers to assign subjects to all students or to a specific team

### Fixed
* fix(bigint): serialize BigInt values consistently in API responses and Redis payloads, regardless of cache state
* fix(settings): update logged-out user permissions for the active class instead of a hard-coded class ID
* fix(legacy): show the legacy-origin notice using the Bootstrap toast API

### Changed
* chore(subject): filter timetable and homework subject choices based on joined teams
* chore(team): show only joined teams in event, homework, and upload selectors, and sort teams alphabetically
* chore(timetable): include teacher names when duplicate subject names need to be distinguished
* chore(landing): link app actions and legal pages to app.taskminder.de
* chore(packages): bump packages

---

## \[v2.3.0] - 2026-09-12

### Breaking Changes
* chore(codebase): migrate to typescript v6 (use oxlint workaround to satisfy prisma > v6)
* chore(license): change custom source-available TaskMinder to open source AGPLv3 license
* chore(app): separate application and landing page into app.taskminder.de and taskminder.de

### Added
* chore(dev): add dev mode to /bootstrap to avoid caching issues in development
* feat(homework/events): add personal homework and events
* feat(uploads): add improved preview and support for more file types

### Fixed
* fix(team): prevent authenticated users from modifying teams in arbitrary classes
* fix(session): revoke session cookie when user is removed from class to prevent continued access

### Changed
* chore(ui/upload): improve upload files UI
* chore(ui/ux): combine icons into dot menu for homework and events
* chore(readme): add banner, social media and info page notice
* chore(packages): bump packages (npm, docker, ci)

---

## \[v2.2.6] - 2026-06-04

### Breaking Changes
* chore(codebase): migrate to typescript 6 (locking in on v5 due to prisma issues)
* chore(prisma): migrate to prisma 7
* chore(session): migrate from connect-pg-simple to custom redis store

### Added
* feat(upload): add .md, .csv and .mp3 file upload support in backend
* feat(info): add info box with link to info.taskminder.de at /join

### Fixed
* fix(class): admin can delete members of other classes
* fix(middleware): pdf view fails on safari due to missing blob: for frame-src and connect-src
* fix(substitution): reduce substitution prefetch cache from 60min to 1 min (peak times) and 10 min (off-peak times)
* fix(csrfToken): do not issue csrfTokens eagerly, only when /csrf-token is requested

### Changed
* chore(env): add centralized .env variable loader and config
* chore(packages): bump packages (npm, docker, gh-actions)
* chore(docs): use built-in admonitions in mdbook
* chore(impressum/dsgvo): update Impressum and DSGVO to distinguish more clearly between "Betreiber" and legal representative

---

## \[v2.2.5] - 2026-04-12

### Breaking Changes
* chore(db): migrate postgresql@14 to postgresql@18
* feat(encryption): add server-side encryption

### Added
* feat(frontend): add caching and offline mode
* feat(maintenance): add maintenance mode
* feat(animation): add animations, add specific calendar animation
* feat(warnings): add suspicious settings warnings
* feat(upload): add upload description and request new uploads
* feat(upload): edit files
* feat(homework/event/upload): add homework/event/upload pinning
* feat(upload): file-input as pretty wrapper for drag&drop and browse file input with preview list
* chore(homework): add "later" section
* chore(ui): show breaks in the timetable and correctly display them (respect events/substitutions)

### Fixed
* fix(rate-limit): proxy setting and update nginx.config
* fix(subject): subject data not stringified correctly
* fix(account): send 201 instead of 200 at /register
* fix(links): /main links to events/homework do not use pjax
* fix(homework/check): homework check on /main does not work
* fix(navbar/login): login button in navbar does not always show up 
* fix(richtextarea): allow multiple spaces in rich textarea
* fix(search): search in plaintext not styled rich textarea text

### Changed
* chore(scss): compressed scss for event type styles
* chore(frontend/cache): better caching for event type styles and files
* chore(frontend/logic): guess new subjectId for substitution
* chore(ux): copy unknown error server response & better request timeout error toast
* chore(ui): better appearance of substituted breaks
* chore(logging): improve error logs on server
* chore(ui): improve frontend class settings on mobile
* chore(upload/loading): add upload loading animation
* chore(substitution): change DSBMobile fetch to weekday peak time prefetch
* chore(api): rename and change method of API routes
* chore(password): bump password requirements
* chore(ui): make bottombar icons pop on click
* chore(ui): scroll to top on site change
* chore(substitution): replace axios with node fetch
* chore(substitution): use shared cache key per school, avoid redundant DSB API fetches for classes within the same school
* chore(frontend/logic): remove $.get and replace with modern fetch
* chore(ui): change filter interface to modal and offcanvas (mobile)
* chore(tableview): improve table layouts for events & uploads
* chore(csp): remove csp .env variable
* chore(getdata): event, homework and upload metadata order by more values
* chore(docs): migrate to mdbook and github actions/pages for deployment
* chore(sitemap): update sitemap values
* chore(migration): add migrate upload metadata date script
* chore(package): update package.json version to v2.2.5, bump packages, update CI
* chore(frontend): several bugfixes and smaller improvements
* chore(backend): several bugfixes and smaller improvements

---

## \[v2.2.4] - 2026-01-11

🎉 Happy New Year! This release kicks off the year with improvements and fixes to make TaskMinder smoother, faster, and more reliable. Thanks for your support—here’s to a productive year ahead!

### Added
* feat(main): new homework view on /main
* feat(upload/event): add table/gallery view
* feat(upload/event/homework): add search boxes
* feat(timetable): suggest most used room for subject, add autocomplete markings
* chore(upload): add not supported note for download for webkit-standalone users

### Fixed
* fix(homework): check animation does not show
* fix(homework): homework list renders twice
* fix(homework): homework button stays disabled
* fix(navbar): reload button does not properly show / hide
* fix(getTeamsData): data is not stringified with BigIntreplacer, leading to fetch errors
* fix(migration): demo class homework/event movement does not work
* fix(upload): upload not found change http code from 400 to 404
* fix(event/homework): events/homework can be changed/deleted through API even if not in class
* fix(event): check for valid eventTypeId before adding/editing events
* fix(checkhomework): homework of foreign classes can be checked through API

### Changed
* chore(docs): update year to 2026
* refactor(class): rewrite 62base method to use randomInt from crypto package
* feat(event): singleflight deduplication for sass compilation of event styles
* chore(deps): update packages, allow bun > v1.3.5 again
* fix(rate-limit): increase global threshold to 125req/s

### Removed
* chore(deps): remove express-async-handler in favor of native ts implemetation

---

## \[v2.2.3b] - 2025-12-14

### Fixed
* fix(regression): homework checking is not consistent across page reloads on webkit clients (Safari)
* fix(regression): improved alloy config and better labelling
* chore(docker): bump monitoring stack packages

---

## \[v2.2.3a] - 2025-12-13

### Fixed
* fix(regression): checking homework would display all homework of the last 60 days
* fix(regression): page did not load properly with content (grey screen)
* fix(linting): run linting in frontend folder

---

## \[v2.2.3] - 2025-12-12

### Changed
* Backend: Invalidate cache at all update actions (edit, delete, set, etc.), only refetch if getting (GET) data
* Backend: Implement individual route rate-limiters
* Sys: Lock in bun on v1.3.3 (v1.3.4 has package installment issues) in production
* Frontend: Improve performance by listening directly on changed data instead of socket to update
* Frontend: Add explicit info box for data responsibility

### Fixed
* Backend: Fix awaiting some async functions in backend

### Security
* Package bumping

---

## \[v2.2.2] - 2025-11-30

### Changed
* Backend now sends regex for substitution data directly
* Add 400 return codes if file is too large or too many files being uploaded
* Explanation for test class is now wrapped in an info box
* Added createdAt field to multiple tables
* Cache is now invalidated/refechted if corresponding data changes
* Change cron job delete test class schedule to run every 15mins
* Uploads now support autocomplete for lessons and date (at title)

### Fixed
* Migrate from promtail (deprecated) to alloy
* (. Stunde) bug still existed in /main
* Certain lessons were not displayed in timetable
* "Heute kein Unterricht" (or the blue info box in general) did not always display immediately
* Improve production deployment regarding permissions (least privilege)
* Change host volume to named volume in docker compose to avoid permission errors
* Correct docs at db migration
* Fixed Adding/editing/checking homework will lead to displaying all homework (ignoring filters) of the last 90 days

### Removed
* Redis volume as not needed anymore (cache-only)

### Security
* Package bumping

---

## \[v2.2.1] - 2025-11-16

### Fixed
* BigInts were not correctly serialized to JSON at /get_upload_metadata
* ClamAV did not work in production as intended
* Add object "self" to CSP headers to support upload viewing

---

## \[v2.2.0] - 2025-11-16

### Added
* Add feature to upload files
* Timetable announcer, e.g. "Nächste Stunde Geographie in 48min in Raum 40983."
* Randomly select one homework (spin wheel), exclude/include homework in selection (like vocab)
* Add easter egg in devTools
* Add "Angemeldet als..." in offcanvas
* Socket events for many real-time changes
* Add loading bar to simulate progress
* Add frontend feedback for timetable changes
* Move events and homework further along (1 week)

### Fixed
* Fix bug where an account could not be deleted due to too early checks in backend
* Fix bug where teams could not be deleted due to wrong css selector in frontend
* Fix big where cache could return invalid or outdated data
* Fix bug where substitution cache would return No Data due to inconsistent thrid-party response
* Fix bug where "Neuer Nutzername" at change name is type=password

### Changed
* Different text styles for more or less important things, misc. UI changes
* Marking of text now adapts to background of event, etc.
* Improved data loading to skip file calling when previously called (up to 2x less requests and data transferred)
* Use substitutionData when auto selecting date at addHomework, etc.
* /main links smaller (arrows)
* Improved out-of-bounds checks and additional barrier checks in the backend
* Improved caching for all relevant tables if one related thing is updated
* Migrate from custom logger to winston
* Require bun v1.3.2 (> v1.3) in development and production (no breaking changes)
* Renaming files in backend for readability
* Monitoring /metrics endpoint exposed to local network instead of public route
* Bump loki, prometheus, grafana, promtail (no breaking changes)
* Bump redis to v8 (no breaking changes)
* Increased deletion for homework from 60 to 90 days

### Security
* Package bumping
* Close security issue with validator.js (removed)

### Removed
* Remove unused packages
* Remove unused domain names from nginx config

---

## \[v2.1.0] - 2025-09-27

### Added
* Add `prisma.config.ts` to Dockerfile
* Add event cleanup cron job (365 days)
* Tests for services in backend
* Accessibility features
* ToS

### Fixed
* Fix bug where a joined class user (not logged in) visiting `/join` or `/` would get the hardcoded `10d - className` value
* Fixed check for team/subject (now validates specific `teamId`, `subjectId`, and `classId`)

### Changed
* Update documentation
* Scripts improvements through `GITCMD` and `DOCKERCMD`
* Frontend improvements
* Improve SEO
* Change `classCode`, `className`, upgrade test classes to normal classes

### Removed
* Remove unused packages

---

## \[v2.0.0] - 2025-08-16

### Breaking Change
- Database structure (please refer to the migration guide on docs.taskminder.de)

### Added
- Functionality to create new classes (account required)
- Functionality to log out, delete account, change password and username
- Add autocomplete for due date and team selection as soon as subject is selected
- QR Code sharing of class code
- Copy paste for event/homework descriptions
- Add prisma transactions for safer database handling
- Add homework check animation
- Add sharing events with calendar
- Add soft deletion of accounts wth 30d auto delete from db
- Add permission levels (0,1,2,3) for classes with different permission levels
- Default setting for unregistered user and individual permissions for registered users
- Functionality to kick members from class
- Add 404 page

### Changed
- Change formatter to eslint formatting instead of prettier
- Improve data loading on frontend side
- Improve production handling by introducing build and run stages in Dockerfile
- Rename tables for more generic usage
- Update nginx config for domain change and redirection
- Change calendar month view: show 2 weeks before & after selected, not the whole month
- Improve displayed dates (strings like tomorrow or weekdays)
- Move session check and class check to extra middleware with single source of truth check with db with redis caching
- Move vaidation (zod) layer from controller to seperate middleware

### Fixed
#### Frontend
- Show more button on rich textarea not showing up
- No 404 result
- Multiple toast containers which overlap
- Homework checking is buggy on frontend
- Class settings: made more collapsible

#### Backend
- Server not restarting on change
- Move type packages to devDependencies in package.json
- Error on requesting unknown route

### Security
- Package bumping

### Removed
- Timetable validator, ajv package
- Compression package, compression now handeled by nginx

---

## \[v1.2.2] - 2025-07-14

### Changed

* change domain to taskminder.de, update email to info@taskminder.de
* update default legal information

### Fixed

* fix nginx config file and setup guide in documentation

---

## \[v1.2.1] - 2025-07-14

### Added

* add codylon.de migration toast

### Changed

* Increase timeout to 5 seconds
* migrate to extern sh script

### Fixed

* sometimes no homework & events appear on their own site
* fix cache stringify issue

---

## \[v1.2.0] - 2025-06-10

### Breaking Change - License

Users must review and comply with the updated license terms before updating or continuing use.

### Added

- Migrated runtime environment from Node.js to [Bun](https://bun.sh) for improved performance and native support for TypeScript.
- Updated all scripts and tooling to be compatible with Bun.

### Changed

- Replaced `npm` scripts with `bun` equivalents.
- Adjusted build and deployment pipelines to support Bun.
- run linting and formatting tools in frontend
- LICENSE changes to clarify ownership and permissions

### Removed

- Removed `package-lock.json` in favor of Bun’s dependency manager.

---

## \[v1.1.2] - 2025-06-08

### Added

- Rich text support in homework and events.
- Added release notes for v.1.1.1 and v1.1.2
- Linting and Formatting tools - ESLint and Prettier.

### Changed

- Impressum and DSGVO updates
- UI improvements

### Fixed

- Resolved an issue where logged-in users were unable to join multiple teams within the same class.

### Security

- Bump packages to close security iusses.

---

## \[v1.1.1] - 2025-06-04

### Fixed

- fix redis cache not working correctly

---

## \[v1.1.0] - 2025-06-03

### Added

- .env.example file

### Changed

- Moved docs to host on readthedocs
- Migrate to prisma ORM, add migrations

### Fixed

- wrong joinedTeamsData saved locally
- edit toggle btn doesn't always show up when logged in

---

## \[v1.0.1] - 2025-05-25

### Added

- Support for multiline event and homework descriptions.
- `.sql` dump compression to reduce storage usage.
- Collapsible long events to improve UI/UX.
- Production documentation updates for:
  - User permission details.
  - Switched the order of NGINX and Certbot setup.
- `trust proxy` enabled for Express Rate Limit compatibility ([source](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues)).

### Changed

- Resized "Copy Classcode" button for better mobile experience.
- Updated NGINX configuration for improved compatibility and performance.

### Fixed

- Timetable now properly displays when no substitutions are available.
- Backup table issue resolved by referencing the correct `.env` variable.
- Duplicate display issue corrected in UI.

### Security

- Bump packages to close securtity iusses.
- Escaping html to reduce attack risks.

---

## \[v1.0.0] – 2025-05-23

### Added

- Fetch, edit, and store timetable and subjects from the frontend.
- Ability to add and edit teams.
- Privacy Policy including _Impressum_, _Datenschutzinformation_, and contact email.
- Forced login or class code entry before accessing content.
- Copy class code button for easy sharing.
- Server monitoring tools to track system health and performance metrics.

### Changed

- Migrated codebase from JavaScript to TypeScript for improved type safety and maintainability.
- External content fetching moved from client-side to server-side.
- SEO improvements to enhance discoverability.
- Mobile navigation improved with off-canvas menu and direct login/logout buttons.
- File compression enabled to reduce load times.
- Documentation migrated from Notion to self-hosted MkDocs.
- Bumped core packages, including major upgrade to Express v5.
- Strengthened Content Security Policy (CSP) headers.
- Established and enforced new code standards.

### Fixed

- Backup table command issues resolved.

### Security

- Added server-side rate limiter to prevent abuse.
- Implemented CSRF middleware to protect against cross-site request forgery attacks.

### Removed

- Previous license replaced with updated terms (see LICENSE file).

---
