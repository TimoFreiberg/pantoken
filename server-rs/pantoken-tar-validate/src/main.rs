//! Archive path-safety validator for the pantoken provisioning flow.
//!
//! Validates that a `.tar.gz` archive contains only safe, expected member paths
//! (no traversal, no symlinks escaping the root, no unexpected files). Used
//! during remote provisioning to ensure downloaded archives are safe to extract
//! before uploading over SSH. Exit 0 = valid, 2 = malformed gzip/tar, 3 = unsafe.

use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() != 2 {
        eprintln!("Usage: pantoken-tar-validate <archive.tar.gz>");
        eprintln!("Exit 0: valid");
        eprintln!("Exit 2: malformed gzip/tar");
        eprintln!("Exit 3: unsafe or unexpected member");
        process::exit(1);
    }

    let path = &args[1];
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Error opening {path}: {e}");
            process::exit(2);
        }
    };

    match pantoken_tar_validate::validate_tar(file) {
        Ok(paths) => {
            let count = paths.len();
            println!("Valid tar with {count} members");
            process::exit(pantoken_tar_validate::exit_codes::VALID);
        }
        Err(pantoken_tar_validate::TarValidateError::Malformed) => {
            eprintln!("Malformed gzip/tar archive");
            process::exit(pantoken_tar_validate::exit_codes::MALFORMED);
        }
        Err(pantoken_tar_validate::TarValidateError::Unsafe(msg)) => {
            eprintln!("Unsafe or unexpected member: {msg}");
            process::exit(pantoken_tar_validate::exit_codes::UNSAFE);
        }
    }
}
