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
use std::time::Duration;

// We used to hand-roll a streaming copy for large files. That was actually
// slower than the OS native path because our read/write loop was synchronous
// (read → write → read → write) whereas CopyFileEx on Windows and
// copy_file_range on Linux overlap I/O. Now we always call `fs::copy` and
// track progress by polling the destination file's size in a background
// thread.
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

    // Native OS copy path. On Windows this calls CopyFileExW (async overlapped
    // I/O, adaptive buffering); on Linux it uses copy_file_range/sendfile.
    // Both beat any hand-rolled read/write loop for large files.
    let done_signal = Arc::new(AtomicBool::new(false));
    let poller_bytes = ctx.bytes_done.clone();
    let poller_dest = final_dest.clone();
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
        // Final reconciliation: make sure bytes_done reflects the full file
        // size, in case fs::copy finished before our last poll.
        if let Ok(md) = fs::metadata(&poller_dest) {
            let now = md.len();
            if now > last {
                poller_bytes.fetch_add(now - last, Ordering::Relaxed);
            }
        }
    });

    let copy_result = fs::copy(src, &final_dest)
        .with_context(|| format!("copy {} -> {}", src.display(), final_dest.display()));
    done_signal.store(true, Ordering::Relaxed);
    let _ = poller.join();

    // Honor a job-level cancel: if the user cancelled during this file,
    // remove the partial destination and report cancellation.
    if ctx.cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&final_dest);
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
