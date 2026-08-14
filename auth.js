// js/auth.js — logic for index.html (login / register)
// Mirrors ui/activities/AuthActivity.java

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase-config.js";
import {
  createAccountAtomically,
  getProfile,
  ensureIdCode,
} from "./firestore-api.js";
import { getOrCreatePublicKeyBase64 } from "./crypto.js";

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

  let profile;
  try {
    profile = await getProfile(uid);
  } catch (e) {
    await auth.signOut();
    throw new Error("Couldn't load your profile — please try signing in again.");
  }

  if (!profile.idCode) {
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

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

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
  return err.message || "Something went wrong — please try again.";
}
