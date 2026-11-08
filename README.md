# MASMS web + API

Express + MongoDB API (JWT auth) that hosts the MASMS page and saves its data in the cloud, ready for Vercel.

## Where data is kept
- **On the device (always on):** `scripts/local-store.js` saves the full dataset to IndexedDB every 5s, when the app is hidden/closed, and reloads it on start. No internet or server needed. It keeps one earlier copy (Settings > Backup & Restore > *Restore earlier copy on this device*). Phone storage is lost if the app is uninstalled or the phone reset, so keep downloading backups.
- **Cloud (optional):** the cloud button syncs the same data across devices. If this device holds changes the cloud never received, you are asked which copy to keep.
- **Manual backup:** Settings > Backup & Restore exports/imports a JSON file (in the APK it opens the Android share sheet).

## Layout
- `source/MAESTRO_MASMS_FINAL.html` – the app (edit this, then rebuild)
- `scripts/build.js` – produces `public/` (images pulled out of the HTML, JS whitespace-minified, vendor libs + fonts copied from npm)
- `scripts/local-store.js` – browser module: on-device autosave/restore
- `scripts/cloud-sync.js` – browser module: the "cloud" button bottom-left signs in, loads saved data on start, autosaves every 20s
- `src/app.js`, `src/store.js` – API and data layer · `api/index.js` – Vercel entry · `vercel.json`

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/status` | `{needsSetup}` |
| POST | `/api/auth/register` | first account becomes admin; afterwards an admin token is required |
| POST | `/api/auth/login` | rate-limited, returns a 12h JWT |
| GET/PUT | `/api/data` | whole backup JSON; `baseVersion` stops stale saves overwriting newer data (409) |
| GET | `/api/health` | |

| GET | `/api/comms/status` | which of SMS / email / M-Pesa the server has set up |
| POST | `/api/sms/send` | `{to,message}` or `{messages:[{to,message}]}` via Africa's Talking; returns `sent`, `failed`, `units` |
| POST | `/api/email/send` | `{to,subject,message}` or `{messages:[{email,subject,message}]}` via SMTP |
| POST | `/api/mpesa/stkpush` | sends an M-Pesa prompt; Safaricom confirms to `/api/mpesa/callback/<MPESA_CALLBACK_SECRET>` |
| GET | `/api/mpesa/status/:id`, `/api/mpesa/recent` | prompt status / confirmed payments (for the Reconciliation tab) |

## Communication & payments setup
Messages and M-Pesa prompts are sent **by the server**, so provider keys never reach the browser. Staff must be signed in with the cloud button (bottom-left). Set these in `.env` or Vercel's Environment Variables (see `.env.example`); each feature shows a clear "not set up" message until its variables exist:
- **SMS:** `AT_USERNAME`, `AT_API_KEY`, optional `AT_SENDER_ID` (Africa's Talking; `AT_USERNAME=sandbox` for testing).
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (Gmail: use an App Password).
- **M-Pesa (Daraja STK push):** `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_SECRET` (any long random string), `PUBLIC_URL` (your deployed https address), `MPESA_ENV=production` when live.
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
4. Play Store needs a signed release build (Build > Generate Signed Bundle) and a $25 developer account.

Note: PDF/Excel downloads inside the APK need the Capacitor Filesystem/Share plugin (not included yet); they work in the installed web app (Option A).
