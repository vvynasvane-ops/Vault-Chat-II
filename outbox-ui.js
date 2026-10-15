// outbox-ui.js — the slim status bar above the chat that tells you what is
// happening with messages that haven't gone out yet, and lets you push them.
//
//   offline + waiting  →  📡 Offline — 3 messages waiting. They'll send automatically…
//   offline, none      →  📡 You're offline — messages you send will be queued…
//   online + waiting   →  📤 2 messages not sent yet            [Send now]
//   just delivered     →  ✓ 3 queued messages sent
//   all clear          →  (hidden)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function setupOutboxBar({ bar, icon, text, sendBtn, getPending, isOnline, onSendNow }) {
  if (!bar || !icon || !text || !sendBtn) return { refresh() {}, flash() {} };

  let timer = null;
  let flashUntil = 0;
  let busy = false;

  async function render() {
    if (Date.now() < flashUntil) return; // a success flash is showing
    let n = 0;
    try {
      n = await getPending();
    } catch (_) {}
    const online = isOnline();

    bar.classList.remove("ok", "offline", "pending");
    sendBtn.classList.add("hidden");

    if (!online) {
      bar.classList.remove("hidden");
      bar.classList.add("offline");
      icon.textContent = "📡";
      text.textContent =
        n > 0
          ? `Offline — ${plural(n, "message", "messages")} waiting. ${n === 1 ? "It" : "They"}'ll send automatically when you're back online.`
          : "You're offline — messages you send will be queued and sent automatically.";
    } else if (n > 0) {
      bar.classList.remove("hidden");
      bar.classList.add("pending");
      icon.textContent = "📤";
      text.textContent = `${plural(n, "message", "messages")} not sent yet.`;
      sendBtn.classList.remove("hidden");
      sendBtn.disabled = busy;
      sendBtn.textContent = busy ? "Sending…" : "Send now";
    } else {
      bar.classList.add("hidden");
    }
  }

  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  }

  function flash(message) {
    flashUntil = Date.now() + 2600;
    bar.classList.remove("hidden", "offline", "pending");
    bar.classList.add("ok");
    sendBtn.classList.add("hidden");
    icon.textContent = "✓";
    text.textContent = message;
    setTimeout(refresh, 2700);
  }

  sendBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      await onSendNow();
    } finally {
      busy = false;
      refresh();
    }
  });

  refresh();
  return { refresh, flash };
}
