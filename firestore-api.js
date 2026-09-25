// js/firestore-api.js
//
// Mirrors app/src/.../firebase/FirestoreManager.java field-for-field and
// collection-for-collection, so the web client reads/writes the exact same
// documents the Android app does. Do not rename any field below — the
// deployed firestore.rules (shared by both clients) validate these exact
// key names.
//
// /users/{uid}          uid, username, displayName, idCode, publicKeyBase64,
//                        fcmToken, lastSeen, isOnline, createdAt
// /idcodes/{idCode}      uid, reservedAt
// /contacts/{uid}/list/{friendUid}   addedAt

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction,
  collection,
  query,
  where,
  limit,
  getDocs,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-config.js";

export const ERROR_ID_CODE_TAKEN = "ID_CODE_TAKEN";
const MAX_ID_CODE_ATTEMPTS = 6;

// Alphanumeric ID codes (Section 1 upgrade): 6 characters drawn from an
// unambiguous set (no 0/O/1/I/L) so codes are easy to read aloud and type,
// but the space is ~2.2B codes instead of the old 6-digit space of 1M —
// far fewer collisions as the user base grows. Always stored/compared
// upper-case so "a3k9pq" and "A3K9PQ" are the same code.
const ID_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ID_CODE_LENGTH = 6;
export const ID_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function randomIdCode() {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(ID_CODE_LENGTH));
  for (let i = 0; i < ID_CODE_LENGTH; i++) {
    out += ID_CODE_ALPHABET[bytes[i] % ID_CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeIdCode(raw) {
  return (raw || "").trim().toUpperCase();
}

// ─── Account creation (mirrors createAccountAtomically) ──────────────────

export async function createAccountAtomically(profile) {
  for (let attempt = 1; attempt <= MAX_ID_CODE_ATTEMPTS; attempt++) {
    const idCode = attempt === 1 && profile.idCode ? profile.idCode : randomIdCode();
    const idCodeRef = doc(db, "idcodes", idCode);
    const userRef = doc(db, "users", profile.uid);
    try {
      await runTransaction(db, async (transaction) => {
        const idCodeSnap = await transaction.get(idCodeRef);
        if (idCodeSnap.exists()) {
          throw new Error(ERROR_ID_CODE_TAKEN);
        }
        transaction.set(idCodeRef, { uid: profile.uid, reservedAt: Date.now() });
        transaction.set(userRef, { ...profile, idCode });
      });
      return idCode;
    } catch (e) {
      if (e.message === ERROR_ID_CODE_TAKEN && attempt < MAX_ID_CODE_ATTEMPTS) continue;
      throw e;
    }
  }
  throw new Error(ERROR_ID_CODE_TAKEN);
}

// ─── Profile ───────────────────────────────────────────────────────────

export async function getProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) throw new Error("User not found");
  return snap.data();
}

// Rebuilds a /users/{uid} doc for an already-authenticated account whose
// Firestore profile is missing (e.g. it was never fully written, or was
// deleted separately from the Auth account). Used as a self-heal path so a
// returning user isn't locked out just because their document is gone.
// `cached` is the last-known local session data (see auth.js saveSession);
// anything missing falls back to a safe default.
//
// IMPORTANT: this must write uid/username/displayName/idCode/publicKeyBase64
// /fcmToken all in the SAME create — firestore.rules' `allow create` on
// /users/{uid} requires idCode to already be present and validly formatted
// on that very write. Writing the doc first and patching in idCode after
// (via a separate update) is rejected by the rules as a create with no
// idCode, which is what previously made recovery fail outright. Reusing
// createAccountAtomically() keeps this in the one atomic, rule-compliant
// write and always mints a fresh code — deliberately not reusing any old
// cached idCode, since we can't be sure it's still free or still theirs.
export async function recoverProfileFromCache(uid, cached = {}) {
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) return snap.data(); // recovered/created concurrently elsewhere

  const profile = {
    uid,
    username: cached.username || `user_${uid.slice(0, 6)}`,
    displayName: cached.displayName || cached.username || "User",
    publicKeyBase64: cached.publicKeyBase64 || "",
    fcmToken: "",
    createdAt: Date.now(),
    lastSeen: Date.now(),
    isOnline: true,
  };

  const idCode = await createAccountAtomically(profile);
  return { ...profile, idCode };
}

// Lets a signed-in user replace their own ID code on demand (e.g. a "Renew
// ID code" button) — distinct from ensureIdCode(), which only backfills a
// code when one is entirely missing and is a no-op otherwise. This always
// mints and reserves a brand-new code and overwrites the old one. The old
// code's /idcodes reservation is intentionally left in place (idcodes
// entries are immutable per firestore.rules) — it simply stops resolving
// to this user going forward since /users/{uid}.idCode has moved on.
export async function renewIdCode(uid) {
  for (let attempt = 1; attempt <= MAX_ID_CODE_ATTEMPTS; attempt++) {
    const candidate = randomIdCode();
    const userRef = doc(db, "users", uid);
    const idCodeRef = doc(db, "idcodes", candidate);
    try {
      return await runTransaction(db, async (transaction) => {
        const idCodeSnap = await transaction.get(idCodeRef);
        if (idCodeSnap.exists()) {
          throw new Error(ERROR_ID_CODE_TAKEN);
        }
        transaction.set(idCodeRef, { uid, reservedAt: Date.now() });
        transaction.update(userRef, { idCode: candidate });
        return candidate;
      });
    } catch (e) {
      if (e.message === ERROR_ID_CODE_TAKEN && attempt < MAX_ID_CODE_ATTEMPTS) continue;
      throw e;
    }
  }
  throw new Error(ERROR_ID_CODE_TAKEN);
}

export async function searchByIdCode(idCode) {
  const q = query(collection(db, "users"), where("idCode", "==", normalizeIdCode(idCode)), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("User not found");
  return snap.docs[0].data();
}

// ─── ID code backfill (mirrors ensureIdCode / assignIdCodeIfMissing) ─────

export async function ensureIdCode(uid) {
  for (let attempt = 1; attempt <= MAX_ID_CODE_ATTEMPTS; attempt++) {
    const candidate = randomIdCode();
    const userRef = doc(db, "users", uid);
    const idCodeRef = doc(db, "idcodes", candidate);
    try {
      return await runTransaction(db, async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const existing = userSnap.data()?.idCode;
        if (existing) return existing; // already assigned - no-op

        const idCodeSnap = await transaction.get(idCodeRef);
        if (idCodeSnap.exists()) {
          throw new Error(ERROR_ID_CODE_TAKEN);
        }
        transaction.set(idCodeRef, { uid, reservedAt: Date.now() });
        transaction.update(userRef, { idCode: candidate });
        return candidate;
      });
    } catch (e) {
      if (e.message === ERROR_ID_CODE_TAKEN && attempt < MAX_ID_CODE_ATTEMPTS) continue;
      throw e;
    }
  }
  throw new Error(ERROR_ID_CODE_TAKEN);
}

export async function updateFcmToken(uid, token) {
  // Web has no FCM push registration; kept as a harmless no-op field update
  // so the schema stays identical across platforms.
  await updateDoc(doc(db, "users", uid), { fcmToken: token || "" });
}

export async function setOnlineStatus(uid, isOnline) {
  await updateDoc(doc(db, "users", uid), { isOnline, lastSeen: Date.now() });
}

export async function updatePublicKey(uid, publicKeyBase64) {
  await updateDoc(doc(db, "users", uid), { publicKeyBase64 });
}

// Username is display-only (not used for lookup — idCode is), so this is a
// simple owner-checked field update. firestore.rules restricts it to a
// username-only write of 3-30 chars, same bounds as at registration.
export async function updateUsername(uid, username) {
  await updateDoc(doc(db, "users", uid), { username });
}

// ─── Profile picture (Section 12 — Profile Pictures) ─────────────────────
// Stored as a small compressed base64 JPEG directly on the user document —
// no new cloud storage service is introduced, consistent with the app's
// existing architecture (mirrors ProfilePhotoActivity.java's approach).

export async function updateProfilePhoto(uid, base64Jpeg) {
  await updateDoc(doc(db, "users", uid), { profilePhotoBase64: base64Jpeg || "" });
}

// ─── Contacts ─────────────────────────────────────────────────────────

export async function addContact(myUid, friendUid) {
  await setDoc(doc(db, "contacts", myUid, "list", friendUid), { addedAt: Date.now() });
}

export async function removeContact(myUid, friendUid) {
  const { deleteDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
  );
  await deleteDoc(doc(db, "contacts", myUid, "list", friendUid));
}

export async function getContactUids(myUid) {
  const snap = await getDocs(collection(db, "contacts", myUid, "list"));
  return snap.docs.map((d) => d.id);
}

// ─── Presence listener (mirrors listenToPresence) ────────────────────────

// ─── Blocked senders (Section 6 — unknown-sender requests) ───────────────
// Local-only would let a blocked stranger keep re-messaging after a device
// switch, so blocks live in Firestore next to contacts: /blocks/{uid}/list/{blockedUid}.

export async function blockUser(myUid, blockedUid) {
  await setDoc(doc(db, "blocks", myUid, "list", blockedUid), { blockedAt: Date.now() });
}

export async function unblockUser(myUid, blockedUid) {
  const { deleteDoc } = await import(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
  );
  await deleteDoc(doc(db, "blocks", myUid, "list", blockedUid));
}

export async function getBlockedUids(myUid) {
  const snap = await getDocs(collection(db, "blocks", myUid, "list"));
  return snap.docs.map((d) => d.id);
}

export function listenToProfile(uid, onChange, onError) {
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (snap.exists()) onChange(snap.data());
    },
    onError
  );
}
