# Publishing MASMS on the Google Play Store

## A. One-time setup (about 30 minutes)
1. **Vercel address:** your live site, e.g. `https://maestro-app-jade.vercel.app`. Your privacy policy is at `<that address>/privacy.html` (edit `pwa/privacy.html` first: replace the two [BRACKETED] items, then push to GitHub so Vercel redeploys).
2. **GitHub variable:** repo Settings > Secrets and variables > Actions > **Variables** > New: `API_BASE` = your Vercel address (no trailing slash).
3. **Create the signing key (once):** repo > Actions > **Create Play Store signing key** > Run workflow. When finished, download artifact `MASMS-signing-key`, unzip it, and **keep a safe copy of all 3 files** (losing the key means you can never update the app).
4. **Add 4 secrets:** Settings > Secrets and variables > Actions > **Secrets** > New repository secret:
   - `KEYSTORE_BASE64`  = the whole text inside `keystore-base64.txt`
   - `KEYSTORE_PASSWORD` = value from `secrets.txt`
   - `KEY_PASSWORD`      = value from `secrets.txt`
   - `KEY_ALIAS`        = `masms`
5. **Google Play developer account:** play.google.com/console, one-time fee about US$25, ID verification required.

## B. Build the app bundle (repeat for every update)
Actions > **Build Play Store release** > Run workflow > download artifact `MASMS-play-release` > unzip > `app-release.aab`. The version number goes up automatically each run.

## C. Create the app in Play Console
Create app > name **MASMS**, default language English, App, Free. Then complete the dashboard tasks:
- **Privacy policy:** your `/privacy.html` address.
- **App access:** "All or some functionality is restricted" and provide a demo login for the reviewers (a test staff account and its password).
- **Ads:** No ads.
- **Content rating:** answer the questionnaire honestly (no violence etc.); expect "Everyone".
- **Target audience:** 18 and over (staff and school administrators). Do not pick under-13 audiences.
- **Data safety** (suggested answers, check them against the policy):
  - Collects: Personal info (name, email, phone), Photos, App activity/records entered by the user.
  - Purpose: App functionality, Account management. Not used for advertising.
  - Shared with third parties: No (database host acts as our processor).
  - Encrypted in transit: Yes. Users can request deletion: Yes (contact email).
- **Production release / Testing:** upload `app-release.aab`, add release notes, and submit for review. New personal accounts may first need a **closed test** (about 12 testers for 14 days); check the Play Console for the current requirement.

## D. Store listing text (copy and edit)
**App name:** MASMS - School Management
**Short description (max 80 chars):** Manage students, fees, exams, timetables and school records in one app.
**Full description:**
MASMS (Maestro Advanced School Management System) helps schools run daily work from one place.

- Students, classes, teachers and staff records
- Timetables with automatic lesson placement
- Examinations, marks, grading and report forms
- Fees, invoices, receipts and payment tracking
- Attendance, boarding, transport, library, stores and laboratory
- Parent and student portal, announcements and SMS-ready communication
- Works offline: data is saved on your device and can sync to the cloud
- Backups you can download and restore at any time

For schools in Kenya and beyond. Staff sign in with their own accounts; sales agents manage the schools they register.

**Graphics you must prepare:** app icon 512x512 (use `pwa/icons/icon-512.png`), feature graphic 1024x500, at least 2 phone screenshots (take them in the installed app).

## E. Updating later
Push changes to GitHub, run **Build Play Store release** again, and upload the new `.aab` as a new release in Play Console.
