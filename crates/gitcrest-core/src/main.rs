#[tokio::main]
async fn main() {
    let exit_code = gitcrest_core::run().await;
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
