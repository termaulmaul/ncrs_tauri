// this hides the console for Windows release builds
#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use serde::Serialize;
use std::sync::Mutex;
use tauri::{
  // state is used in Linux
  self,
  Emitter,
  Manager,
};
use tauri_plugin_store;
use tauri_plugin_window_state;

mod tray_icon;
mod utils;
mod serial;
use crate::serial::{serial_enclose_latest, serial_enclose_all};

use tray_icon::{create_tray_icon, tray_update_lang, TrayState};
use utils::long_running_thread;

#[derive(Clone, Serialize)]
struct SingleInstancePayload {
  args: Vec<String>,
  cwd: String,
}

// Removed unused Example struct to avoid dead_code warning

#[cfg(target_os = "linux")]
pub struct DbusState(Mutex<Option<dbus::blocking::SyncConnection>>);

pub struct SerialState(Mutex<Option<serial::SerialWorker>>);

#[tauri::command]
fn process_file(filepath: String) -> String {
  println!("Processing file: {}", filepath);
  "Hello from Rust!".into()
}

#[tauri::command]
fn write_public_config(text: String) -> Result<(), String> {
  // NOTE: dev-only path; for production, switch to a writable AppData/Documents path
  let cfg_path = "/Users/maul/github/modern-desktop-app-template/public/config.json";
  std::fs::write(cfg_path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn serial_list_ports() -> Vec<String> { serial::list_ports() }

#[tauri::command]
fn serial_connect(app: tauri::AppHandle, state: tauri::State<SerialState>, port: String) -> Result<(), String> {
  let mut guard = state.0.lock().unwrap();
  // stop existing
  if let Some(w) = guard.as_mut() { w.stop(); }
  let worker = serial::SerialWorker::start(app, port)?;
  *guard = Some(worker);
  Ok(())
}

#[tauri::command]
fn serial_disconnect(state: tauri::State<SerialState>) -> Result<(), String> {
  let mut guard = state.0.lock().unwrap();
  if let Some(w) = guard.as_mut() { w.stop(); }
  *guard = None;
  Ok(())
}

#[cfg(target_os = "linux")]
fn webkit_hidpi_workaround() {
  // See: https://github.com/spacedriveapp/spacedrive/issues/1512#issuecomment-1758550164
  std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

fn main_prelude() {
  #[cfg(target_os = "linux")]
  webkit_hidpi_workaround();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  main_prelude();
  // main window should be invisible to allow either the setup delay or the plugin to show the window
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::new().build())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    // custom commands
    .invoke_handler(tauri::generate_handler![tray_update_lang, process_file, write_public_config])
    .invoke_handler(tauri::generate_handler![serial_list_ports, serial_connect, serial_disconnect, serial_enclose_latest, serial_enclose_all])
    // allow only one instance and propagate args and cwd to existing instance
    .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
      app
        .emit("newInstance", SingleInstancePayload { args, cwd })
        .unwrap();
    }))
    // persistent storage with filesystem
    .plugin(tauri_plugin_store::Builder::default().build())
    // save window position and size between sessions
    // if you remove this, make sure to uncomment the mainWebview?.show line in TauriProvider.tsx
    .plugin(tauri_plugin_window_state::Builder::default().build())
    // custom setup code
    .setup(|app| {
      let _ = create_tray_icon(app.handle());
      app.manage(Mutex::new(TrayState::NotPlaying));
      app.manage(SerialState(Mutex::new(None)));

      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move { long_running_thread(&app_handle).await });

      #[cfg(target_os = "linux")]
      app.manage(DbusState(Mutex::new(
        dbus::blocking::SyncConnection::new_session().ok(),
      )));

      // TODO: AUTOSTART
      // FOLLOW: https://v2.tauri.app/plugin/autostart/

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// useful crates
// https://crates.io/crates/directories for getting common directories

// TODO: optimize permissions
// TODO: decorations false and use custom title bar
