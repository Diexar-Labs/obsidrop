const $ = (id) => document.getElementById(id);
const els = {
  port: $("port"),
  token: $("token"),
  paste: $("paste"),
  test: $("test"),
  save: $("save"),
  status: $("status"),
};

async function load() {
  const { port = 27124, token = "" } = await chrome.storage.local.get(["port", "token"]);
  els.port.value = port;
  els.token.value = token;
}

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.style.color = ok === undefined
    ? "var(--muted)"
    : ok ? "var(--fg)" : "var(--danger-border)";
  els.status.style.fontWeight = ok === false ? "600" : "normal";
}

async function save() {
  const port = parseInt(els.port.value, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    setStatus("Invalid port (1024–65535)", false);
    return;
  }
  await chrome.storage.local.set({
    port,
    token: els.token.value.trim(),
  });
  setStatus("Saved.", true);
}

async function test() {
  const port = parseInt(els.port.value, 10);
  if (!Number.isFinite(port)) { setStatus("Invalid port", false); return; }
  setStatus("Testing…");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: "GET",
      headers: { Authorization: `Bearer ${els.token.value.trim()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.app === "obsidrop") {
      setStatus("Connection OK — ObsiDrop is running.", true);
    } else {
      setStatus("Reached server, but it's not ObsiDrop.", false);
    }
  } catch (e) {
    setStatus(`Cannot reach plugin: ${e.message || e}`, false);
  }
}

els.save.addEventListener("click", () => { void save(); });
els.test.addEventListener("click", () => { void test(); });
els.paste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) els.token.value = text.trim();
  } catch {
    setStatus("Clipboard read denied — paste manually.", false);
  }
});

void load();
