# PhotoGeo — Project Notes for Claude

Working context for an ongoing project. This file is not for users. Read it before making changes.

## What this is
PhotoGeo is a personal photography location journal for Cristina, built as a single-page PWA.
It has an interactive map of shooting spots. Each spot holds photos, notes, and coordinates, and she uses it to plan upcoming shoots.
- **Owner account:** stgp.art@gmail.com. That account handles Google sign-in, Firebase, and Drive. The app and the Firestore rules refuse any other account.
- **Privacy:** spots must stay private. Don't publish locations anywhere, and leave `<meta name="robots" content="noindex">` in place.
- **Stack:** plain HTML/CSS/JS with no build step, the same as the yaoi journal. Files: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`.
- **Live site:** https://stgpart.github.io/photogeo/ (repo github.com/stgpart/photogeo, GitHub account stgpart, under stgp.art@gmail.com)
- **Deploy:** upload changed files through GitHub's web upload, commit to `main`, and GitHub Pages auto-deploys. Run `node --check app.js` before pushing.
  If `sw.js` changes, bump its `CACHE_NAME` (currently `photogeo-v1`).

## Libraries (CDN)
- MapLibre GL 4.7.1. The map runs on free tiles: Esri World Imagery satellite with Esri roads/labels overlays, an OSM street layer as an alternative, and AWS Terrarium elevation for 3D terrain.
  Google Maps was rejected because it needs a billing account.
- exifr 7.1.3 reads GPS, date, and camera settings from photo files.
- Firebase compat 10.14.1 (auth and Firestore only). Google Identity Services (GIS) handles Drive tokens.
- Nominatim (OSM) reverse geocoding suggests spot names. It's best-effort, and a failure falls back to "New spot".

## Data
Firestore paths, stored under `users/{uid}/`:
- `spots/{id}`: `{name, lat, lng, notes, createdAt, updatedAt}`
- `photos/{id}`: `{spotId, thumb (400px JPEG data URL), takenAt, lat, lng, locSource, camera|null, fileName, mimeType, size, driveId, driveStatus: 'pending'|'done', createdAt, updatedAt}`
  - `locSource` values:
    - `photo`: the file had EXIF GPS (DSLR, or an iPhone file that kept it)
    - `device`: the phone's GPS at upload time (iPhone Safari usually strips GPS)
    - `spot`: added via a spot's "Add photo here" button
    - `map`: placed by hand as a fallback
  - `camera` fields: `{make, model, lens, fNumber, exposureTime, iso, focalLength, focalLength35, exposureComp}`. Only DSLR files reliably carry these.
- `meta/app`: `{driveFolderId}`

Photo files go to the owner's Google Drive, in a "PhotoGeo Images" folder, using the `drive.file` scope.
- The original file is queued in IndexedDB (`pending` store) **before** anything else, and stays there until the Drive upload succeeds. Then it moves to the `images` cache.
- Never delete a `pending` item unless its Firestore photo doc is confirmed gone. `flushUploads()` only runs after the first photos snapshot (`photosLoaded`).
- Drive tokens come from the GIS token client. They're cached in localStorage for about an hour, so a reload doesn't force a reconnect the way the yaoi journal does.
  When a token expires, a banner says "N photos waiting to save to Google Drive → Connect Drive". `requestAccessToken` must run directly inside a tap handler.
- Deleting a spot or photo removes the PhotoGeo records only. Drive files are left alone on purpose.

## Decisions (from Cristina, Oct 2026)
- Personal use only: no photo scores, no other users, no "desired look" presets.
- Weather is shown **only when planning**, for a selected spot. Nothing is saved at upload time. The source is a live Windy embed (embed.windy.com).
- Sun info for a selected spot:
  - the phase breakdown (night, astronomical/nautical/civil twilight, blue hour, golden hour, day), like the screenshot she shared
  - sun position and direction, like suncalc.org
  - a date picker for planning a future shoot
- DSLR uploads show the camera settings per photo. iPhone uploads use GPS plus timestamp, so phase 2 can show what light the photo was taken in.
- 3D means satellite imagery plus tiltable terrain. No 3D buildings.

## Roadmap
1. **Phase 1 (built):** sign-in, map (satellite/streets, 3D terrain), spots, add photo with auto-pin (EXIF GPS → phone GPS → map center), join a nearby spot (within 60 m), notes, directions link, photo viewer with camera settings, Drive backup queue.
2. **Phase 2:** per-spot planner: sun phases table, sun direction lines on the map with a time slider, date picker, and the "taken during golden hour" label on photos (suncalc library, computed locally).
3. **Phase 3:** Windy embed for the selected spot.
4. **Later:** DSLR import polish (batch from Files, HEIC on desktop), and bringing the Drive-token fix back to the yaoi journal.
