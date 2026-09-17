#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod listing;
mod fs_ops;
mod jobs;
mod media;

use listing::{list_dir, DirEntryInfo, DriveInfo, list_drives, folder_size};
use jobs::{JobManager, JobKind};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Manager, State, Emitter};

struct AppState {
    jobs: Arc<JobManager>,
}

#[derive(Serialize)]
struct HomeDirs {
    home: Option<String>,
    desktop: Option<String>,
    documents: Option<String>,
    downloads: Option<String>,
}

#[tauri::command]
fn cmd_list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntryInfo>, String> {
    list_dir(&path, show_hidden).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_list_drives() -> Result<Vec<DriveInfo>, String> {
    Ok(list_drives())
}

#[tauri::command]
fn cmd_folder_size(path: String) -> u64 {
    folder_size(&path)
}

#[tauri::command]
fn cmd_home_dirs() -> HomeDirs {
    HomeDirs {
        home: dirs::home_dir().and_then(|p| p.to_str().map(String::from)),
        desktop: dirs::desktop_dir().and_then(|p| p.to_str().map(String::from)),
        documents: dirs::document_dir().and_then(|p| p.to_str().map(String::from)),
        downloads: dirs::download_dir().and_then(|p| p.to_str().map(String::from)),
    }
}

#[tauri::command]
fn cmd_start_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    destination: String,
    mode: String, // "copy" | "move"
    conflict: String, // "overwrite" | "skip" | "rename"
) -> Result<String, String> {
    let kind = match mode.as_str() {
        "move" => JobKind::Move,
        _ => JobKind::Copy,
    };
    let conflict = match conflict.as_str() {
        "skip" => fs_ops::ConflictPolicy::Skip,
        "rename" => fs_ops::ConflictPolicy::Rename,
        _ => fs_ops::ConflictPolicy::Overwrite,
    };
    let handle = state.jobs.spawn(app.clone(), kind, sources, destination, conflict);
    Ok(handle.id)
}

#[tauri::command]
fn cmd_cancel(state: State<'_, AppState>, id: String) {
    state.jobs.cancel(&id);
}

#[tauri::command]
fn cmd_delete(paths: Vec<String>) -> Result<(), String> {
    fs_ops::delete_paths(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_mkdir(parent: String, name: String) -> Result<String, String> {
    fs_ops::mkdir(&parent, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_rename(path: String, new_name: String) -> Result<String, String> {
    fs_ops::rename(&path, &new_name).map_err(|e| e.to_string())
}

fn main() {
    let jobs = Arc::new(JobManager::new());
    tauri::Builder::default()
        .manage(AppState { jobs: jobs.clone() })
        .invoke_handler(tauri::generate_handler![
            cmd_list_dir,
            cmd_list_drives,
            cmd_folder_size,
            cmd_home_dirs,
            cmd_start_transfer,
            cmd_cancel,
            cmd_delete,
            cmd_mkdir,
            cmd_rename,
        ])
        .setup(move |app| {
            let _ = app.get_webview_window("main");
            // Emit a ready event so the UI knows backend is up.
            let _ = app.emit("swiftcopy://ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SwiftCopy");
}
