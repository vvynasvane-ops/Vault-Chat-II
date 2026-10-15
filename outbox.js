// outbox.js — the send queue behind "resend messages that couldn't go out".
//
// A message you send is ALWAYS saved locally first (so it shows up in the
// chat at once). Then we try to transmit it:
//   • offline / timed out        → status QUEUED  (sends itself when back online)
//   • rejected by the server     → status FAILED  (tap ⚠ to retry)
//   • accepted                   → status SENT
//
// The same messageId is reused on every retry, so a retry can never create a
// second copy: the relay path is keyed by messageId, and the receiving side
// ignores ids it already holds.
//
// This file has no Firebase in it: the real network call (`transmit`) and the
// connectivity check (`isOnline`) are injected by messaging.js, which keeps
// the queue logic small, predictable and unit-testable.

import { idb } from "./idb.js";

export const PENDING_STATUSES = ["QUEUED", "FAILED"];
const DONE_STATUSES = ["SENT", "DELIVERED", "READ"];
const AUTO_MAX_ATTEMPTS = 6; // automatic retries per message (manual taps always work)

export function isPendingStatus(status) {
  return PENDING_STATUSES.includes(status);
}

export function createOutbox({
  transmit, // async (storedMessage, ctx) => void  — throws on failure
  isOnline = () => true,
  onStatus = () => {},
  timeoutText = 12000,
  timeoutMedia = 60000,
}) {
  const inflight = new Set(); // messageIds being transmitted right now
  let flushing = false;

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("Timed out waiting for the network");
        err.code = "TIMEOUT";
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Try to send one stored message. Returns the stored message afterwards
  // (or null if it vanished / is already being sent).
  async function attempt(messageId, ctx, { manual = false } = {}) {
    // Reserve the id BEFORE any await, so double-taps can't start two sends.
    if (inflight.has(messageId)) return null;
    inflight.add(messageId);
    try {
      const first = await idb.get("messages", messageId);
      if (!first) return null;
      if (!first.isSentByMe || first.deletedForEveryone) return first;
      if (DONE_STATUSES.includes(first.status)) return first; // already out

      let status = "QUEUED";
      let error = "";
      try {
        first.status = "SENDING";
        first.attempts = manual ? 1 : (first.attempts || 0) + 1;
        await idb.put("messages", first);
        onStatus(first);

        if (isOnline()) {
          try {
            await withTimeout(
              transmit(first, ctx),
              first.messageType === "TEXT" ? timeoutText : timeoutMedia
            );
            status = "SENT";
          } catch (err) {
            error = String((err && err.message) || err);
            status = (err && err.code === "TIMEOUT") || !isOnline() ? "QUEUED" : "FAILED";
          }
        }
      } catch (err) {
        error = String((err && err.message) || err); // storage hiccup: keep it queued
      }

      // Re-read: the person may have edited, deleted or been acked meanwhile.
      const fresh = await idb.get("messages", messageId);
      if (!fresh) return null; // deleted while sending — never resurrect it
      if (["DELIVERED", "READ"].includes(fresh.status)) return fresh; // never downgrade
      fresh.status = status;
      fresh.lastError = error;
      fresh.lastAttempt = Date.now();
      await idb.put("messages", fresh);
      onStatus(fresh);
      return fresh;
    } finally {
      inflight.delete(messageId);
    }
  }

  // Sent messages left in "SENDING" by a closed tab / crash → back in the queue.
  async function recoverStuck() {
    const all = await idb.getAll("messages");
    let n = 0;
    for (const m of all) {
      if (m.isSentByMe && m.status === "SENDING" && !inflight.has(m.messageId)) {
        m.status = "QUEUED";
        await idb.put("messages", m);
        onStatus(m);
        n++;
      }
    }
    return n;
  }

  async function listPending() {
    const all = await idb.getAll("messages");
    return all
      .filter((m) => m.isSentByMe && !m.deletedForEveryone && isPendingStatus(m.status))
      .sort((a, b) => a.timestamp - b.timestamp); // oldest first: keep conversation order
  }

  async function count() {
    return (await listPending()).length;
  }

  // Send everything that's waiting, oldest first. Stops as soon as the
  // connection drops again so nothing is reordered or burned for nothing.
  async function flush(resolveCtx, { manual = false } = {}) {
    if (flushing) return { sent: 0, left: await count(), busy: true };
    flushing = true;
    let sent = 0;
    try {
      const list = await listPending();
      for (const m of list) {
        if (!isOnline()) break;
        if (!manual && (m.attempts || 0) >= AUTO_MAX_ATTEMPTS) continue;
        const ctx = await resolveCtx(m);
        if (!ctx) continue; // contact gone / key unknown → leave it queued
        const res = await attempt(m.messageId, ctx, { manual });
        if (res && res.status === "SENT") sent++;
        else if (res && res.status === "QUEUED") break; // connection lost mid-flush
      }
    } finally {
      flushing = false;
    }
    return { sent, left: await count(), busy: false };
  }

  return { attempt, recoverStuck, listPending, count, flush, isInflight: (id) => inflight.has(id) };
}
