use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::{
    window::Color, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewWindow,
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct HotkeyConfig {
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
    code: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            ctrl: true,
            shift: true,
            alt: false,
            meta: false,
            code: "KeyT".to_string(),
        }
    }
}

#[derive(Debug, Default)]
struct HitState {
    is_overlay_mode: bool,
    window_is_dark: bool,
    auto_passthrough: bool,
    force_click_through: bool,
    initialized: bool,
    bar_rect: HitRect,
    dock_rect: HitRect,
    quad: Vec<Point2D>,
    last_ignore: Option<bool>,
    toggle_hotkey: Option<HotkeyConfig>,
    saved_normal_bounds: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
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

fn point_to_segment_dist_sq(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let len_sq = abx * abx + aby * aby;
    if len_sq <= 1e-6 {
        let dx = px - ax;
        let dy = py - ay;
        return dx * dx + dy * dy;
    }
    let t = (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0);
    let proj_x = ax + t * abx;
    let proj_y = ay + t * aby;
    let dx = px - proj_x;
    let dy = py - proj_y;
    dx * dx + dy * dy
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
    let edge_pad_sq = 14.0 * 14.0;
    for i in 0..4 {
        let a = &quad[i];
        let b = &quad[(i + 1) % 4];
        if point_to_segment_dist_sq(px, py, a.x, a.y, b.x, b.y) <= edge_pad_sq {
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
    let (was_overlay, saved_bounds, is_dark) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "overlay state lock poisoned".to_string())?;
        let prev = guard.is_overlay_mode;
        guard.is_overlay_mode = overlay;
        guard.auto_passthrough = overlay;
        if !overlay {
            guard.force_click_through = false;
            guard.last_ignore = Some(false);
        } else {
            guard.last_ignore = None;
        }
        (prev, guard.saved_normal_bounds, guard.window_is_dark)
    };

    if !overlay {
        let _ = window.set_ignore_cursor_events(false);
        window
            .set_always_on_top(false)
            .map_err(|e| e.to_string())?;
        let bg = if is_dark {
            Color(17, 19, 24, 255)
        } else {
            Color(248, 249, 252, 255)
        };
        let _ = window.set_background_color(Some(bg));
        let _ = window.set_theme(Some(if is_dark { Theme::Dark } else { Theme::Light }));
        let _ = window.set_decorations(true);
        let _ = window.set_resizable(true);
        let _ = window.set_maximizable(true);
        let _ = window.set_shadow(true);

        if was_overlay {
            if let Some((pos, size)) = saved_bounds {
                let _ = window.set_size(size);
                let _ = window.set_position(pos);
            } else {
                fit_normal_window_to_monitor(&window);
            }
            let _ = window.set_focus();
        }
        return Ok(());
    }

    // Returning from normal resizable window -> save bounds & restore full-monitor transparent overlay
    if !was_overlay {
        let is_max = window.is_maximized().unwrap_or(false);
        let is_min = window.is_minimized().unwrap_or(false);
        if !is_max && !is_min {
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
                if size.width >= 320 && size.height >= 240 {
                    if let Ok(mut guard) = state.0.lock() {
                        guard.saved_normal_bounds = Some((pos, size));
                    }
                }
            }
        }
        if is_max {
            let _ = window.unmaximize();
        }
    }

    let _ = window.set_decorations(false);
    let _ = window.set_maximizable(false);
    let _ = window.set_resizable(false);
    let _ = window.set_shadow(false);
    let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
    window
        .set_always_on_top(true)
        .map_err(|e| e.to_string())?;
    fit_overlay_window_to_monitor(&window);
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
fn set_toggle_hotkey(
    state: State<'_, AppOverlayState>,
    hotkey: Option<HotkeyConfig>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.toggle_hotkey = hotkey.filter(|h| !h.code.is_empty());
    }
    Ok(())
}

#[tauri::command]
fn set_window_theme(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    dark: bool,
) -> Result<(), String> {
    let is_overlay = if let Ok(mut guard) = state.0.lock() {
        guard.window_is_dark = dark;
        guard.is_overlay_mode
    } else {
        true
    };
    let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
    if !is_overlay {
        let bg = if dark {
            Color(17, 19, 24, 255)
        } else {
            Color(248, 249, 252, 255)
        };
        let _ = window.set_background_color(Some(bg));
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/KoolShow/PenpaAnywhere") {
        return Err("URL not allowed".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_app(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn read_windows_accent_hex() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };

    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\DWM\0"
        .encode_utf16()
        .collect();
    let val_name: Vec<u16> = "AccentColor\0".encode_utf16().collect();
    let mut raw: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;

    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            val_name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut raw as *mut u32).cast(),
            &mut size,
        )
    };
    if status == 0 {
        // DWM AccentColor DWORD is 0xAABBGGRR
        let r = raw & 0xFF;
        let g = (raw >> 8) & 0xFF;
        let b = (raw >> 16) & 0xFF;
        return Some(format!("#{:02X}{:02X}{:02X}", r, g, b));
    }
    None
}

#[cfg(target_os = "macos")]
fn read_macos_accent_hex() -> Option<String> {
    use std::ffi::{c_char, c_void, CStr};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFTypeID = usize;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT32_TYPE: isize = 3;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFPreferencesAppSynchronize(application_id: CFStringRef) -> bool;
        fn CFPreferencesCopyAppValue(key: CFStringRef, application_id: CFStringRef) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
        fn CFNumberGetTypeID() -> CFTypeID;
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFNumberGetValue(number: CFTypeRef, the_type: isize, value_ptr: *mut c_void) -> bool;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(cf: CFTypeRef);
    }

    unsafe {
        let key_cstr = b"AppleAccentColor\0";
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            key_cstr.as_ptr().cast(),
            K_CF_STRING_ENCODING_UTF8,
        );
        if key.is_null() {
            return None;
        }
        let _ = CFPreferencesAppSynchronize(kCFPreferencesAnyApplication);
        let val = CFPreferencesCopyAppValue(key, kCFPreferencesAnyApplication);
        CFRelease(key);
        if val.is_null() {
            return None;
        }

        let type_id = CFGetTypeID(val);
        let mut parsed_code: Option<i32> = None;

        if type_id == CFNumberGetTypeID() {
            let mut num: i32 = 0;
            if CFNumberGetValue(val, K_CF_NUMBER_SINT32_TYPE, (&mut num as *mut i32).cast()) {
                parsed_code = Some(num);
            }
        } else if type_id == CFStringGetTypeID() {
            let mut buf = [0u8; 32];
            if CFStringGetCString(
                val,
                buf.as_mut_ptr().cast(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            ) {
                if let Ok(s) = CStr::from_ptr(buf.as_ptr().cast()).to_str() {
                    parsed_code = s.trim().parse::<i32>().ok();
                }
            }
        }
        CFRelease(val);

        let hex = match parsed_code? {
            -1 => "#8E8E93", // Graphite
            0 => "#FF3B30",  // Red
            1 => "#FF9500",  // Orange
            2 => "#FFCC00",  // Yellow
            3 => "#34C759",  // Green
            4 => "#007AFF",  // Blue
            5 => "#AF52DE",  // Purple
            6 => "#FF2D55",  // Pink
            _ => return None,
        };
        Some(hex.to_string())
    }
}

#[tauri::command]
fn get_system_accent_color() -> Option<String> {
    #[cfg(windows)]
    {
        return read_windows_accent_hex();
    }
    #[cfg(target_os = "macos")]
    {
        return read_macos_accent_hex();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
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

fn fit_normal_window_to_monitor(window: &WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let target_w = ((1280.0 * scale).round() as u32)
            .min((size.width as f64 * 0.85).round() as u32)
            .max(640)
            .min(size.width.max(320));
        let target_h = ((820.0 * scale).round() as u32)
            .min((size.height as f64 * 0.82).round() as u32)
            .max(480)
            .min(size.height.max(240));
        let x = pos.x + ((size.width.saturating_sub(target_w)) / 2) as i32;
        let y = pos.y + ((size.height.saturating_sub(target_h)) / 2) as i32;
        let _ = window.set_size(PhysicalSize::new(target_w, target_h));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[cfg(windows)]
fn code_to_windows_vk(code: &str) -> Option<i32> {
    if let Some(rest) = code.strip_prefix("Key") {
        let bytes = rest.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
            return Some(bytes[0] as i32);
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        let bytes = rest.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_digit() {
            return Some(bytes[0] as i32);
        }
    }
    if let Some(rest) = code.strip_prefix("Numpad") {
        let bytes = rest.as_bytes();
        if bytes.len() == 1 && bytes[0].is_ascii_digit() {
            return Some(0x60 + (bytes[0] - b'0') as i32);
        }
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<i32>() {
            if (1..=12).contains(&n) {
                return Some(0x6F + n);
            }
        }
    }
    match code {
        "Backquote" => Some(0xC0),
        "Minus" => Some(0xBD),
        "Equal" => Some(0xBB),
        "BracketLeft" => Some(0xDB),
        "BracketRight" => Some(0xDD),
        "Backslash" => Some(0xDC),
        "Semicolon" => Some(0xBA),
        "Quote" => Some(0xDE),
        "Comma" => Some(0xBC),
        "Period" => Some(0xBE),
        "Slash" => Some(0xBF),
        "Space" => Some(0x20),
        "Tab" => Some(0x09),
        "Insert" => Some(0x2D),
        "Delete" => Some(0x2E),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "Pause" => Some(0x13),
        "ScrollLock" => Some(0x91),
        _ => None,
    }
}

#[cfg(windows)]
fn spawn_windows_overlay_poller(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MENU, VK_RBUTTON, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut prev_hotkey_down = false;
        let mut prev_accent = read_windows_accent_hex();
        let mut accent_tick: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(25));

            // Poll Windows system accent color every ~2s so theme changes apply live
            accent_tick = accent_tick.wrapping_add(1);
            if accent_tick % 80 == 0 {
                let current = read_windows_accent_hex();
                if current != prev_accent {
                    prev_accent = current.clone();
                    if let Some(hex) = current {
                        let _ = window.emit("system-accent-changed", hex);
                    }
                }
            }

            let (initialized, auto_enabled, force_ct, bar_rect, dock_rect, quad, last_ignore, toggle_hotkey) = {
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
                    guard.toggle_hotkey.clone(),
                )
            };

            let hotkey_down = if let Some(ref hk) = toggle_hotkey {
                if let Some(vk) = code_to_windows_vk(&hk.code) {
                    unsafe {
                        let key_down = (GetAsyncKeyState(vk) as u16 & 0x8000) != 0;
                        let ctrl_down = (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0;
                        let shift_down = (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0;
                        let alt_down = (GetAsyncKeyState(VK_MENU as i32) as u16 & 0x8000) != 0;
                        let meta_down = (GetAsyncKeyState(VK_LWIN as i32) as u16 & 0x8000) != 0
                            || (GetAsyncKeyState(VK_RWIN as i32) as u16 & 0x8000) != 0;
                        key_down
                            && ctrl_down == hk.ctrl
                            && shift_down == hk.shift
                            && alt_down == hk.alt
                            && meta_down == hk.meta
                    }
                } else {
                    false
                }
            } else {
                false
            };

            if hotkey_down && !prev_hotkey_down && auto_enabled {
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
fn code_to_macos_keycode(code: &str) -> Option<u16> {
    match code {
        "KeyA" => Some(0),
        "KeyS" => Some(1),
        "KeyD" => Some(2),
        "KeyF" => Some(3),
        "KeyH" => Some(4),
        "KeyG" => Some(5),
        "KeyZ" => Some(6),
        "KeyX" => Some(7),
        "KeyC" => Some(8),
        "KeyV" => Some(9),
        "KeyB" => Some(11),
        "KeyQ" => Some(12),
        "KeyW" => Some(13),
        "KeyE" => Some(14),
        "KeyR" => Some(15),
        "KeyY" => Some(16),
        "KeyT" => Some(17),
        "Digit1" => Some(18),
        "Digit2" => Some(19),
        "Digit3" => Some(20),
        "Digit4" => Some(21),
        "Digit6" => Some(22),
        "Digit5" => Some(23),
        "Equal" => Some(24),
        "Digit9" => Some(25),
        "Digit7" => Some(26),
        "Minus" => Some(27),
        "Digit8" => Some(28),
        "Digit0" => Some(29),
        "BracketRight" => Some(30),
        "KeyO" => Some(31),
        "KeyU" => Some(32),
        "BracketLeft" => Some(33),
        "KeyI" => Some(34),
        "KeyP" => Some(35),
        "KeyL" => Some(37),
        "KeyJ" => Some(38),
        "Quote" => Some(39),
        "KeyK" => Some(40),
        "Semicolon" => Some(41),
        "Backslash" => Some(42),
        "Comma" => Some(43),
        "Slash" => Some(44),
        "KeyN" => Some(45),
        "KeyM" => Some(46),
        "Period" => Some(47),
        "Tab" => Some(48),
        "Space" => Some(49),
        "Backquote" => Some(50),
        "Delete" => Some(117),
        "Home" => Some(115),
        "End" => Some(119),
        "PageUp" => Some(116),
        "PageDown" => Some(121),
        "F1" => Some(122),
        "F2" => Some(120),
        "F3" => Some(99),
        "F4" => Some(118),
        "F5" => Some(96),
        "F6" => Some(97),
        "F7" => Some(98),
        "F8" => Some(100),
        "F9" => Some(101),
        "F10" => Some(109),
        "F11" => Some(103),
        "F12" => Some(111),
        "Numpad0" => Some(82),
        "Numpad1" => Some(83),
        "Numpad2" => Some(84),
        "Numpad3" => Some(85),
        "Numpad4" => Some(86),
        "Numpad5" => Some(87),
        "Numpad6" => Some(88),
        "Numpad7" => Some(89),
        "Numpad8" => Some(91),
        "Numpad9" => Some(92),
        _ => None,
    }
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
    const KEY_CMD_L: u16 = 55;
    const KEY_CMD_R: u16 = 54;
    const KEY_SHIFT_L: u16 = 56;
    const KEY_SHIFT_R: u16 = 60;
    const KEY_OPT_L: u16 = 58;
    const KEY_OPT_R: u16 = 61;
    const KEY_CTRL_L: u16 = 59;
    const KEY_CTRL_R: u16 = 62;

    thread::spawn(move || {
        let mut prev_hotkey_down = false;
        let mut prev_accent = read_macos_accent_hex();
        let mut accent_tick: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(25));

            // Poll macOS system accent color via CoreFoundation every ~2s so theme changes apply live
            accent_tick = accent_tick.wrapping_add(1);
            if accent_tick % 80 == 0 {
                let current = read_macos_accent_hex();
                if current != prev_accent {
                    prev_accent = current.clone();
                    let _ = window.emit("system-accent-changed", current);
                }
            }

            let (initialized, auto_enabled, force_ct, bar_rect, dock_rect, quad, last_ignore, toggle_hotkey) = {
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
                    guard.toggle_hotkey.clone(),
                )
            };

            let hotkey_down = if let Some(ref hk) = toggle_hotkey {
                if let Some(kc) = code_to_macos_keycode(&hk.code) {
                    unsafe {
                        let key_down = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, kc);
                        let ctrl_down = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CTRL_L)
                            || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CTRL_R);
                        let shift_down = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_SHIFT_L)
                            || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_SHIFT_R);
                        let alt_down = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_OPT_L)
                            || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_OPT_R);
                        let meta_down = CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CMD_L)
                            || CGEventSourceKeyState(K_COMBINED_SESSION_STATE, KEY_CMD_R);
                        key_down
                            && ctrl_down == hk.ctrl
                            && shift_down == hk.shift
                            && alt_down == hk.alt
                            && meta_down == hk.meta
                    }
                } else {
                    false
                }
            } else {
                false
            };

            if hotkey_down && !prev_hotkey_down && auto_enabled {
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
        is_overlay_mode: true,
        window_is_dark: true,
        auto_passthrough: true,
        initialized: false,
        toggle_hotkey: Some(HotkeyConfig::default()),
        ..Default::default()
    }));

    let state_for_setup = Arc::clone(&shared_state);

    tauri::Builder::default()
        .manage(AppOverlayState(shared_state))
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_always_on_top,
            set_overlay_window_mode,
            set_window_theme,
            open_external_url,
            update_hit_regions,
            get_system_accent_color,
            set_toggle_hotkey,
            close_app
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = window.set_shadow(false);
                let _ = window.set_maximizable(false);
                let _ = window.set_resizable(false);
                let _ = window.set_ignore_cursor_events(false);
                fit_overlay_window_to_monitor(&window);

                let win_for_evt = window.clone();
                let state_for_evt = Arc::clone(&state_for_setup);
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                        let is_overlay = state_for_evt
                            .lock()
                            .map(|g| g.is_overlay_mode)
                            .unwrap_or(false);
                        if is_overlay {
                            fit_overlay_window_to_monitor(&win_for_evt);
                        }
                    }
                });

                #[cfg(windows)]
                spawn_windows_overlay_poller(window, state_for_setup);

                #[cfg(target_os = "macos")]
                spawn_macos_overlay_poller(window, state_for_setup);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PenpaAnywhere Tauri application");
}
