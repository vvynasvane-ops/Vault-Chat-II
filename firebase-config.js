// js/firebase-config.js
//
// Firebase bootstrap for the VaultChatt II web client.
// This talks to the SAME Firebase project as the Android app, so accounts,
// contacts, and messages sync live across both.
//
// HOW TO FILL THIS IN: see FIRESTORE_SETUP.md, section "2. Register a Web App".
// Everything here EXCEPT apiKey / appId comes straight from your existing
// Android project (vault-chatt-ii), so those are pre-filled for you.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

 const firebaseConfig = {
    apiKey: "AIzaSyCwrBPybpiCQ-MJTFx3JizMOhWN-YeUxKs",
    authDomain: "vault-chatt-ii.firebaseapp.com",
    databaseURL: "https://vault-chatt-ii-default-rtdb.firebaseio.com",
    projectId: "vault-chatt-ii",
    storageBucket: "vault-chatt-ii.firebasestorage.app",
    messagingSenderId: "732391842107",
    appId: "1:732391842107:web:7c110db8c403dac951d71e",
    measurementId: "G-N9MRTW0CSL"
  };

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

// Keep the user signed in across tabs/reloads, same as the Android app keeping
// a session in SharedPreferences.
setPersistence(auth, browserLocalPersistence);
