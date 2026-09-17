# SwiftCopy

A fast local file transfer app with a Windows 2000-era dual-pane UI.
Rust backend (Tauri v2), zero-build static HTML/CSS/JS frontend.

## Why it's faster than Explorer

The copy engine (`src-tauri/src/fs_ops.rs`) tries three paths in order:

1. **Reflink / copy-on-write** — btrfs, xfs (with reflinks), APFS, ReFS. Instant, regardless of file size, same-volume only.
2. **OS fast path** for files < 8 MiB — `std::fs::copy` maps to `copy_file_range` / `sendfile` on Linux and `CopyFileEx` on Windows.
3. **Streaming path** for large files — 4 MiB buffers (Explorer uses ~64 KiB), pre-allocated destination via `set_len` to avoid extent fragmentation, and `posix_fadvise(SEQUENTIAL)` on Unix.

On top of that the job manager (`src-tauri/src/jobs.rs`) runs up to 4 files in parallel via Rayon, throttled to 4 so USB sticks don't thrash.

Moves prefer `rename()` (O(1) same-volume) before falling back to copy-then-delete.

## Layout

```
src/                  Frontend (static, no bundler)
  index.html
  styles.css          Real Win9x/2000 bevels + focus dots
  main.js             Uses Tauri globals (withGlobalTauri)
  icons/*.svg
src-tauri/            Rust backend
  src/main.rs         Tauri commands
  src/listing.rs      Directory reads, drives
  src/fs_ops.rs       Copy engine
  src/jobs.rs         Job manager, progress events
  tauri.conf.json
  capabilities/default.json
```

## Running

Prerequisites: Rust (stable) and the Tauri v2 system deps for your OS
(webview2 on Windows; webkit2gtk on Linux; nothing extra on macOS).

```bash
# Install the Tauri CLI once
npm install
# Dev mode with hot-reload
npm run dev
# Release build (produces a native installer)
npm run build
```

The Rust `[profile.release]` block enables LTO + single-codegen-unit for the smallest, fastest binary.

## Keyboard

| Key   | Action                     |
|-------|----------------------------|
| F5    | Refresh both panes         |
| F6/Tab| Switch active pane         |
| F7    | New folder                 |
| F8    | Copy selection to other pane |
| F9    | Move selection to other pane |
| Del   | Delete selection           |

## Notes

- Cross-filesystem moves fall back to copy + delete; a rename on the same volume is instant.
- Reflink support depends on filesystem AND kernel; SwiftCopy silently falls back if the reflink call fails, so nothing breaks on ext4 / FAT / exFAT.
- Progress events are throttled to 20 Hz, so the UI stays snappy even when copying 100k small files.
