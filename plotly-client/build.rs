//! Builds the 3D viewer (`kiwi-3d`, a Vite app) into `web/3d`, which the
//! server serves from disk in debug builds and embeds in release builds.
//!
//! Needs Node/npm. If npm is not installed but `web/3d` already exists, that
//! copy is used with a warning so pure-Rust work is not blocked. If npm runs
//! and the frontend build fails, the build fails: a stale bundle must never
//! ship in place of a broken one.

use std::{fs, path::Path, process::Command};

#[cfg(target_os = "windows")]
const NPM: &str = "npm.cmd";
#[cfg(not(target_os = "windows"))]
const NPM: &str = "npm";

const APP_DIR: &str = "kiwi-3d";
const OUT_DIR: &str = "web/3d";

fn main() {
    // Only the viewer's sources matter; watching the whole directory would
    // include node_modules and dist and rebuild on every cargo invocation.
    for p in [
        "kiwi-3d/src",
        "kiwi-3d/public",
        "kiwi-3d/index.html",
        "kiwi-3d/package.json",
        "kiwi-3d/package-lock.json",
        "kiwi-3d/vite.config.js",
        "web/kiwi-protocol.js",
    ] {
        println!("cargo:rerun-if-changed={p}");
    }

    match build_viewer() {
        Ok(()) => {}
        Err(BuildError::NpmMissing(e)) if Path::new(OUT_DIR).join("index.html").exists() => {
            println!(
                "cargo:warning=npm unavailable ({e}); using existing {OUT_DIR} without rebuilding"
            );
        }
        Err(BuildError::NpmMissing(e)) => panic!("npm is required to build the 3D viewer: {e}"),
        Err(BuildError::Failed(e)) => panic!("3D viewer build failed: {e}"),
    }
}

enum BuildError {
    /// npm could not be started at all.
    NpmMissing(String),
    /// npm ran but a step failed.
    Failed(String),
}

fn build_viewer() -> Result<(), BuildError> {
    if !Path::new(APP_DIR).join("node_modules").exists() {
        npm(&["ci"])?;
    }
    npm(&["run", "build"])?;

    let _ = fs::remove_dir_all(OUT_DIR);
    copy_dir_all(Path::new(APP_DIR).join("dist"), Path::new(OUT_DIR))
        .map_err(|e| BuildError::Failed(format!("copying dist to {OUT_DIR}: {e}")))
}

fn npm(args: &[&str]) -> Result<(), BuildError> {
    let status = Command::new(NPM)
        .args(args)
        .current_dir(APP_DIR)
        .status()
        .map_err(|e| BuildError::NpmMissing(e.to_string()))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| BuildError::Failed(format!("`npm {}` exited with {status}", args.join(" "))))
}

fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.as_ref().join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(entry.path(), target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
