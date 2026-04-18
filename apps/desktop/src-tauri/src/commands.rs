//! Tauri IPC commands — called from the web frontend via `invoke(...)`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use serde::{Deserialize, Serialize};
use crate::AppState;

// ── Discovery ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_nearby_devices(state: State<'_, AppState>) -> Result<Vec<crate::mdns::NearbyDevice>, String> {
    Ok(state.mdns.device_list())
}

#[tauri::command]
pub async fn announce_device(
    name: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.mdns.announce(&name, port, &state.peer_id, "desktop")
        .map_err(|e| e.to_string())
}

// ── Clipboard sync ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_clipboard_text(app: AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    // Read via the OS clipboard API
    let clipboard = app.clipboard();
    clipboard.read_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_clipboard_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// ── Room / signaling ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RoomInfo {
    pub room_id: String,
    pub code: String,
    pub peer_id: String,
    pub token: String,
    pub expires_at: u64,
}

/// Create a signaling room. The frontend handles WebRTC/QUIC after this.
#[tauri::command]
pub async fn create_signaling_room(
    signaling_url: String,
    device_name: String,
    state: State<'_, AppState>,
) -> Result<RoomInfo, String> {
    use serde_json::json;
    let client = reqwest::Client::new();
    // Exchange via HTTP helper endpoint (add /api/room/create to signaling server
    // or use WS directly — see SignalingClient in @dropbeam/transfer for WS path).
    // For now, return a placeholder; the web layer uses SignalingClient directly.
    let _ = (signaling_url, device_name, client);
    Err("use SignalingClient from the frontend directly".into())
}

// ── File transfer (QUIC direct on LAN) ───────────────────────────────────

#[derive(Deserialize)]
pub struct QuicSendPayload {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub transfer_id: String,
    pub file_paths: Vec<String>,
    pub lanes: u8,
}

#[tauri::command]
pub async fn quic_send_files(
    payload: QuicSendPayload,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;
    let bin = find_quic_binary(&app);
    if let Some(bin) = bin {
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args([
            "send",
            "--host", &payload.host,
            "--port", &payload.port.to_string(),
            "--token", &payload.token,
            "--transfer-id", &payload.transfer_id,
            "--lanes", &payload.lanes.to_string(),
        ]);
        for f in &payload.file_paths { cmd.arg(f); }
        let out = cmd.output().await.map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    } else {
        Err("dropbeam-quic binary not found — fall back to WebRTC in frontend".into())
    }
}

#[derive(Deserialize)]
pub struct QuicRecvPayload {
    pub port: u16,
    pub token: String,
    pub out_dir: String,
}

#[tauri::command]
pub async fn quic_recv_files(payload: QuicRecvPayload, app: AppHandle) -> Result<(), String> {
    let bin = find_quic_binary(&app);
    if let Some(bin) = bin {
        let out = tokio::process::Command::new(bin)
            .args(["recv", "--port", &payload.port.to_string(),
                   "--token", &payload.token, "--out", &payload.out_dir])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) }
        else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
    } else {
        Err("dropbeam-quic binary not found".into())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn find_quic_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Next to the app bundle
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("dropbeam-quic");
        if p.exists() { return Some(p); }
    }
    // 2. PATH
    which::which("dropbeam-quic").ok()
}
