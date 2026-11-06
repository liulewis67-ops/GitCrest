use tokio::sync::watch;

pub(super) fn requested(signal: &Option<watch::Receiver<bool>>) -> bool {
    signal.as_ref().is_some_and(|signal| *signal.borrow())
}

pub(super) async fn wait(mut signal: Option<watch::Receiver<bool>>) {
    let Some(signal) = signal.as_mut() else {
        return std::future::pending().await;
    };
    while !*signal.borrow() {
        if signal.changed().await.is_err() {
            return;
        }
    }
}
