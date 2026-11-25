// Tailwind settings for the landing page. pwa/landing.html is generated from pwa/landing.src.html with `npm run landing:css`
// (the page's styles are compiled once and written into it, so the app never loads Tailwind from the internet).
module.exports = {
  content: [__dirname + '/landing.src.html'],
  theme: { extend: {
    fontFamily: { sans: ['"Inter"', '"Roboto"', 'system-ui', '-apple-system', 'sans-serif'] },
    colors: { canvas: '#F4F7FA', slateNavy: '#1E2D3D', slateNavyDark: '#15202B', royalBlue: '#1E88E5', royalBlueDark: '#1565C0', royalBlueLight: '#E3F2FD', footerStrip: '#EDF2F7' },
    boxShadow: { card: '0 4px 16px rgba(30, 45, 61, 0.08)', cardHover: '0 10px 26px rgba(30, 45, 61, 0.14)', bottomNav: '0 -2px 12px rgba(30, 45, 61, 0.08)' },
  } },
};
