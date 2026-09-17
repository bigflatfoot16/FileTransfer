//! Job manager: runs transfer jobs on a worker thread pool, streams progress
//! events to the frontend, and supports cancellation.

use crate::fs_ops::{self, ConflictPolicy, CopyContext};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Copy, Clone)]
pub enum JobKind {
    Copy,
    Move,
}

#[derive(Serialize, Clone)]
pub struct ProgressEvent {
    pub id: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub current: String,
    pub bytes_per_sec: u64,
    pub eta_secs: u64,
    pub elapsed_ms: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

pub struct JobHandle {
    pub id: String,
}

struct JobEntry {
    cancel: Arc<AtomicBool>,
}

pub struct JobManager {
    inner: Mutex<HashMap<String, JobEntry>>,
    counter: AtomicU64,
}

impl JobManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(entry) = self.inner.lock().get(id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        kind: JobKind,
        sources: Vec<String>,
        destination: String,
        conflict: ConflictPolicy,
    ) -> JobHandle {
        let id = format!("job-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner
            .lock()
            .insert(id.clone(), JobEntry { cancel: cancel.clone() });

        let app_clone = app.clone();
        let id_clone = id.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = run_job(app_clone.clone(), id_clone.clone(), kind, sources, destination, conflict, cancel.clone(), started);
            let elapsed_ms = started.elapsed().as_millis() as u64;
            // Emit final event.
            let evt = match result {
                Ok((files, bytes)) => ProgressEvent {
                    id: id_clone.clone(),
                    bytes_done: bytes,
                    bytes_total: bytes,
                    files_done: files,
                    files_total: files,
                    current: String::new(),
                    bytes_per_sec: 0,
                    eta_secs: 0,
                    elapsed_ms,
                    done: true,
                    cancelled: cancel.load(Ordering::Relaxed),
                    error: None,
                },
                Err(e) => ProgressEvent {
                    id: id_clone.clone(),
                    bytes_done: 0,
                    bytes_total: 0,
                    files_done: 0,
                    files_total: 0,
                    current: String::new(),
                    bytes_per_sec: 0,
                    eta_secs: 0,
                    elapsed_ms,
                    done: true,
                    cancelled: cancel.load(Ordering::Relaxed),
                    error: Some(e.to_string()),
                },
            };
            let _ = app_clone.emit("swiftcopy://progress", evt);
        });
        JobHandle { id }
    }
}

/// Walks the source list to build a flat plan, then executes files in parallel.
fn run_job(
    app: AppHandle,
    id: String,
    kind: JobKind,
    sources: Vec<String>,
    destination: String,
    conflict: ConflictPolicy,
    cancel: Arc<AtomicBool>,
    started: Instant,
) -> anyhow::Result<(u64, u64)> {
    let dest_root = PathBuf::from(&destination);
    std::fs::create_dir_all(&dest_root)
        .map_err(|e| anyhow::anyhow!("cannot create destination {}: {}", dest_root.display(), e))?;
    // Canonicalize for a reliable self-copy check.
    let dest_root_canon = std::fs::canonicalize(&dest_root).unwrap_or_else(|_| dest_root.clone());

    // Build plan: (src_file, dest_file, size).
    let mut plan: Vec<(PathBuf, PathBuf, u64)> = Vec::new();
    let mut bytes_total: u64 = 0;

    for src in &sources {
        let src_path = PathBuf::from(src);
        let src_canon = std::fs::canonicalize(&src_path).unwrap_or_else(|_| src_path.clone());
        // Guard: refuse to copy a folder into itself or one of its descendants.
        if src_canon == dest_root_canon || dest_root_canon.starts_with(&src_canon) {
            return Err(anyhow::anyhow!(
                "destination \"{}\" is the same as or inside the source \"{}\"",
                dest_root.display(),
                src_path.display()
            ));
        }
        let base_name = src_path
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_default();
        let dest_top = dest_root.join(&base_name);

        if src_path.is_file() {
            let sz = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
            bytes_total += sz;
            plan.push((src_path.clone(), dest_top, sz));
        } else if src_path.is_dir() {
            for entry in WalkDir::new(&src_path).follow_links(false) {
                let e = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let rel = e.path().strip_prefix(&src_path).unwrap_or(e.path());
                let d = dest_top.join(rel);
                if e.file_type().is_dir() {
                    std::fs::create_dir_all(&d).ok();
                } else if e.file_type().is_file() {
                    let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes_total += sz;
                    plan.push((e.path().to_path_buf(), d, sz));
                }
            }
        }
    }

    let files_total = plan.len() as u64;
    let bytes_done = Arc::new(AtomicU64::new(0));
    let files_done = Arc::new(AtomicU64::new(0));
    let current = Arc::new(Mutex::new(String::new()));

    // Progress emitter thread (20 Hz), stops when done flag flips.
    let done_flag = Arc::new(AtomicBool::new(false));
    let emitter = {
        let app = app.clone();
        let id = id.clone();
        let bytes_done = bytes_done.clone();
        let files_done = files_done.clone();
        let current = current.clone();
        let done_flag = done_flag.clone();
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            let mut last_bytes: u64 = 0;
            let mut last_time = started;
            while !done_flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
                let bd = bytes_done.load(Ordering::Relaxed);
                let now = Instant::now();
                let dt = now.duration_since(last_time).as_secs_f64().max(0.001);
                let bps = (((bd.saturating_sub(last_bytes)) as f64) / dt) as u64;
                let remaining = bytes_total.saturating_sub(bd);
                let eta = if bps > 0 { remaining / bps.max(1) } else { 0 };
                let cur = current.lock().clone();
                let elapsed_ms = started.elapsed().as_millis() as u64;
                let _ = app.emit(
                    "swiftcopy://progress",
                    ProgressEvent {
                        id: id.clone(),
                        bytes_done: bd,
                        bytes_total,
                        files_done: files_done.load(Ordering::Relaxed),
                        files_total,
                        current: cur,
                        bytes_per_sec: bps,
                        eta_secs: eta,
                        elapsed_ms,
                        done: false,
                        cancelled: cancel.load(Ordering::Relaxed),
                        error: None,
                    },
                );
                last_bytes = bd;
                last_time = now;
            }
        })
    };

    let ctx = CopyContext {
        cancel: cancel.clone(),
        bytes_done: bytes_done.clone(),
    };

    // Collect per-file errors instead of aborting on first — a big transfer
    // with a couple of unreadable files is still mostly a success, and the
    // user needs to know exactly which files failed.
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // Parallel workers. Cap at 4 so we don't thrash slow media (USB sticks).
    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build()?;
    pool.install(|| {
        plan.par_iter().for_each(|(src, dest, _sz)| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            {
                let mut c = current.lock();
                *c = src.to_string_lossy().to_string();
            }
            let res = match kind {
                JobKind::Copy => fs_ops::copy_file(src, dest, conflict, &ctx),
                JobKind::Move => fs_ops::move_file(src, dest, conflict, &ctx),
            };
            match res {
                Ok(_) => { files_done.fetch_add(1, Ordering::Relaxed); }
                Err(e) => {
                    errors.lock().push(format!("{}: {}", src.display(), e));
                }
            }
        })
    });

    done_flag.store(true, Ordering::Relaxed);
    let _ = emitter.join();

    // If move-mode, prune now-empty source directories.
    if matches!(kind, JobKind::Move) && !cancel.load(Ordering::Relaxed) {
        for src in &sources {
            let p = Path::new(src);
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }

    let errs = errors.lock();
    if !errs.is_empty() {
        let first = errs.iter().take(3).cloned().collect::<Vec<_>>().join(" | ");
        return Err(anyhow::anyhow!(
            "{} file(s) failed. First: {}",
            errs.len(),
            first
        ));
    }
    Ok((files_done.load(Ordering::Relaxed), bytes_done.load(Ordering::Relaxed)))
}
