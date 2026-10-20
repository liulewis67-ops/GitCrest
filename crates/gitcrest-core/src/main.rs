fn main() {
    // Background reads such as `git status` refresh the index and take .git/index.lock while doing
    // so, which makes a concurrent stage, commit or cherry-pick fail with "index.lock: File exists".
    // Every git process the core spawns inherits this, so reads never take that optional lock.
    // Set before the runtime starts any threads.
    std::env::set_var("GIT_OPTIONAL_LOCKS", "0");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to start the async runtime");
    let exit_code = runtime.block_on(gitcrest_core::run());
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
