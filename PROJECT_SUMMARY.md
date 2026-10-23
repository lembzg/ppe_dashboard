# PPE Safety Dashboard: full project summary

## What it is
A multi-tenant web dashboard for industrial site safety. Cameras running an object-detection model detect safety violations (currently a missing high-vis vest and a person too close to a moving vehicle). The violations are reported to a Supabase backend and shown to site managers as incidents, scores, breakdowns by shift and zone, and video clips. My task was building the dashboard; the focus is the dashboard and its design choices. The safety score algorithm is NOT final. The current formula is a placeholder (details below).

## Repository layout
```
ppe_dashboard/
├─ supabase/            backend: config.toml, 5 SQL migrations, 2 edge functions (Deno/TypeScript)
├─ frontend/            React 19 + Vite single-page app (~2,500 lines)
├─ pipeline/            Python detection pipeline (YOLO + tracker) that reports to the backend
├─ .mcp.json            Supabase MCP server config for Claude Code
└─ Untitled0 (1).ipynb  original Colab notebook the tracker logic came from
```
The git history has 3 commits. The latest, "Config and vid upload and view", replaced an earlier plain-JS mock (`frontend-mock/`) with the React app and added the pipeline, edge functions and later migrations.

## Architecture
```
Camera / Jetson (or replay script)                 Supabase                          Browser
YOLO + BoT-SORT tracker ──HTTPS POST JSON──► ingest edge function ──► Postgres ◄── React dashboard
ffmpeg clip ──────────HTTPS PUT (signed URL)──► Storage bucket ◄──signed URL───┘     │
                                                admin-users edge function ◄──────────┘ (invite/remove users)
```
- No custom backend server. The browser talks directly to Supabase's auto-generated REST API (PostgREST) through `@supabase/supabase-js`. Security is enforced in the database with Row Level Security (RLS).
- Edge functions exist only where the logic needs the all-powerful service-role key: device ingest and user management.
- Cameras make outbound HTTPS calls only, so no inbound ports need to be opened on the site network.

---

## 1. Supabase backend

### Local config (`supabase/config.toml`)
Postgres 17. Custom ports (API 54331, DB 54332, Studio 54333, mail 54334) so it doesn't clash with other local projects. The API returns at most 1000 rows per request (`max_rows = 1000`). Storage file size limit is 50 MiB. Email signup is on, with confirmations off. Realtime is enabled but unused. There's also a hosted Supabase project, which the frontend points at.

### Data model (migration `initial_schema`)
Hierarchy:
```
organisations
 ├─ profiles         (id = auth.users.id, org_id, email, role 'admin' | 'customer')
 ├─ violation_types  (code, label, severity_points ≥ 0; unique per org)
 └─ sites            (name, timezone, default Europe/London)
     ├─ shifts           (name, starts_at, ends_at as time; may cross midnight)
     ├─ score_configs    (baseline_score default 100, score_window 'daily'|'weekly'; one per site) — prepared for the future algorithm, not used yet
     ├─ site_daily_stats (site_id, day, people_observed) — added later
     └─ zones            (name, zone_type)
         └─ devices          (serial unique, model, key_hash, last_heartbeat)
             ├─ device_sessions  (one per processed recording / tracker run, people_observed) — added later
             └─ incidents        (zone_id, device_id, shift_id, session_id, track_id, started_at, ended_at, status open|closed)
                 ├─ violations      (violation_type_id, first_seen_at, last_seen_at, confidence 0–1, vote_ratio 0–1; unique per incident+type)
                 └─ incident_clips  (storage_path unique, duration_s, blurred)
```
- All keys are UUIDs. Times are `timestamptz`. Foreign keys cascade on delete. An incident's shift is set to null if the shift is deleted.
- **One incident = one tracked person in one session on one device.** Unique key `(device_id, session_id, track_id)`. Each violation type appears at most once per incident; repeated episodes are merged.
- RLS is enabled on every table.
- A private storage bucket `incident-clips` is created.

### Security: Row Level Security (migration `rls_policies`)
- A `private` schema holds `security definer` helper functions, which the API doesn't expose: `current_org_id()`, `is_admin()`, `site_in_org()`, `zone_in_org()`, `incident_in_org()`. They walk up the hierarchy to the user's org.
- **Every member reads only their own organisation's data** (multi-tenant isolation).
- **Configuration tables** (organisations read-only; profiles, sites, zones, devices, shifts, score_configs, violation_types): members can read, and only admins of that org can insert, update or delete.
- **Incidents, violations, incident_clips: read-only for all users.** No user (not even an admin) can create or edit them. Only the service role, used by the ingest function, writes them. That makes incident records tamper-proof evidence.
- `revoke select (key_hash) on devices` means even logged-in users can't read device key hashes.
- Storage policy: a user can read a clip file only if an `incident_clips` row points at it and that incident belongs to their org.

### People counts (migrations `site_daily_stats` and `device_sessions`)
- `device_sessions`: one row per detection session with `people_observed`. Only the ingest function writes it (RLS enabled, no user policies).
- `site_daily_stats`: people observed per site per local day. Members read it.
- `refresh_site_daily_stats(site, day)`: **recomputes** the day's total as the sum over that day's sessions, in the site's timezone, rather than incrementing it, so a re-reported session is never double-counted. Only the service role can call it.
- Purpose: a denominator (people observed) for compliance rate and the future scoring algorithm.

### Controlled deletion (migration `delete_violation_type`)
- `delete_violation_type(type_id)` is a `security definer` function callable by authenticated users. It checks that the caller is an admin of the type's org, deletes that type's violations, then any incidents left with none, then the type. It returns the counts.
- It exists because admins deliberately have no delete rights on violations or incidents. This is the single audited exception.

### Edge function `ingest` (for devices)
- JWT verification is off. Devices authenticate with the headers `x-device-serial` and `x-device-key`. The function SHA-256 hashes the key and compares it against `devices.key_hash` with a constant-time (`timingSafeEqual`) comparison. It uses the service-role client.
- `POST /ingest/session`: body `{session_id, recording, started_at, ended_at, people_observed, incidents:[{track_id, violations:[{code, first_seen_at, last_seen_at, confidence, vote_ratio}]}]}`.
  - Maps violation codes to the org's `violation_types`. **Unknown codes are skipped, not rejected**, logged, and returned as `skipped_codes`.
  - Rejects with 409 if the session id belongs to another device.
  - Upserts `device_sessions`.
  - Assigns each incident to a **shift using the site's local time**, handling overnight shifts that cross midnight.
  - **Upserts** incidents (on `device_id, session_id, track_id`) and violations (on `incident_id, violation_type_id`), so **retries are idempotent**.
  - Calls `refresh_site_daily_stats` and updates the heartbeat.
  - Returns the saved incident ids by track id.
- `POST /ingest/clip`: checks that the incident belongs to this device, creates a **signed upload URL** for `<serial>/<incident_id>.mp4`, and upserts the `incident_clips` row (before the upload happens).
- `POST /ingest/heartbeat`: sets `last_heartbeat`.

### Edge function `admin-users` (for the Configuration page)
- Creating and deleting auth users needs the service role, which must never reach the browser. The browser sends the admin's JWT; the function verifies the user, checks that their profile role is admin, and acts only within the admin's org. CORS is enabled.
- `POST /invite {email, role, redirect_to}`: validates the input, calls `auth.admin.generateLink({type:'invite'})`, inserts the profile (rolling back the auth user if that fails) and **returns the invite link to the admin instead of emailing it**, so no SMTP provider is needed. Returns 409 if the email already exists.
- `POST /remove {user_id}`: you can't remove yourself, and the user must be in the same org. Deleting the auth user cascades to the profile.

---

## 2. Device authentication: per-camera hashed keys (headline design choice)
- When an admin adds a camera, or clicks "Replace key", the browser generates a **random 256-bit key** (`crypto.getRandomValues`, 32 bytes, base64url, 43 characters).
- Only its **SHA-256 hash** is stored in `devices.key_hash`. The plain key is **shown once** in the UI as `DEVICE_KEY_<serial>=<key>` to paste into the device's `pipeline/.env`. It is never stored server-side.
- Each request sends serial + key. The server hashes the key and compares it in constant time, which defeats timing attacks.
- Why: a database leak can't be used to impersonate cameras. Each device has its own key, so one compromised camera doesn't expose the others. "Replace key" revokes a stolen device instantly. Devices can't do interactive logins.
- Why plain SHA-256 instead of bcrypt: the key is 256 bits of randomness, not a guessable human password, so slow hashing isn't needed.
- Defence in depth: the `key_hash` column is revoked from client roles.
- Known weakness: the key is plaintext in `.env` on the device, so physical theft exposes it. Mitigation: rotate the key.

## 3. Video clips (Supabase Storage)
- Clips live in a private bucket. The database stores only the path.
- Upload: the device asks `/ingest/clip`, receives a one-time **signed upload URL**, and PUTs the MP4 straight to Storage. The video doesn't pass through the function.
- Viewing: the dashboard drawer requests a **signed download URL valid for 1 hour**. Storage RLS only issues it to members of the incident's org.
- Clips are cut by ffmpeg: H.264, 720p, CRF 28, no audio, faststart, ±2 s padding, max 20 s.
- The `blurred` flag exists. The pipeline currently always sends `false`, so face blurring isn't implemented.
- Known gap: the clip row is written before the upload, so a failed upload leaves a row with no file (the UI shows "Clip unavailable").

---

## 4. Frontend (the dashboard): `frontend/`

### Stack and structure
- React 19 + Vite 8. Only three runtime dependencies: `react`, `react-dom`, `@supabase/supabase-js`. No router, chart or UI library. Hash routing, the SVG trend chart, sparklines, tables and menus are hand-built. Fonts: Inter and JetBrains Mono.
- `config.js` holds the Supabase URL and the **publishable key**, which is safe in the browser because RLS guards the data.
- Files: `App.jsx` (auth gate), `Dashboard.jsx` (shell + routing), `lib/loadData.js` (Supabase → dataset), `lib/model.js` (all derived figures), `lib/dates.js`, `lib/format.js`, `lib/deviceKeys.js`, `lib/supabase.js`, `components/` (Sidebar, Topbar, Scope, Kpis, TrendChart, Drawer, EditableTable, ui, icons, DashboardContext), `pages/` (6 pages).

### Auth flow (`App.jsx`)
- `onAuthStateChange` tracks the session. No session → **Sign in** form (email/password via `signInWithPassword`).
- Arriving from an invite or password-recovery link (detected from the URL hash before the client clears it) → **Choose a password** form (`auth.updateUser`, min 8 characters, confirmation).
- Signed in → `loadDashboardData()` runs once per user (not on token refreshes) → `<Dashboard>`. Shows loading and error states, including "account has no profile yet" and "no sites set up".
- `?asOf=YYYY-MM-DD` renders the dashboard as of the end of that day (for demos on recorded footage).

### Data loading (`lib/loadData.js`)
- Fetches the profile (role, org), then in parallel: the organisation, sites with nested zones → devices (serial, heartbeat) and shifts, and violation types.
- Fetches incidents from the first day of the previous month to now, **paginated in pages of 1000** (matches the API row cap), with nested zone, device, violations → types and clips in one query.
- Fetches `site_daily_stats` for people observed.
- Converts every timestamp to the **site's local timezone**. Groups incidents by local date and assigns display ids `EVT-YYYYMMDD-NNNN`. An incident's displayed type and severity is its most severe violation.
- Severity buckets from `severity_points`: ≥15 Critical, ≥8 High, ≥4 Medium, otherwise Low.
- Camera "online" = heartbeat within the last 10 minutes.
- Currently uses the **first site only** (`sites[0]`) for detail. Other sites contribute only scores for the ranking.

### Scoring (PLACEHOLDER, algorithm not decided)
- Score = max(0, 100 − total deductions). Each violation deducts its violation type's `severity_points`; an incident deducts the sum of its violations. Every window (day, shift, week, month) starts at 100 and subtracts only the violations inside it, floored at 0. Zone and shift scores apply the same rule to filtered incidents.
- It's computed client-side in `model.js`, so the algorithm can be swapped in one place.
- The data is already in place for a real algorithm: per-type `severity_points`, `people_observed` per day, shifts, zones, and `score_configs` (baseline, daily/weekly window), which is unused so far.

### App shell (`Dashboard.jsx`)
- Hash routes `#/overview`, `#/incidents`, `#/shifts`, `#/zones`, `#/reports`, `#/configuration` (admin only; customers are redirected to Overview and see a locked, disabled nav item).
- The **period switch Today / Week / Month** drives every analytics page. The previous-period comparison is "vs yesterday", "vs same point last week" or "vs same point last month".
- `createDerivations(data)` → `deriveModel(period)`, memoised. It's shared through React Context with `selectedIncidentId`, `openDrawer` and `reloadData`.
- Keyboard and accessibility: Escape closes menus and then the drawer, focus returns to the originating row, there are ARIA roles for menus and the dialog, and `aria-current` on the active nav item.

### Top bar and sidebar
- Scope breadcrumb menus Organisation / Site / Zone. **Currently cosmetic**: the selections are local state and don't filter data yet.
- Date, period switch, "Live" indicator with "X of Y cameras online" and "Last event HH:MM". **Not actually real-time**: data loads at sign-in and refreshes after configuration changes.
- An **Export** button exists but does nothing yet.
- The sidebar shows the user's initials, email, role and Sign out.

### Pages
1. **Overview**: KPI tiles (safety score with delta and 7-day sparkline; incident count with delta; critical/high counts; leading violation; people observed and **compliance rate** = (people observed − PPE violations) / people observed). Safety score trend chart (Today = step chart through the day, one step per incident, against yesterday; Week/Month = daily points against the previous period, dashed line). Incidents by type (bars, ranked by count, then severity, then recency). Shift and zone score tables. Recent incidents today (5). Site ranking with company average.
2. **Incidents**: the full log for the period, newest first. Filters: severity (segmented buttons), zone, violation type, and clear filters, with a count of "N of M". Columns: time, event id, violation, severity, zone, camera, shift, points deducted, clip icon. Clicking a row opens the **drawer**.
3. **Incident drawer**: plays the private clip via a signed URL (loading, unavailable and "no clip" states; pauses on close), with time, violation, severity, points deducted, zone, camera, shift, and **score after the event** (running score through the day).
4. **Shifts**: a performance table (hours, score, incidents, high-risk count, leading violation, an "in progress" marker for the current shift), a **violations × shift matrix**, and a daily score per shift alongside the site score.
5. **Zones**: a performance table (sorted worst first, with cameras), a **violations × zone matrix**, and a camera table (zone, online/offline, incident count, last event).
6. **Reports**: site comparison ranked by score for today/week/month, with company average and median. **Scheduled reports and the "NODE benchmark" panel are placeholders** (the scheduled reports list is empty; the benchmark shows "Available once enough sites contribute data").
7. **Configuration** (admin only): `EditableTable` components with inline add, edit and delete, error messages and delete confirmations, for:
   - **Sites** (name, timezone picker, zone count)
   - **Zones** per site (name, optional type, camera count)
   - **Cameras** (serial validated `[A-Za-z0-9_-]`, not editable after creation; zone; model; status from the last heartbeat). Adding a camera shows its key once. "New key" / "Replace key" rotates it, and the device stops reporting until updated.
   - **Shifts** (name, start, end, computed length)
   - **Violation types** (label; code validated `^[a-z][a-z0-9_]*$`, not editable after creation; severity points, with the severity derived from them; "PPE" if the code starts with `ppe_`; "Detected: By cameras / Not yet" based on which codes the pipeline emits; recorded count). Deleting a type with history goes through `delete_violation_type`.
   - **Users** (email, role Admin/Customer, invite → link shown once to copy, change role, remove)
   - Friendly error for unique-constraint violations. After any change, the dashboard data reloads in the background.

---

## 5. Detection pipeline (context): `pipeline/`
- Python: `ultralytics` (YOLO), `lap`, `opencv-python-headless`, `numpy`, `requests`, `python-dotenv`.
- `process_recordings.py data/videos [--upload] [--clips] [--annotate] [--calibration json] [--distance-m 2.0] [--timezone] [--force] [--device]` runs over **recorded video files** and reports the same way a live device would. A live Jetson loop is not in the repo yet; the README says the Jetson Orin Nano uses the same ingest endpoint.
- Recording names encode the device and start time: `2026_08_18_FMDC1_00_20260818082151.mp4` → serial `FMDC1_00`, started 2026-08-18 08:21:51 site time. **The session id is a deterministic UUIDv5** of serial + name, so re-uploading updates rather than duplicates.
- Model: custom YOLO `best.pt` with 3 classes (0 Person, 1 Safety_Vest, 2 Vehicle), image size 960, BoT-SORT tracking. A fresh model is loaded per recording so track ids don't carry over.
- `ScenarioTracker` (ported from a Colab notebook) produces explainable event episodes:
  - **VEST_MISSING**: vests are associated to a person's torso box. Evidence counts only on frames where the person's geometry is usable (not too small, not cut off at the edge). It needs ≥10 valid observations within a 30-frame history; ≤15% vest presence → review/missing.
  - **PERSON_VEHICLE_PROXIMITY**: the distance between person and vehicle is estimated from a camera calibration file or by assuming a 170 cm person height. Threshold 2 m. Alerts only if the vehicle is moving or recently moving, and the condition persists for 8 frames out of 15. **Vehicle riders/operators are recognised and suppressed.** Confidence is a weighted mix of detection, geometry, persistence and motion.
  - People observed = person tracks lasting ≥1 s.
- Results are saved to `data/outputs/<recording>/` (`events.json`, `summary.json`). Already-processed recordings are skipped unless `--force` is given.
- `build_incidents()` groups events per track → one incident per person, one violation per type (merged episodes, max confidence, mean vote ratio). Event types map to codes: `VEST_MISSING → ppe_no_vest`, `PERSON_VEHICLE_PROXIMITY → person_near_vehicle`.
- `IngestClient` sends `/session`, then for each incident `/clip` + PUT the file. `.env` holds `INGEST_URL` and `DEVICE_KEY_<serial>`.
- No offline retry queue: a network failure raises an error.

---

## 6. Key design choices (for the presentation)
1. **Supabase instead of a custom backend**: auth, Postgres, storage, an auto API and edge functions out of the box. Effort went into the dashboard. Custom logic only in 2 edge functions.
2. **Security in the database (RLS)**: applies to every query regardless of path. Multi-tenant org isolation. Admin vs customer roles. Incidents are writable only by the service role, which makes them tamper-proof.
3. **Per-camera random keys stored as SHA-256 hashes**: shown once, rotatable, constant-time compare, hash column hidden from clients.
4. **Service-role key never in the browser**: user management goes through an edge function that verifies the caller is an admin.
5. **Invite links instead of emails**: works without an SMTP provider.
6. **One incident per tracked person** rather than per frame. Violations merged per type.
7. **Idempotent ingest**: deterministic session ids, upserts on natural keys, and stats recomputed rather than incremented, so retries never duplicate or double-count.
8. **Fault-tolerant ingest**: unknown violation codes are skipped and reported back, rather than failing the batch.
9. **Timezone-correct**: shift assignment and day boundaries use each site's timezone, and overnight shifts are supported.
10. **Clips in object storage with signed URLs**: one-time upload links for devices, 1-hour playback links for viewers, access tied to org membership.
11. **Controlled deletion via a single security-definer function** rather than giving admins broad delete rights.
12. **Lean frontend**: 3 dependencies, hand-built charts and routing, and all metrics derived in one module (`model.js`), so the scoring algorithm can be swapped in one place.
13. **Data captured for the future scoring algorithm**: severity points, people observed, shifts, zones, `score_configs`.
14. **`?asOf=` demo mode** for showing recorded footage as if it were live.

## 7. Not done yet / known limitations
- **Safety score algorithm**: the current formula is a placeholder. `score_configs` is unused, and severity points are only bucketed, not used directly.
- Only the first site is shown in detail. The Org/Site/Zone scope menus are cosmetic.
- Not real-time (Supabase Realtime is available but unused). The "Live" badge reflects data at load time.
- Export button, scheduled reports and the benchmark panel are placeholders.
- A live Jetson capture loop isn't in the repo (only the recording replay). No offline retry queue. Periodic heartbeats are needed for a live device.
- Clip row written before the upload. No retention or cleanup policy (storage quota). Face blurring not implemented.
- Only two violation types are detected by the model so far (missing vest, person near moving vehicle). Others can be configured but are never reported.
