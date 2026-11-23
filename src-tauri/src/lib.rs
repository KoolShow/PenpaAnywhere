use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::{
    window::Color, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
};

#[derive(Debug, Clone, Deserialize, Default)]
struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Point2D {
    x: f64,
    y: f64,
}

#[derive(Debug, Default)]
struct HitState {
    auto_passthrough: bool,
    force_click_through: bool,
    initialized: bool,
    bar_rect: HitRect,
    dock_rect: HitRect,
    quad: Vec<Point2D>,
    last_ignore: Option<bool>,
}

struct AppOverlayState(Arc<Mutex<HitState>>);

fn point_in_rect_padded(px: f64, py: f64, r: &HitRect, pad: f64) -> bool {
    r.w > 0.0
        && r.h > 0.0
        && px >= r.x - pad
        && px <= r.x + r.w + pad
        && py >= r.y - pad
        && py <= r.y + r.h + pad
}

fn point_in_quad_padded(px: f64, py: f64, quad: &[Point2D], corner_pad: f64) -> bool {
    if quad.len() != 4 {
        return false;
    }
    for pt in quad {
        let dx = px - pt.x;
        let dy = py - pt.y;
        if dx * dx + dy * dy <= corner_pad * corner_pad {
            return true;
        }
    }
    let mut has_pos = false;
    let mut has_neg = false;
    for i in 0..4 {
        let a = &quad[i];
        let b = &quad[(i + 1) % 4];
        let cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
        if cross > 0.0 {
            has_pos = true;
        } else if cross < 0.0 {
            has_neg = true;
        }
        if has_pos && has_neg {
            return false;
        }
    }
    true
}

fn apply_ignore_cursor(window: &WebviewWindow, ignore: bool) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = win.set_ignore_cursor_events(ignore);
    });
}

#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    ignore: bool,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.force_click_through = ignore;
        // Let the poller decide cursor ignore dynamically so the top control bar stays clickable!
        if !ignore {
            guard.last_ignore = Some(false);
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, always_on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_overlay_window_mode(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    overlay: bool,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.auto_passthrough = overlay;
        if !overlay {
            guard.force_click_through = false;
            guard.last_ignore = Some(false);
        }
    }
    window
        .set_always_on_top(overlay)
        .map_err(|e| e.to_string())?;
    if !overlay {
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_hit_regions(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    enabled: bool,
    force_click_through: bool,
    bar_rect: HitRect,
    dock_rect: HitRect,
    quad: Vec<Point2D>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.auto_passthrough = enabled;
        guard.force_click_through = force_click_through;
        guard.bar_rect = bar_rect;
        guard.dock_rect = dock_rect;
        guard.quad = quad;
        guard.initialized = guard.bar_rect.w > 0.0 && guard.bar_rect.h > 0.0;
        if !enabled {
            guard.last_ignore = Some(false);
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    Ok(())
}

#[tauri::command]
fn close_app(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

fn fit_overlay_window_to_monitor(window: &WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
        let pos = monitor.position();
        let size = monitor.size();
        #[cfg(windows)]
        let h = size.height.saturating_sub(1).max(400);
        #[cfg(not(windows))]
        let h = size.height.max(400);
        let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = window.set_size(PhysicalSize::new(size.width, h));
    }
}

#[cfg(windows)]
fn spawn_windows_overlay_poller(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_RBUTTON, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut prev_hotkey_down = false;
        loop {
            thread::sleep(Duration::from_millis(25));

            let hotkey_down = unsafe {
                (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0
                    && (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0
                    && (GetAsyncKeyState('T' as i32) as u16 & 0x8000) != 0
            };
            if hotkey_down && !prev_hotkey_down {
                let next_force = if let Ok(mut guard) = state.lock() {
                    guard.force_click_through = !guard.force_click_through;
                    guard.last_ignore = None;
                    Some(guard.force_click_through)
                } else {
                    None
                };
                if let Some(val) = next_force {
                    let _ = window.emit("click-through-toggled", val);
                }
            }
            prev_hotkey_down = hotkey_down;

            let (initialized, auto_enabled, force_ct, bar_rect, dock_rect, quad, last_ignore) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.initialized,
                    guard.auto_passthrough,
                    guard.force_click_through,
                    guard.bar_rect.clone(),
                    guard.dock_rect.clone(),
                    guard.quad.clone(),
                    guard.last_ignore,
                )
            };

            if !auto_enabled || !initialized {
                continue;
            }

            let mouse_down = unsafe {
                (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0
                    || (GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000) != 0
            };
            if mouse_down && last_ignore == Some(false) {
                continue;
            }

            let mut pt = POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut pt) } == 0 {
                continue;
            }

            let Ok(win_pos) = window.inner_position() else {
                continue;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let local_x = (pt.x - win_pos.x) as f64 / scale;
            let local_y = (pt.y - win_pos.y) as f64 / scale;

            let hit_bar = point_in_rect_padded(local_x, local_y, &bar_rect, 14.0);
            let should_ignore = if force_ct {
                // Locked pass-through: board & dock pass through, but top control bar remains clickable!
                !hit_bar
            } else {
                let hit_dock = point_in_rect_padded(local_x, local_y, &dock_rect, 14.0);
                let hit_board = point_in_quad_padded(local_x, local_y, &quad, 28.0);
                !(hit_bar || hit_dock || hit_board)
            };

            if last_ignore != Some(should_ignore) {
                apply_ignore_cursor(&window, should_ignore);
                if let Ok(mut guard) = state.lock() {
                    guard.last_ignore = Some(should_ignore);
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn spawn_macos_overlay_poller(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::ffi::c_void;
    use std::thread;
    use std::time::Duration;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const K_COMBINED_SESSION_STATE: i32 = 0;
    const KEY_T: u16 = 17;
    const KEY_CMD_L: u16 = 55;
    const KEY_CMD_R: u16 = 54;
    const KEY_SHIFT_L: u16 = 56;
    const KEY_SHIFT_R: u16 = 60;
    const KEY_CTRL_L: u16 = 59;
    const KEY_CTRL_R: u16 = 62;

    thread::spawn(move || {
        let mut prev_hotkey_down = false;
        loop {
            thread::sleep(Duration::from_millis(25));

            // Global Cmd+Shift+T or Ctrl+Shift+T toggles forced click-through
            let hotkey_down = unsafe {
                let mod_cmd_or_ctrl = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CMD_L)
                    || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CMD_R)
                    || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CTRL_L)
                    || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CTRL_R);
                let shift = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_SHIFT_L)
                    || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_SHIFT_R);
                let key_t = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_T);
                mod_cmd_or_ctrl && shift && key_t
            };

            if hotkey_down && !prev_hotkey_down {
                let next_force = if let Ok(mut guard) = state.lock() {
                    guard.force_click_through = !guard.force_click_through;
                    guard.last_ignore = None;
                    Some(guard.force_click_through)
                } else {
                    None
                };
                if let Some(val) = next_force {
                    let _ = window.emit("click-through-toggled", val);
                }
            }
            prev_hotkey_down = hotkey_down;

            let (initialized, auto_enabled, force_ct, bar_rect, dock_rect, quad, last_ignore) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.initialized,
                    guard.auto_passthrough,
                    guard.force_click_through,
                    guard.bar_rect.clone(),
                    guard.dock_rect.clone(),
                    guard.quad.clone(),
                    guard.last_ignore,
                )
            };

            if !auto_enabled || !initialized {
                continue;
            }

            // Protect active left/right mouse drags from flipping into click-through
            let mouse_down = unsafe {
                CGEventSourceButtonState(K_COMBINED_SESSION_STATE, 0)
                    || CGEventSourceButtonState(K_COMBINED_SESSION_STATE, 1)
            };
            if mouse_down && last_ignore == Some(false) {
                continue;
            }

            let pt = unsafe {
                let ev = CGEventCreate(std::ptr::null());
                if ev.is_null() {
                    continue;
                }
                let loc = CGEventGetLocation(ev);
                CFRelease(ev);
                loc
            };

            let Ok(win_pos) = window.inner_position() else {
                continue;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let win_logical_x = win_pos.x as f64 / scale;
            let win_logical_y = win_pos.y as f64 / scale;
            let local_x = pt.x - win_logical_x;
            let local_y = pt.y - win_logical_y;

            let hit_bar = point_in_rect_padded(local_x, local_y, &bar_rect, 14.0);
            let should_ignore = if force_ct {
                !hit_bar
            } else {
                let hit_dock = point_in_rect_padded(local_x, local_y, &dock_rect, 14.0);
                let hit_board = point_in_quad_padded(local_x, local_y, &quad, 28.0);
                !(hit_bar || hit_dock || hit_board)
            };

            if last_ignore != Some(should_ignore) {
                apply_ignore_cursor(&window, should_ignore);
                if let Ok(mut guard) = state.lock() {
                    guard.last_ignore = Some(should_ignore);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_state = Arc::new(Mutex::new(HitState {
        auto_passthrough: true,
        initialized: false,
        ..Default::default()
    }));

    let state_for_setup = Arc::clone(&shared_state);

    tauri::Builder::default()
        .manage(AppOverlayState(shared_state))
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_always_on_top,
            set_overlay_window_mode,
            update_hit_regions,
            close_app
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = window.set_shadow(false);
                let _ = window.set_ignore_cursor_events(false);
                fit_overlay_window_to_monitor(&window);

                #[cfg(windows)]
                spawn_windows_overlay_poller(window, state_for_setup);

                #[cfg(target_os = "macos")]
                spawn_macos_overlay_poller(window, state_for_setup);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PenpaCanvas Tauri application");
}
