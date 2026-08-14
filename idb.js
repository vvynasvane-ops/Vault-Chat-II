// js/idb.js
//
// Minimal IndexedDB wrapper. Plays the same role Room/SQLite plays on
// Android: local, persistent storage for your keypair, decrypted message
// history, media blobs, wallpapers, and appearance settings, so nothing
// readable ever has to live in Firebase.
//
// Object stores:
//   keys          - your X25519 CryptoKey pair (structured-clone persisted)
//   sessionKeys   - derived AES-GCM shared keys per contact uid
//   messages      - decrypted local message history, keyed by messageId,
//                   indexed by conversationId (mirrors Room's Message table +
//                   edit/delete tombstone/pin columns — see Section 5/6/14
//                   of the Feature Overview: schema changes are additive,
//                   non-destructive upgrades, never a wipe-and-restart)
//   contactsCache - last-known contact profiles
//   media         - decrypted media Blobs, keyed by messageId (Section 7)
//   wallpapers    - per-conversation / home-screen background Blobs,
//                   keyed by "home" or a conversationId (Section 8/9)
//   settings      - single-row app settings: theme, fonts, contact prefs
//                   (favorite/mute), keyed by string ids (Section 10/11)
//
// DB_VERSION bumps are additive only — onupgradeneeded only ever *adds*
// stores/indexes it doesn't find, it never deletes or recreates an
// existing one, so upgrading the app never loses a user's local data
// (Section 14 — "Database migrations are non-destructive").

const DB_NAME = "vaultchatt_web";
const DB_VERSION = 2;

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
      // v2 additions — media, wallpapers, settings (Sections 7, 8, 9, 10, 11)
      if (!dbi.objectStoreNames.contains("media")) {
        dbi.createObjectStore("media"); // key: messageId, value: Blob
      }
      if (!dbi.objectStoreNames.contains("wallpapers")) {
        dbi.createObjectStore("wallpapers"); // key: "home" | conversationId
      }
      if (!dbi.objectStoreNames.contains("settings")) {
        dbi.createObjectStore("settings"); // key: string id, value: object
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
    const names = ["keys", "sessionKeys", "messages", "contactsCache", "media", "wallpapers", "settings"];
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
