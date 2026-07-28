use std::net::IpAddr;

use serde::Serialize;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

pub(crate) const TOOL_BROWSER_WINDOW_LABEL: &str = "tool-browser";
const EMBEDDED_TOOL_BROWSER_LABEL: &str = "tool-browser-embedded";
const TOOL_BROWSER_WINDOW_TITLE: &str = "Lantor Tool Browser";
const TOOL_BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const TOOL_BROWSER_INIT_SCRIPT: &str = r#"
(() => {
  delete window.__TAURI__;
  delete window.__TAURI_INTERNALS__;
})();
"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ToolBrowserTargetKind {
    Http,
    Https,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolBrowserTarget {
    pub(crate) url: String,
    pub(crate) kind: ToolBrowserTargetKind,
    pub(crate) host: String,
    pub(crate) is_loopback: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolBrowserWindowInfo {
    pub(crate) label: &'static str,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) is_loopback: bool,
    pub(crate) created: bool,
}

pub(crate) fn validate_tool_browser_target(target: &str) -> Result<ToolBrowserTarget, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("tool browser target is required".to_owned());
    }
    if trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
        return Err("tool browser target is invalid".to_owned());
    }
    let lower = trimmed.to_ascii_lowercase();
    let authority = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
        .ok_or_else(|| "tool browser target must be an absolute http or https URL".to_owned())?;
    if authority.is_empty() || authority.starts_with('/') {
        return Err("tool browser target must include a host".to_owned());
    }

    let url = Url::parse(trimmed)
        .map_err(|_| "tool browser target must be an absolute http or https URL".to_owned())?;
    let kind = match url.scheme() {
        "http" => ToolBrowserTargetKind::Http,
        "https" => ToolBrowserTargetKind::Https,
        _ => {
            return Err(
                "tool browser target must use http or https; file, data, javascript, and app protocols are not supported"
                    .to_owned(),
            )
        }
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err("tool browser target cannot include credentials".to_owned());
    }
    let host = url
        .host_str()
        .filter(|host| !host.trim().is_empty())
        .ok_or_else(|| "tool browser target must include a host".to_owned())?
        .to_owned();

    Ok(ToolBrowserTarget {
        url: url.to_string(),
        kind,
        is_loopback: is_loopback_host(&host),
        host,
    })
}

#[tauri::command]
pub(crate) async fn open_tool_browser(
    app: AppHandle,
    target: String,
) -> Result<ToolBrowserWindowInfo, String> {
    let target = validate_tool_browser_target(&target)?;
    open_or_retarget_tool_browser(&app, target, true)
}

#[tauri::command]
pub(crate) async fn focus_tool_browser(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(TOOL_BROWSER_WINDOW_LABEL)
        .ok_or_else(|| "tool browser window is not open".to_owned())?;
    focus_tool_browser_window(&window)
}

#[tauri::command]
pub(crate) async fn retarget_tool_browser(
    app: AppHandle,
    target: String,
) -> Result<ToolBrowserWindowInfo, String> {
    let target = validate_tool_browser_target(&target)?;
    open_or_retarget_tool_browser(&app, target, false)
}

#[tauri::command]
pub(crate) async fn close_tool_browser(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TOOL_BROWSER_WINDOW_LABEL) {
        window.close().map_err(to_tool_browser_error)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_embedded_tool_browser(
    app: AppHandle,
    target: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
) -> Result<ToolBrowserWindowInfo, String> {
    let target = validate_tool_browser_target(&target)?;
    let url = parse_validated_url(&target)?;
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    let zoom = embedded_tool_browser_zoom(zoom);
    let created = if let Some(webview) = app.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
        webview
            .set_position(position)
            .map_err(to_tool_browser_error)?;
        webview.set_size(size).map_err(to_tool_browser_error)?;
        webview.set_zoom(zoom).map_err(to_tool_browser_error)?;
        webview.navigate(url).map_err(to_tool_browser_error)?;
        webview.show().map_err(to_tool_browser_error)?;
        false
    } else {
        let main = app
            .get_webview("main")
            .ok_or_else(|| "main webview is not available".to_owned())?;
        let window = main.window();
        let app_for_new_window = app.clone();
        let webview_builder = WebviewBuilder::new(
            EMBEDDED_TOOL_BROWSER_LABEL,
            WebviewUrl::External(url.clone()),
        )
        .user_agent(TOOL_BROWSER_USER_AGENT)
        .initialization_script(TOOL_BROWSER_INIT_SCRIPT)
        .on_navigation(|url| validate_tool_browser_target(url.as_str()).is_ok())
        .on_new_window(move |url, _| {
            if validate_tool_browser_target(url.as_str()).is_ok() {
                if let Some(webview) = app_for_new_window.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
                    if let Err(error) = webview.navigate(url) {
                        eprintln!("failed to navigate embedded tool browser new window: {error}");
                    }
                }
            } else {
                eprintln!("blocked embedded tool browser new window target: {url}");
            }
            NewWindowResponse::Deny
        });
        let webview = window
            .add_child(webview_builder, position, size)
            .map_err(to_tool_browser_error)?;
        webview.set_zoom(zoom).map_err(to_tool_browser_error)?;
        true
    };

    Ok(ToolBrowserWindowInfo {
        label: TOOL_BROWSER_WINDOW_LABEL,
        url: target.url,
        host: target.host,
        is_loopback: target.is_loopback,
        created,
    })
}

#[tauri::command]
pub(crate) async fn set_embedded_tool_browser_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
        webview
            .set_position(LogicalPosition::new(x.max(0.0), y.max(0.0)))
            .map_err(to_tool_browser_error)?;
        webview
            .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
            .map_err(to_tool_browser_error)?;
        webview
            .set_zoom(embedded_tool_browser_zoom(zoom))
            .map_err(to_tool_browser_error)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn close_embedded_tool_browser(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
        webview.close().map_err(to_tool_browser_error)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn go_back_embedded_tool_browser(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
        webview
            .eval("if (window.history.length > 1) window.history.back();")
            .map_err(to_tool_browser_error)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn go_forward_embedded_tool_browser(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(EMBEDDED_TOOL_BROWSER_LABEL) {
        webview
            .eval("window.history.forward();")
            .map_err(to_tool_browser_error)?;
    }
    Ok(())
}

fn embedded_tool_browser_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(0.25, 3.0)
    } else {
        1.0
    }
}

fn open_or_retarget_tool_browser(
    app: &AppHandle,
    target: ToolBrowserTarget,
    create_if_missing: bool,
) -> Result<ToolBrowserWindowInfo, String> {
    let url = parse_validated_url(&target)?;
    let created = if let Some(window) = app.get_webview_window(TOOL_BROWSER_WINDOW_LABEL) {
        navigate_tool_browser_window(&window, url)?;
        window
            .set_title(&window_title(&target))
            .map_err(to_tool_browser_error)?;
        focus_tool_browser_window(&window)?;
        false
    } else {
        if !create_if_missing {
            return Err("tool browser window is not open".to_owned());
        }
        WebviewWindowBuilder::new(
            app,
            TOOL_BROWSER_WINDOW_LABEL,
            WebviewUrl::External(url.clone()),
        )
        .user_agent(TOOL_BROWSER_USER_AGENT)
        .title(window_title(&target))
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .center()
        .focused(true)
        .incognito(true)
        .initialization_script(TOOL_BROWSER_INIT_SCRIPT)
        .on_navigation(|url| validate_tool_browser_target(url.as_str()).is_ok())
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()
        .map_err(to_tool_browser_error)?;
        true
    };

    Ok(ToolBrowserWindowInfo {
        label: TOOL_BROWSER_WINDOW_LABEL,
        url: target.url,
        host: target.host,
        is_loopback: target.is_loopback,
        created,
    })
}

fn navigate_tool_browser_window(window: &tauri::WebviewWindow, url: Url) -> Result<(), String> {
    let should_navigate = window
        .url()
        .map(|current| current.as_str() != url.as_str())
        .unwrap_or(true);
    if should_navigate {
        window.navigate(url).map_err(to_tool_browser_error)?;
    }
    Ok(())
}

fn focus_tool_browser_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(to_tool_browser_error)?;
    window.set_focus().map_err(to_tool_browser_error)?;
    Ok(())
}

fn parse_validated_url(target: &ToolBrowserTarget) -> Result<Url, String> {
    Url::parse(&target.url).map_err(|_| "tool browser target is invalid".to_owned())
}

fn window_title(target: &ToolBrowserTarget) -> String {
    format!("{TOOL_BROWSER_WINDOW_TITLE} - {}", target.host)
}

fn to_tool_browser_error(error: impl std::fmt::Display) -> String {
    format!("tool browser window error: {error}")
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_matches(|ch| ch == '[' || ch == ']')
        .parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{validate_tool_browser_target, window_title, ToolBrowserTargetKind};

    #[test]
    fn accepts_http_and_https_targets() {
        let http =
            validate_tool_browser_target(" http://localhost:5173/tool-output?run=1#preview ")
                .expect("localhost http target");
        assert_eq!(http.kind, ToolBrowserTargetKind::Http);
        assert_eq!(http.host, "localhost");
        assert!(http.is_loopback);
        assert_eq!(http.url, "http://localhost:5173/tool-output?run=1#preview");

        let https = validate_tool_browser_target("https://example.com/path").expect("https target");
        assert_eq!(https.kind, ToolBrowserTargetKind::Https);
        assert_eq!(https.host, "example.com");
        assert!(!https.is_loopback);
    }

    #[test]
    fn accepts_loopback_ip_targets() {
        assert!(
            validate_tool_browser_target("http://127.0.0.1:3000")
                .unwrap()
                .is_loopback
        );
        assert!(
            validate_tool_browser_target("http://[::1]:3000")
                .unwrap()
                .is_loopback
        );
    }

    #[test]
    fn rejects_relative_or_hostless_targets() {
        assert!(validate_tool_browser_target("/artifact/123").is_err());
        assert!(validate_tool_browser_target("localhost:5173").is_err());
        assert!(validate_tool_browser_target("http:///missing-host").is_err());
    }

    #[test]
    fn rejects_unsupported_or_dangerous_schemes() {
        for target in [
            "file:///tmp/report.html",
            "asset://localhost/attachment",
            "data:text/html,<h1>x</h1>",
            "javascript:alert(1)",
            "mailto:owner@example.com",
            "tauri://localhost",
        ] {
            assert!(validate_tool_browser_target(target).is_err(), "{target}");
        }
    }

    #[test]
    fn rejects_credentials_and_control_characters() {
        assert!(validate_tool_browser_target("https://user:pass@example.com").is_err());
        assert!(validate_tool_browser_target("https://example.com/\nnext").is_err());
    }

    #[test]
    fn derives_stable_window_title_from_validated_target() {
        let target = validate_tool_browser_target("https://example.com/report").unwrap();
        assert_eq!(window_title(&target), "Lantor Tool Browser - example.com");
    }
}
