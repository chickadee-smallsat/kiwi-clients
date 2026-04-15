use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../kiwi-3d");

    let status = Command::new("npm.cmd")
        .args(["run", "build"])
        .current_dir("../kiwi-3d")
        .status()
        .expect("Failed to run npm build");

    if !status.success() {
        panic!("Frontend build failed");
    }
}

