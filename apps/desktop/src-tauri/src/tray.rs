//! System tray: "Nearby devices" submenu + quick-action items.

use tauri::{
    menu::{MenuBuilder, MenuItem, Submenu, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let nearby_menu = SubmenuBuilder::new(app, "Nearby Devices")
        .item(&MenuItem::with_id(app, "nearby_scan", "Scanning…", false, None::<&str>)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&nearby_menu)
        .separator()
        .item(&MenuItem::with_id(app, "open_window", "Open DropBeam", true, None::<&str>)?)
        .item(&MenuItem::with_id(app, "copy_code", "Copy Room Code", true, None::<&str>)?)
        .separator()
        .item(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)
        .build()?;

    TrayIconBuilder::new()
        .menu(&menu)
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("DropBeam")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_window" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
