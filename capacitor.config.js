// LIVE_URL (e.g. https://your-site.vercel.app) makes the Android app load MASMS from that address,
// so every Vercel deploy updates installed apps with no new Play Store release.
// Leave it unset to bundle the app inside the APK (works fully offline, updates only via Play Store).
const liveUrl = (process.env.LIVE_URL || '').replace(/\/$/, '');
module.exports = {
  appId: 'com.maestro.masms',
  appName: 'MASMS',
  webDir: 'public',
  backgroundColor: '#152c58',
  android: { allowMixedContent: false },
  server: liveUrl ? { url: liveUrl, cleartext: false } : { androidScheme: 'https' },
};
