Put your photos (jpg, png, webp) in this folder, then list each one in ../gallery.json:

[
  { "file": "open-day.jpg",  "title": "Open day 2026", "caption": "Parents touring the new science lab" },
  { "file": "sports.jpg",    "title": "Sports day",    "caption": "Inter-house relays" }
]

Each entry becomes one card on the Gallery page. Resize photos to about 1200px wide first (under 700KB each).
Then run: npm run build   (and npm run standalone for the single HTML file, npm run build:android for the APK)
