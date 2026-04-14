use std::process::Command;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=kiwi-3d");

    let _ = Command::new("npm")
        .args(["install"])
        .current_dir("kiwi-3d")
        .status()
        .expect("Failed to run npm install");

    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir("kiwi-3d")
        .status()
        .expect("Failed to run npm build");

    if !status.success() {
        panic!("Frontend build failed");
    }
    // Copy the built files to the output directory
    copy_dir_all("kiwi-3d/dist", "web/3d").expect("Failed to copy built files");
}

// Recursively copy directories and files
fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.as_ref().join(entry.file_name()))?;
        }
    }
    Ok(())
}