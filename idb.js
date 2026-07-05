// js/idb.js
//
// Minimal IndexedDB wrapper. Plays the same role Room/SQLite plays on
// Android: local, persistent storage for your keypair and decrypted message
// history, so nothing readable ever has to live in Firebase.
//
// Three object stores:
//   keys        - your X25519 CryptoKey pair (non-exportable-in-transit; the
//                 CryptoKey objects themselves are stored via structured
//                 clone, which is how the browser is designed to persist them)
//   sessionKeys - derived AES-GCM shared keys per contact uid, so we don't
//                 re-run ECDH on every message
//   messages    - decrypted local message history, keyed by conversationId

const DB_NAME = "vaultchatt_web";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      if (!dbi.objectStoreNames.contains("keys")) {
        dbi.createObjectStore("keys");
      }
      if (!dbi.objectStoreNames.contains("sessionKeys")) {
        dbi.createObjectStore("sessionKeys");
      }
      if (!dbi.objectStoreNames.contains("messages")) {
        const store = dbi.createObjectStore("messages", { keyPath: "messageId" });
        store.createIndex("byConversation", "conversationId");
      }
      if (!dbi.objectStoreNames.contains("contactsCache")) {
        dbi.createObjectStore("contactsCache", { keyPath: "uid" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const dbi = await openDb();
  return new Promise((resolve, reject) => {
    const t = dbi.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export const idb = {
  async put(storeName, value, key) {
    return tx(storeName, "readwrite", (store) => store.put(value, key));
  },
  async get(storeName, key) {
    const dbi = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbi.transaction(storeName, "readonly");
      const req = t.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAll(storeName) {
    const dbi = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbi.transaction(storeName, "readonly");
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAllByIndex(storeName, indexName, value) {
    const dbi = await openDb();
    return new Promise((resolve, reject) => {
      const t = dbi.transaction(storeName, "readonly");
      const req = t.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async delete(storeName, key) {
    return tx(storeName, "readwrite", (store) => store.delete(key));
  },
  async clearAll() {
    const dbi = await openDb();
    const names = ["keys", "sessionKeys", "messages", "contactsCache"];
    return Promise.all(
      names.map(
        (n) =>
          new Promise((resolve, reject) => {
            const t = dbi.transaction(n, "readwrite");
            t.objectStore(n).clear();
            t.oncomplete = resolve;
            t.onerror = () => reject(t.error);
          })
      )
    );
  },
};
