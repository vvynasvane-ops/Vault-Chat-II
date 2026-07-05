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

function randomIdCode() {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, "0");
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

export async function searchByIdCode(idCode) {
  const q = query(collection(db, "users"), where("idCode", "==", idCode.trim()), limit(1));
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

export function listenToProfile(uid, onChange, onError) {
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (snap.exists()) onChange(snap.data());
    },
    onError
  );
}
