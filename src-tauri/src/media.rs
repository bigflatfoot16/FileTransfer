//! Detect whether a path lives on a spinning-platter HDD.
//!
//! Parallel workers hurt HDDs (head thrashing) but help SSDs. Knowing which
//! we've got lets us pick the right level of concurrency automatically.

use parking_lot::Mutex;
use std::collections::HashMap;

/// Returns true if the path likely lives on a spinning HDD.
/// On non-Windows platforms we currently return false (assume SSD).
pub fn is_hdd(path: &str) -> bool {
    #[cfg(windows)]
    { windows_impl::is_hdd_cached(path) }
    #[cfg(not(windows))]
    { linux_impl::is_hdd(path) }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use once_cell::sync::Lazy;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    // Cache results per drive letter — the answer never changes at runtime.
    static CACHE: Lazy<Mutex<HashMap<char, bool>>> = Lazy::new(|| Mutex::new(HashMap::new()));

    // IOCTL and struct constants (from ntddstor.h / winioctl.h).
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x2D1400;
    const STORAGE_DEVICE_SEEK_PENALTY_PROPERTY: i32 = 7;
    const PROPERTY_STANDARD_QUERY: i32 = 0;

    #[repr(C)]
    struct StoragePropertyQuery {
        property_id: i32,
        query_type: i32,
        additional_parameters: [u8; 1],
    }
    #[repr(C)]
    struct DeviceSeekPenaltyDescriptor {
        version: u32,
        size: u32,
        incurs_seek_penalty: u8, // 1 => HDD, 0 => SSD/NVMe
    }

    pub fn is_hdd_cached(path: &str) -> bool {
        let Some(drive) = drive_letter(path) else { return false; };
        if let Some(&cached) = CACHE.lock().get(&drive) { return cached; }
        let ans = query_seek_penalty(drive).unwrap_or(false);
        CACHE.lock().insert(drive, ans);
        ans
    }

    fn drive_letter(path: &str) -> Option<char> {
        let c = path.chars().next()?.to_ascii_uppercase();
        if c.is_ascii_alphabetic() { Some(c) } else { None }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn query_seek_penalty(drive: char) -> Option<bool> {
        // Open a handle to the volume, e.g. "\\.\C:".
        let path = format!(r"\\.\{}:", drive);
        let wide = to_wide(&path);
        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE { return None; }
            let query = StoragePropertyQuery {
                property_id: STORAGE_DEVICE_SEEK_PENALTY_PROPERTY,
                query_type: PROPERTY_STANDARD_QUERY,
                additional_parameters: [0],
            };
            let mut desc = DeviceSeekPenaltyDescriptor { version: 0, size: 0, incurs_seek_penalty: 0 };
            let mut returned: u32 = 0;
            let ok = DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                &query as *const _ as *const _,
                std::mem::size_of::<StoragePropertyQuery>() as u32,
                &mut desc as *mut _ as *mut _,
                std::mem::size_of::<DeviceSeekPenaltyDescriptor>() as u32,
                &mut returned,
                std::ptr::null_mut(),
            );
            CloseHandle(handle);
            if ok == 0 { return None; }
            Some(desc.incurs_seek_penalty != 0)
        }
    }
}

#[cfg(not(windows))]
mod linux_impl {
    // Best-effort HDD detection on Linux via /sys/block/*/queue/rotational.
    // Non-Linux Unixes return false (assume SSD).
    pub fn is_hdd(_path: &str) -> bool {
        #[cfg(target_os = "linux")]
        {
            if let Ok(entries) = std::fs::read_dir("/sys/block") {
                for e in entries.flatten() {
                    let p = e.path().join("queue/rotational");
                    if let Ok(v) = std::fs::read_to_string(&p) {
                        if v.trim() == "1" { return true; }
                    }
                }
            }
        }
        false
    }
}

/// Do two paths live on the same root/drive?
/// Used only as a hint; not authoritative for mount points.
pub fn same_root(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        let da = a.chars().next().map(|c| c.to_ascii_uppercase());
        let db = b.chars().next().map(|c| c.to_ascii_uppercase());
        da.is_some() && da == db
    }
    #[cfg(not(windows))]
    {
        // Compare device IDs from stat.
        use std::os::unix::fs::MetadataExt;
        let ma = std::fs::metadata(a).ok();
        let mb = std::fs::metadata(b).ok();
        match (ma, mb) {
            (Some(x), Some(y)) => x.dev() == y.dev(),
            _ => false,
        }
    }
}

/// How many parallel workers to use for a given transfer.
/// HDDs get 1 worker (parallelism causes head thrashing, hurting throughput
/// as verified in real-world tests). SSDs get 4.
pub fn worker_count(sources: &[String], destination: &str) -> usize {
    let any_hdd = is_hdd(destination) || sources.iter().any(|s| is_hdd(s));
    if any_hdd { 1 } else { 4 }
}
