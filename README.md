# MASMS web + API

Express + MongoDB API (JWT auth) that hosts the MASMS page and saves its data in the cloud, ready for Vercel.

## Where data is kept
- **On the device (always on):** `scripts/local-store.js` saves the full dataset to IndexedDB every 5s, when the app is hidden/closed, and reloads it on start. No internet or server needed. It keeps one earlier copy (Settings > Backup & Restore > *Restore earlier copy on this device*). Phone storage is lost if the app is uninstalled or the phone reset, so keep downloading backups.
- **Cloud (optional):** the cloud button syncs the same data across devices. Every signed-in device uploads its changes within ~10s and checks for other devices' changes every 15s (also when the app is reopened/refocused or the connection returns); newer data from another device is loaded automatically (not while someone is typing). If both devices changed something, you are asked which copy to keep. If this device holds changes the cloud never received, you are asked which copy to keep.
- **Manual backup:** Settings > Backup & Restore exports/imports a JSON file (in the APK it opens the Android share sheet).

## Sign-in needs the internet (hosted site and Android app)
- Signing in (password, fingerprint, learner/parent portal) goes through the server first (`scripts/online-login.js`). With no connection the login page says *No internet connection. Connect to the internet to sign in.* and nobody gets in, in the browser or in the Android app. The server also decides whether this device's cloud sign-in is still valid, so a removed user or suspended school cannot sign in.
- A saved session (refresh, or reopening the app within 8 hours) is picked up again only after the server answers (`scripts/keep-session.js`, switched on by `window.MASMS_ONLINE_ONLY`, which `build.js` sets for the web and Android builds). Offline, or if the server rejects the sign-in, the saved session is dropped and the person signs in again once online.
- After signing in, people keep working if the signal drops (work is saved on the phone and uploads on reconnect); after 12 offline hours they are signed out.
- `navigator.onLine` is never used to decide whether someone is online: Firefox and Edge report `false` on VPNs, some Wi-Fi/proxy set-ups and Windows "limited connectivity" while the server is reachable, which could block sign-in there. The real request to the server decides.
- **A fresh browser or phone can only sign staff in if their school exists on the server.** The device has no school data, so `POST /api/staff/login` must find the school. That works for a school registered in the System Developer's *Schools* list (linked automatically while that device is online). A school that is not registered (e.g. the built-in demo school) or is switched off cannot be found, and the login page now says so ("your school is not registered on the MASMS server yet…") instead of "Incorrect username or password". The System Developer never has to sign in on the staff member's browser.
- Only a genuine MASMS server reply counts as "online". An HTML page answering with 200 (the app's own built-in server, a Wi-Fi login page) is treated as offline. An Android app built **without `API_BASE`** has no server to talk to; it used to let people in offline because its own server answered every request. It now says *This app is not linked to the MASMS server* and `npm run build:android` refuses to build without `API_BASE` (set the repository variable `API_BASE` to your site address, then build the APK again).
- The single-file `dist/MASMS_standalone.html` (desktop wrapper) is not online-only. Tests: `test/online-login-gate.test.js`, `test/online-session-restore.test.js`.
- **Schools link themselves to the cloud, and staff are never asked to sign in to it.** When the System Developer registers a school (or on start-up for schools registered earlier), the connected platform-owner device calls `POST /api/schools/link`: the school gets its own private cloud space on the server, started with its registered details and principal login (`cloudCode` is saved on the registry entry). A staff member signs in on any phone with the same phone number or user name (e.g. `janekamau@alphasenior`) and password as before: the first time on a device the app calls `POST /api/staff/login` (rules in `src/staff.js`, a copy of the app's login rules), the server finds the school that holds those details and gives the device a token for **that school only**; the school's data loads and the normal sign-in carries on. The device stays connected: the token lasts 180 days (`CLOUD_TOKEN_DAYS`) and renews itself daily. Suspending a school cuts every device off within seconds. Only the System Developer sees the cloud button or makes the one-time platform-owner connection (that token lasts 90 days, `PLATFORM_TOKEN_DAYS`, and renews itself daily while the device is in use). A space that holds several schools (the platform owner's working copy) is never signed in to this way. Tests: `test/staff-login.test.js`, `test/online-login-gate.test.js`.
- After a school is linked, **its live data lives in its own cloud space** (staff and learners save there). The copy that stays in the System Developer's platform data is the starting copy made when it was linked.
- **Online quizzes reach only the learners who take the subject** (`qzQuizzesForStudent` in the app and `quizzesFor` on the server use the same rule as marks entry): a learner who does not take Physics never receives the Physics paper and cannot open or answer it by id. Subjects everyone sits (English, Mathematics, ...) go to the whole class. Test: `test/quiz-subject-audience.test.js`.
- **Forgot Password** works from the login page with only the internet (no cloud sign-in on the device): `POST /api/auth/recover/send` texts or emails a code to the phone/email on file (the answer is the same for any number), and `POST /api/auth/recover/reset` checks the code and saves the new password in the school's data. Tests: `test/recover.test.js`, `test/forgot-password-ui.test.js`.

## Several schools on one server (multi-school)
One deployment can host many schools. Each school has its **own private data and its own users**; the server decides which school a request belongs to from the signed login token, never from anything the browser sends.

| Role | Can do |
|---|---|
| **Platform owner** (the very first account created on a new server) | add / suspend / restore schools, create a school's first admin, reset any password, edit the public web page |
| **School admin** | add, remove and reset users of their own school only |
| **Staff** | sign in and use their school's data |

How to run it:
1. Deploy once (see *Deploy to Vercel*). Open the site, click the cloud button, and create the **platform owner** account. It also becomes the first school ("default").
2. Click the cloud button > **All schools** > *Add a school*: school name + the school admin's username and password. Give those details to the school.
3. The school admin signs in with the cloud button, opens **Users of this school** and adds their staff. Everyone then signs in on any browser or phone and sees the same school data.
4. Removing a user or suspending a school takes effect within ~15 seconds, even for people already signed in. Suspended schools keep their data.

Things to know:
- **Isolation** is enforced on the server (data, users, M-Pesa payment records). Tested in `test/api.test.js` (*several schools on one server*).
- A phone or computer shared by two schools is safe: when a different school signs in, the earlier school's copy on that device is wiped first and never uploaded.
- Usernames are unique across the whole server (pick e.g. `jane.kamau`, not just `admin`).
- Accounts made before multi-school existed keep working: they belong to the "default" school and the old admin stays the platform owner. Existing data is kept (it still lives under `SNAPSHOT_KEY`).
- **SMS, email and M-Pesa settings are server-wide** (one Africa's Talking / SMTP / Daraja account for the whole server). Schools share that account; per-school keys would be a further change.
- The server protects each school's data **as a whole**. Inside a school, the app's own roles (teacher, bursar, ...) are enforced by the app on the device, not by the server, so give the cloud login only to people you trust with that school's data.
- Back up the database (MongoDB Atlas > Backup). One school's data is one MongoDB document (16MB max, 4MB per upload), so keep photos small.

## Several people working at once (no overwriting)
The school is saved as one snapshot, so two devices changing it at the same time used to trigger "which copy do you keep?". `scripts/marks-merge.js` now does a three-way merge (last-synced copy, this device, newest cloud copy) of everything in the data:
- Anything only one device changed is kept. Work done offline is merged when it uploads (the last-synced copy is kept on the device).
- Marks, attendance, remarks, comments, photos: merged cell by cell; the later save wins on the very same cell (history stays in the marks audit log).
- Lists of records (learners, receipts, fee adjustments, income, expenses, library, stores, lab, boarding, discipline, medical, payroll, budget, transport, teachers, staff, users, and any list whose records have an `id`): new records from both sides are kept, edits merge field by field, deletions apply.
- Running totals (copies issued, stock quantity, budget spent) are added together.
- Receipt (RCPT-), voucher (PV-), store-movement and exeat numbers issued on two devices at the same moment: the later device's document gets the next free number, counters move on, and the person is told. Numbers are never duplicated.
- Settings (timetable, terms, grading, classes, school profile ...) merge per setting.
- Only a true clash asks which copy to keep: e.g. a learner deleted on one device and edited on the other, two different learners with one admission number, or one setting changed to two different values.
The store and boarding id counters are now rebuilt from the records on load (they used to restart after every reload and could reuse ids).

## Learners and online quizzes on their own phones
A learner's phone holds none of the school's data, so the portal sign-in now goes through the server:
1. A teacher publishes a quiz (Exams > Online Exams). On the hosted site and the Android app a successful staff login already links the device to the school's cloud (no cloud button needed), so the quiz uploads at once. If the link was lost, the Publish message tells the teacher to log out and in again.
2. The learner opens the site on their own phone and signs in as before (admission number + `welcome`, or guardian phone + admission number). The server finds the learner in the school's data and returns only that learner's record, the quizzes published to the learner's class, and the learner's own attempts. If two schools share an admission number, type it as `4501@schoolcode`.
3. Attempts are saved to the server when the quiz is started and finished (saved answers are sent every ~20s). **The server marks the score** from the teacher's answers; a finished attempt is final. Teachers' devices receive attempts through the normal 15-second cloud check.
4. This learner session is never written to the phone's own storage (`window.MASMS_NO_PERSIST`), so it can never be uploaded later as school data. Refreshing the page resumes it; Logout ends it.
5. If a teacher saves while learners were submitting, the server keeps both (`merged: true` on `PUT /api/data`) instead of asking the teacher to choose. A real conflict between two staff devices still asks, as before.

Limits: learners see only the quiz portal on their own phone (fees, results and attendance stay on staff-signed-in devices). The quiz's correct answers travel to the learner's phone because the page scores and reviews on the phone; the server re-marks every submission. Learner sign-in is rate-limited per address (`PORTAL_RATE_LIMIT`, default 300 per 15 min, so a whole class on one school Wi-Fi can sign in).

**Structured quizzes and marking schemes.** In the quiz editor each structured question has a *Marking scheme*: a worked answer plus marking points (the wording expected, other accepted wording/values, and marks). When a learner submits, the server compares the answer with every point and awards full, proportional or no marks (numbers must match exactly; spelling slips and word endings are tolerated; marks never exceed the question's marks). If every question has a scheme the attempt is marked at once (`autoMarked: true`); otherwise it waits for the teacher. Teachers see the point-by-point breakdown under Results > *Review marks*, can change any mark, and *Auto-mark with scheme* marks older submissions. MCQ and short-answer questions also take a worked answer / explanation. Schemes never leave the server (`forLearner`); the marker code between `// <qz-scheme>` markers is identical in `source/MAESTRO_MASMS_FINAL.html` and `src/app.js` (checked by `test/typed-quizzes.test.js`).

**Marking Mathematics working (skipped and implied steps).** The marking-scheme marker (`qzMarkTyped`, identical in the app and on the server) now reads a question's marking points as a chain of working. When a later point is fully shown (usually the final answer), the earlier points are credited as *implied*, so a clever learner who skips steps, or writes only the answer, is not penalised; the teacher's Review marks table labels them "implied by later working". A wrong final answer earns nothing for steps that are not shown. Tick **Must be shown** on a point that has to be written (a formula, a "show that" step, units): it is never implied and does not imply others. Equivalent working is recognised (1/2 = 0.5, 5.0 = 5, 5 = x for x = 5, x² = x^2, 2*x = 2x, x = 10/2 = 5). It is on by default for Mathematics, Physics, Chemistry, Accounting and Statistics quizzes, and the quiz settings have a checkbox *Credit skipped / implied working* to change it (`impliedSteps`). Uploaded schemes may use KNEC-style codes: `M1` (method), `A1` (accuracy), `B1` (independent, so it must be shown). Test: `test/math-working-marking.test.js`.

**Uploading short-answer and structured quizzes from Word / PDF.** In the quiz editor, pick the quiz type first, then *Upload questions from a Word or PDF file* (or paste text). The reader is the same as for MCQ (`qzDocxLines`, `qzPdfLines`); `qzParseTypedLines` builds the questions.
- *Short answer:* `1. Question` then `Answer: photosynthesis | photo synthesis` (`|` or `;` separate other accepted wording; `Also accept:` adds more). An end-of-paper key (heading `Answers`, then `1. ...`) also works.
- *Structured:* `1. Question (4 marks)`, then `Answer:` (worked answer) and `Marking scheme:` with one point per line, ending in its marks, e.g. `- Deforestation removes ground cover | clearing of trees (2)`. The question's marks are the points added up. A marking scheme at the end of the paper (`Marking scheme`, then `1. ...`) also works. A question with no points waits for the teacher to mark it.
- After the upload the app says how many questions have no answer or no marking points. Test: `test/typed-quiz-import.test.js`.

**Strict key-term spelling.** Ordinary words in a marking point still forgive spelling slips and word endings, but a *key term* must be spelled exactly (only its plural is forgiven). A point's key terms come from the **Key terms (exact spelling)** box, from `[key: photosynthesis; chlorophyll]` after the point in an uploaded file, or from the words made **bold** in a Word file. Tick **Key terms must be spelled exactly** in the quiz settings (`strictTerms`, off by default so existing quizzes mark as before) to make a built-in glossary of science, geography and mathematics words (`QZ_GLOSSARY`) exact too. A point that loses marks to a near-miss says so under Review marks (*key term photosynthesis written as "photosythesis"*). The option reaches the marker as its fifth argument, `qzMarkTyped(x, resp, max, implied, qzMarkOpts(quiz))`, on the app and on the server (same `// <qz-scheme>` block). Short-answer quizzes already compare exactly.

**Uploading a marking scheme for questions already in the editor.** For short-answer and structured quizzes, *Upload a marking scheme for the questions above* reads a Word / PDF / text file that holds only the scheme (`qzParseScheme`) and attaches scheme *n* to question *n* (`qzApplyScheme`): each answer is numbered like the questions, with `Answer:` for the worked answer and one marking point per line ending in its marks. The app says how many questions got a scheme, which numbers had none, which numbers have no question, and asks before replacing a scheme a question already has. Test: `test/key-terms-scheme-photos.test.js`.

**Photos of written working.** A structured quiz can switch on *Learners may attach a photo of written working* (`allowPhotos`). Each question then offers up to 2 photos, shrunk on the phone (at most 1000 px, JPEG, about 60 KB) and saved with the answer; a photo alone counts as an answer. The server accepts photos only for quizzes that allow them, only real `data:image` JPEG / PNG / WebP of at most 150,000 characters, at most 2 per question and only for the quiz's own questions. Because one school's data is one document, the server also limits all photos in a school to `QUIZ_PHOTO_BUDGET` characters (default about 6 MB): a photo that does not fit is dropped and the learner is told to type the working instead. An attempt with photos is **not** auto-marked (the marker cannot read handwriting): it waits for the teacher, who sees the photos under each answer in Review marks (with the typed text's suggested marks) and can **Delete the photos after marking** to free space. Auto-mark with scheme leaves such attempts alone.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/portal/login` | `{username, password}` → learner token (12h) + record, class quizzes, own attempts |
| GET | `/api/portal/quizzes` | learner token: refresh quizzes/attempts |
| PUT | `/api/portal/attempt` | learner token: `{attempt}` saved and marked on the server |

## Layout
- `source/MAESTRO_MASMS_FINAL.html` – the app (edit this, then rebuild)
- `scripts/build.js` – produces `public/` (images pulled out of the HTML, JS whitespace-minified, vendor libs + fonts copied from npm)
  - Web build only: the inline Font Awesome copy (1MB of base64) is dropped in favour of the linked `vendor/fa/all.min.css`, and `xlsx` / `exceljs` load right after the page has loaded instead of blocking it. `dist/MASMS_standalone.html` keeps everything inline.
- `scripts/local-store.js` – browser module: on-device autosave/restore
  - Autosave and cloud sync no longer serialize the whole dataset on every timer tick: `window.MASMS_DIRTY` (defined in `local-store.js`) counts changes (every `render()` plus any input/click/key event). Timers skip while it has not moved, still do a full check every 60s, and always flush when the app is hidden/closed. A failed save or upload is retried on the next tick. If you add code that changes data with no render and no user event, call `MASMS_DIRTY.bump()`.
- `scripts/cloud-sync.js` – browser module: the "cloud" button bottom-left signs in, loads saved data on start, autosaves every 20s
- `src/app.js`, `src/store.js` – API and data layer · `api/index.js` – Vercel entry · `vercel.json`

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/status` | `{needsSetup}` |
| POST | `/api/auth/register` | first account becomes the platform owner; afterwards an admin adds users to their own school (`role`: staff/admin; the platform owner may pass `tenant`) |
| POST | `/api/auth/login` | rate-limited, returns a 12h JWT (carries the school) |
| GET | `/api/auth/me` | username, role, school, platform flag |
| POST | `/api/auth/password` | `{current, password}` change your own password |
| GET | `/api/users` | admin: users of your school (platform owner: `?tenant=code`) |
| DELETE | `/api/users/:username` | admin: remove a user (never the last admin of a school) |
| PUT | `/api/users/:username/password` | admin: reset a password |
| GET/POST | `/api/schools` | platform owner: list schools / add a school with its first admin |
| PATCH | `/api/schools/:code` | platform owner: `{active}` suspend or restore, `{name}` rename |
| GET | `/api/data/version` | `{version, updatedAt, updatedBy}` only; devices poll this and download the data when it moved |
| GET/PUT | `/api/data` | whole backup JSON; `baseVersion` stops stale saves overwriting newer data (409) |
| GET | `/api/health` | |

| GET | `/api/comms/status` | which of SMS / email / M-Pesa the server has set up |
| POST | `/api/sms/send` | `{to,message}` or `{messages:[{to,message}]}` via Africa's Talking; returns `sent`, `failed`, `units` |
| POST | `/api/email/send` | `{to,subject,message}` or `{messages:[{email,subject,message}]}` via SMTP |
| POST | `/api/mpesa/stkpush` | sends an M-Pesa prompt; Safaricom confirms to `/api/mpesa/callback/<MPESA_CALLBACK_SECRET>` |
| GET | `/api/mpesa/status/:id`, `/api/mpesa/recent` | prompt status / confirmed payments (for the Reconciliation tab) |
| POST | `/api/auth/recover/send` | forgot password: `{phone, via?}` texts (or, with `via:"email"` or no SMS set up, emails) a 6-digit code to the phone/email kept for that staff member; needs the device's cloud sign-in |
| POST | `/api/auth/recover/verify` | `{phone, code}` confirms the code once; the app then saves the new password |

## Communication & payments setup
Messages and M-Pesa prompts are sent **by the server**, so provider keys never reach the browser. Staff must be signed in with the cloud button (bottom-left). Set these in `.env` or Vercel's Environment Variables (see `.env.example`); each feature shows a clear "not set up" message until its variables exist:
- **SMS:** `AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID` (Africa's Talking; `AT_USERNAME=sandbox` for testing).
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (Gmail: use an App Password).
- **M-Pesa (Daraja STK push):** `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_SECRET` (any long random string), `PUBLIC_URL` (your deployed https address), `MPESA_ENV=production` when live.
### Staff sign-in and "Forgot Password"
- Staff sign in with their **phone number** (any format; the last 9 digits are compared) and the password **`welcome`** the first time. They are then made to choose their own password (8+ characters, letters and numbers). An administrator can send anyone back to `welcome` in Settings > Users & Roles.
- **Forgot Password** (login page): the person types their phone number and taps *Send code*. The server generates a 6-digit code and sends it **only to the phone number (SMS) or email address kept on that staff record** (Teachers list, Staff list or the account), never to one typed on the form. SMS is used when it is set up; *Send the code to my email instead* (or a server with no SMS) uses email. The person enters the code and a new password; the password is saved exactly like a first-login password and syncs with the rest of the data.
- A code is valid for 10 minutes, one can be asked for per minute, and five wrong guesses cancel it. Only a keyed hash of the code is stored. The form is also rate-limited per address (`RECOVER_RATE_LIMIT`, default 10 code requests per 15 minutes).
- It needs the internet, the device's cloud sign-in, and SMS (`AT_*`) and/or email (`SMTP_*`) set up above. Otherwise the form says so and points to the administrator. The System Developer, sales agents and inactive people are not reset this way.
- Each reset is recorded in the Login Monitor as *Password reset*.

SMS credits in the app are drawn down by what the server actually sent (160-character segments). Buying credits by M-Pesa only adds them after Safaricom confirms; invoice requests add credits when marked paid.

## Run locally
```
npm install && npm run build && npm start     # http://localhost:3000 (volatile in-memory DB if MONGODB_URI is unset)
npm test
```

## Deploy to Vercel
1. Create a free MongoDB Atlas cluster and copy its connection string (allow access from 0.0.0.0/0 for Vercel).
2. Push this folder to GitHub (or run `npx vercel` in it).
3. In Vercel > Project > Settings > Environment Variables add `MONGODB_URI` and `JWT_SECRET` (a long random string).
4. Deploy. Open the site, click the cloud button, create the admin account. Every browser/device then signs in to the same data.

## Limits
- Vercel request bodies max about 4.5MB; if student photos push the backup past that, saving returns "too large" (move photos to object storage).
- The app's own login: staff use first name **or phone number** (from their teacher/staff record). A new account signs in with the **welcome password** (`WELCOME_PASSWORD` in the source, currently `welcome`, any letter case, also shown to admins in Settings > Users & Roles) and is stopped at a *Choose your own password* screen before entering the app (8+ characters, letters and numbers, not the welcome password, not just their name or phone). The chosen password is stored only as a salted hash on the user record (case-sensitive). Settings > Users & Roles shows who is still on the welcome password and has a *Reset password* button that puts a user back on it. Accounts created before this change have no password of their own, so they also start on the welcome password. Parents use guardian phone + admission number. This is the app's own on-device login, not server-side auth; the cloud account is separate and only protects the stored data.
- Timetable auto-fill: double lessons never sit directly against another double (a break between them counts as a gap). It retries several arrangements first and only lets two doubles touch when the week has no other slot for them.
- `qrcode.min.js` has no browser build on npm, so QR features stay disabled as before (the page tolerates it).

## Finance notes
- **Student Fee Accounts** is built from the live fee structure, payments, scholarships/discounts and fines (billed / paid / balance / status). Payments are matched to learners by admission number, so two learners with the same name never share payments. Arrears ageing counts days from the first day of the oldest unpaid term (from Settings term dates).
- **Receipt (RCPT-) and voucher (PV-) numbers** and the cash-book opening balance are saved per school (`financeMeta`) and re-derived from the records on load, so numbers are never reissued after a reload or restore. Receipts/vouchers are cancelled, not deleted; only already-cancelled ones can be removed.
- **Payroll** is monthly (pick the pay period). Basic + allowances = gross; NSSF (Year 4: Ksh 9,000 / 108,000 limits, 6% each side), SHIF 2.75% (min Ksh 300), Affordable Housing Levy 1.5% each side, then PAYE (monthly bands, Ksh 2,400 personal relief). Constants are at the top of the payroll block (`NSSF_TIER_*`, `SHIF_*`, `AHL_RATE`, `PAYE_BANDS`) - update them when rates change. Paid salaries post to the cash book, ledger and Income & Expenditure; statutory deductions sit in *Statutory Deductions Payable* until marked remitted. Payslip PDF per employee; *Payroll Statutory Summary* report.
- **Budget & Variance** actuals fill in from logged expenses (see `BUDGET_EXPENSE_MAP`); a typed actual overrides.
- Ledger / trial balance exclude cancelled receipts and vouchers, matching the cash book.

## Tests & tools
- `npm test` – Jest: API/auth/data (18), finance (payroll maths, ledger balance, counters, accounts/arrears), dark mode (jsdom), double-lesson placement and welcome-password logic (run against the real source functions), and source checks (scripts parse, undefined-variable lint, regression for fixed bugs, build output)
- `npm run standalone` – writes `dist/MASMS_standalone.html` (patched app + dark mode) for the desktop wrapper
- Dark mode: moon/sun button bottom-left, remembers the choice, follows the system setting on first visit

## Android
**Option A – install from the website (no APK needed):** open the deployed site in Chrome on the phone, tap ⋮ > *Install app* (or *Add to Home screen*). It gets the MASMS icon, opens full screen and the app shell works offline.

**Option B – real APK (installable file / Play Store):**
1. Push the repo to GitHub, then Settings > Secrets and variables > Actions > Variables > add `API_BASE` = your Vercel URL (e.g. `https://masms.vercel.app`).
2. Actions tab > *Build Android APK* > Run workflow. Download `MASMS-debug-apk` and install `app-debug.apk` (allow "install unknown apps").
3. Or locally with Android Studio: `API_BASE=https://your-site npm run build:android`, then open the `android/` folder and Build > Build APK.

**The APK is the live site.** The *Build Android APK* workflow builds the app so it loads your live MASMS address (the `API_BASE` repository variable), so the app is always identical to the website and every Vercel deploy updates installed phones with no new APK. (Set the repository variable `LIVE_UPDATES=0` only if you want a self-contained offline APK.) A new version is applied by itself: the app saves to the device and reloads into it as soon as nobody is typing; if someone is mid-entry it waits until they stop for 20 seconds.

**Download button.** Each run of *Build Android APK* publishes the file as `MASMS.apk` on the GitHub release `android-latest`, always at the same address, so the website's **Download Android app** button always gives the newest APK. One-time setup: in Vercel set `GITHUB_REPOSITORY` to `owner/repo` (or `APK_URL` to a full address) and redeploy. For updates to install over an older APK, run *Create Play Store signing key* once and add its four secrets: with them the workflow signs the APK with that stable key; without them it falls back to a debug key that changes every build (phones then have to uninstall before installing a newer APK).
4. Play Store needs a signed release build (Build > Generate Signed Bundle) and a $25 developer account.

### Automatic updates
The app checks for a newer version by itself (about 4 seconds after opening, whenever it returns from the background, and every 6 hours), with nothing to tap in Settings. Code: `scripts/app-update.js`.
- **Installed from Google Play:** uses Play's in-app update. Users see an *Update available* banner, the update downloads while they keep working, then *Restart now* installs it. Play decides when a new release is visible (usually within hours of publishing). To force an urgent update, set the release's *in-app update priority* to 4 or 5 in the Play Console (or via the Publishing API); the app then runs Google's full-screen update and the old version cannot be used.
- **Installed from an APK file:** the app reads `GET /api/app-version`. After publishing a new build, set in Vercel (then redeploy so the env change applies): `APP_LATEST_VERSION_CODE` (the number shown in the GitHub run summary), `APP_LATEST_VERSION_NAME`, `APP_DOWNLOAD_URL` (direct link to the new APK; defaults to the Play Store page), optional `APP_UPDATE_NOTES`, and `APP_MIN_VERSION_CODE` to make older builds unable to dismiss the prompt.
- **Website / installed web app / live-URL APK (`LIVE_UPDATES=1`):** the service worker is re-checked on the same triggers and a *Reload* banner appears once the new build is loaded. This kind of install updates on every Vercel deploy, no new APK needed.
- The version code must go up on every release; the workflows use the GitHub run number. Set repository variable `APP_VERSION_NAME` to change the displayed name (default 1.1). Updates only work on a release build that has the same signing key as the installed one.
- Data is written to the device before any restart, and "Later" hides the banner for 24 hours (not possible for a below-minimum version).

Note: PDF/Excel downloads inside the APK need the Capacitor Filesystem/Share plugin (not included yet); they work in the installed web app (Option A).

## Photo gallery (landing page)
The landing page has a **Gallery** link that opens a page of photo cards. Add photos by putting the images (jpg/png/webp, about 1200px wide) in `pwa/gallery/` and listing them in `pwa/gallery.json`: `[{ "file": "open-day.jpg", "title": "Open day", "caption": "Parents touring the labs" }]`. Rebuild (`npm run build`, `npm run standalone`, `npm run build:android`); the photos are embedded in the page, so they work offline. Until photos are added, placeholder cards show. Tapping a photo opens it full size.

## Web Page (System Developer)
System Developer > **Web Page** edits what visitors see on the landing page before login: the home heading and description, the contacts (phone, email, WhatsApp, Facebook) and photo cards for the Gallery (add, retitle, caption, reorder, remove; photos are resized in the browser, up to 12).
- **Save** keeps the changes on this device (key `maestroWebPage`; the landing page reads it straight away). When the cloud button (bottom-left) is signed in with the admin account, Save also **publishes** to the server (`PUT /api/web-page`, admin only), and every visitor's landing page loads it from `GET /api/web-page` (public). Without the cloud sign-in it shows "Saved on this device only"; sign in and press **Publish**.
- Unpublished edits on a device are never overwritten by the published copy. Without a server (single HTML file) the changes show on that device only.
- The photos live in this setting, not in school backups. `pwa/gallery.json` is still the built-in default gallery; anything published replaces it.
