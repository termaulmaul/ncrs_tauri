use serialport::available_ports;
use std::{fs, io::Read, sync::{Arc, atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};
use chrono::{Local, SecondsFormat};
use serde_json::{Value, json};
use once_cell::sync::Lazy;

static LAST_EVENT: Lazy<Mutex<(String, u128)>> = Lazy::new(|| Mutex::new((String::new(), 0)));

fn should_emit(key: &str, window_ms: u128) -> bool {
  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
  let mut g = LAST_EVENT.lock().unwrap();
  if g.0 == key && now.saturating_sub(g.1) < window_ms { return false; }
  *g = (key.to_string(), now);
  true
}

pub fn list_ports() -> Vec<String> {
  let mut out = Vec::new();
  if let Ok(ports) = available_ports() {
    for p in ports {
      // return the raw port name for use by serial_connect
      out.push(p.port_name.clone());
    }
  }
  out
}

pub struct SerialWorker {
  stop: Arc<AtomicBool>,
  handle: Option<std::thread::JoinHandle<()>>,
}

impl SerialWorker {
  pub fn start(app: AppHandle, port_name: String) -> Result<Self, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_c = stop.clone();
    let handle = std::thread::spawn(move || {
      // retry loop: keep attempting to open the port until stopped
      'outer: loop {
        if stop_c.load(Ordering::Relaxed) { break 'outer; }
        let mut last_active_code: Option<String> = None;
        let mut awaiting_reset = false;
        let mut standby_count: u32 = 0;
        match serialport::new(&port_name, 9600)
          .timeout(Duration::from_millis(200))
          .open() {
            Ok(mut port) => {
              let _ = app.emit("serial-connected", &port_name);
              let mut buf = [0u8; 1024];
              // read loop until error or stop
              while !stop_c.load(Ordering::Relaxed) {
                match port.read(&mut buf) {
                  Ok(n) if n > 0 => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("serial-data", &s);
                    // treat 99: as standby pulse
                    if s.contains("99:") {
                      let _ = app.emit("serial-standby-ok", &());
                      if awaiting_reset {
                        standby_count = standby_count.saturating_add(1);
                        if standby_count >= 5 {
                          if let Some(code) = &last_active_code { let _ = complete_latest_for_code(code); }
                          awaiting_reset = false;
                        }
                      }
                    }
                    // try parse lines like "<code>: <adc>"
                    for part in s.split(|c| c == '\n' || c == '\r') {
                      if let Some((code_str, rest)) = part.split_once(':') {
                        let code = code_str.trim();
                        let rest_trim = rest.trim();
                        // Enclose/response: patterns like "901:" (no ADC required)
                        if code.len() == 3 && code.starts_with("90") && code.chars().all(|c| c.is_ascii_digit()) && rest_trim.is_empty() {
                          let _ = handle_enclose(&app, code);
                          awaiting_reset = false;
                          continue;
                        }
                        // Valid trigger with ADC
                        let val = rest_trim.split_whitespace().next().unwrap_or("");
                        if code.len() == 3 && code.chars().all(|c| c.is_ascii_digit()) && val.chars().all(|c| c.is_ascii_digit()) {
                          let adc: i32 = val.parse().unwrap_or(0);
                          if code.starts_with("90") { awaiting_reset = false; }
                          handle_trigger(&app, code, adc);
                          if !code.starts_with("90") {
                            last_active_code = Some(code.to_string());
                            awaiting_reset = true; standby_count = 0;
                          }
                        }
                      }
                    }
                  }
                  Ok(_) => {}
                  Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                  Err(_e) => { break; }
                }
              }
              // leaving read loop: disconnected or stopped
              let _ = app.emit("serial-disconnected", &());
              // slight delay before retrying
              std::thread::sleep(Duration::from_millis(800));
            }
            Err(e) => {
              // emit throttled error and retry
              if should_emit(&format!("open_err:{}", port_name), 3000) {
                let _ = app.emit("serial-error", &format!("{} (retrying)", e));
              }
              // backoff before retrying
              std::thread::sleep(Duration::from_millis(1000));
            }
          }
      }
    });
    Ok(Self { stop, handle: Some(handle) })
  }

  pub fn stop(&mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(h) = self.handle.take() { let _ = h.join(); }
  }
}

fn now_iso() -> String { chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true) }
fn now_local_compact() -> String { Local::now().format("%H:%M:%S.%-m-%-d-%Y").to_string() }

fn read_master_type(v: &Value) -> String {
  v.get("masterSettings")
    .and_then(|m| m.get("masterType").or_else(|| m.get("master")).or_else(|| m.get("type")))
    .and_then(|s| s.as_str())
    .unwrap_or("Commax")
    .trim()
    .to_string()
}

fn handle_trigger(app: &AppHandle, code: &str, adc: i32) {
  let cfg_path = "/Users/maul/github/modern-desktop-app-template/public/config.json";
  let cfg_text = match fs::read_to_string(cfg_path) { Ok(t) => t, Err(_) => return };
  let mut v: Value = match serde_json::from_str(&cfg_text) { Ok(j) => j, Err(_) => return };
  let master_type = read_master_type(&v);
  let threshold = if master_type.eq_ignore_ascii_case("AIPHONE") { 150 } else { 70 };
  if adc < threshold { return; }

  // reset code pattern: 90x maps to 10x
  if code.starts_with("90") && code.len() == 3 {
    let last = &code[2..];
    let target = format!("10{}", last);
    if let Some(arr) = v.get_mut("callHistoryStorage").and_then(|a| a.as_array_mut()) {
      // find latest active with target code
      if let Some(pos) = arr.iter().rposition(|rec| rec.get("code").and_then(|s| s.as_str()) == Some(target.as_str()) && rec.get("status").and_then(|s| s.as_str()) != Some("completed")) {
        if let Some(obj) = arr.get_mut(pos).and_then(|r| r.as_object_mut()) {
          let iso = now_iso();
          obj.insert("status".into(), Value::String("completed".into()));
          obj.insert("resetTime".into(), Value::String(iso.clone()));
          obj.insert("resetTimeStr".into(), Value::String(now_local_compact()));
          obj.insert("dateModified".into(), Value::String(iso));
          let _ = fs::write(cfg_path, serde_json::to_string_pretty(&v).unwrap());
        }
      }
    }
    return;
  }

  if adc < threshold { return; }

  // De-dup: if there is already an active record for this code, do not append or emit again
  if let Some(arr) = v.get("callHistoryStorage").and_then(|a| a.as_array()) {
    let exists_active = arr.iter().any(|rec|
      rec.get("code").and_then(|s| s.as_str()) == Some(code)
        && rec.get("status").and_then(|s| s.as_str()) != Some("completed")
    );
    if exists_active { return; }
  }

  let mut room = String::new();
  let mut bed = String::new();
  let mut files: Vec<String> = Vec::new();
  if let Some(md) = v.get("masterData").and_then(|a| a.as_array()) {
    for r in md {
      if r.get("charCode").and_then(|s| s.as_str()) == Some(code) {
        room = r.get("roomName").and_then(|s| s.as_str()).unwrap_or("").to_string();
        bed = r.get("bedName").and_then(|s| s.as_str()).unwrap_or("").to_string();
        for key in ["v1","v2","v3","v4","v5","v6"] {
          if let Some(f) = r.get(key).and_then(|s| s.as_str()) {
            if !f.is_empty() && f != "-" { files.push(f.to_string()); }
          }
        }
        break;
      }
    }
  }
  let display = if !room.is_empty() { format!("{} - {}", room, bed) } else { code.to_string() };
  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
  let iso = now_iso();
  let rec = json!({
    "id": now,
    "code": code,
    "room": room,
    "bed": bed,
    "display": display,
    "time": now_local_compact(),
    "timestamp": iso,
    "status": "active",
    "dateAdded": iso,
    "dateModified": iso
  });
  // append to callHistoryStorage
  if let Some(arr) = v.get_mut("callHistoryStorage").and_then(|a| a.as_array_mut()) {
    arr.push(rec);
    let _ = fs::write(cfg_path, serde_json::to_string_pretty(&v).unwrap());
  }
  if should_emit(&format!("trigger:{}", code), 1500) {
    // emit event for frontend to play sounds and notifications
    let _ = app.emit("nurse-call", &json!({
      "code": code,
      "room": room,
      "bed": bed,
      "display": display,
      "files": files,
    }));
  }
}

fn complete_latest_for_code(code: &str) -> Result<(String,String), String> {
  let cfg_path = "/Users/maul/github/modern-desktop-app-template/public/config.json";
  let cfg_text = fs::read_to_string(cfg_path).map_err(|e| e.to_string())?;
  let mut v: Value = serde_json::from_str(&cfg_text).map_err(|e| e.to_string())?;
  let mut room = String::new();
  let mut bed = String::new();
  if let Some(arr) = v.get_mut("callHistoryStorage").and_then(|a| a.as_array_mut()) {
    if let Some(pos) = arr.iter().rposition(|rec| rec.get("code").and_then(|s| s.as_str()) == Some(code) && rec.get("status").and_then(|s| s.as_str()) != Some("completed")) {
      if let Some(obj) = arr.get_mut(pos).and_then(|r| r.as_object_mut()) {
        let iso = now_iso();
        obj.insert("status".into(), Value::String("completed".into()));
        obj.insert("resetTime".into(), Value::String(iso.clone()));
        obj.insert("resetTimeStr".into(), Value::String(now_local_compact()));
        obj.insert("dateModified".into(), Value::String(iso));
        if let Some(r) = obj.get("room").and_then(|s| s.as_str()) { room = r.to_string(); }
        if let Some(b) = obj.get("bed").and_then(|s| s.as_str()) { bed = b.to_string(); }
        fs::write(cfg_path, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
      }
    }
  }
  Ok((room, bed))
}

fn handle_enclose(app: &AppHandle, code90: &str) -> Result<(), String> {
  // Map 90x -> 10x
  let mut chars = code90.chars();
  let _ = chars.next(); let _ = chars.next();
  let last = chars.next().unwrap_or('0');
  let target = format!("10{}", last);
  if let Ok((room, bed)) = complete_latest_for_code(&target) {
    let display = if !room.is_empty() { format!("{} - {}", room, bed) } else { target.clone() };
    if should_emit(&format!("enclose:{}", target), 1500) {
      // app notification/event only; frontend will also raise OS notification
      let _ = app.emit("nurse-call-response", &json!({ "code": target, "room": room, "bed": bed, "display": display }));
    }
  }
  Ok(())
}

fn complete_latest_any() -> Result<(String,String,String), String> {
  let cfg_path = "/Users/maul/github/modern-desktop-app-template/public/config.json";
  let cfg_text = fs::read_to_string(cfg_path).map_err(|e| e.to_string())?;
  let mut v: Value = serde_json::from_str(&cfg_text).map_err(|e| e.to_string())?;
  if let Some(arr) = v.get_mut("callHistoryStorage").and_then(|a| a.as_array_mut()) {
    if let Some(pos) = arr.iter().rposition(|rec| rec.get("status").and_then(|s| s.as_str()) != Some("completed")) {
      if let Some(obj) = arr.get_mut(pos).and_then(|r| r.as_object_mut()) {
        let code = obj.get("code").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let room = obj.get("room").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let bed  = obj.get("bed").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let iso = now_iso();
        obj.insert("status".into(), Value::String("completed".into()));
        obj.insert("resetTime".into(), Value::String(iso.clone()));
        obj.insert("resetTimeStr".into(), Value::String(now_local_compact()));
        obj.insert("dateModified".into(), Value::String(iso));
        fs::write(cfg_path, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
        return Ok((code, room, bed));
      }
    }
  }
  Err("no pending calls".into())
}

#[tauri::command]
pub fn serial_enclose_latest(app: AppHandle) -> Result<(), String> {
  match complete_latest_any() {
    Ok((code, room, bed)) => {
      let display = if !room.is_empty() { format!("{} - {}", room, bed) } else { code.clone() };
      let _ = app.emit("nurse-call-response", &json!({"code": code, "display": display}));
      Ok(())
    }
    Err(e) => Err(e)
  }
}

#[tauri::command]
pub fn serial_enclose_all(app: AppHandle) -> Result<u32, String> {
  let cfg_path = "/Users/maul/github/modern-desktop-app-template/public/config.json";
  let cfg_text = fs::read_to_string(cfg_path).map_err(|e| e.to_string())?;
  let mut v: Value = serde_json::from_str(&cfg_text).map_err(|e| e.to_string())?;
  let mut updated: u32 = 0;
  let mut responses: Vec<(String, String)> = Vec::new(); // (code, display)
  if let Some(arr) = v.get_mut("callHistoryStorage").and_then(|a| a.as_array_mut()) {
    for rec in arr.iter_mut() {
      let status = rec.get("status").and_then(|s| s.as_str()).unwrap_or("");
      if status != "completed" {
        let code = rec.get("code").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let room = rec.get("room").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let bed  = rec.get("bed").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let display = if !room.is_empty() { format!("{} - {}", room, bed) } else { code.clone() };
        let iso = now_iso();
        if let Some(obj) = rec.as_object_mut() {
          obj.insert("status".into(), Value::String("completed".into()));
          obj.insert("resetTime".into(), Value::String(iso.clone()));
          obj.insert("resetTimeStr".into(), Value::String(now_local_compact()));
          obj.insert("dateModified".into(), Value::String(iso));
        }
        responses.push((code, display));
        updated += 1;
      }
    }
  }
  if updated > 0 {
    fs::write(cfg_path, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
    for (code, display) in responses {
      let _ = app.emit("nurse-call-response", &json!({"code": code, "display": display}));
    }
  }
  Ok(updated)
}
