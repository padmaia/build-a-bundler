use std::path::PathBuf;

use rb::Bundler;

fn main() {
    let mut bundler = Bundler::new(PathBuf::from("./input.js"));
    bundler.bundle();
}
