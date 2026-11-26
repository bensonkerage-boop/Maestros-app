// LIVE_URL (e.g. https://your-site.vercel.app) makes the Android app load MASMS from that address,
// so every Vercel deploy updates installed apps with no new Play Store release.
// Leave it unset to bundle the app inside the APK (works fully offline, updates only via Play Store).
// With LIVE_URL set, offline.html (bundled in the APK) is shown when the site cannot be reached and reconnects by itself.
const liveUrl = (process.env.LIVE_URL || '').replace(/\/$/, '');
module.exports = {
  appId: 'com.maestro.masms',
  appName: 'MASMS',
  webDir: 'public',
  backgroundColor: '#152c58',
  // appendUserAgent tags the app's browser so the page knows it is inside the Android app (no landing page, no Home arrow: wheel, then sign-in).
  android: { allowMixedContent: false, appendUserAgent: 'MASMSApp' },
  server: liveUrl ? { url: liveUrl, cleartext: false, errorPath: 'offline.html' } : { androidScheme: 'https' },
};
