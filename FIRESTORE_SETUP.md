# VaultChatt II — Web Client Setup & Sync Guide

## What's new in this revision

- **Alphanumeric ID codes** — new accounts get a 6-character code of letters + digits (e.g. `K7M2QX`). Existing 6-digit codes keep working. Input is case-insensitive.
- **Message requests** — if someone messages you using your ID code before you've added them, the conversation appears under *Message requests* with Accept / Block. You can reply before accepting.
- **Notification system** (`notifications.js`) — OS notifications (permission asked once, via a dismissible banner), unread pills per contact, tab-title counter `(3) VaultChatt II`, favicon badge, and a soft chime. Notification bodies show the message preview only while the tab is in the background.
- **Google sign-in** — "Continue with Google" on the sign-in page.
- **Mobile layout** — ☰ menu button opens the contact drawer on small screens; the message box stays visible at every size (the layout no longer relies on a fixed 100vh).
- **New app icons** — all in the root folder alongside everything else, no subfolder, + `site.webmanifest` + `browserconfig.xml` (Android/Chrome incl. maskable + monochrome, iOS, Windows, favicon.ico, Safari pinned tab).

> Notifications work while VaultChatt is open in a tab/window (foreground or background). Delivering them with the tab fully closed needs Firebase Cloud Messaging + a service worker — not included here.

---

## A. Enable Google sign-in (Firebase Console)

1. Open **console.firebase.google.com** → project **vault-chatt-ii**.
2. **Build → Authentication → Sign-in method** → **Add new provider** → **Google**.
3. Toggle **Enable**, choose a **Public-facing name** and a **Support email**, click **Save**.
4. **Authentication → Settings → Authorized domains** → **Add domain** for wherever you host the site (e.g. your custom domain). `localhost`, `vault-chatt-ii.firebaseapp.com` and `vault-chatt-ii.web.app` are already listed. If you test via `127.0.0.1`, add that too.
5. Reload the site and click **Continue with Google**. First-time Google users get a profile + ID code automatically.

Troubleshooting: `auth/unauthorized-domain` → step 4. `auth/operation-not-allowed` → step 3. Popup blocked → allow popups for the site.

*(Optional, Android app)* Google sign-in there also needs your SHA-1/SHA-256 added under Project settings → Your apps → Android, then a fresh `google-services.json`.

## B. Security rules

Both files in this folder are now your **actual deployed rules**, each merged
with only the minimal changes needed — nothing else touched:

**`firestore.rules`** — two changes from what you sent:
1. `idCode.matches('^[0-9]{6}$')` → `'^[A-Z0-9]{6}$'` in three places
   (`/users` create, `/users` update backfill, `/idcodes` create) — the
   alphanumeric ID code upgrade (Section 1).
2. A new `/blocks/{uid}/list/{blockedUid}` match block, identical in shape
   to your existing `/contacts` block, backing the Block action on message
   requests (Section 6).

**`database.rules.json`** — one change from what you sent: the `.validate`
type regex on `/messages/$recipientUid/$messageId` gained `EDIT` and
`DELETE_EVERYONE` — your rules only listed
`TEXT|IMAGE|VIDEO|FILE|AUDIO|KEY_EXCHANGE|DELIVERY_ACK|READ_ACK`, but the
client (Section 5 — edit / delete-for-everyone) also sends those two types,
which your deployed rules would currently reject. Everything else —
`presence`, the read/write ownership checks, the `$other` deny-all — is
untouched. Note: your pasted version had the long rule expressions wrapped
across multiple lines inside the quotes for readability in the console;
that's not valid JSON for a `.json` file the CLI deploys, so they're
collapsed back to single lines here (same logic, same characters, just no
embedded line breaks).

Deploy:

```
firebase deploy --only firestore:rules,database --project vault-chatt-ii
```

## C. Files

```
index.html / chat.html      pages          style.css      styling
auth.js / app.js            page logic     notifications.js  NEW notification system
firebase-config.js          Firebase init  firestore-api.js / messaging.js / crypto.js / idb.js / appearance.js
site.webmanifest / browserconfig.xml       icon-*.png, favicon*, apple-touch-icon*  NEW icon set (+ SVG masters), all flat in this same folder
favicon.ico, apple-touch-icon.png, favicon-*.png
```
All files sit in one folder (the HTML/JS reference each other without css/ or js/ subfolders).

---

This web app is **not a separate product** — it's a second client for the exact same
Firebase project (`vault-chatt-ii`) your Android app already uses. Same users, same
ID codes, same contacts, same message relay. No new backend, no schema changes,
no rules changes. You're pointing a browser at the same data.

```
Android app  ─┐
               ├──► Firestore (users, idcodes, contacts)
Web app      ─┘        │
               ├──► Realtime Database (messages mailbox, presence)
               └──► same X25519 + AES-256-GCM encryption, so each side
                     can decrypt what the other sends
```

---

## 1. What you got

```
webapp/
├── index.html          sign in / register page
├── chat.html            contact list + conversation view
├── css/style.css        styling
├── js/firebase-config.js   ← you edit this (2 lines)
├── js/idb.js             local storage (keys + message history)
├── js/crypto.js          X25519 + AES-256-GCM (mirrors CryptoEngine.java)
├── js/firestore-api.js   mirrors FirestoreManager.java
├── js/messaging.js       mirrors MessageSender.java / VaultMessageListener.java
├── js/auth.js            index.html logic
└── js/app.js             chat.html logic
```

Nothing here talks to any server of mine — every request goes directly from
the browser to your Firebase project, same as the Android app.

---

## 2. Register a Web App in Firebase Console

Your Android app's API key won't work here — Google restricts it to Android
package name + SHA-1 fingerprint. You need a **Web app** entry, which takes two minutes:

1. Go to **console.firebase.google.com** → project **vault-chatt-ii**.
2. Click the gear icon → **Project settings**.
3. Scroll to **"Your apps"** → click the **`</>`** (web) icon → **Add app**.
4. Nickname it "VaultChatt Web" (Firebase Hosting checkbox optional — see §5).
5. Firebase shows you a config block like:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "vault-chatt-ii.firebaseapp.com",
     projectId: "vault-chatt-ii",
     storageBucket: "vault-chatt-ii.firebasestorage.app",
     messagingSenderId: "732391842107",
     appId: "1:732391842107:web:xxxxxxxxxxxxx"
   };
   ```
6. Open `js/firebase-config.js` and paste in just the **`apiKey`** and **`appId`**
   values — everything else is already filled in correctly for your project.

---

## 3. Confirm Email/Password sign-in is enabled

Firebase Console → **Authentication** → **Sign-in method** → **Email/Password** → make
sure it's **Enabled**. (It already is for Android, since that's what `AuthActivity`
uses — this step is almost certainly already done. Just confirm.)

---

## 4. Confirm your Realtime Database URL

Firebase Console → **Realtime Database** → copy the URL shown above the data
tree (looks like `https://vault-chatt-ii-default-rtdb.firebaseio.com` or with a
region suffix like `...-default-rtdb.asia-southeast1.firebasedatabase.app`).
Paste it into `databaseURL` in `js/firebase-config.js` if it differs from the
placeholder already there.

---

## 5. Rules — nothing to change

Your existing `firestore.rules` and `database.rules.json` already govern this
web client too. Firestore/RTDB security rules key off `request.auth.uid`, not
platform — they don't know or care whether the request came from Android or a
browser. As long as you've already run:

```cmd
firebase deploy --only firestore:rules,database --project vault-chatt-ii
```
you're covered. If you haven't deployed rules recently, do that now — this is
the single most common cause of "it works on Android but not on web" reports.

---

## 6. Run it

Browsers block Firebase Auth persistence and some Web Crypto features on
`file://` pages, so don't just double-click `index.html`. Pick one:

**Option A — quickest, for local testing (Windows CMD):**
```cmd
cd path\to\webapp
python -m http.server 8080
```
Then open **http://localhost:8080** in your browser.

**Option B — deploy it properly with Firebase Hosting (free, gets you HTTPS + a real URL):**
```cmd
npm install -g firebase-tools
firebase login
cd path\to\webapp
firebase init hosting
```
When prompted:
- Public directory: `.` (current folder, since your html/css/js are already here)
- Configure as single-page app: **No**
- Set up automatic builds with GitHub: **No**

Then:
```cmd
firebase deploy --only hosting --project vault-chatt-ii
```
You'll get a live URL like `https://vault-chatt-ii.web.app`.

---

## 7. Browser requirements

The crypto layer uses the browser's **native Web Crypto X25519 support**
(`crypto.subtle`), matching the Android app's BouncyCastle X25519 byte-for-byte
so messages decrypt correctly on both ends. This needs a current version of:
- Chrome or Edge (2024+ release)
- Firefox (2024+ release)

Older Safari versions may not support X25519 in `crypto.subtle` yet — if you
need Safari support, tell me and I'll wire in a small audited JS fallback
library (`@noble/curves`) instead of the native API.

---

## 8. Test the sync

1. Open the web app, register a **new** account (or sign in with an existing
   Android account's email/password — same Firebase Auth user works on both).
2. Note the ID code shown top-left.
3. On your Android phone, add that ID code as a contact (or vice versa).
4. Send a message from either side — it should appear on the other within
   a second or two, decrypted correctly.
5. Confirm presence: closing the browser tab should flip your contact's
   online dot to offline on the other device within a few seconds.

If a message doesn't decrypt (garbled text) on one side, it almost always
means that side is holding a stale public key for the contact — reopen the
conversation to trigger a fresh key exchange, or remove and re-add the
contact.

---

## 9. Security note

Android stores your private key in the hardware-backed Android Keystore.
The web client stores it as a non-extractable `CryptoKey` object in
IndexedDB, which is solid for a browser but doesn't have hardware backing —
anyone with full access to the OS profile running the browser (or malicious
browser extensions) has a larger attack surface than on Android. This is a
reasonable, standard trade-off for a browser client, but worth knowing if a
device is shared or unmanaged. Only ever run this over HTTPS (Firebase
Hosting gives you that automatically) — never deploy it over plain HTTP.

---

## 10. Troubleshooting quick reference

| Symptom | Likely cause |
|---|---|
| "Missing or insufficient permissions" on login/register | Rules not deployed — see §5 |
| Register works but ID code never appears | Same idCode-backfill rule issue covered in your Android debugging session — redeploy rules |
| Messages never arrive | Wrong `databaseURL` in `firebase-config.js`, or RTDB rules not deployed |
| Garbled decrypted text | Stale public key — reopen the conversation or re-add the contact |
| Blank page / console error about crypto.subtle | Browser doesn't support native X25519 — update browser or ask me for the fallback library |
| Auth works, then instantly signs out | `apiKey`/`appId` pasted from the wrong app (Android instead of Web) in Firebase Console |
