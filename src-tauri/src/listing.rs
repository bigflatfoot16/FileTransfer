use anyhow::Result;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub ext: String,
    pub hidden: bool,
}

pub fn list_dir(path: &str, show_hidden: bool) -> Result<Vec<DirEntryInfo>> {
    let p = Path::new(path);
    let mut out = Vec::new();
    let rd = fs::read_dir(p)?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let hidden = is_hidden(&name, &entry.path());
        if hidden && !show_hidden {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = metadata.file_type().is_symlink();
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let ext = if is_dir {
            String::new()
        } else {
            Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
        };
        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size,
            modified_ms,
            ext,
            hidden,
        });
    }
    // Directories first, then case-insensitive name sort.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[cfg(unix)]
fn is_hidden(name: &str, _p: &Path) -> bool {
    name.starts_with('.')
}

#[cfg(windows)]
fn is_hidden(name: &str, p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    if name.starts_with('.') {
        return true;
    }
    if let Ok(md) = fs::metadata(p) {
        return md.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
    }
    false
}

#[derive(Serialize, Clone)]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    pub total: u64,
    pub available: u64,
    pub kind: String,
}

pub fn list_drives() -> Vec<DriveInfo> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let mut out: Vec<DriveInfo> = disks
        .list()
        .iter()
        .map(|d| {
            let mount = d.mount_point().to_string_lossy().to_string();
            let name = if d.name().is_empty() {
                mount.clone()
            } else {
                d.name().to_string_lossy().to_string()
            };
            DriveInfo {
                name,
                path: mount,
                total: d.total_space(),
                available: d.available_space(),
                kind: format!("{:?}", d.kind()),
            }
        })
        .collect();
    // Deduplicate by mount path.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}
