use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{
    window::Color, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewWindow,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
struct SafeAreaInsets {
    top: u32,
    right: u32,
    bottom: u32,
    left: u32,
}

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
    is_overlay_mode: bool,
    always_on_top: bool,
    window_theme_mode: String,
    window_is_dark: bool,
    auto_passthrough: bool,
    force_click_through: bool,
    drag_active: bool,
    initialized: bool,
    bar_rect: HitRect,
    dock_rect: HitRect,
    ui_rects: Vec<HitRect>,
    quads: Vec<Vec<Point2D>>,
    gizmo_quad: Option<Vec<Point2D>>,
    last_ignore: Option<bool>,
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

fn point_on_quad_border(
    px: f64,
    py: f64,
    quad: &[Point2D],
    corner_pad: f64,
    edge_pad: f64,
) -> bool {
    if quad.len() != 4 {
        return false;
    }
    let corner_pad_sq = corner_pad * corner_pad;
    for pt in quad {
        let dx = px - pt.x;
        let dy = py - pt.y;
        if dx * dx + dy * dy <= corner_pad_sq {
            return true;
        }
    }
    let edge_pad_sq = edge_pad * edge_pad;
    for i in 0..4 {
        let a = &quad[i];
        let b = &quad[(i + 1) % 4];
        if point_to_segment_dist_sq(px, py, a.x, a.y, b.x, b.y) <= edge_pad_sq {
            return true;
        }
    }
    false
}

fn point_in_quad_padded(px: f64, py: f64, quad: &[Point2D], corner_pad: f64) -> bool {
    if point_on_quad_border(px, py, quad, corner_pad, 16.0) {
        return true;
    }
    if quad.len() != 4 {
        return false;
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
fn set_always_on_top(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    always_on_top: bool,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.always_on_top = always_on_top;
    }
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())
}

fn apply_window_theme(window: &WebviewWindow, mode: &str, dark: bool, is_overlay: bool) {
    let target = match mode {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    let _ = window.set_theme(target);
    if !is_overlay {
        let bg = if dark {
            Color(17, 19, 24, 255)
        } else {
            Color(248, 249, 252, 255)
        };
        let _ = window.set_background_color(Some(bg));
    }
}

#[tauri::command]
fn set_overlay_window_mode(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    overlay: bool,
) -> Result<(), String> {
    let (was_overlay, saved_bounds, theme_mode, is_dark, always_on_top) = {
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
        (
            prev,
            guard.saved_normal_bounds,
            guard.window_theme_mode.clone(),
            guard.window_is_dark,
            guard.always_on_top,
        )
    };

    if !overlay {
        let _ = window.set_ignore_cursor_events(false);
        window
            .set_always_on_top(always_on_top)
            .map_err(|e| e.to_string())?;
        apply_window_theme(&window, &theme_mode, is_dark, false);
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
        emit_safe_area_insets(&window, false);
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
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())?;
    fit_overlay_window_to_monitor(&window);
    emit_safe_area_insets(&window, true);
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
    ui_rects: Option<Vec<HitRect>>,
    quads: Option<Vec<Vec<Point2D>>>,
    quad: Option<Vec<Point2D>>,
    gizmo_quad: Option<Vec<Point2D>>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.auto_passthrough = enabled;
        guard.force_click_through = force_click_through;
        guard.bar_rect = bar_rect;
        guard.dock_rect = dock_rect;
        guard.ui_rects = ui_rects.unwrap_or_default();
        let mut next_quads = quads.unwrap_or_default();
        if next_quads.is_empty() {
            if let Some(q) = quad {
                if q.len() == 4 {
                    next_quads.push(q);
                }
            }
        }
        guard.quads = next_quads;
        guard.gizmo_quad = gizmo_quad.filter(|q| q.len() == 4);
        guard.initialized = guard.bar_rect.w > 0.0 && guard.bar_rect.h > 0.0;
        if !enabled {
            guard.last_ignore = Some(false);
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    Ok(())
}

#[tauri::command]
fn set_drag_active(state: State<'_, AppOverlayState>, active: bool) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.drag_active = active;
    }
    Ok(())
}

#[tauri::command]
fn set_window_theme(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    mode: String,
    dark: bool,
) -> Result<(), String> {
    let normalized = match mode.as_str() {
        "dark" | "light" => mode,
        _ => "auto".to_string(),
    };
    let is_overlay = if let Ok(mut guard) = state.0.lock() {
        guard.window_theme_mode = normalized.clone();
        guard.window_is_dark = dark;
        guard.is_overlay_mode
    } else {
        true
    };
    apply_window_theme(&window, &normalized, dark, is_overlay);
    Ok(())
}

fn is_allowed_external_url(raw: &str) -> bool {
    let url = raw.trim();
    if url.is_empty() || url.len() > 32_768 {
        return false;
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        r
    } else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.starts_with('.')
}

fn sanitize_download_filename(raw: &str) -> String {
    let base = raw
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();
    let mut cleaned: String = base
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect();
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    while cleaned.starts_with('.') || cleaned.starts_with(' ') {
        cleaned.remove(0);
    }
    if cleaned.is_empty() {
        "download.bin".to_string()
    } else {
        cleaned
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let payload = match input.find(";base64,") {
        Some(idx) => &input[idx + 8..],
        None => input,
    };
    let mut out = Vec::with_capacity(payload.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in payload.bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return Err("Invalid base64 character".to_string()),
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

fn pick_unique_file_path(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let safe_name = sanitize_download_filename(filename);
    let first = dir.join(&safe_name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match safe_name.rfind('.') {
        Some(dot) if dot > 0 => (&safe_name[..dot], &safe_name[dot..]),
        _ => (safe_name.as_str(), ""),
    };
    for idx in 1..=9999 {
        let candidate = dir.join(format!("{stem} ({idx}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !is_allowed_external_url(trimmed) {
        return Err("URL scheme not allowed".to_string());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = trimmed.encode_utf16().chain(std::iter::once(0)).collect();
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if ret <= 32 {
            return Err(format!("ShellExecuteW failed with code {ret}"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_download_file(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    let bytes = decode_base64(&base64_data)?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
        .or_else(|_| app.path().document_dir())
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = pick_unique_file_path(&dir, &filename);
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&filename)
        .to_string())
}

#[tauri::command]
fn close_app(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn toggle_devtools(window: WebviewWindow) -> bool {
    #[cfg(debug_assertions)]
    {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
        true
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        false
    }
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

#[cfg(windows)]
fn read_windows_apps_dark() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };

    let subkey: Vec<u16> =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16()
            .collect();
    let val_name: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();
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
        return Some(raw == 0);
    }
    None
}

#[cfg(target_os = "macos")]
fn read_macos_apps_dark() -> Option<bool> {
    use std::ffi::{c_char, c_void, CStr};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFTypeID = usize;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

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
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(cf: CFTypeRef);
    }

    unsafe {
        let key_cstr = b"AppleInterfaceStyle\0";
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
            // macOS omits AppleInterfaceStyle when in Light mode
            return Some(false);
        }
        let mut is_dark = false;
        if CFGetTypeID(val) == CFStringGetTypeID() {
            let mut buf = [0u8; 32];
            if CFStringGetCString(
                val,
                buf.as_mut_ptr().cast(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            ) {
                if let Ok(s) = CStr::from_ptr(buf.as_ptr().cast()).to_str() {
                    is_dark = s.trim().eq_ignore_ascii_case("Dark");
                }
            }
        }
        CFRelease(val);
        Some(is_dark)
    }
}

#[tauri::command]
fn get_system_theme(window: WebviewWindow) -> String {
    #[cfg(windows)]
    let is_dark = read_windows_apps_dark()
        .unwrap_or_else(|| matches!(window.theme(), Ok(Theme::Dark)));
    #[cfg(target_os = "macos")]
    let is_dark = read_macos_apps_dark()
        .unwrap_or_else(|| matches!(window.theme(), Ok(Theme::Dark)));
    #[cfg(not(any(windows, target_os = "macos")))]
    let is_dark = matches!(window.theme(), Ok(Theme::Dark));

    if is_dark {
        "dark".to_string()
    } else {
        "light".to_string()
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

fn compute_work_area_insets(
    win_pos: (i32, i32),
    win_size: (u32, u32),
    work_pos: (i32, i32),
    work_size: (u32, u32),
    scale: f64,
) -> SafeAreaInsets {
    let safe_scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let win_left = win_pos.0;
    let win_top = win_pos.1;
    let win_right = win_left.saturating_add(win_size.0 as i32);
    let win_bottom = win_top.saturating_add(win_size.1 as i32);

    let work_left = work_pos.0;
    let work_top = work_pos.1;
    let work_right = work_left.saturating_add(work_size.0 as i32);
    let work_bottom = work_top.saturating_add(work_size.1 as i32);

    let to_css = |px: i32| -> u32 {
        if px <= 0 {
            0
        } else {
            ((px as f64) / safe_scale).round().clamp(0.0, 400.0) as u32
        }
    };

    SafeAreaInsets {
        top: to_css(work_top - win_top),
        right: to_css(win_right - work_right),
        bottom: to_css(win_bottom - work_bottom),
        left: to_css(work_left - win_left),
    }
}

fn read_window_safe_area_insets(window: &WebviewWindow, is_overlay: bool) -> SafeAreaInsets {
    if !is_overlay {
        return SafeAreaInsets::default();
    }
    let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) else {
        return SafeAreaInsets::default();
    };
    let pos = monitor.position();
    let size = monitor.size();
    let work = monitor.work_area();
    #[cfg(windows)]
    let win_h = size.height.saturating_sub(1).max(400);
    #[cfg(not(windows))]
    let win_h = size.height.max(400);

    compute_work_area_insets(
        (pos.x, pos.y),
        (size.width, win_h),
        (work.position.x, work.position.y),
        (work.size.width, work.size.height),
        monitor.scale_factor(),
    )
}

fn emit_safe_area_insets(window: &WebviewWindow, is_overlay: bool) {
    let insets = read_window_safe_area_insets(window, is_overlay);
    let _ = window.emit("safe-area-insets-changed", insets);
}

#[tauri::command]
fn get_safe_area_insets(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
) -> SafeAreaInsets {
    let is_overlay = state
        .0
        .lock()
        .map(|g| g.is_overlay_mode)
        .unwrap_or(true);
    read_window_safe_area_insets(&window, is_overlay)
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
fn spawn_windows_theme_watchers(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_NOTIFY,
        REG_NOTIFY_CHANGE_LAST_SET,
    };

    // 1. Zero-polling watcher for Windows DWM AccentColor changes
    let win_accent = window.clone();
    thread::spawn(move || {
        let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\DWM\0"
            .encode_utf16()
            .collect();
        let mut prev_accent = read_windows_accent_hex();
        loop {
            let mut hkey: HKEY = std::ptr::null_mut();
            let open_status = unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    subkey.as_ptr(),
                    0,
                    KEY_NOTIFY,
                    &mut hkey,
                )
            };
            if open_status != 0 || hkey.is_null() {
                thread::sleep(Duration::from_secs(5));
                continue;
            }
            loop {
                // Blocks in kernel until a value under HKCU\Software\Microsoft\Windows\DWM changes (0% CPU)
                let status = unsafe {
                    RegNotifyChangeKeyValue(
                        hkey,
                        0,
                        REG_NOTIFY_CHANGE_LAST_SET,
                        std::ptr::null_mut(),
                        0,
                    )
                };
                if status != 0 {
                    break;
                }
                let current = read_windows_accent_hex();
                if current != prev_accent {
                    prev_accent = current.clone();
                    let _ = win_accent.emit("system-accent-changed", current);
                }
            }
            unsafe {
                RegCloseKey(hkey);
            }
            thread::sleep(Duration::from_secs(1));
        }
    });

    // 2. Zero-polling watcher for Windows AppsUseLightTheme (Auto Dark/Light mode)
    let win_theme = window;
    thread::spawn(move || {
        let subkey: Vec<u16> =
            "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
                .encode_utf16()
                .collect();
        let mut prev_dark = read_windows_apps_dark();
        loop {
            let mut hkey: HKEY = std::ptr::null_mut();
            let open_status = unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    subkey.as_ptr(),
                    0,
                    KEY_NOTIFY,
                    &mut hkey,
                )
            };
            if open_status != 0 || hkey.is_null() {
                thread::sleep(Duration::from_secs(5));
                continue;
            }
            loop {
                // Blocks in kernel until a value under Themes\Personalize changes (0% CPU)
                let status = unsafe {
                    RegNotifyChangeKeyValue(
                        hkey,
                        0,
                        REG_NOTIFY_CHANGE_LAST_SET,
                        std::ptr::null_mut(),
                        0,
                    )
                };
                if status != 0 {
                    break;
                }
                let current = read_windows_apps_dark();
                if current != prev_dark {
                    prev_dark = current;
                    if let Some(is_dark) = current {
                        let (is_auto, is_overlay) = if let Ok(mut guard) = state.lock() {
                            let auto_mode = guard.window_theme_mode == "auto";
                            if auto_mode {
                                guard.window_is_dark = is_dark;
                            }
                            (auto_mode, guard.is_overlay_mode)
                        } else {
                            (true, true)
                        };
                        if is_auto && !is_overlay {
                            let w = win_theme.clone();
                            let _ = win_theme.run_on_main_thread(move || {
                                let bg = if is_dark {
                                    Color(17, 19, 24, 255)
                                } else {
                                    Color(248, 249, 252, 255)
                                };
                                let _ = w.set_background_color(Some(bg));
                            });
                        }
                        let _ = win_theme.emit(
                            "system-theme-changed",
                            if is_dark { "dark" } else { "light" },
                        );
                    }
                }
            }
            unsafe {
                RegCloseKey(hkey);
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(windows)]
fn spawn_windows_overlay_poller(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut last_emitted_cursor: (f64, f64) = (-10000.0, -10000.0);
        let mut last_safe_insets: Option<SafeAreaInsets> = None;
        let mut safe_check_ticks: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(12));

            let (is_overlay, initialized, auto_enabled, force_ct, drag_active, bar_rect, dock_rect, ui_rects, quads, gizmo_quad, last_ignore) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.is_overlay_mode,
                    guard.initialized,
                    guard.auto_passthrough,
                    guard.force_click_through,
                    guard.drag_active,
                    guard.bar_rect.clone(),
                    guard.dock_rect.clone(),
                    guard.ui_rects.clone(),
                    guard.quads.clone(),
                    guard.gizmo_quad.clone(),
                    guard.last_ignore,
                )
            };

            // Periodically sync monitor work area (~480ms) while in overlay mode so toggling
            // taskbar auto-hide or resizing/moving the taskbar immediately updates safe insets.
            safe_check_ticks = safe_check_ticks.wrapping_add(1);
            if safe_check_ticks % 40 == 0 {
                let current_insets = read_window_safe_area_insets(&window, is_overlay);
                if last_safe_insets != Some(current_insets) {
                    last_safe_insets = Some(current_insets);
                    let _ = window.emit("safe-area-insets-changed", current_insets);
                }
            }

            if !auto_enabled || !initialized {
                continue;
            }

            let mouse_down = unsafe {
                (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0
                    || (GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000) != 0
                    || (GetAsyncKeyState(VK_MBUTTON as i32) as u16 & 0x8000) != 0
            };
            if mouse_down && (last_ignore == Some(false) || drag_active) {
                if last_ignore != Some(false) {
                    apply_ignore_cursor(&window, false);
                    if let Ok(mut guard) = state.lock() {
                        guard.last_ignore = Some(false);
                    }
                }
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

            if (local_x - last_emitted_cursor.0).abs() >= 2.0
                || (local_y - last_emitted_cursor.1).abs() >= 2.0
            {
                last_emitted_cursor = (local_x, local_y);
                let _ = window.emit("overlay-cursor-pos", (local_x, local_y));
            }

            let hit_bar = point_in_rect_padded(local_x, local_y, &bar_rect, 14.0);
            let hit_dock = point_in_rect_padded(local_x, local_y, &dock_rect, 14.0);
            let hit_extra_ui = ui_rects
                .iter()
                .any(|r| point_in_rect_padded(local_x, local_y, r, 10.0));
            let hit_ui = hit_bar || hit_dock || hit_extra_ui;
            let should_ignore = if force_ct {
                // Element-level pass-through never disables UI windows (ControlBar, PenpaDock, Layers, Toolbar)
                !hit_ui
            } else {
                let hit_board = quads
                    .iter()
                    .any(|q| point_in_quad_padded(local_x, local_y, q, 26.0));
                let hit_gizmo = gizmo_quad
                    .as_deref()
                    .map(|q| point_on_quad_border(local_x, local_y, q, 24.0, 16.0))
                    .unwrap_or(false);
                !(hit_ui || hit_board || hit_gizmo)
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
fn spawn_macos_theme_watcher(window: WebviewWindow, state: Arc<Mutex<HitState>>) {
    use std::ffi::{c_char, c_void};
    use std::thread;

    type CFNotificationCenterRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFNotificationCallback = extern "C" fn(
        center: CFNotificationCenterRef,
        observer: *mut c_void,
        name: CFStringRef,
        object: *const c_void,
        user_info: CFDictionaryRef,
    );

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NOTIFICATION_SUSPENSION_BEHAVIOR_DELIVER_IMMEDIATELY: isize = 4;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFNotificationCenterGetDistributedCenter() -> CFNotificationCenterRef;
        fn CFNotificationCenterAddObserver(
            center: CFNotificationCenterRef,
            observer: *const c_void,
            callback: CFNotificationCallback,
            name: CFStringRef,
            object: *const c_void,
            suspension_behavior: isize,
        );
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
        fn CFRunLoopRun();
    }

    struct MacThemeObserverCtx {
        window: WebviewWindow,
        state: Arc<Mutex<HitState>>,
        last_accent: Mutex<Option<String>>,
        last_dark: Mutex<Option<bool>>,
    }

    extern "C" fn on_accent_changed(
        _center: CFNotificationCenterRef,
        observer: *mut c_void,
        _name: CFStringRef,
        _object: *const c_void,
        _user_info: CFDictionaryRef,
    ) {
        if observer.is_null() {
            return;
        }
        let ctx = unsafe { &*(observer as *const MacThemeObserverCtx) };
        let current = read_macos_accent_hex();
        let changed = if let Ok(mut prev) = ctx.last_accent.lock() {
            if *prev != current {
                *prev = current.clone();
                true
            } else {
                false
            }
        } else {
            false
        };
        if changed {
            let _ = ctx.window.emit("system-accent-changed", current);
        }
    }

    extern "C" fn on_interface_theme_changed(
        _center: CFNotificationCenterRef,
        observer: *mut c_void,
        _name: CFStringRef,
        _object: *const c_void,
        _user_info: CFDictionaryRef,
    ) {
        if observer.is_null() {
            return;
        }
        let ctx = unsafe { &*(observer as *const MacThemeObserverCtx) };
        let current = read_macos_apps_dark();
        let changed = if let Ok(mut prev) = ctx.last_dark.lock() {
            if *prev != current {
                *prev = current;
                true
            } else {
                false
            }
        } else {
            false
        };
        if changed {
            if let Some(is_dark) = current {
                let (is_auto, is_overlay) = if let Ok(mut guard) = ctx.state.lock() {
                    let auto_mode = guard.window_theme_mode == "auto";
                    if auto_mode {
                        guard.window_is_dark = is_dark;
                    }
                    (auto_mode, guard.is_overlay_mode)
                } else {
                    (true, true)
                };
                if is_auto && !is_overlay {
                    let w = ctx.window.clone();
                    let _ = ctx.window.run_on_main_thread(move || {
                        let bg = if is_dark {
                            Color(17, 19, 24, 255)
                        } else {
                            Color(248, 249, 252, 255)
                        };
                        let _ = w.set_background_color(Some(bg));
                    });
                }
                let _ = ctx
                    .window
                    .emit("system-theme-changed", if is_dark { "dark" } else { "light" });
            }
        }
    }

    thread::spawn(move || {
        let ctx = Box::into_raw(Box::new(MacThemeObserverCtx {
            window,
            state,
            last_accent: Mutex::new(read_macos_accent_hex()),
            last_dark: Mutex::new(read_macos_apps_dark()),
        }));
        unsafe {
            let center = CFNotificationCenterGetDistributedCenter();
            if center.is_null() {
                return;
            }
            let accent_name = CFStringCreateWithCString(
                std::ptr::null(),
                b"AppleColorPreferencesChangedNotification\0".as_ptr().cast(),
                K_CF_STRING_ENCODING_UTF8,
            );
            if !accent_name.is_null() {
                CFNotificationCenterAddObserver(
                    center,
                    ctx.cast(),
                    on_accent_changed,
                    accent_name,
                    std::ptr::null(),
                    K_CF_NOTIFICATION_SUSPENSION_BEHAVIOR_DELIVER_IMMEDIATELY,
                );
                CFRelease(accent_name);
            }
            let theme_name = CFStringCreateWithCString(
                std::ptr::null(),
                b"AppleInterfaceThemeChangedNotification\0".as_ptr().cast(),
                K_CF_STRING_ENCODING_UTF8,
            );
            if !theme_name.is_null() {
                CFNotificationCenterAddObserver(
                    center,
                    ctx.cast(),
                    on_interface_theme_changed,
                    theme_name,
                    std::ptr::null(),
                    K_CF_NOTIFICATION_SUSPENSION_BEHAVIOR_DELIVER_IMMEDIATELY,
                );
                CFRelease(theme_name);
            }
            CFRunLoopRun();
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
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const K_COMBINED_SESSION_STATE: i32 = 0;

    thread::spawn(move || {
        let mut last_emitted_cursor: (f64, f64) = (-10000.0, -10000.0);
        loop {
            thread::sleep(Duration::from_millis(25));

            let (initialized, auto_enabled, force_ct, bar_rect, dock_rect, ui_rects, quads, gizmo_quad, last_ignore) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.initialized,
                    guard.auto_passthrough,
                    guard.force_click_through,
                    guard.bar_rect.clone(),
                    guard.dock_rect.clone(),
                    guard.ui_rects.clone(),
                    guard.quads.clone(),
                    guard.gizmo_quad.clone(),
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

            if (local_x - last_emitted_cursor.0).abs() >= 2.0
                || (local_y - last_emitted_cursor.1).abs() >= 2.0
            {
                last_emitted_cursor = (local_x, local_y);
                let _ = window.emit("overlay-cursor-pos", (local_x, local_y));
            }

            let hit_bar = point_in_rect_padded(local_x, local_y, &bar_rect, 14.0);
            let hit_dock = point_in_rect_padded(local_x, local_y, &dock_rect, 14.0);
            let hit_extra_ui = ui_rects
                .iter()
                .any(|r| point_in_rect_padded(local_x, local_y, r, 10.0));
            let hit_ui = hit_bar || hit_dock || hit_extra_ui;
            let should_ignore = if force_ct {
                !hit_ui
            } else {
                let hit_board = quads
                    .iter()
                    .any(|q| point_in_quad_padded(local_x, local_y, q, 26.0));
                let hit_gizmo = gizmo_quad
                    .as_deref()
                    .map(|q| point_on_quad_border(local_x, local_y, q, 24.0, 16.0))
                    .unwrap_or(false);
                !(hit_ui || hit_board || hit_gizmo)
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
        window_theme_mode: "auto".to_string(),
        window_is_dark: true,
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
            set_window_theme,
            open_external_url,
            save_download_file,
            update_hit_regions,
            set_drag_active,
            get_system_theme,
            get_system_accent_color,
            get_safe_area_insets,
            close_app,
            is_debug_build,
            toggle_devtools
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = window.set_shadow(false);
                let _ = window.set_maximizable(false);
                let _ = window.set_resizable(false);
                let _ = window.set_always_on_top(false);
                let _ = window.set_ignore_cursor_events(false);
                fit_overlay_window_to_monitor(&window);
                emit_safe_area_insets(&window, true);

                let win_for_evt = window.clone();
                let state_for_evt = Arc::clone(&state_for_setup);
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        let is_overlay = state_for_evt
                            .lock()
                            .map(|g| g.is_overlay_mode)
                            .unwrap_or(false);
                        if is_overlay {
                            fit_overlay_window_to_monitor(&win_for_evt);
                        }
                        emit_safe_area_insets(&win_for_evt, is_overlay);
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let is_overlay = state_for_evt
                            .lock()
                            .map(|g| g.is_overlay_mode)
                            .unwrap_or(false);
                        emit_safe_area_insets(&win_for_evt, is_overlay);
                    }
                    tauri::WindowEvent::ThemeChanged(theme) => {
                        let is_dark = matches!(theme, Theme::Dark);
                        let (is_auto, is_overlay) = if let Ok(mut guard) = state_for_evt.lock() {
                            let auto_mode = guard.window_theme_mode == "auto";
                            if auto_mode {
                                guard.window_is_dark = is_dark;
                            }
                            (auto_mode, guard.is_overlay_mode)
                        } else {
                            (true, true)
                        };
                        if is_auto && !is_overlay {
                            let bg = if is_dark {
                                Color(17, 19, 24, 255)
                            } else {
                                Color(248, 249, 252, 255)
                            };
                            let _ = win_for_evt.set_background_color(Some(bg));
                        }
                        let _ = win_for_evt.emit(
                            "system-theme-changed",
                            if is_dark { "dark" } else { "light" },
                        );
                    }
                    _ => {}
                });

                #[cfg(windows)]
                {
                    spawn_windows_theme_watchers(window.clone(), Arc::clone(&state_for_setup));
                    spawn_windows_overlay_poller(window, state_for_setup);
                }

                #[cfg(target_os = "macos")]
                {
                    spawn_macos_theme_watcher(window.clone(), Arc::clone(&state_for_setup));
                    spawn_macos_overlay_poller(window, state_for_setup);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PenpaAnywhere Tauri application");
}

#[cfg(all(test, windows))]
mod windows_theme_tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteTreeW, RegNotifyChangeKeyValue, RegOpenKeyExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_NOTIFY, REG_DWORD,
        REG_NOTIFY_CHANGE_LAST_SET,
    };

    #[test]
    fn reads_real_windows_theme_and_accent() {
        let dark = read_windows_apps_dark();
        let accent = read_windows_accent_hex();
        println!("REAL_WINDOWS_REG: dark={dark:?}, accent={accent:?}");
        assert!(dark.is_some(), "AppsUseLightTheme should be readable on Windows");
        if let Some(ref hex) = accent {
            assert_eq!(hex.len(), 7);
            assert!(hex.starts_with('#'));
        }
    }

    #[test]
    fn reg_notify_wakes_immediately_without_polling() {
        let subkey: Vec<u16> = "Software\\PenpaAnywhereRegNotifyTest\0"
            .encode_utf16()
            .collect();
        let val_name: Vec<u16> = "TestDword\0".encode_utf16().collect();

        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, subkey.as_ptr(), &mut hkey) };
        assert_eq!(status, 0, "RegCreateKeyW failed");

        let (tx, rx) = mpsc::channel();
        let subkey_watch = subkey.clone();
        let watcher = thread::spawn(move || {
            let mut watch_key: HKEY = std::ptr::null_mut();
            let open = unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    subkey_watch.as_ptr(),
                    0,
                    KEY_NOTIFY,
                    &mut watch_key,
                )
            };
            assert_eq!(open, 0);
            tx.send("ready").unwrap();
            let notify_status = unsafe {
                RegNotifyChangeKeyValue(
                    watch_key,
                    0,
                    REG_NOTIFY_CHANGE_LAST_SET,
                    std::ptr::null_mut(),
                    0,
                )
            };
            unsafe {
                RegCloseKey(watch_key);
            }
            tx.send(if notify_status == 0 { "notified" } else { "err" })
                .unwrap();
        });

        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "ready");
        // Give watcher 40ms to enter kernel wait
        thread::sleep(Duration::from_millis(40));

        let t0 = Instant::now();
        let new_val: u32 = 42;
        let set_status = unsafe {
            RegSetValueExW(
                hkey,
                val_name.as_ptr(),
                0,
                REG_DWORD,
                (&new_val as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        assert_eq!(set_status, 0);

        let evt = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let elapsed_ms = t0.elapsed().as_millis();
        println!("REG_NOTIFY_EVENT={evt} elapsed_ms={elapsed_ms}");
        assert_eq!(evt, "notified");
        assert!(elapsed_ms < 500, "RegNotifyChangeKeyValue should wake almost instantly");

        watcher.join().unwrap();
        unsafe {
            RegCloseKey(hkey);
            RegDeleteTreeW(HKEY_CURRENT_USER, subkey.as_ptr());
        }
    }
}

#[cfg(test)]
mod io_utils_tests {
    use super::*;

    #[test]
    fn validates_external_urls_strictly() {
        assert!(is_allowed_external_url(
            "https://swaroopg92.github.io/penpa-edit/#m=edit&p=abc123"
        ));
        assert!(is_allowed_external_url("http://tinyurl.com/app"));
        assert!(!is_allowed_external_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("https://example.com/\ncalc"));
        assert!(!is_allowed_external_url("https://"));
        assert!(!is_allowed_external_url(""));
    }

    #[test]
    fn sanitizes_filenames_and_deduplicates() {
        assert_eq!(sanitize_download_filename("../../evil:name?.png"), "evilname.png");
        assert_eq!(sanitize_download_filename("  ...  "), "download.bin");
        assert_eq!(sanitize_download_filename("puzzle.txt"), "puzzle.txt");

        let tmp = std::env::temp_dir().join(format!(
            "penpaanywhere-dl-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let p0 = pick_unique_file_path(&tmp, "puzzle.png");
        assert_eq!(p0.file_name().unwrap(), "puzzle.png");
        std::fs::write(&p0, b"1").unwrap();
        let p1 = pick_unique_file_path(&tmp, "puzzle.png");
        assert_eq!(p1.file_name().unwrap(), "puzzle (1).png");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn decodes_base64_and_data_uri() {
        assert_eq!(decode_base64("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(
            decode_base64("data:text/plain;base64,UGVucGEr\n").unwrap(),
            b"Penpa+"
        );
        assert!(decode_base64("not!valid@base64").is_err());
    }

    #[test]
    fn computes_taskbar_work_area_insets() {
        // Bottom 48px taskbar on 1920x1080 @ 1.0x (overlay window height = 1079 on Windows)
        let bottom = compute_work_area_insets((0, 0), (1920, 1079), (0, 0), (1920, 1032), 1.0);
        assert_eq!(
            bottom,
            SafeAreaInsets {
                top: 0,
                right: 0,
                bottom: 47,
                left: 0
            }
        );

        // Bottom 72px taskbar on 2560x1440 @ 1.5x -> 48 CSS px
        let hidpi = compute_work_area_insets((0, 0), (2560, 1439), (0, 0), (2560, 1368), 1.5);
        assert_eq!(
            hidpi,
            SafeAreaInsets {
                top: 0,
                right: 0,
                bottom: 47,
                left: 0
            }
        );

        // Left 60px docked taskbar @ 1.0x
        let left = compute_work_area_insets((0, 0), (1920, 1079), (60, 0), (1860, 1080), 1.0);
        assert_eq!(
            left,
            SafeAreaInsets {
                top: 0,
                right: 0,
                bottom: 0,
                left: 60
            }
        );

        // Auto-hidden taskbar (work_area == full monitor) -> all 0
        let hidden = compute_work_area_insets((0, 0), (1920, 1079), (0, 0), (1920, 1080), 1.0);
        assert_eq!(hidden, SafeAreaInsets::default());
    }

    #[test]
    fn gizmo_border_hit_test_covers_edges_and_corners_not_hollow_interior() {
        let quad = vec![
            Point2D { x: 100.0, y: 100.0 },
            Point2D { x: 500.0, y: 100.0 },
            Point2D { x: 500.0, y: 400.0 },
            Point2D { x: 100.0, y: 400.0 },
        ];
        // Empty corner of a diagonal group's bounding box -> HIT
        assert!(point_on_quad_border(500.0, 100.0, &quad, 24.0, 16.0));
        assert!(point_on_quad_border(516.0, 86.0, &quad, 24.0, 16.0));
        // Empty span along top & left edges -> HIT
        assert!(point_on_quad_border(300.0, 100.0, &quad, 24.0, 16.0));
        assert!(point_on_quad_border(100.0, 260.0, &quad, 24.0, 16.0));
        assert!(point_on_quad_border(300.0, 114.0, &quad, 24.0, 16.0));
        // Hollow interior far from edges -> PASS THROUGH (false)
        assert!(!point_on_quad_border(300.0, 250.0, &quad, 24.0, 16.0));
        // Outside far from edges -> PASS THROUGH (false)
        assert!(!point_on_quad_border(300.0, 60.0, &quad, 24.0, 16.0));
    }
}
