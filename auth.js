// js/auth.js — logic for index.html (login / register)
// Mirrors ui/activities/AuthActivity.java

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase-config.js";
import {
  createAccountAtomically,
  getProfile,
  ensureIdCode,
} from "./firestore-api.js";
import { getOrCreatePublicKeyBase64 } from "./crypto.js";

const googleProvider = new GoogleAuthProvider();

const els = {
  form: document.getElementById("auth-form"),
  title: document.getElementById("form-title"),
  toggle: document.getElementById("toggle-mode"),
  submit: document.getElementById("btn-submit"),
  error: document.getElementById("form-error"),
  username: document.getElementById("field-username"),
  displayName: document.getElementById("field-display-name"),
  email: document.getElementById("input-email"),
  password: document.getElementById("input-password"),
  usernameInput: document.getElementById("input-username"),
  displayNameInput: document.getElementById("input-display-name"),
  google: document.getElementById("btn-google"),
};

let isLoginMode = true;

// If already signed in, skip straight to the app.
onAuthStateChanged(auth, (user) => {
  if (user && sessionStorage.getItem("vc_uid") !== "signing_out") {
    window.location.href = "chat.html";
  }
});

els.toggle.addEventListener("click", () => {
  isLoginMode = !isLoginMode;
  els.title.textContent = isLoginMode ? "Sign in" : "Create account";
  els.submit.textContent = isLoginMode ? "Sign in" : "Sign up";
  els.toggle.textContent = isLoginMode
    ? "Don't have an account? Sign up"
    : "Already have an account? Sign in";
  els.username.classList.toggle("hidden", isLoginMode);
  els.displayName.classList.toggle("hidden", isLoginMode);
  setError("");
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  setLoading(true);
  try {
    if (isLoginMode) await doLogin();
    else await doRegister();
  } catch (err) {
    setError(friendlyError(err));
  } finally {
    setLoading(false);
  }
});

async function doLogin() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) throw new Error("Please fill in all fields");

  const cred = await signInWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  let profile = await getProfile(uid).catch(() => null);

  if (!profile) {
    // The Auth account exists (password just verified above) but its
    // Firestore profile doc doesn't — e.g. an old-system account whose
    // /users doc was cleared out. Recreate it with a fresh ID code rather
    // than locking the person out of an account they can still authenticate.
    const publicKeyBase64 = await getOrCreatePublicKeyBase64();
    const username = await uniqueUsernameFromGoogle({ email });
    const newProfile = {
      uid,
      username,
      displayName: username,
      publicKeyBase64,
      fcmToken: "",
      createdAt: Date.now(),
      lastSeen: Date.now(),
      isOnline: true,
    };
    const idCode = await createAccountAtomically(newProfile);
    profile = { ...newProfile, idCode };
  } else if (!profile.idCode) {
    // Account predates the ID-code system - assign one now (same as Android).
    try {
      profile.idCode = await ensureIdCode(uid);
    } catch (_) {
      // Don't block sign-in over this; retried next time the app loads.
    }
  }

  await getOrCreatePublicKeyBase64(); // ensure a local keypair exists
  saveSession(uid, email, profile.username, profile.displayName, profile.idCode);
  window.location.href = "chat.html";
}

async function doRegister() {
  const username = els.usernameInput.value.trim();
  const displayName = els.displayNameInput.value.trim();
  const email = els.email.value.trim();
  const password = els.password.value;

  if (!username || !displayName || !email || !password) {
    throw new Error("Please fill in all fields");
  }
  if (username.length < 3 || username.length > 30) {
    throw new Error("Username must be 3–30 characters");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  let uid;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    uid = cred.user.uid;
  } catch (err) {
    if (err.code !== "auth/email-already-in-use") throw err;

    // The Auth account for this email still exists — most likely one of the
    // old accounts whose Firestore profile was deleted without deleting the
    // Auth record itself. If the password just typed matches it, recover
    // the account with a brand-new ID code instead of blocking sign-up.
    // If it doesn't match, this is a genuinely different, still-active
    // account and we shouldn't silently take it over.
    let cred;
    try {
      cred = await signInWithEmailAndPassword(auth, email, password);
    } catch (_) {
      throw new Error("That email already has an account. Sign in instead, or use a different email.");
    }
    uid = cred.user.uid;

    const existing = await getProfile(uid).catch(() => null);
    if (existing) {
      // Fully intact account after all — nothing to recover, just sign them in.
      saveSession(uid, email, existing.username, existing.displayName, existing.idCode);
      window.location.href = "chat.html";
      return;
    }
    // Auth record survived but the profile doc is gone — fall through and
    // provision a brand-new profile + ID code below, using the username and
    // display name from this registration form.
  }

  const publicKeyBase64 = await getOrCreatePublicKeyBase64();

  const profile = {
    uid,
    username,
    displayName,
    publicKeyBase64,
    fcmToken: "", // web has no push token; kept for schema parity
    createdAt: Date.now(),
    lastSeen: Date.now(),
    isOnline: true,
  };

  const idCode = await createAccountAtomically(profile);
  saveSession(uid, email, username, displayName, idCode);
  window.location.href = "chat.html";
}

// ─── Google Sign-In (Section 3 — auth upgrade) ────────────────────────────
// One popup handles both first-time sign-up AND returning sign-in: if the
// Firestore /users/{uid} doc doesn't exist yet, we create it here exactly
// like doRegister() does for email/password, so both paths converge on the
// same profile shape the Android app expects.

els.google.addEventListener("click", async () => {
  setError("");
  setLoading(true);
  try {
    const cred = await signInWithPopup(auth, googleProvider);
    const uid = cred.user.uid;

    let profile;
    try {
      profile = await getProfile(uid);
      if (!profile.idCode) {
        try {
          profile.idCode = await ensureIdCode(uid);
        } catch (_) {}
      }
    } catch (_) {
      // First time signing in with this Google account — provision a profile.
      const displayName = cred.user.displayName || "New user";
      const username = await uniqueUsernameFromGoogle(cred.user);
      const publicKeyBase64 = await getOrCreatePublicKeyBase64();
      const newProfile = {
        uid,
        username,
        displayName,
        publicKeyBase64,
        fcmToken: "",
        createdAt: Date.now(),
        lastSeen: Date.now(),
        isOnline: true,
      };
      const idCode = await createAccountAtomically(newProfile);
      profile = { ...newProfile, idCode };
    }

    await getOrCreatePublicKeyBase64();
    saveSession(uid, cred.user.email, profile.username, profile.displayName, profile.idCode);
    window.location.href = "chat.html";
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") setError(friendlyError(err));
  } finally {
    setLoading(false);
  }
});

async function uniqueUsernameFromGoogle(user) {
  const base = (user.email ? user.email.split("@")[0] : user.displayName || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24) || "user";
  const suffix = Math.floor(1000 + Math.random() * 9000);
  const candidate = `${base}${suffix}`;
  return candidate.length >= 3 ? candidate : `user${suffix}`;
}

function saveSession(uid, email, username, displayName, idCode) {
  localStorage.setItem(
    "vc_session",
    JSON.stringify({ uid, email, username, displayName, idCode })
  );
}

function setError(msg) {
  els.error.textContent = msg;
  els.error.classList.toggle("hidden", !msg);
}

function setLoading(loading) {
  els.submit.disabled = loading;
  els.submit.textContent = loading
    ? "Please wait…"
    : isLoginMode
    ? "Sign in"
    : "Sign up";
}

function friendlyError(err) {
  const code = err.code || "";
  if (code.includes("email-already-in-use")) return "That email is already registered.";
  if (code.includes("invalid-email")) return "Please enter a valid email address.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential"))
    return "Incorrect email or password.";
  if (code.includes("network-request-failed")) return "Network error — check your connection.";
  if (code.includes("account-exists-with-different-credential"))
    return "That email is already registered with a password — sign in that way instead.";
  if (code.includes("popup-blocked")) return "Your browser blocked the Google sign-in popup — allow popups and try again.";
  return err.message || "Something went wrong — please try again.";
}
