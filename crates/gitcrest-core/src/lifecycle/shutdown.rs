use tokio::io::AsyncReadExt;

pub(crate) async fn wait_for_shutdown() {
    tokio::select! {
        _ = wait_for_stdin_close() => {}
        _ = wait_for_os_signal() => {}
    }
}

async fn wait_for_stdin_close() {
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0; 1024];
    loop {
        match stdin.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[cfg(unix)]
async fn wait_for_os_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let Ok(mut terminate) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(windows)]
async fn wait_for_os_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
