// Tauri v2 exposes its API as globals when `withGlobalTauri` is enabled.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ────────── State ──────────
const state = {
  panes: {
    left:  { path: "", entries: [], selection: new Set(), sort: { key: "name", dir: 1 } },
    right: { path: "", entries: [], selection: new Set(), sort: { key: "name", dir: 1 } },
  },
  active: "left",
  showHidden: false,
  jobId: null,
};

const paneEl = (id) => document.querySelector(`.pane[data-pane="${id}"]`);
const other = (id) => (id === "left" ? "right" : "left");

// ────────── Formatting ──────────
function fmtSize(n) {
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : i < 2 ? 1 : 2)} ${u[i]}`;
}
function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSpeed(bps) {
  return `${fmtSize(bps)}/s`;
}
function fmtEta(s) {
  if (!s || !isFinite(s)) return "ETA —";
  if (s < 60) return `ETA ${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `ETA ${m}m ${String(sec).padStart(2,"0")}s`;
  const h = Math.floor(m / 60);
  return `ETA ${h}h ${String(m % 60).padStart(2,"0")}m`;
}
function typeLabel(entry) {
  if (entry.is_dir) return "Folder";
  if (!entry.ext) return "File";
  return `${entry.ext.toUpperCase()} file`;
}
function iconClass(entry) {
  if (entry.is_dir) return "folder";
  const e = entry.ext;
  if (["png","jpg","jpeg","gif","bmp","webp","tif","tiff","svg","ico"].includes(e)) return "image";
  if (["zip","rar","7z","tar","gz","bz2","xz"].includes(e)) return "archive";
  if (["exe","msi","app","bat","cmd","sh"].includes(e)) return "exec";
  if (["js","ts","rs","py","c","cpp","h","java","go","html","css","json","xml","yaml","yml","md","toml"].includes(e)) return "code";
  return "file";
}

// ────────── Loading ──────────
async function loadPane(id, path) {
  const p = state.panes[id];
  try {
    const entries = await invoke("cmd_list_dir", { path, showHidden: state.showHidden });
    p.path = path;
    p.entries = entries;
    p.selection.clear();
    sortEntries(p);
    renderList(id);
    paneEl(id).querySelector(".path-input").value = path;
    setFooter(`${entries.length} items in ${path}`);
  } catch (e) {
    setFooter(`Error: ${e}`);
  }
}
async function refresh(id) { await loadPane(id, state.panes[id].path); }

function sortEntries(p) {
  const { key, dir } = p.sort;
  p.entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    switch (key) {
      case "size": cmp = a.size - b.size; break;
      case "type": cmp = (a.ext || "").localeCompare(b.ext || ""); break;
      case "date": cmp = a.modified_ms - b.modified_ms; break;
      default:     cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    return cmp * dir;
  });
}

// ────────── Rendering ──────────
function renderList(id) {
  const p = state.panes[id];
  const tbody = paneEl(id).querySelector("tbody");
  const frag = document.createDocumentFragment();
  p.entries.forEach((e, idx) => {
    const tr = document.createElement("tr");
    tr.className = "row" + (p.selection.has(idx) ? " selected" : "");
    tr.dataset.idx = idx;
    tr.innerHTML = `
      <td><span class="icon ${iconClass(e)}"></span>${escapeHtml(e.name)}</td>
      <td class="size">${e.is_dir ? "" : fmtSize(e.size)}</td>
      <td>${typeLabel(e)}</td>
      <td>${fmtDate(e.modified_ms)}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.replaceChildren(frag);
  paneEl(id).querySelector(".sb-count").textContent = `${p.entries.length} items`;
  paneEl(id).querySelector(".sb-selection").textContent = `${p.selection.size} selected`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ────────── Selection & navigation ──────────
let lastClicked = { left: null, right: null };
function onRowMouseDown(id, ev) {
  const tr = ev.target.closest("tr.row");
  if (!tr) return;
  activatePane(id);
  const idx = Number(tr.dataset.idx);
  const p = state.panes[id];
  if (ev.shiftKey && lastClicked[id] != null) {
    const a = Math.min(lastClicked[id], idx), b = Math.max(lastClicked[id], idx);
    p.selection.clear();
    for (let i = a; i <= b; i++) p.selection.add(i);
  } else if (ev.ctrlKey || ev.metaKey) {
    if (p.selection.has(idx)) p.selection.delete(idx); else p.selection.add(idx);
    lastClicked[id] = idx;
  } else {
    p.selection.clear();
    p.selection.add(idx);
    lastClicked[id] = idx;
  }
  renderList(id);
}
async function onRowDblClick(id, ev) {
  const tr = ev.target.closest("tr.row");
  if (!tr) return;
  const idx = Number(tr.dataset.idx);
  const entry = state.panes[id].entries[idx];
  if (entry.is_dir) await loadPane(id, entry.path);
}
function activatePane(id) {
  state.active = id;
  document.querySelectorAll(".pane").forEach((el) => el.classList.remove("active"));
  paneEl(id).classList.add("active");
}
async function goUp(id) {
  const p = state.panes[id].path;
  if (!p) return;
  const sep = p.includes("\\") && !p.startsWith("/") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 1) {
    // On Unix, "/" is root; on Windows fall back to drive root.
    await loadPane(id, sep === "/" ? "/" : parts[0] + sep);
    return;
  }
  parts.pop();
  const up = (sep === "/" ? "/" : "") + parts.join(sep) + (sep === "\\" ? "\\" : "");
  await loadPane(id, up || "/");
}

// ────────── Drives ──────────
async function refreshDrives() {
  try {
    const drives = await invoke("cmd_list_drives");
    for (const id of ["left", "right"]) {
      const row = paneEl(id).querySelector(".drives-row");
      row.innerHTML = "";
      drives.forEach((d) => {
        const chip = document.createElement("button");
        chip.className = "drive-chip";
        const free = fmtSize(d.available), total = fmtSize(d.total);
        chip.title = `${d.path}  —  ${free} free of ${total}`;
        chip.textContent = d.path;
        chip.addEventListener("click", () => loadPane(id, d.path));
        row.appendChild(chip);
      });
    }
  } catch (e) {
    console.warn("drives", e);
  }
}

// ────────── Operations ──────────
async function beginTransfer(mode) {
  const src = state.active;
  const dst = other(src);
  const p = state.panes[src];
  const dest = state.panes[dst].path;
  if (!dest) { setFooter("Set a destination path in the other pane first."); return; }
  const sources = [...p.selection].map((i) => p.entries[i].path);
  if (sources.length === 0) { setFooter("Nothing selected."); return; }
  const conflict = document.querySelector("#sel-conflict").value;
  openProgress(mode);
  state.jobId = await invoke("cmd_start_transfer", { sources, destination: dest, mode, conflict });
}

async function doDelete() {
  const id = state.active;
  const p = state.panes[id];
  const paths = [...p.selection].map((i) => p.entries[i].path);
  if (paths.length === 0) return;
  const ok = await confirmPrompt("Delete", `Delete ${paths.length} item(s)? This cannot be undone.`);
  if (!ok) return;
  try {
    await invoke("cmd_delete", { paths });
    await refresh(id);
    setFooter(`Deleted ${paths.length} item(s).`);
  } catch (e) { setFooter(`Delete failed: ${e}`); }
}

async function doMkdir() {
  const id = state.active;
  const name = await textPrompt("New Folder", "Folder name:");
  if (!name) return;
  try {
    await invoke("cmd_mkdir", { parent: state.panes[id].path, name });
    await refresh(id);
  } catch (e) { setFooter(`mkdir failed: ${e}`); }
}

// ────────── Progress dialog ──────────
const progEls = {
  shade: document.querySelector("#modal-shade"),
  current: document.querySelector("#prog-current"),
  fill: document.querySelector("#prog-fill"),
  pct: document.querySelector("#prog-percent"),
  speed: document.querySelector("#prog-speed"),
  eta: document.querySelector("#prog-eta"),
  files: document.querySelector("#prog-files"),
  cancel: document.querySelector("#prog-cancel"),
  close: document.querySelector("#prog-close"),
  title: document.querySelector(".w9x-title"),
};
function openProgress(mode) {
  progEls.shade.hidden = false;
  progEls.title.textContent = mode === "move" ? "Moving…" : "Copying…";
  progEls.current.textContent = "Preparing…";
  progEls.fill.style.width = "0%";
  progEls.pct.textContent = "0%";
  progEls.speed.textContent = "— MB/s";
  progEls.eta.textContent = "ETA —";
  progEls.files.textContent = "0/0 files";
  progEls.cancel.textContent = "Cancel";
}
function closeProgress() { progEls.shade.hidden = true; state.jobId = null; }

progEls.cancel.addEventListener("click", async () => {
  if (state.jobId) await invoke("cmd_cancel", { id: state.jobId });
  progEls.cancel.textContent = "Cancelling…";
});
progEls.close.addEventListener("click", closeProgress);

listen("swiftcopy://progress", async (e) => {
  const p = e.payload;
  if (state.jobId && p.id !== state.jobId) return;
  const total = p.bytes_total || 1;
  const pct = Math.min(100, Math.round((p.bytes_done / total) * 100));
  progEls.fill.style.width = `${pct}%`;
  progEls.pct.textContent = `${pct}%`;
  progEls.speed.textContent = fmtSpeed(p.bytes_per_sec);
  progEls.eta.textContent = fmtEta(p.eta_secs);
  progEls.files.textContent = `${p.files_done}/${p.files_total} files`;
  if (p.current) progEls.current.textContent = p.current;
  if (p.done) {
    progEls.fill.style.width = "100%";
    progEls.pct.textContent = "100%";
    progEls.cancel.textContent = "Close";
    if (p.error) {
      setFooter(`Transfer failed: ${p.error}`);
    } else if (p.cancelled) {
      setFooter("Transfer cancelled.");
    } else {
      setFooter(`Done. ${p.files_done} file(s), ${fmtSize(p.bytes_done)}.`);
    }
    // Refresh both panes so the user sees the result.
    await refresh("left"); await refresh("right");
    // Wait for user to dismiss (change cancel to close).
    progEls.cancel.onclick = closeProgress;
  }
});

// ────────── Modal prompts ──────────
const prompt = {
  shade: document.querySelector("#prompt-shade"),
  msg: document.querySelector("#prompt-msg"),
  input: document.querySelector("#prompt-input"),
  ok: document.querySelector("#prompt-ok"),
  cancel: document.querySelector("#prompt-cancel"),
  title: document.querySelector("#prompt-title"),
};
function textPrompt(title, msg) {
  return new Promise((resolve) => {
    prompt.title.textContent = title;
    prompt.msg.textContent = msg;
    prompt.input.value = "";
    prompt.input.style.display = "";
    prompt.shade.hidden = false;
    setTimeout(() => prompt.input.focus(), 0);
    const done = (val) => { prompt.shade.hidden = true; cleanup(); resolve(val); };
    const onOk = () => done(prompt.input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (ev) => { if (ev.key === "Enter") onOk(); if (ev.key === "Escape") onCancel(); };
    const cleanup = () => {
      prompt.ok.removeEventListener("click", onOk);
      prompt.cancel.removeEventListener("click", onCancel);
      prompt.input.removeEventListener("keydown", onKey);
    };
    prompt.ok.addEventListener("click", onOk);
    prompt.cancel.addEventListener("click", onCancel);
    prompt.input.addEventListener("keydown", onKey);
  });
}
function confirmPrompt(title, msg) {
  return new Promise((resolve) => {
    prompt.title.textContent = title;
    prompt.msg.textContent = msg;
    prompt.input.style.display = "none";
    prompt.shade.hidden = false;
    const done = (val) => { prompt.shade.hidden = true; prompt.input.style.display = ""; cleanup(); resolve(val); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const cleanup = () => {
      prompt.ok.removeEventListener("click", onOk);
      prompt.cancel.removeEventListener("click", onCancel);
    };
    prompt.ok.addEventListener("click", onOk);
    prompt.cancel.addEventListener("click", onCancel);
  });
}

// ────────── Footer ──────────
function setFooter(msg) { document.querySelector("#footer-status").textContent = msg; }

// ────────── Wire up ──────────
function wirePane(id) {
  const el = paneEl(id);
  const listing = el.querySelector(".listing");
  const tbody = el.querySelector("tbody");
  tbody.addEventListener("mousedown", (ev) => onRowMouseDown(id, ev));
  tbody.addEventListener("dblclick", (ev) => onRowDblClick(id, ev));
  listing.addEventListener("focus", () => activatePane(id));
  el.addEventListener("mousedown", () => activatePane(id));

  el.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const p = state.panes[id];
      const k = th.dataset.sort;
      if (p.sort.key === k) p.sort.dir *= -1; else { p.sort.key = k; p.sort.dir = 1; }
      sortEntries(p); renderList(id);
    });
  });
  el.querySelector('[data-pane-btn="up"]').addEventListener("click", () => goUp(id));
  el.querySelector('[data-pane-btn="home"]').addEventListener("click", async () => {
    const h = await invoke("cmd_home_dirs");
    if (h.home) loadPane(id, h.home);
  });
  const input = el.querySelector(".path-input");
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") loadPane(id, input.value.trim());
  });
}

document.querySelector("#btn-copy").addEventListener("click", () => beginTransfer("copy"));
document.querySelector("#btn-move").addEventListener("click", () => beginTransfer("move"));
document.querySelector("#btn-delete").addEventListener("click", doDelete);
document.querySelector("#btn-mkdir").addEventListener("click", doMkdir);
document.querySelector("#btn-refresh").addEventListener("click", async () => {
  await refresh("left"); await refresh("right"); await refreshDrives();
});
document.querySelector("#chk-hidden").addEventListener("change", async (ev) => {
  state.showHidden = ev.target.checked;
  await refresh("left"); await refresh("right");
});

// Keyboard shortcuts
window.addEventListener("keydown", (ev) => {
  if (ev.key === "F5") { refresh("left"); refresh("right"); ev.preventDefault(); }
  else if (ev.key === "F6" || ev.key === "Tab") {
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      activatePane(other(state.active));
      paneEl(state.active).querySelector(".listing").focus();
      ev.preventDefault();
    }
  } else if (ev.key === "Delete") { doDelete(); }
  else if (ev.key === "F7") { doMkdir(); }
  else if (ev.key === "F8") { beginTransfer("copy"); }
  else if (ev.key === "F9") { beginTransfer("move"); }
});

// Init
(async function init() {
  wirePane("left"); wirePane("right");
  activatePane("left");
  const h = await invoke("cmd_home_dirs");
  const start = h.home || "/";
  await loadPane("left", start);
  await loadPane("right", h.documents || start);
  await refreshDrives();
})();
