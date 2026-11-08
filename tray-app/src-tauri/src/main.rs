// UNVERIFIED — never compiled (no Rust toolchain in the sandbox that wrote
// this). See ../README.md. Deliberately thin: no sync logic lives here, it
// all stays in scripts/cms-sync.ts (already built + tested) — this just
// shows a tray icon/menu and shells out to it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

#[derive(Deserialize)]
struct Config {
    /// Absolute path to the content-management repo checkout — needed so
    /// `npx tsx scripts/cms-sync.ts` runs from the right directory with its
    /// node_modules available. No default; the app refuses to run without it.
    cms_repo_path: String,
    #[serde(default = "default_sync_folder")]
    sync_folder: String,
}

fn default_sync_folder() -> String {
    "content/posts".to_string()
}

fn config_path() -> Option<PathBuf> {
    dirs_config_dir().map(|d| d.join("interactor-cms-sync").join("config.json"))
}

// Deliberately not pulling in the `dirs` crate for one lookup — this is the
// standard XDG/platform config-dir logic it would give us anyway.
fn dirs_config_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
}

fn load_config() -> Result<Config, String> {
    let path = config_path().ok_or("Could not determine config directory")?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Missing config at {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid config JSON: {}", e))
}

fn run_sync(command: &str) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[interactor-cms-sync-tray] {}", e);
            return;
        }
    };

    // Shells out to the already-tested CLI rather than reimplementing sync
    // logic in Rust — see scripts/cms-sync.ts for the actual pull/push/
    // conflict/force behavior.
    let status = Command::new("npx")
        .args(["tsx", "scripts/cms-sync.ts", command, "--dir", &config.sync_folder])
        .current_dir(&config.cms_repo_path)
        .status();

    match status {
        Ok(s) if s.success() => println!("[interactor-cms-sync-tray] {} completed", command),
        Ok(s) => eprintln!("[interactor-cms-sync-tray] {} exited with {}", command, s),
        Err(e) => eprintln!("[interactor-cms-sync-tray] failed to run {}: {}", command, e),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Tray-only app — no dock icon / taskbar entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let pull = MenuItem::with_id(app, "pull", "Pull posts", true, None::<&str>)?;
            let push = MenuItem::with_id(app, "push", "Push changed posts", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&pull, &push, &separator, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().cloned().unwrap())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "pull" => run_sync("pull"),
                    "push" => run_sync("push"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Interactor CMS Sync tray app");
}
