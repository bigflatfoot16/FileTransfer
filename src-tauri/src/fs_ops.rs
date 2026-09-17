//! Fast filesystem operations.
//!
//! Strategy for maximum throughput:
//! - Try `reflink` for instant same-filesystem CoW copies (btrfs/xfs/APFS/ReFS).
//! - Fall back to `std::fs::copy`, which internally uses `copy_file_range`/`sendfile`
//!   on Linux and `CopyFileEx` on Windows.
//! - For very large files we prefer a manual 4 MiB buffered path so we can
//!   emit progress; the OS-level fast path takes precedence only when we
//!   don't need per-byte progress ticks (small files).

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(not(windows))]
use std::time::Duration;

// Windows uses CopyFileExW with a real progress callback (no polling).
// Other platforms poll the destination file's size while std::fs::copy runs.
#[cfg(not(windows))]
const PROGRESS_POLL: Duration = Duration::from_millis(80);

#[derive(Copy, Clone, Debug)]
pub enum ConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

pub struct CopyContext {
    pub cancel: Arc<AtomicBool>,
    pub bytes_done: Arc<AtomicU64>,
}

/// Copy a single file, applying the conflict policy and hinting the OS for
/// sequential I/O. Returns bytes copied (0 if skipped).
pub fn copy_file(
    src: &Path,
    dest: &Path,
    policy: ConflictPolicy,
    ctx: &CopyContext,
) -> Result<u64> {
    let final_dest = match resolve_conflict(dest, policy)? {
        Some(p) => p,
        None => return Ok(0), // skipped
    };

    if let Some(parent) = final_dest.parent() {
        fs::create_dir_all(parent).ok();
    }

    let src_size = fs::metadata(src)
        .with_context(|| format!("stat {}", src.display()))?
        .len();

    // Fast path 1: reflink (instant on supporting filesystems: ReFS, btrfs,
    // xfs with reflinks, APFS). Skipped silently on NTFS.
    if reflink_copy::reflink(src, &final_dest).is_ok() {
        ctx.bytes_done.fetch_add(src_size, Ordering::Relaxed);
        return Ok(src_size);
    }

    // Windows: use CopyFileExW directly so we can pass COPY_FILE_NO_BUFFERING
    // (Explorer does; std::fs::copy does not) and hook the native progress
    // callback for real-time updates without a separate polling thread.
    #[cfg(windows)]
    {
        return windows_native::copy_file_ex(src, &final_dest, src_size, ctx);
    }
    // Other platforms: std::fs::copy is already optimal (copy_file_range /
    // sendfile on Linux; copyfile() on macOS). Progress is polled from the
    // destination file's size in a background thread.
    #[cfg(not(windows))]
    {
        return unix_copy(src, &final_dest, ctx);
    }
}

#[cfg(not(windows))]
fn unix_copy(src: &Path, final_dest: &Path, ctx: &CopyContext) -> Result<u64> {
    let done_signal = Arc::new(AtomicBool::new(false));
    let poller_bytes = ctx.bytes_done.clone();
    let poller_dest = final_dest.to_path_buf();
    let poller_done = done_signal.clone();
    let poller = std::thread::spawn(move || {
        let mut last: u64 = 0;
        while !poller_done.load(Ordering::Relaxed) {
            std::thread::sleep(PROGRESS_POLL);
            if let Ok(md) = fs::metadata(&poller_dest) {
                let now = md.len();
                if now > last {
                    poller_bytes.fetch_add(now - last, Ordering::Relaxed);
                    last = now;
                }
            }
        }
        if let Ok(md) = fs::metadata(&poller_dest) {
            let now = md.len();
            if now > last {
                poller_bytes.fetch_add(now - last, Ordering::Relaxed);
            }
        }
    });
    let copy_result = fs::copy(src, final_dest)
        .with_context(|| format!("copy {} -> {}", src.display(), final_dest.display()));
    done_signal.store(true, Ordering::Relaxed);
    let _ = poller.join();
    if ctx.cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(final_dest);
        return Err(anyhow!("cancelled"));
    }
    copy_result
}

/// Try a same-filesystem rename first (instant), then fall back to copy+delete.
pub fn move_file(
    src: &Path,
    dest: &Path,
    policy: ConflictPolicy,
    ctx: &CopyContext,
) -> Result<u64> {
    let final_dest = match resolve_conflict(dest, policy)? {
        Some(p) => p,
        None => return Ok(0),
    };
    if let Some(parent) = final_dest.parent() {
        fs::create_dir_all(parent).ok();
    }
    // Rename is O(1) on same filesystem. Whole-directory move works too.
    if fs::rename(src, &final_dest).is_ok() {
        let size = fs::metadata(&final_dest).map(|m| m.len()).unwrap_or(0);
        ctx.bytes_done.fetch_add(size, Ordering::Relaxed);
        return Ok(size);
    }
    // Cross-device: copy then delete.
    let n = copy_file(src, &final_dest, ConflictPolicy::Overwrite, ctx)?;
    fs::remove_file(src).ok();
    Ok(n)
}

fn resolve_conflict(dest: &Path, policy: ConflictPolicy) -> Result<Option<PathBuf>> {
    if !dest.exists() {
        return Ok(Some(dest.to_path_buf()));
    }
    match policy {
        ConflictPolicy::Overwrite => Ok(Some(dest.to_path_buf())),
        ConflictPolicy::Skip => Ok(None),
        ConflictPolicy::Rename => Ok(Some(unique_path(dest))),
    }
}

fn unique_path(dest: &Path) -> PathBuf {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = dest
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    for i in 2..10_000 {
        let candidate = if ext.is_empty() {
            parent.join(format!("{stem} ({i})"))
        } else {
            parent.join(format!("{stem} ({i}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

// ─── Windows-native copy via CopyFileExW ────────────────────────────────
//
// This is the same underlying call std::fs::copy makes, but we control the
// flags (COPY_FILE_NO_BUFFERING, added in Windows 7) and the progress
// callback. NO_BUFFERING bypasses the Windows cache manager for large
// sequential I/O — the trick FastCopy and TeraCopy use to beat plain
// Explorer copy on huge files.

#[cfg(windows)]
mod windows_native {
    use super::{CopyContext, Result};
    use anyhow::{anyhow, Context};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::CopyFileExW;

    const COPY_FILE_NO_BUFFERING: u32 = 0x0000_1000;
    const PROGRESS_CONTINUE: u32 = 0;
    const PROGRESS_CANCEL: u32 = 1;

    // Files under this size don't benefit from NO_BUFFERING; the cache
    // manager can even help them. Threshold matches what FastCopy uses.
    const NO_BUFFER_THRESHOLD: u64 = 32 * 1024 * 1024; // 32 MiB

    fn to_wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    struct ProgressCtx<'a> {
        ctx: &'a CopyContext,
        last: std::cell::Cell<i64>,
    }

    unsafe extern "system" fn progress_cb(
        _total_file_size: i64,
        total_bytes_transferred: i64,
        _stream_size: i64,
        _stream_bytes_transferred: i64,
        _stream_number: u32,
        _reason: u32,
        _hsource: HANDLE,
        _hdest: HANDLE,
        lpdata: *const std::ffi::c_void,
    ) -> u32 {
        let pctx = &*(lpdata as *const ProgressCtx);
        // User pressed cancel? Ask Windows to abort mid-copy.
        if pctx.ctx.cancel.load(Ordering::Relaxed) {
            return PROGRESS_CANCEL;
        }
        // Report only the DELTA to the shared atomic counter.
        let last = pctx.last.get();
        if total_bytes_transferred > last {
            pctx.ctx
                .bytes_done
                .fetch_add((total_bytes_transferred - last) as u64, Ordering::Relaxed);
            pctx.last.set(total_bytes_transferred);
        }
        PROGRESS_CONTINUE
    }

    pub fn copy_file_ex(
        src: &Path,
        dest: &Path,
        src_size: u64,
        ctx: &CopyContext,
    ) -> Result<u64> {
        let src_w = to_wide(src);
        let dst_w = to_wide(dest);
        let mut cancel_flag: i32 = 0;
        let flags = if src_size >= NO_BUFFER_THRESHOLD {
            COPY_FILE_NO_BUFFERING
        } else {
            0
        };
        let pctx = ProgressCtx { ctx, last: std::cell::Cell::new(0) };

        let ok = unsafe {
            CopyFileExW(
                src_w.as_ptr(),
                dst_w.as_ptr(),
                Some(progress_cb),
                &pctx as *const _ as *const _,
                &mut cancel_flag,
                flags,
            )
        };

        if ctx.cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(dest);
            return Err(anyhow!("cancelled"));
        }
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // Retry without NO_BUFFERING — some filesystems (network shares,
            // exFAT, USB flash) reject unbuffered I/O.
            if flags != 0 {
                let ok2 = unsafe {
                    CopyFileExW(
                        src_w.as_ptr(),
                        dst_w.as_ptr(),
                        Some(progress_cb),
                        &pctx as *const _ as *const _,
                        &mut cancel_flag,
                        0,
                    )
                };
                if ok2 != 0 {
                    return Ok(src_size);
                }
            }
            return Err(err).with_context(|| {
                format!("copy {} -> {}", src.display(), dest.display())
            });
        }
        Ok(src_size)
    }
}

pub fn delete_paths(paths: &[String]) -> Result<()> {
    for p in paths {
        let path = Path::new(p);
        if !path.exists() {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(path)
                .with_context(|| format!("remove_dir_all {}", path.display()))?;
        } else {
            fs::remove_file(path)
                .with_context(|| format!("remove_file {}", path.display()))?;
        }
    }
    Ok(())
}

pub fn mkdir(parent: &str, name: &str) -> Result<String> {
    let p = Path::new(parent).join(name);
    fs::create_dir_all(&p)?;
    Ok(p.to_string_lossy().to_string())
}

pub fn rename(path: &str, new_name: &str) -> Result<String> {
    let src = Path::new(path);
    let dest = src
        .parent()
        .ok_or_else(|| anyhow!("no parent"))?
        .join(new_name);
    fs::rename(src, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}
