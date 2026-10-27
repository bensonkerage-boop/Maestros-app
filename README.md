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

## Tests & tools
- `npm test` – Jest: API/auth/data (18), dark mode (jsdom), double-lesson placement and welcome-password logic (run against the real source functions), and source checks (scripts parse, undefined-variable lint, regression for fixed bugs, build output)
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
