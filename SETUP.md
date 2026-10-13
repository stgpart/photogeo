# PhotoGeo — one-time setup (all free, no billing)

Everything below is done while signed in to Google as **stgp.art@gmail.com**.
Claude can do most of these clicks for you in Chrome. You just need to be signed in to that account.

## 1. Firebase project
1. Go to https://console.firebase.google.com and click **Create a project**. Name it `photogeo`. Turn Google Analytics **off**. Stay on the free **Spark** plan.
2. **Add a web app**: on the project overview, click the `</>` icon and name it `PhotoGeo`. Skip Firebase Hosting.
3. Copy the `firebaseConfig` values it shows into `FIREBASE_CONFIG` at the top of `app.js`.

## 2. Sign-in
1. **Build → Authentication → Get started → Sign-in method → Google → Enable**. Set the support email to stgp.art@gmail.com.
2. **Authentication → Settings → Authorized domains → Add domain**: add `stgpart.github.io`.
   Without this, the Google popup opens and immediately closes. It's the same issue the yaoi journal hit.

## 3. Database
1. **Build → Firestore Database → Create database**. Pick location `us-west1` and **production mode**.
2. **Rules** tab: paste the contents of `firestore.rules` and click **Publish**.
   This locks all data to stgp.art@gmail.com only.

## 4. Google Drive access (for photo files)
Go to https://console.cloud.google.com and make sure the project selector at the top says **photogeo**. Firebase made this project for you.
1. **APIs & Services → Library**: search for **Google Drive API** and click **Enable**.
2. **Google Auth Platform** (or "OAuth consent screen"):
   - Branding: app name `PhotoGeo`, support email stgp.art@gmail.com.
   - Audience: External. Either click **Publish app**, or add stgp.art@gmail.com under **Test users**.
   - Data access: add the scope `.../auth/drive.file`. This is a non-sensitive scope, so Google doesn't require verification.
3. **Credentials** → open **Web client (auto created by Google Service)**:
   - Under Authorized JavaScript origins, add `https://stgpart.github.io`.
   - Copy the **Client ID** into `OAUTH_CLIENT_ID` in `app.js`.

## 5. GitHub Pages
1. Create a public repo named `photogeo` on the chosen GitHub account.
2. Upload all files at the repo root: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, and the icon PNGs folder. Commit to `main`.
3. Go to **Settings → Pages**. Set Source to "Deploy from a branch", choose `main` and `/ (root)`, then click **Save**.
4. After about a minute, the app is live at `https://stgpart.github.io/photogeo/`.

## 6. On your iPhone
Open the link in Safari, then tap **Share → Add to Home Screen**. Open PhotoGeo from the icon and sign in.
When it asks for location access, choose **Allow**. That's how photos get pinned when the iPhone strips GPS from the file.
