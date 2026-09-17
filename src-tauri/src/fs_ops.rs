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
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

const BUF_SIZE: usize = 4 * 1024 * 1024; // 4 MiB - well beyond Explorer's default.
const SMALL_FILE_THRESHOLD: u64 = 8 * 1024 * 1024; // Use OS fast path under this size.

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

    let src_meta = fs::metadata(src).with_context(|| format!("stat {}", src.display()))?;
    let size = src_meta.len();

    // Fast path 1: reflink (instant on supporting filesystems).
    if reflink_copy::reflink(src, &final_dest).is_ok() {
        ctx.bytes_done.fetch_add(size, Ordering::Relaxed);
        return Ok(size);
    }

    // Fast path 2: small file, let the OS handle it (uses copy_file_range/CopyFileEx).
    if size <= SMALL_FILE_THRESHOLD {
        let n = fs::copy(src, &final_dest)
            .with_context(|| format!("copy {} -> {}", src.display(), final_dest.display()))?;
        ctx.bytes_done.fetch_add(n, Ordering::Relaxed);
        return Ok(n);
    }

    // Streaming path: big buffer + progress ticks + cancel checks.
    let mut reader = File::open(src).with_context(|| format!("open {}", src.display()))?;
    hint_sequential(&reader);
    let mut writer = File::create(&final_dest)
        .with_context(|| format!("create {}", final_dest.display()))?;

    // Pre-allocate the destination to avoid fragmentation and fs metadata churn.
    let _ = writer.set_len(size);

    let mut buf = vec![0u8; BUF_SIZE];
    let mut total = 0u64;
    loop {
        if ctx.cancel.load(Ordering::Relaxed) {
            drop(writer);
            let _ = fs::remove_file(&final_dest);
            return Err(anyhow!("cancelled"));
        }
        let n = reader.read(&mut buf).with_context(|| "read")?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).with_context(|| "write")?;
        total += n as u64;
        ctx.bytes_done.fetch_add(n as u64, Ordering::Relaxed);
    }
    writer.flush().ok();
    Ok(total)
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

#[cfg(unix)]
fn hint_sequential(f: &File) {
    use std::os::unix::io::AsRawFd;
    unsafe {
        // POSIX_FADV_SEQUENTIAL = 2
        libc::posix_fadvise(f.as_raw_fd(), 0, 0, 2);
    }
}

#[cfg(windows)]
fn hint_sequential(_f: &File) {
    // Perf delta on NTFS is small next to the buffer-size win — no-op.
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
