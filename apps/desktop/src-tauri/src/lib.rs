pub mod commands;
pub mod mdns;
pub mod tray;

use std::sync::Arc;
use uuid::Uuid;

pub struct AppState {
    pub peer_id: String,
    pub mdns: Arc<mdns::MdnsDiscovery>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mdns = Arc::new(mdns::MdnsDiscovery::new().expect("mDNS init failed"));
    mdns.browse();

    let state = AppState {
        peer_id: Uuid::new_v4().to_string(),
        mdns: Arc::clone(&mdns),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .setup(|app| {
            tray::setup_tray(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_nearby_devices,
            commands::announce_device,
            commands::get_clipboard_text,
            commands::set_clipboard_text,
            commands::create_signaling_room,
            commands::quic_send_files,
            commands::quic_recv_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
