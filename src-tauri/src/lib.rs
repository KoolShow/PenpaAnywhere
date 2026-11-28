use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    window::Color,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
struct SafeAreaInsets {
    top: u32,
    right: u32,
    bottom: u32,
    left: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
struct PhysicalRect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorDescriptor {
    id: String,
    name: String,
    phys_rect: PhysicalRect,
    work_area: PhysicalRect,
    scale: f64,
    is_primary: bool,
    is_launch: bool,
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

#[derive(Debug, Clone, Default)]
struct ViewportHitState {
    auto_passthrough: bool,
    force_click_through: bool,
    initialized: bool,
    bar_rect: HitRect,
    dock_rect: HitRect,
    ui_rects: Vec<HitRect>,
    quads: Vec<Vec<Point2D>>,
    gizmo_quad: Option<Vec<Point2D>>,
    last_ignore: Option<bool>,
}

#[cfg(windows)]
const WINDOWS_WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

#[derive(Debug, Clone)]
struct ActiveSurfaceDrag {
    label: String,
    cursor_start: (i32, i32),
    win_start: (i32, i32),
    logical_w: f64,
    logical_h: f64,
    last_phys_pos: (i32, i32),
    last_phys_size: (u32, u32),
}

#[derive(Debug, Default)]
struct HitState {
    is_overlay_mode: bool,
    multi_monitor_enabled: bool,
    always_on_top: bool,
    window_theme_mode: String,
    window_is_dark: bool,
    drag_active: bool,
    active_surface_drag: Option<ActiveSurfaceDrag>,
    launch_monitor_id: Option<String>,
    main_monitor_id: Option<String>,
    monitors: Vec<MonitorDescriptor>,
    /// monitor_id -> secondary overlay window label ("overlay-...")
    secondary_overlays: HashMap<String, String>,
    /// surface_id -> native floating surface window label ("dock-..." / "surface-...")
    surface_windows: HashMap<String, String>,
    /// window_label -> per-window overlay hit-test regions ("main", "overlay-*")
    viewports: HashMap<String, ViewportHitState>,
    saved_normal_bounds: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
}

struct AppOverlayState(Arc<Mutex<HitState>>);

#[derive(Debug, Clone)]
struct GridFrameEntry {
    seq: u64,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[derive(Default)]
struct AppFrameStore(Arc<RwLock<HashMap<String, GridFrameEntry>>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GridFrameMeta {
    grid_id: String,
    seq: u64,
    width: u32,
    height: u32,
}

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
    let label = window.label().to_string();
    if let Ok(mut guard) = state.0.lock() {
        let vp = guard.viewports.entry(label).or_default();
        vp.force_click_through = ignore;
        // Let the poller decide cursor ignore dynamically so the top control bar stays clickable!
        if !ignore {
            vp.last_ignore = Some(false);
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    always_on_top: bool,
) -> Result<(), String> {
    let (overlay_labels, surface_labels) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "overlay state lock poisoned".to_string())?;
        guard.always_on_top = always_on_top;
        (
            guard.secondary_overlays.values().cloned().collect::<Vec<_>>(),
            guard.surface_windows.values().cloned().collect::<Vec<_>>(),
        )
    };
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| e.to_string())?;
    for label in overlay_labels.into_iter().chain(surface_labels.into_iter()) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_always_on_top(always_on_top);
        }
    }
    Ok(())
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
async fn set_overlay_window_mode(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
    overlay: bool,
) -> Result<(), String> {
    let (was_overlay, saved_bounds, theme_mode, is_dark, always_on_top, main_monitor) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "overlay state lock poisoned".to_string())?;
        let prev = guard.is_overlay_mode;
        guard.is_overlay_mode = overlay;
        let vp = guard.viewports.entry("main".to_string()).or_default();
        vp.auto_passthrough = overlay;
        if !overlay {
            vp.force_click_through = false;
            vp.last_ignore = Some(false);
        } else {
            vp.last_ignore = None;
        }
        let target_mon = resolve_main_monitor(&guard.monitors, guard.main_monitor_id.as_deref());
        (
            prev,
            guard.saved_normal_bounds,
            guard.window_theme_mode.clone(),
            guard.window_is_dark,
            guard.always_on_top,
            target_mon,
        )
    };

    if !overlay {
        reconcile_secondary_overlays(&app, &state.0);
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
                fit_normal_window_to_monitor(&window, main_monitor.as_ref());
            }
            let _ = window.set_focus();
        }
        emit_safe_area_insets_for_window(&window, false, main_monitor.as_ref());
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
    fit_overlay_window_to_monitor(&window, main_monitor.as_ref());
    emit_safe_area_insets_for_window(&window, true, main_monitor.as_ref());
    reconcile_secondary_overlays(&app, &state.0);
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
    let label = window.label().to_string();
    if let Ok(mut guard) = state.0.lock() {
        let vp = guard.viewports.entry(label.clone()).or_default();
        vp.auto_passthrough = enabled;
        vp.force_click_through = force_click_through;
        vp.bar_rect = bar_rect;
        vp.dock_rect = dock_rect;
        vp.ui_rects = ui_rects.unwrap_or_default();
        let mut next_quads = quads.unwrap_or_default();
        if next_quads.is_empty() {
            if let Some(q) = quad {
                if q.len() == 4 {
                    next_quads.push(q);
                }
            }
        }
        vp.quads = next_quads;
        vp.gizmo_quad = gizmo_quad.filter(|q| q.len() == 4);
        // Secondary overlay viewports may not host the main ControlBar; they are initialized as soon
        // as update_hit_regions has been called at least once!
        vp.initialized = if label == "main" {
            vp.bar_rect.w > 0.0 && vp.bar_rect.h > 0.0
        } else {
            true
        };
        if !enabled {
            vp.last_ignore = Some(false);
            let _ = window.set_ignore_cursor_events(false);
        }
    }
    Ok(())
}

#[tauri::command]
fn set_drag_active(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    active: bool,
) -> Result<(), String> {
    let multi_enabled = if let Ok(mut guard) = state.0.lock() {
        guard.drag_active = active;
        guard.multi_monitor_enabled
    } else {
        false
    };
    #[cfg(windows)]
    if active && multi_enabled {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } != 0 {
            let _ = app.emit_to("main", "overlay-global-cursor", (pt.x as f64, pt.y as f64));
        }
    }
    #[cfg(target_os = "macos")]
    if active && multi_enabled {
        if let Some((x, y)) = read_macos_cursor_point() {
            let _ = app.emit_to("main", "overlay-global-cursor", (x, y));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (app, multi_enabled);
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
    let is_main = window.label() == "main";
    let is_overlay = if let Ok(mut guard) = state.0.lock() {
        if is_main {
            guard.window_theme_mode = normalized.clone();
            guard.window_is_dark = dark;
        }
        guard.is_overlay_mode
    } else {
        true
    };
    // Secondary overlay viewports and native floating dock windows are always transparent
    apply_window_theme(&window, &normalized, dark, !is_main || is_overlay);
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
fn close_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
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

fn sanitize_window_label_suffix(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

fn overlay_label_for_monitor(monitor_id: &str) -> String {
    format!("overlay-{}", sanitize_window_label_suffix(monitor_id))
}

fn surface_label_for_id(surface_id: &str) -> String {
    let suffix = sanitize_window_label_suffix(surface_id);
    if suffix.starts_with("dock-") || suffix.starts_with("surface-") {
        suffix
    } else {
        format!("surface-{suffix}")
    }
}

#[allow(dead_code)]
fn encode_query_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn resolve_main_monitor(
    monitors: &[MonitorDescriptor],
    preferred_id: Option<&str>,
) -> Option<MonitorDescriptor> {
    if let Some(pid) = preferred_id {
        if let Some(found) = monitors.iter().find(|m| m.id == pid) {
            return Some(found.clone());
        }
    }
    monitors
        .iter()
        .find(|m| m.is_launch)
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .or_else(|| monitors.first())
        .cloned()
}

fn find_monitor_for_point(
    monitors: &[MonitorDescriptor],
    px: i32,
    py: i32,
) -> Option<MonitorDescriptor> {
    for m in monitors {
        let r = m.phys_rect;
        if px >= r.x
            && px < r.x.saturating_add(r.w as i32)
            && py >= r.y
            && py < r.y.saturating_add(r.h as i32)
        {
            return Some(m.clone());
        }
    }
    monitors
        .iter()
        .min_by_key(|m| {
            let r = m.phys_rect;
            let cx = px.clamp(r.x, r.x.saturating_add(r.w as i32));
            let cy = py.clamp(r.y, r.y.saturating_add(r.h as i32));
            let dx = (px - cx) as i64;
            let dy = (py - cy) as i64;
            dx * dx + dy * dy
        })
        .cloned()
}

#[cfg(windows)]
fn disable_windows_dwm_transitions(window: &WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    if let Ok(hwnd) = window.hwnd() {
        let disabled: u32 = 1;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_TRANSITIONS_FORCEDISABLED as u32,
                (&disabled as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn read_macos_cursor_point() -> Option<(f64, f64)> {
    use std::ffi::c_void;

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
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() {
            return None;
        }
        let loc = CGEventGetLocation(ev);
        CFRelease(ev);
        Some((loc.x, loc.y))
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_launch_monitor_id(monitors: &[MonitorDescriptor]) -> Option<String> {
    let (cx, cy) = read_macos_cursor_point()?;
    find_monitor_for_point(monitors, cx.round() as i32, cy.round() as i32).map(|m| m.id)
}

#[cfg(not(windows))]
fn disable_windows_dwm_transitions(_window: &WebviewWindow) {}

#[cfg(windows)]
fn detect_windows_launch_monitor_id() -> Option<String> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon.is_null() {
            return None;
        }
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info.monitorInfo) == 0 {
            return None;
        }
        let end = info
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.szDevice.len());
        let dev = String::from_utf16_lossy(&info.szDevice[..end]);
        if dev.is_empty() {
            None
        } else {
            Some(dev)
        }
    }
}

#[cfg(windows)]
fn enumerate_monitors(app: &AppHandle, launch_id: Option<&str>) -> Vec<MonitorDescriptor> {
    use windows_sys::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };
    use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

    const MONITORINFOF_PRIMARY: u32 = 1;

    struct CollectCtx {
        list: Vec<MonitorDescriptor>,
    }

    unsafe extern "system" fn enum_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rc: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let ctx = &mut *(data as *mut CollectCtx);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info.monitorInfo) == 0 {
            return 1;
        }
        let end = info
            .szDevice
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.szDevice.len());
        let dev = String::from_utf16_lossy(&info.szDevice[..end]);
        let id = if dev.is_empty() {
            format!("DISPLAY_{}", ctx.list.len() + 1)
        } else {
            dev
        };
        let r = info.monitorInfo.rcMonitor;
        let w = info.monitorInfo.rcWork;
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let scale = if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) == 0
            && dpi_x >= 48
        {
            dpi_x as f64 / 96.0
        } else {
            1.0
        };
        let is_primary = (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
        let display_name = id
            .strip_prefix("\\\\.\\")
            .unwrap_or(&id)
            .to_string();

        ctx.list.push(MonitorDescriptor {
            id,
            name: display_name,
            phys_rect: PhysicalRect {
                x: r.left,
                y: r.top,
                w: (r.right - r.left).max(1) as u32,
                h: (r.bottom - r.top).max(1) as u32,
            },
            work_area: PhysicalRect {
                x: w.left,
                y: w.top,
                w: (w.right - w.left).max(1) as u32,
                h: (w.bottom - w.top).max(1) as u32,
            },
            scale,
            is_primary,
            is_launch: false,
        });
        1
    }

    let mut ctx = CollectCtx { list: Vec::new() };
    unsafe {
        let _ = EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(enum_proc),
            (&mut ctx as *mut CollectCtx) as LPARAM,
        );
    }

    if ctx.list.is_empty() {
        return enumerate_monitors_tauri_fallback(app, launch_id);
    }

    let effective_launch = launch_id
        .filter(|lid| ctx.list.iter().any(|m| m.id == *lid))
        .map(|s| s.to_string())
        .or_else(|| ctx.list.iter().find(|m| m.is_primary).map(|m| m.id.clone()))
        .or_else(|| ctx.list.first().map(|m| m.id.clone()));

    for m in &mut ctx.list {
        m.is_launch = effective_launch.as_deref() == Some(m.id.as_str());
    }
    ctx.list
}

#[cfg(not(windows))]
fn enumerate_monitors(app: &AppHandle, launch_id: Option<&str>) -> Vec<MonitorDescriptor> {
    enumerate_monitors_tauri_fallback(app, launch_id)
}

fn enumerate_monitors_tauri_fallback(
    app: &AppHandle,
    launch_id: Option<&str>,
) -> Vec<MonitorDescriptor> {
    let primary = app.primary_monitor().ok().flatten();
    let Ok(list) = app.available_monitors() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(list.len());
    for (idx, m) in list.into_iter().enumerate() {
        let pos = m.position();
        let size = m.size();
        let work = m.work_area();
        let is_primary = primary
            .as_ref()
            .map(|p| p.position() == pos && p.size() == size)
            .unwrap_or(idx == 0);
        let name = m
            .name()
            .cloned()
            .unwrap_or_else(|| format!("Display {}", idx + 1));
        // On macOS, AppKit/CoreGraphics desktop coordinates and WKWebView CSS pixels both live
        // in one unified Logical Point space (no overlap between 2x Retina & 1x external displays),
        // whereas tao's PhysicalPosition scales each monitor origin by its own scale_factor().
        #[cfg(target_os = "macos")]
        let (rect_x, rect_y, rect_w, rect_h, work_x, work_y, work_w, work_h, norm_scale) = {
            let s = m.scale_factor().max(0.5);
            (
                (pos.x as f64 / s).round() as i32,
                (pos.y as f64 / s).round() as i32,
                ((size.width as f64 / s).round() as u32).max(1),
                ((size.height as f64 / s).round() as u32).max(1),
                (work.position.x as f64 / s).round() as i32,
                (work.position.y as f64 / s).round() as i32,
                ((work.size.width as f64 / s).round() as u32).max(1),
                ((work.size.height as f64 / s).round() as u32).max(1),
                1.0_f64,
            )
        };
        #[cfg(not(target_os = "macos"))]
        let (rect_x, rect_y, rect_w, rect_h, work_x, work_y, work_w, work_h, norm_scale) = (
            pos.x,
            pos.y,
            size.width.max(1),
            size.height.max(1),
            work.position.x,
            work.position.y,
            work.size.width.max(1),
            work.size.height.max(1),
            m.scale_factor(),
        );
        let id = format!("MON_{}_{}_{}", idx, rect_x, rect_y);
        out.push(MonitorDescriptor {
            id,
            name,
            phys_rect: PhysicalRect {
                x: rect_x,
                y: rect_y,
                w: rect_w,
                h: rect_h,
            },
            work_area: PhysicalRect {
                x: work_x,
                y: work_y,
                w: work_w,
                h: work_h,
            },
            scale: norm_scale,
            is_primary,
            is_launch: false,
        });
    }
    let effective_launch = launch_id
        .filter(|lid| out.iter().any(|m| m.id == *lid))
        .map(|s| s.to_string())
        .or_else(|| out.iter().find(|m| m.is_primary).map(|m| m.id.clone()))
        .or_else(|| out.first().map(|m| m.id.clone()));
    for m in &mut out {
        m.is_launch = effective_launch.as_deref() == Some(m.id.as_str());
    }
    out
}

fn compute_monitor_safe_insets(monitor: &MonitorDescriptor, is_overlay: bool) -> SafeAreaInsets {
    if !is_overlay {
        return SafeAreaInsets::default();
    }
    #[cfg(windows)]
    let win_h = monitor.phys_rect.h.saturating_sub(1).max(400);
    #[cfg(not(windows))]
    let win_h = monitor.phys_rect.h.max(400);

    compute_work_area_insets(
        (monitor.phys_rect.x, monitor.phys_rect.y),
        (monitor.phys_rect.w, win_h),
        (monitor.work_area.x, monitor.work_area.y),
        (monitor.work_area.w, monitor.work_area.h),
        monitor.scale,
    )
}

fn read_window_safe_area_insets(
    window: &WebviewWindow,
    is_overlay: bool,
    monitor_hint: Option<&MonitorDescriptor>,
) -> SafeAreaInsets {
    if !is_overlay {
        return SafeAreaInsets::default();
    }
    if let Some(m) = monitor_hint {
        return compute_monitor_safe_insets(m, true);
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

fn emit_safe_area_insets_for_window(
    window: &WebviewWindow,
    is_overlay: bool,
    monitor_hint: Option<&MonitorDescriptor>,
) {
    let insets = read_window_safe_area_insets(window, is_overlay, monitor_hint);
    let _ = window.emit_to(window.label(), "safe-area-insets-changed", insets);
}

#[tauri::command]
fn get_safe_area_insets(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
) -> SafeAreaInsets {
    let label = window.label().to_string();
    if label.starts_with("dock-") || label.starts_with("surface-") {
        return SafeAreaInsets::default();
    }
    let (is_overlay, mon_hint) = state
        .0
        .lock()
        .map(|g| {
            let mon = if label == "main" {
                resolve_main_monitor(&g.monitors, g.main_monitor_id.as_deref())
            } else {
                g.secondary_overlays
                    .iter()
                    .find(|(_, lbl)| *lbl == &label)
                    .and_then(|(mid, _)| g.monitors.iter().find(|m| m.id == *mid).cloned())
            };
            (g.is_overlay_mode, mon)
        })
        .unwrap_or((true, None));
    read_window_safe_area_insets(&window, is_overlay, mon_hint.as_ref())
}

fn apply_window_rect(window: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
        let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(PhysicalSize::new(w, h));
        // Re-apply position after size so mixed-DPI WM_DPICHANGED transitions never drift origin
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

fn fit_overlay_window_to_monitor(window: &WebviewWindow, monitor_hint: Option<&MonitorDescriptor>) {
    if let Some(m) = monitor_hint {
        #[cfg(windows)]
        let h = m.phys_rect.h.saturating_sub(1).max(400);
        #[cfg(not(windows))]
        let h = m.phys_rect.h.max(400);
        apply_window_rect(window, m.phys_rect.x, m.phys_rect.y, m.phys_rect.w, h);
        return;
    }
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
        let pos = monitor.position();
        let size = monitor.size();
        #[cfg(windows)]
        let h = size.height.saturating_sub(1).max(400);
        #[cfg(not(windows))]
        let h = size.height.max(400);
        let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = window.set_size(PhysicalSize::new(size.width, h));
        let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
    }
}

fn fit_normal_window_to_monitor(window: &WebviewWindow, monitor_hint: Option<&MonitorDescriptor>) {
    if let Some(m) = monitor_hint {
        let scale = m.scale.max(0.5);
        let target_w = ((1280.0 * scale).round() as u32)
            .min((m.phys_rect.w as f64 * 0.85).round() as u32)
            .max(640)
            .min(m.phys_rect.w.max(320));
        let target_h = ((820.0 * scale).round() as u32)
            .min((m.phys_rect.h as f64 * 0.82).round() as u32)
            .max(480)
            .min(m.phys_rect.h.max(240));
        let x = m.phys_rect.x + ((m.phys_rect.w.saturating_sub(target_w)) / 2) as i32;
        let y = m.phys_rect.y + ((m.phys_rect.h.saturating_sub(target_h)) / 2) as i32;
        apply_window_rect(window, x, y, target_w, target_h);
        return;
    }
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

/// Reconcile existing secondary `overlay-*` transparent viewport windows against the current monitor topology.
/// - Destroys stale overlays (when multi-monitor is OFF, Canvas mode is active, or a monitor is unplugged).
/// - Repositions/resizes already-open overlays when monitor geometry/DPI changes.
/// - Missing overlays are opened from `main` via `window.open()` + `on_new_window(NewWindowResponse::Create)`
///   so all viewports and docks share the SAME renderer process & GPU context (true zero-copy `texImage2D`!).
fn reconcile_secondary_overlays(app: &AppHandle, state: &Arc<Mutex<HitState>>) {
    let (should_have_secondary, monitors, main_id, existing) = {
        let Ok(mut guard) = state.lock() else {
            return;
        };
        let resolved_main = resolve_main_monitor(&guard.monitors, guard.main_monitor_id.as_deref());
        guard.main_monitor_id = resolved_main.as_ref().map(|m| m.id.clone());
        (
            guard.is_overlay_mode && guard.multi_monitor_enabled,
            guard.monitors.clone(),
            guard.main_monitor_id.clone(),
            guard.secondary_overlays.clone(),
        )
    };

    let desired_monitors: Vec<MonitorDescriptor> = if should_have_secondary {
        monitors
            .into_iter()
            .filter(|m| main_id.as_deref() != Some(m.id.as_str()))
            .collect()
    } else {
        Vec::new()
    };

    let desired_ids: std::collections::HashSet<String> =
        desired_monitors.iter().map(|m| m.id.clone()).collect();

    // 1. Destroy stale secondary overlay windows on a worker task
    let to_remove: Vec<(String, String)> = existing
        .iter()
        .filter(|(mid, _)| !desired_ids.contains(*mid))
        .map(|(mid, lbl)| (mid.clone(), lbl.clone()))
        .collect();

    if !to_remove.is_empty() {
        if let Ok(mut guard) = state.lock() {
            for (mid, lbl) in &to_remove {
                guard.secondary_overlays.remove(mid);
                guard.viewports.remove(lbl);
            }
        }
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            for (_, lbl) in to_remove {
                if let Some(w) = app_clone.get_webview_window(&lbl) {
                    let _ = w.destroy();
                }
            }
        });
    }

    // 2. Update bounds on already-open secondary overlay windows
    for mon in desired_monitors {
        let label = overlay_label_for_monitor(&mon.id);
        let already_mapped = existing.get(&mon.id).map(|l| l == &label).unwrap_or(false);
        if already_mapped && app.get_webview_window(&label).is_some() {
            let app_clone = app.clone();
            let mon_clone = mon.clone();
            let lbl_clone = label.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(w) = app_clone.get_webview_window(&lbl_clone) {
                    fit_overlay_window_to_monitor(&w, Some(&mon_clone));
                    emit_safe_area_insets_for_window(&w, true, Some(&mon_clone));
                }
            });
        }
    }
}

/// Intercepts same-origin `window.open('index.html?role=viewport|dock|surface&...')` calls from `main`
/// and binds the new transparent frameless Tauri window to the SAME WebView2/WKWebView environment
/// via `NewWindowResponse::Create`. This keeps `main`, `overlay-*`, and `dock-*` in ONE shared
/// Chromium/WebKit renderer process so `gl.texImage2D(livePenpaCanvas)` runs 100% GPU-to-GPU zero-copy!
#[cfg(desktop)]
fn handle_linked_new_window(
    app: &AppHandle,
    state: &Arc<Mutex<HitState>>,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    let params: HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let role = params.get("role").map(|s| s.as_str()).unwrap_or("");
    if role != "viewport" && role != "dock" && role != "surface" {
        return tauri::webview::NewWindowResponse::Deny;
    }

    let (always_on_top, monitors) = state
        .lock()
        .map(|g| (g.always_on_top, g.monitors.clone()))
        .unwrap_or((true, Vec::new()));

    let blank_url = match "about:blank".parse() {
        Ok(u) => u,
        Err(_) => return tauri::webview::NewWindowResponse::Deny,
    };

    if role == "viewport" {
        let Some(monitor_id) = params.get("monitorId").cloned().filter(|s| !s.is_empty()) else {
            return tauri::webview::NewWindowResponse::Deny;
        };
        let label = overlay_label_for_monitor(&monitor_id);
        if app.get_webview_window(&label).is_some() {
            return tauri::webview::NewWindowResponse::Deny;
        }
        let target_mon = monitors.iter().find(|m| m.id == monitor_id).cloned();
        let title = target_mon
            .as_ref()
            .map(|m| format!("PenpaAnywhere Overlay ({})", m.name))
            .unwrap_or_else(|| "PenpaAnywhere Overlay".to_string());

        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank_url))
            .window_features(features)
            .title(title)
            .visible(false)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .skip_taskbar(true)
            .always_on_top(always_on_top);

        let win = match builder.build() {
            Ok(w) => w,
            Err(err) => {
                eprintln!("[PenpaAnywhere] Linked viewport build failed ({label}): {err}");
                return tauri::webview::NewWindowResponse::Deny;
            }
        };

        if let Ok(mut guard) = state.lock() {
            guard.secondary_overlays.insert(monitor_id.clone(), label.clone());
            guard.viewports.entry(label.clone()).or_insert_with(|| ViewportHitState {
                auto_passthrough: true,
                initialized: true,
                ..Default::default()
            });
        }

        let _ = win.set_background_color(Some(Color(0, 0, 0, 0)));
        disable_windows_dwm_transitions(&win);
        if let Some(ref m) = target_mon {
            fit_overlay_window_to_monitor(&win, Some(m));
        }
        let _ = win.set_ignore_cursor_events(true);

        let win_evt = win.clone();
        let st_evt = Arc::clone(state);
        let mon_id_evt = monitor_id.clone();
        win.on_window_event(move |ev| {
            if matches!(ev, tauri::WindowEvent::ScaleFactorChanged { .. }) {
                let latest_mon = st_evt
                    .lock()
                    .ok()
                    .and_then(|g| g.monitors.iter().find(|m| m.id == mon_id_evt).cloned());
                if let Some(m) = latest_mon {
                    fit_overlay_window_to_monitor(&win_evt, Some(&m));
                    emit_safe_area_insets_for_window(&win_evt, true, Some(&m));
                }
            }
        });

        return tauri::webview::NewWindowResponse::Create { window: win };
    }

    // Native floating surface ("dock" / "surface") linked into main's same renderer process
    let surface_id = params
        .get("surfaceId")
        .cloned()
        .filter(|s| !s.is_empty())
        .or_else(|| params.get("gridId").map(|gid| format!("dock-{gid}")))
        .unwrap_or_else(|| "surface-default".to_string());
    let label = surface_label_for_id(&surface_id);
    if app.get_webview_window(&label).is_some() {
        return tauri::webview::NewWindowResponse::Deny;
    }

    let phys_x = params
        .get("physX")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(80);
    let phys_y = params
        .get("physY")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(80);
    let logical_w = params
        .get("logicalW")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(668.0)
        .max(120.0);
    let logical_h = params
        .get("logicalH")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(428.0)
        .max(36.0);
    let visible = params.get("visible").map(|s| s != "0" && s != "false").unwrap_or(true);

    let target_mon = find_monitor_for_point(&monitors, phys_x, phys_y);
    let scale = target_mon.as_ref().map(|m| m.scale).unwrap_or(1.0).max(0.5);
    let phys_w = (logical_w * scale).round() as u32;
    let phys_h = (logical_h * scale).round() as u32;

    let title = params
        .get("title")
        .cloned()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Penpa+".to_string());

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank_url))
        .window_features(features)
        .title(title)
        .visible(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .skip_taskbar(false)
        .always_on_top(always_on_top);

    let win = match builder.build() {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[PenpaAnywhere] Linked surface build failed ({label}): {err}");
            return tauri::webview::NewWindowResponse::Deny;
        }
    };

    if let Ok(mut guard) = state.lock() {
        guard.surface_windows.insert(surface_id.clone(), label.clone());
    }

    let _ = win.set_background_color(Some(Color(0, 0, 0, 0)));
    disable_windows_dwm_transitions(&win);
    apply_window_rect(&win, phys_x, phys_y, phys_w, phys_h);

    if let Some(grid_id) = surface_id.strip_prefix("dock-").map(|s| s.to_string()) {
        let app_close = app.clone();
        let win_close = win.clone();
        win.on_window_event(move |ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = win_close.hide();
                let _ = app_close.emit_to(
                    "main",
                    "world-command",
                    serde_json::json!({
                        "type": "dock-visible",
                        "gridId": grid_id,
                        "visible": false
                    }),
                );
            }
        });
    }

    if visible {
        let _ = win.show();
    }

    tauri::webview::NewWindowResponse::Create { window: win }
}

#[tauri::command]
fn get_monitors(app: AppHandle, state: State<'_, AppOverlayState>) -> Vec<MonitorDescriptor> {
    let launch_id = state
        .0
        .lock()
        .ok()
        .and_then(|g| g.launch_monitor_id.clone());
    let list = enumerate_monitors(&app, launch_id.as_deref());
    if let Ok(mut guard) = state.0.lock() {
        guard.monitors = list.clone();
        if guard.main_monitor_id.is_none() {
            guard.main_monitor_id = resolve_main_monitor(&list, launch_id.as_deref()).map(|m| m.id);
        }
    }
    list
}

#[tauri::command]
async fn set_multi_monitor_enabled(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    enabled: bool,
) -> Result<Vec<MonitorDescriptor>, String> {
    let launch_id = state
        .0
        .lock()
        .ok()
        .and_then(|g| g.launch_monitor_id.clone());
    let list = enumerate_monitors(&app, launch_id.as_deref());
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "overlay state lock poisoned".to_string())?;
        guard.multi_monitor_enabled = enabled;
        guard.monitors = list.clone();
        guard.main_monitor_id =
            resolve_main_monitor(&list, guard.main_monitor_id.as_deref()).map(|m| m.id);
    }
    reconcile_secondary_overlays(&app, &state.0);
    let _ = app.emit("monitors-changed", &list);
    Ok(list)
}

#[tauri::command]
async fn viewport_ready(
    window: WebviewWindow,
    state: State<'_, AppOverlayState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mon = state.0.lock().ok().and_then(|g| {
        if label == "main" {
            resolve_main_monitor(&g.monitors, g.main_monitor_id.as_deref())
        } else {
            g.secondary_overlays
                .iter()
                .find(|(_, lbl)| *lbl == &label)
                .and_then(|(mid, _)| g.monitors.iter().find(|m| m.id == *mid).cloned())
        }
    });
    if let Some(m) = mon {
        fit_overlay_window_to_monitor(&window, Some(&m));
        emit_safe_area_insets_for_window(&window, true, Some(&m));
    }
    if label != "main" {
        let _ = window.show();
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ensure_surface_window(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
    url_query: String,
    phys_x: i32,
    phys_y: i32,
    logical_w: f64,
    logical_h: f64,
    visible: bool,
) -> Result<String, String> {
    let label = surface_label_for_id(&surface_id);
    let (always_on_top, monitors) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "overlay state lock poisoned".to_string())?;
        guard.surface_windows.insert(surface_id.clone(), label.clone());
        (guard.always_on_top, guard.monitors.clone())
    };

    let target_mon = find_monitor_for_point(&monitors, phys_x, phys_y);
    let scale = target_mon.as_ref().map(|m| m.scale).unwrap_or(1.0).max(0.5);
    let phys_w = (logical_w.max(120.0) * scale).round() as u32;
    let phys_h = (logical_h.max(36.0) * scale).round() as u32;

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_always_on_top(always_on_top);
        apply_window_rect(&existing, phys_x, phys_y, phys_w, phys_h);
        if visible {
            let _ = existing.show();
        } else {
            let _ = existing.hide();
        }
        return Ok(label);
    }

    let url = if url_query.starts_with('?') {
        format!("index.html{url_query}")
    } else {
        format!("index.html?{url_query}")
    };

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Penpa+")
        .visible(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .skip_taskbar(false)
        .always_on_top(always_on_top);
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(WINDOWS_WEBVIEW_ARGS);
    }
    let win = match builder.build() {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[PenpaAnywhere] Failed to build surface window {label}: {err}");
            if let Ok(mut guard) = state.0.lock() {
                guard.surface_windows.remove(&surface_id);
            }
            return Err(err.to_string());
        }
    };
    let _ = win.set_background_color(Some(Color(0, 0, 0, 0)));
    disable_windows_dwm_transitions(&win);
    apply_window_rect(&win, phys_x, phys_y, phys_w, phys_h);

    // Closing a persistent native dock window (e.g. Alt+F4) hides it instead of destroying the Penpa+ iframe
    if let Some(grid_id) = surface_id.strip_prefix("dock-").map(|s| s.to_string()) {
        let app_close = app.clone();
        let win_close = win.clone();
        win.on_window_event(move |ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = win_close.hide();
                let _ = app_close.emit_to(
                    "main",
                    "world-command",
                    serde_json::json!({
                        "type": "dock-visible",
                        "gridId": grid_id,
                        "visible": false
                    }),
                );
            }
        });
    }

    if visible {
        let _ = win.show();
    }
    Ok(label)
}

#[tauri::command]
async fn set_surface_bounds(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
    phys_x: Option<i32>,
    phys_y: Option<i32>,
    logical_w: f64,
    logical_h: f64,
) -> Result<(), String> {
    let label = surface_label_for_id(&surface_id);
    let Some(win) = app.get_webview_window(&label) else {
        return Ok(());
    };
    let clamped_w = logical_w.max(120.0);
    let clamped_h = logical_h.max(36.0);
    if let (Some(px), Some(py)) = (phys_x, phys_y) {
        let monitors = state
            .0
            .lock()
            .map(|g| g.monitors.clone())
            .unwrap_or_default();
        let probe_mon = find_monitor_for_point(&monitors, px, py);
        let scale = probe_mon.as_ref().map(|m| m.scale).unwrap_or(1.0).max(0.5);
        let target_w = (clamped_w * scale).round() as u32;
        let target_h = (clamped_h * scale).round() as u32;
        apply_window_rect(&win, px, py, target_w, target_h);
    } else {
        #[cfg(target_os = "macos")]
        {
            let _ = win.set_size(LogicalSize::new(clamped_w, clamped_h));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
            let phys_w = (clamped_w * scale).round() as u32;
            let phys_h = (clamped_h * scale).round() as u32;
            let _ = win.set_size(PhysicalSize::new(phys_w, phys_h));
        }
    }
    Ok(())
}

fn raise_window_no_activate(window: &WebviewWindow, always_on_top: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        if let Ok(hwnd) = window.hwnd() {
            let insert_after = if always_on_top { HWND_TOPMOST } else { HWND_TOP };
            unsafe {
                let _ = SetWindowPos(
                    hwnd.0,
                    insert_after,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let _ = win.set_always_on_top(always_on_top);
            if let Ok(ns_win) = win.ns_window() {
                use std::ffi::{c_char, c_void};
                #[link(name = "objc")]
                extern "C" {
                    fn sel_registerName(name: *const c_char) -> *const c_void;
                    fn objc_msgSend();
                }
                unsafe {
                    let sel = sel_registerName(b"orderFront:\0".as_ptr().cast());
                    let send: extern "C" fn(*mut c_void, *const c_void, *mut c_void) =
                        std::mem::transmute(objc_msgSend as *const ());
                    send(ns_win, sel, std::ptr::null_mut());
                }
            }
        });
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = window.set_always_on_top(always_on_top);
    }
}

#[tauri::command]
async fn set_surface_visible(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
    visible: bool,
) -> Result<(), String> {
    let label = surface_label_for_id(&surface_id);
    let always_on_top = state.0.lock().map(|g| g.always_on_top).unwrap_or(true);
    if let Some(win) = app.get_webview_window(&label) {
        if visible {
            let _ = win.show();
            raise_window_no_activate(&win, always_on_top);
        } else {
            let _ = win.hide();
        }
    }
    Ok(())
}

#[tauri::command]
async fn bring_surface_to_front(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
) -> Result<(), String> {
    let label = surface_label_for_id(&surface_id);
    let always_on_top = state.0.lock().map(|g| g.always_on_top).unwrap_or(true);
    if let Some(win) = app.get_webview_window(&label) {
        if win.is_visible().unwrap_or(false) {
            raise_window_no_activate(&win, always_on_top);
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_surface_title(
    app: AppHandle,
    surface_id: String,
    title: String,
) -> Result<(), String> {
    let label = surface_label_for_id(&surface_id);
    if let Some(win) = app.get_webview_window(&label) {
        let trimmed = title.trim();
        let _ = win.set_title(if trimmed.is_empty() { "Penpa+" } else { trimmed });
    }
    Ok(())
}

#[tauri::command]
async fn destroy_surface_window(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
) -> Result<(), String> {
    let label = surface_label_for_id(&surface_id);
    if let Ok(mut guard) = state.0.lock() {
        guard.surface_windows.remove(&surface_id);
        if guard
            .active_surface_drag
            .as_ref()
            .map(|d| d.label == label)
            .unwrap_or(false)
        {
            guard.active_surface_drag = None;
        }
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.destroy();
    }
    Ok(())
}

#[tauri::command]
async fn is_any_app_window_focused(app: AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

#[tauri::command]
async fn start_surface_drag(
    app: AppHandle,
    state: State<'_, AppOverlayState>,
    surface_id: String,
    logical_w: f64,
    logical_h: f64,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let label = surface_label_for_id(&surface_id);
        let Some(win) = app.get_webview_window(&label) else {
            return Ok(false);
        };
        let Ok(pos) = win.outer_position() else {
            return Ok(false);
        };
        let Ok(size) = win.inner_size() else {
            return Ok(false);
        };
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return Ok(false);
        }
        if let Ok(mut guard) = state.0.lock() {
            guard.active_surface_drag = Some(ActiveSurfaceDrag {
                label,
                cursor_start: (pt.x, pt.y),
                win_start: (pos.x, pos.y),
                logical_w: logical_w.max(120.0),
                logical_h: logical_h.max(36.0),
                last_phys_pos: (pos.x, pos.y),
                last_phys_size: (size.width, size.height),
            });
        }
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        let label = surface_label_for_id(&surface_id);
        let Some(win) = app.get_webview_window(&label) else {
            return Ok(false);
        };
        let Ok(pos) = win.outer_position() else {
            return Ok(false);
        };
        let Ok(size) = win.inner_size() else {
            return Ok(false);
        };
        let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
        let win_x = (pos.x as f64 / scale).round() as i32;
        let win_y = (pos.y as f64 / scale).round() as i32;
        let win_w = ((size.width as f64 / scale).round() as u32).max(1);
        let win_h = ((size.height as f64 / scale).round() as u32).max(1);
        let Some((cx, cy)) = read_macos_cursor_point() else {
            return Ok(false);
        };
        let cur_x = cx.round() as i32;
        let cur_y = cy.round() as i32;
        if let Ok(mut guard) = state.0.lock() {
            guard.active_surface_drag = Some(ActiveSurfaceDrag {
                label,
                cursor_start: (cur_x, cur_y),
                win_start: (win_x, win_y),
                logical_w: logical_w.max(120.0),
                logical_h: logical_h.max(36.0),
                last_phys_pos: (win_x, win_y),
                last_phys_size: (win_w, win_h),
            });
        }
        Ok(true)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, state, surface_id, logical_w, logical_h);
        Ok(false)
    }
}

#[tauri::command]
fn end_surface_drag(state: State<'_, AppOverlayState>) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        guard.active_surface_drag = None;
    }
    Ok(())
}

#[tauri::command]
fn push_grid_frame(
    app: AppHandle,
    frames: State<'_, AppFrameStore>,
    req: Request<'_>,
) -> Result<(), String> {
    let hdr = |name: &str| -> Option<String> {
        req.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let grid_id = hdr("x-grid-id").ok_or_else(|| "missing x-grid-id header".to_string())?;
    let seq = hdr("x-frame-seq")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let width = hdr("x-frame-w")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let height = hdr("x-frame-h")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let rgba = match req.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("expected raw binary RGBA body".to_string()),
    };
    let expected = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    if width == 0 || height == 0 || rgba.len() < expected {
        return Err("invalid RGBA frame dimensions".to_string());
    }

    if let Ok(mut guard) = frames.0.write() {
        guard.insert(
            grid_id.clone(),
            GridFrameEntry {
                seq,
                width,
                height,
                rgba,
            },
        );
    }

    let _ = app.emit(
        "grid-frame-ready",
        GridFrameMeta {
            grid_id,
            seq,
            width,
            height,
        },
    );
    Ok(())
}

#[tauri::command]
fn get_grid_frame(frames: State<'_, AppFrameStore>, grid_id: String) -> Response {
    if let Ok(guard) = frames.0.read() {
        if let Some(entry) = guard.get(&grid_id) {
            return Response::new(entry.rgba.clone());
        }
    }
    Response::new(Vec::<u8>::new())
}

#[tauri::command]
fn get_all_grid_frame_metas(frames: State<'_, AppFrameStore>) -> Vec<GridFrameMeta> {
    if let Ok(guard) = frames.0.read() {
        return guard
            .iter()
            .map(|(grid_id, entry)| GridFrameMeta {
                grid_id: grid_id.clone(),
                seq: entry.seq,
                width: entry.width,
                height: entry.height,
            })
            .collect();
    }
    Vec::new()
}

#[tauri::command]
fn relay_world_command(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    app.emit_to("main", "world-command", payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn broadcast_world_state(
    app: AppHandle,
    event_name: String,
    payload: serde_json::Value,
    target_label: Option<String>,
) -> Result<(), String> {
    if let Some(target) = target_label {
        app.emit_to(&target, &event_name, payload)
            .map_err(|e| e.to_string())
    } else {
        app.emit(&event_name, payload).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn relay_penpa_input(
    app: AppHandle,
    target_label: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    app.emit_to(&target_label, "penpa-input", payload)
        .map_err(|e| e.to_string())
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
fn spawn_windows_overlay_poller(app: AppHandle, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut last_emitted_cursor: HashMap<String, (f64, f64)> = HashMap::new();
        let mut last_cursor_in_window: HashMap<String, bool> = HashMap::new();
        let mut last_cursor_monitor_id: Option<String> = None;
        let mut last_global_drag_cursor: (i32, i32) = (i32::MIN, i32::MIN);
        let mut last_safe_insets: HashMap<String, SafeAreaInsets> = HashMap::new();
        let mut last_monitors: Vec<MonitorDescriptor> = Vec::new();
        let mut safe_check_ticks: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(12));

            let (is_overlay, multi_enabled, drag_active, surface_drag, launch_id, main_mon_id, secondary_map, viewports_snapshot, monitors_snapshot) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.is_overlay_mode,
                    guard.multi_monitor_enabled,
                    guard.drag_active,
                    guard.active_surface_drag.clone(),
                    guard.launch_monitor_id.clone(),
                    guard.main_monitor_id.clone(),
                    guard.secondary_overlays.clone(),
                    guard.viewports.clone(),
                    guard.monitors.clone(),
                )
            };

            // Periodically sync monitor topology & work-area safe insets (~480ms):
            // detects monitor hotplug/unplug, DPI changes, and taskbar expand/collapse in one pass.
            safe_check_ticks = safe_check_ticks.wrapping_add(1);
            if safe_check_ticks % 40 == 0 {
                let fresh_monitors = enumerate_monitors(&app, launch_id.as_deref());
                let topology_changed = fresh_monitors != last_monitors;
                if topology_changed {
                    last_monitors = fresh_monitors.clone();
                    let new_main_mon = resolve_main_monitor(&fresh_monitors, main_mon_id.as_deref());
                    let new_main_id = new_main_mon.as_ref().map(|m| m.id.clone());
                    if let Ok(mut guard) = state.lock() {
                        guard.monitors = fresh_monitors.clone();
                        guard.main_monitor_id = new_main_id;
                    }
                    if is_overlay {
                        if let (Some(main_win), Some(m)) =
                            (app.get_webview_window("main"), new_main_mon.clone())
                        {
                            let app_c = app.clone();
                            let _ = app_c.run_on_main_thread(move || {
                                fit_overlay_window_to_monitor(&main_win, Some(&m));
                            });
                        }
                        if multi_enabled {
                            reconcile_secondary_overlays(&app, &state);
                        }
                    }
                    if multi_enabled {
                        let _ = app.emit("monitors-changed", &fresh_monitors);
                    }
                }

                // Emit per-window safe area insets whenever a monitor's work area changes
                let active_monitors = &last_monitors;
                if let Some(main_win) = app.get_webview_window("main") {
                    let main_mon = resolve_main_monitor(active_monitors, main_mon_id.as_deref());
                    let insets =
                        read_window_safe_area_insets(&main_win, is_overlay, main_mon.as_ref());
                    if last_safe_insets.get("main").copied() != Some(insets) {
                        last_safe_insets.insert("main".to_string(), insets);
                        let _ = app.emit_to("main", "safe-area-insets-changed", insets);
                    }
                }
                if multi_enabled {
                    for (mid, lbl) in &secondary_map {
                        if let (Some(_win), Some(mon)) = (
                            app.get_webview_window(lbl),
                            active_monitors.iter().find(|m| m.id == *mid),
                        ) {
                            let insets = compute_monitor_safe_insets(mon, is_overlay);
                            if last_safe_insets.get(lbl).copied() != Some(insets) {
                                last_safe_insets.insert(lbl.clone(), insets);
                                let _ = app.emit_to(lbl, "safe-area-insets-changed", insets);
                            }
                        }
                    }
                }
            }

            let mut pt = POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut pt) } == 0 {
                continue;
            }

            let mouse_down = unsafe {
                (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0
                    || (GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000) != 0
                    || (GetAsyncKeyState(VK_MBUTTON as i32) as u16 & 0x8000) != 0
            };

            // Native floating surface drag (works in BOTH Overlay & Canvas modes, mixed-DPI exact!)
            if let Some(drag) = surface_drag {
                if !mouse_down {
                    if let Ok(mut guard) = state.lock() {
                        guard.active_surface_drag = None;
                    }
                    let _ = app.emit_to(&drag.label, "surface-drag-ended", ());
                } else if let Some(win) = app.get_webview_window(&drag.label) {
                    let next_x = drag.win_start.0 + (pt.x - drag.cursor_start.0);
                    let next_y = drag.win_start.1 + (pt.y - drag.cursor_start.1);
                    let center_x = next_x + (drag.last_phys_size.0 as i32) / 2;
                    let center_y = next_y + (drag.last_phys_size.1 as i32) / 2;
                    let target_mon = find_monitor_for_point(&monitors_snapshot, center_x, center_y);
                    let scale = target_mon.as_ref().map(|m| m.scale).unwrap_or(1.0).max(0.5);
                    let next_w = (drag.logical_w * scale).round() as u32;
                    let next_h = (drag.logical_h * scale).round() as u32;
                    let pos_changed = (next_x, next_y) != drag.last_phys_pos;
                    let size_changed = (next_w, next_h) != drag.last_phys_size;
                    if pos_changed || size_changed {
                        if pos_changed {
                            let _ = win.set_position(PhysicalPosition::new(next_x, next_y));
                        }
                        if size_changed {
                            let _ = win.set_size(PhysicalSize::new(next_w, next_h));
                            let _ = win.set_position(PhysicalPosition::new(next_x, next_y));
                        }
                        if let Ok(mut guard) = state.lock() {
                            if let Some(ref mut active) = guard.active_surface_drag {
                                active.last_phys_pos = (next_x, next_y);
                                active.last_phys_size = (next_w, next_h);
                            }
                        }
                    }
                }
            }

            if !is_overlay {
                continue;
            }

            // Track which monitor currently hosts the mouse cursor so the main ControlBar
            // follows the cursor seamlessly across displays (ONLY when multi-monitor is enabled!).
            if multi_enabled && !drag_active && !mouse_down && !monitors_snapshot.is_empty() {
                let cur_mon_id =
                    find_monitor_for_point(&monitors_snapshot, pt.x, pt.y).map(|m| m.id);
                if cur_mon_id != last_cursor_monitor_id {
                    last_cursor_monitor_id = cur_mon_id.clone();
                    let _ = app.emit("cursor-monitor-changed", &cur_mon_id);
                }
            }

            if multi_enabled
                && drag_active
                && (pt.x != last_global_drag_cursor.0 || pt.y != last_global_drag_cursor.1)
            {
                last_global_drag_cursor = (pt.x, pt.y);
                let _ = app.emit_to("main", "overlay-global-cursor", (pt.x as f64, pt.y as f64));
            } else if !drag_active || !multi_enabled {
                last_global_drag_cursor = (i32::MIN, i32::MIN);
            }

            let mut labels: Vec<String> = Vec::with_capacity(1 + secondary_map.len());
            labels.push("main".to_string());
            for lbl in secondary_map.values() {
                labels.push(lbl.clone());
            }

            for label in labels {
                let Some(vp) = viewports_snapshot.get(&label) else {
                    continue;
                };
                if !vp.auto_passthrough || !vp.initialized {
                    continue;
                }
                let Some(window) = app.get_webview_window(&label) else {
                    continue;
                };

                if mouse_down && (vp.last_ignore == Some(false) || drag_active) {
                    if vp.last_ignore != Some(false) {
                        apply_ignore_cursor(&window, false);
                        if let Ok(mut guard) = state.lock() {
                            if let Some(entry) = guard.viewports.get_mut(&label) {
                                entry.last_ignore = Some(false);
                            }
                        }
                    }
                    continue;
                }

                let Ok(win_pos) = window.inner_position() else {
                    continue;
                };
                let Ok(win_size) = window.inner_size() else {
                    continue;
                };
                let scale = window.scale_factor().unwrap_or(1.0);
                let local_x = (pt.x - win_pos.x) as f64 / scale;
                let local_y = (pt.y - win_pos.y) as f64 / scale;
                let win_w_css = win_size.width as f64 / scale;
                let win_h_css = win_size.height as f64 / scale;
                let cursor_in_win = local_x >= -24.0
                    && local_x <= win_w_css + 24.0
                    && local_y >= -24.0
                    && local_y <= win_h_css + 24.0;
                let was_in_win = last_cursor_in_window.get(&label).copied().unwrap_or(false);

                if cursor_in_win {
                    last_cursor_in_window.insert(label.clone(), true);
                    let prev_cursor = last_emitted_cursor
                        .get(&label)
                        .copied()
                        .unwrap_or((-10000.0, -10000.0));
                    if (local_x - prev_cursor.0).abs() >= 2.0
                        || (local_y - prev_cursor.1).abs() >= 2.0
                    {
                        last_emitted_cursor.insert(label.clone(), (local_x, local_y));
                        let _ = app.emit_to(&label, "overlay-cursor-pos", (local_x, local_y));
                    }
                } else if was_in_win {
                    // Emit one clean out-of-bounds notification on leave so hover toolbars dismiss immediately
                    last_cursor_in_window.insert(label.clone(), false);
                    last_emitted_cursor.insert(label.clone(), (-10000.0, -10000.0));
                    let _ = app.emit_to(&label, "overlay-cursor-pos", (-10000.0_f64, -10000.0_f64));
                }

                let hit_bar = point_in_rect_padded(local_x, local_y, &vp.bar_rect, 14.0);
                let hit_dock = point_in_rect_padded(local_x, local_y, &vp.dock_rect, 14.0);
                let hit_extra_ui = vp
                    .ui_rects
                    .iter()
                    .any(|r| point_in_rect_padded(local_x, local_y, r, 10.0));
                let hit_ui = hit_bar || hit_dock || hit_extra_ui;
                let should_ignore = if vp.force_click_through {
                    !hit_ui
                } else {
                    let hit_board = vp
                        .quads
                        .iter()
                        .any(|q| point_in_quad_padded(local_x, local_y, q, 26.0));
                    let hit_gizmo = vp
                        .gizmo_quad
                        .as_deref()
                        .map(|q| point_on_quad_border(local_x, local_y, q, 24.0, 16.0))
                        .unwrap_or(false);
                    !(hit_ui || hit_board || hit_gizmo)
                };

                if vp.last_ignore != Some(should_ignore) {
                    apply_ignore_cursor(&window, should_ignore);
                    if let Ok(mut guard) = state.lock() {
                        if let Some(entry) = guard.viewports.get_mut(&label) {
                            entry.last_ignore = Some(should_ignore);
                        }
                    }
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
fn spawn_macos_overlay_poller(app: AppHandle, state: Arc<Mutex<HitState>>) {
    use std::thread;
    use std::time::Duration;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }

    const K_COMBINED_SESSION_STATE: i32 = 0;

    thread::spawn(move || {
        let mut last_emitted_cursor: HashMap<String, (f64, f64)> = HashMap::new();
        let mut last_cursor_in_window: HashMap<String, bool> = HashMap::new();
        let mut last_cursor_monitor_id: Option<String> = None;
        let mut last_global_drag_cursor: (f64, f64) = (f64::NAN, f64::NAN);
        let mut last_safe_insets: HashMap<String, SafeAreaInsets> = HashMap::new();
        let mut last_monitors: Vec<MonitorDescriptor> = Vec::new();
        let mut safe_check_ticks: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(12));

            let (
                is_overlay,
                multi_enabled,
                drag_active,
                surface_drag,
                launch_id,
                main_mon_id,
                monitors_snapshot,
                secondary_map,
                viewports_snapshot,
            ) = {
                let Ok(guard) = state.lock() else {
                    continue;
                };
                (
                    guard.is_overlay_mode,
                    guard.multi_monitor_enabled,
                    guard.drag_active,
                    guard.active_surface_drag.clone(),
                    guard.launch_monitor_id.clone(),
                    guard.main_monitor_id.clone(),
                    guard.monitors.clone(),
                    guard.secondary_overlays.clone(),
                    guard.viewports.clone(),
                )
            };

            // Periodically sync monitor topology & menu-bar/Dock safe insets (~480ms)
            safe_check_ticks = safe_check_ticks.wrapping_add(1);
            if safe_check_ticks % 40 == 0 {
                let fresh_monitors = enumerate_monitors(&app, launch_id.as_deref());
                if fresh_monitors != last_monitors {
                    last_monitors = fresh_monitors.clone();
                    let new_main_mon = resolve_main_monitor(&fresh_monitors, main_mon_id.as_deref());
                    let new_main_id = new_main_mon.as_ref().map(|m| m.id.clone());
                    if let Ok(mut guard) = state.lock() {
                        guard.monitors = fresh_monitors.clone();
                        guard.main_monitor_id = new_main_id;
                    }
                    if is_overlay {
                        if let (Some(main_win), Some(m)) =
                            (app.get_webview_window("main"), new_main_mon.clone())
                        {
                            let app_c = app.clone();
                            let _ = app_c.run_on_main_thread(move || {
                                fit_overlay_window_to_monitor(&main_win, Some(&m));
                            });
                        }
                        if multi_enabled {
                            reconcile_secondary_overlays(&app, &state);
                        }
                    }
                    if multi_enabled {
                        let _ = app.emit("monitors-changed", &fresh_monitors);
                    }
                }

                let active_monitors = &last_monitors;
                if let Some(main_win) = app.get_webview_window("main") {
                    let main_mon = resolve_main_monitor(active_monitors, main_mon_id.as_deref());
                    let insets =
                        read_window_safe_area_insets(&main_win, is_overlay, main_mon.as_ref());
                    if last_safe_insets.get("main").copied() != Some(insets) {
                        last_safe_insets.insert("main".to_string(), insets);
                        let _ = app.emit_to("main", "safe-area-insets-changed", insets);
                    }
                }
                if multi_enabled {
                    for (mid, lbl) in &secondary_map {
                        if let (Some(_win), Some(mon)) = (
                            app.get_webview_window(lbl),
                            active_monitors.iter().find(|m| m.id == *mid),
                        ) {
                            let insets = compute_monitor_safe_insets(mon, is_overlay);
                            if last_safe_insets.get(lbl).copied() != Some(insets) {
                                last_safe_insets.insert(lbl.clone(), insets);
                                let _ = app.emit_to(lbl, "safe-area-insets-changed", insets);
                            }
                        }
                    }
                }
            }

            let Some(pt) = read_macos_cursor_point() else {
                continue;
            };

            let mouse_down = unsafe {
                CGEventSourceButtonState(K_COMBINED_SESSION_STATE, 0)
                    || CGEventSourceButtonState(K_COMBINED_SESSION_STATE, 1)
                    || CGEventSourceButtonState(K_COMBINED_SESSION_STATE, 2)
            };

            // Native floating surface drag (works in BOTH Overlay & Canvas modes, Retina-exact!)
            if let Some(drag) = surface_drag {
                if !mouse_down {
                    if let Ok(mut guard) = state.lock() {
                        guard.active_surface_drag = None;
                    }
                    let _ = app.emit_to(&drag.label, "surface-drag-ended", ());
                } else if let Some(win) = app.get_webview_window(&drag.label) {
                    let cur_x = pt.0.round() as i32;
                    let cur_y = pt.1.round() as i32;
                    let next_x = drag.win_start.0 + (cur_x - drag.cursor_start.0);
                    let next_y = drag.win_start.1 + (cur_y - drag.cursor_start.1);
                    if (next_x, next_y) != drag.last_phys_pos {
                        let _ = win.set_position(LogicalPosition::new(next_x as f64, next_y as f64));
                        if let Ok(mut guard) = state.lock() {
                            if let Some(ref mut active) = guard.active_surface_drag {
                                active.last_phys_pos = (next_x, next_y);
                            }
                        }
                    }
                }
            }

            if !is_overlay {
                continue;
            }

            if multi_enabled && drag_active {
                if !last_global_drag_cursor.0.is_finite()
                    || (pt.0 - last_global_drag_cursor.0).abs() >= 0.5
                    || (pt.1 - last_global_drag_cursor.1).abs() >= 0.5
                {
                    last_global_drag_cursor = pt;
                    let _ = app.emit_to("main", "overlay-global-cursor", (pt.0, pt.1));
                }
            } else if last_global_drag_cursor.0.is_finite() {
                last_global_drag_cursor = (f64::NAN, f64::NAN);
            }

            if multi_enabled && !mouse_down && !drag_active && monitors_snapshot.len() > 1 {
                let cur_mon_id = find_monitor_for_point(
                    &monitors_snapshot,
                    pt.0.round() as i32,
                    pt.1.round() as i32,
                )
                .map(|m| m.id);
                if cur_mon_id.is_some() && cur_mon_id != last_cursor_monitor_id {
                    last_cursor_monitor_id = cur_mon_id.clone();
                    if let Some(ref mid) = cur_mon_id {
                        let _ = app.emit_to("main", "cursor-monitor-changed", mid.clone());
                    }
                }
            }

            let mut labels: Vec<String> = Vec::with_capacity(1 + secondary_map.len());
            labels.push("main".to_string());
            if multi_enabled {
                for lbl in secondary_map.values() {
                    labels.push(lbl.clone());
                }
            }

            for label in labels {
                let Some(vp) = viewports_snapshot.get(&label) else {
                    continue;
                };
                if !vp.auto_passthrough || !vp.initialized {
                    continue;
                }
                let Some(window) = app.get_webview_window(&label) else {
                    continue;
                };

                if mouse_down && (vp.last_ignore == Some(false) || drag_active) {
                    continue;
                }

                let Ok(win_pos) = window.inner_position() else {
                    continue;
                };
                let Ok(win_size) = window.inner_size() else {
                    continue;
                };
                let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
                let win_logical_x = win_pos.x as f64 / scale;
                let win_logical_y = win_pos.y as f64 / scale;
                let win_logical_w = win_size.width as f64 / scale;
                let win_logical_h = win_size.height as f64 / scale;
                let local_x = pt.0 - win_logical_x;
                let local_y = pt.1 - win_logical_y;

                let inside_window = local_x >= 0.0
                    && local_x < win_logical_w
                    && local_y >= 0.0
                    && local_y < win_logical_h;
                let was_inside = last_cursor_in_window.get(&label).copied().unwrap_or(false);
                if inside_window {
                    last_cursor_in_window.insert(label.clone(), true);
                    let prev_cursor = last_emitted_cursor
                        .get(&label)
                        .copied()
                        .unwrap_or((-10000.0, -10000.0));
                    if (local_x - prev_cursor.0).abs() >= 2.0
                        || (local_y - prev_cursor.1).abs() >= 2.0
                    {
                        last_emitted_cursor.insert(label.clone(), (local_x, local_y));
                        let _ = app.emit_to(&label, "overlay-cursor-pos", (local_x, local_y));
                    }
                } else if was_inside {
                    last_cursor_in_window.insert(label.clone(), false);
                    last_emitted_cursor.insert(label.clone(), (-10000.0, -10000.0));
                    let _ = app.emit_to(&label, "overlay-cursor-pos", (-10000.0_f64, -10000.0_f64));
                }

                let hit_bar = point_in_rect_padded(local_x, local_y, &vp.bar_rect, 14.0);
                let hit_dock = point_in_rect_padded(local_x, local_y, &vp.dock_rect, 14.0);
                let hit_extra_ui = vp
                    .ui_rects
                    .iter()
                    .any(|r| point_in_rect_padded(local_x, local_y, r, 10.0));
                let hit_ui = hit_bar || hit_dock || hit_extra_ui;
                let should_ignore = if vp.force_click_through {
                    !hit_ui
                } else {
                    let hit_board = vp
                        .quads
                        .iter()
                        .any(|q| point_in_quad_padded(local_x, local_y, q, 26.0));
                    let hit_gizmo = vp
                        .gizmo_quad
                        .as_deref()
                        .map(|q| point_on_quad_border(local_x, local_y, q, 24.0, 16.0))
                        .unwrap_or(false);
                    !(hit_ui || hit_board || hit_gizmo)
                };

                if vp.last_ignore != Some(should_ignore) {
                    apply_ignore_cursor(&window, should_ignore);
                    if let Ok(mut guard) = state.lock() {
                        if let Some(entry) = guard.viewports.get_mut(&label) {
                            entry.last_ignore = Some(should_ignore);
                        }
                    }
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut initial_viewports = HashMap::new();
    initial_viewports.insert(
        "main".to_string(),
        ViewportHitState {
            auto_passthrough: true,
            ..Default::default()
        },
    );
    let shared_state = Arc::new(Mutex::new(HitState {
        is_overlay_mode: true,
        multi_monitor_enabled: false,
        always_on_top: true,
        window_theme_mode: "auto".to_string(),
        window_is_dark: true,
        viewports: initial_viewports,
        ..Default::default()
    }));

    let state_for_setup = Arc::clone(&shared_state);

    tauri::Builder::default()
        .manage(AppOverlayState(shared_state))
        .manage(AppFrameStore::default())
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
            get_monitors,
            set_multi_monitor_enabled,
            viewport_ready,
            ensure_surface_window,
            set_surface_bounds,
            set_surface_visible,
            bring_surface_to_front,
            set_surface_title,
            destroy_surface_window,
            is_any_app_window_focused,
            start_surface_drag,
            end_surface_drag,
            push_grid_frame,
            get_grid_frame,
            get_all_grid_frame_metas,
            relay_world_command,
            broadcast_world_state,
            relay_penpa_input,
            close_app,
            is_debug_build,
            toggle_devtools
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            // Build `main` from config in setup() so we can attach `.on_new_window(...)` for
            // same-renderer GPU zero-copy secondary viewports and native floating dock windows!
            let main_window = if let Some(existing) = app.get_webview_window("main") {
                Some(existing)
            } else if let Some(main_cfg) = app.config().app.windows.first() {
                #[allow(unused_mut)]
                let mut builder = WebviewWindowBuilder::from_config(app.handle(), main_cfg)?;
                #[cfg(desktop)]
                {
                    let app_for_new = app_handle.clone();
                    let state_for_new = Arc::clone(&state_for_setup);
                    builder = builder.on_new_window(move |url, features| {
                        handle_linked_new_window(&app_for_new, &state_for_new, url, features)
                    });
                }
                Some(builder.build()?)
            } else {
                None
            };

            if let Some(window) = main_window {
                // Capture the user's Launch Monitor BEFORE positioning the overlay window,
                // strictly distinguishing Launch Monitor from OS System Primary Monitor!
                #[cfg(windows)]
                let (detected_launch_id, initial_monitors) = {
                    let lid = detect_windows_launch_monitor_id();
                    let mons = enumerate_monitors(&app_handle, lid.as_deref());
                    (lid, mons)
                };
                #[cfg(target_os = "macos")]
                let (detected_launch_id, initial_monitors) = {
                    let probe = enumerate_monitors(&app_handle, None);
                    let lid = detect_macos_launch_monitor_id(&probe);
                    let mons = if lid.is_some() {
                        enumerate_monitors(&app_handle, lid.as_deref())
                    } else {
                        probe
                    };
                    (lid, mons)
                };
                #[cfg(not(any(windows, target_os = "macos")))]
                let (detected_launch_id, initial_monitors) = {
                    let lid: Option<String> = None;
                    let mons = enumerate_monitors(&app_handle, None);
                    (lid, mons)
                };
                let resolved_launch = resolve_main_monitor(&initial_monitors, detected_launch_id.as_deref());
                let resolved_launch_id = resolved_launch.as_ref().map(|m| m.id.clone());

                if let Ok(mut guard) = state_for_setup.lock() {
                    guard.launch_monitor_id = resolved_launch_id.clone();
                    guard.main_monitor_id = resolved_launch_id;
                    guard.monitors = initial_monitors;
                }

                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = window.set_shadow(false);
                let _ = window.set_maximizable(false);
                let _ = window.set_resizable(false);
                let _ = window.set_always_on_top(true);
                let _ = window.set_ignore_cursor_events(false);
                disable_windows_dwm_transitions(&window);
                fit_overlay_window_to_monitor(&window, resolved_launch.as_ref());
                emit_safe_area_insets_for_window(&window, true, resolved_launch.as_ref());

                let win_for_evt = window.clone();
                let state_for_evt = Arc::clone(&state_for_setup);
                let app_for_close = app_handle.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                        app_for_close.exit(0);
                    }
                    tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        let (is_overlay, main_mon) = state_for_evt
                            .lock()
                            .map(|g| {
                                (
                                    g.is_overlay_mode,
                                    resolve_main_monitor(&g.monitors, g.main_monitor_id.as_deref()),
                                )
                            })
                            .unwrap_or((false, None));
                        if is_overlay {
                            fit_overlay_window_to_monitor(&win_for_evt, main_mon.as_ref());
                        }
                        emit_safe_area_insets_for_window(&win_for_evt, is_overlay, main_mon.as_ref());
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let (is_overlay, main_mon) = state_for_evt
                            .lock()
                            .map(|g| {
                                (
                                    g.is_overlay_mode,
                                    resolve_main_monitor(&g.monitors, g.main_monitor_id.as_deref()),
                                )
                            })
                            .unwrap_or((false, None));
                        emit_safe_area_insets_for_window(&win_for_evt, is_overlay, main_mon.as_ref());
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
                    spawn_windows_overlay_poller(app_handle, state_for_setup);
                }

                #[cfg(target_os = "macos")]
                {
                    spawn_macos_theme_watcher(window.clone(), Arc::clone(&state_for_setup));
                    spawn_macos_overlay_poller(app_handle, state_for_setup);
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

    #[test]
    fn distinguishes_primary_and_launch_monitors_and_handles_negative_coords() {
        let primary = MonitorDescriptor {
            id: "\\\\.\\DISPLAY1".to_string(),
            name: "DISPLAY1".to_string(),
            phys_rect: PhysicalRect {
                x: 0,
                y: 0,
                w: 3840,
                h: 2160,
            },
            work_area: PhysicalRect {
                x: 0,
                y: 0,
                w: 3840,
                h: 2088,
            },
            scale: 1.5,
            is_primary: true,
            is_launch: false,
        };
        let left_launch = MonitorDescriptor {
            id: "\\\\.\\DISPLAY2".to_string(),
            name: "DISPLAY2".to_string(),
            phys_rect: PhysicalRect {
                x: -1920,
                y: 0,
                w: 1920,
                h: 1080,
            },
            work_area: PhysicalRect {
                x: -1920,
                y: 0,
                w: 1920,
                h: 1040,
            },
            scale: 1.0,
            is_primary: false,
            is_launch: true,
        };
        let both = vec![primary.clone(), left_launch.clone()];

        // Resolves to launch monitor when connected (distinct from system primary!)
        let chosen = resolve_main_monitor(&both, None).unwrap();
        assert_eq!(chosen.id, "\\\\.\\DISPLAY2");
        assert!(chosen.is_launch);
        assert!(!chosen.is_primary);

        // Falls back to system primary when launch monitor is unplugged
        let only_primary = vec![primary.clone()];
        let fallback = resolve_main_monitor(&only_primary, Some("\\\\.\\DISPLAY2")).unwrap();
        assert_eq!(fallback.id, "\\\\.\\DISPLAY1");
        assert!(fallback.is_primary);

        // Negative coordinate point lookup lands on left secondary display
        let hit_left = find_monitor_for_point(&both, -400, 500).unwrap();
        assert_eq!(hit_left.id, "\\\\.\\DISPLAY2");
        let hit_right = find_monitor_for_point(&both, 1200, 800).unwrap();
        assert_eq!(hit_right.id, "\\\\.\\DISPLAY1");

        // Label sanitization matches Tauri glob capability patterns
        assert_eq!(overlay_label_for_monitor("\\\\.\\DISPLAY2"), "overlay-DISPLAY2");
        assert_eq!(surface_label_for_id("dock-grid_primary"), "dock-grid_primary");
        assert_eq!(surface_label_for_id("control-bar"), "surface-control-bar");
    }
}
