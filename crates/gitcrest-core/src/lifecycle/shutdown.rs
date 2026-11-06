use tokio::{sync::watch, task::JoinHandle};

/// Install before opening the database or recovering repositories. The stdin
/// reader is a dedicated read-only thread: it must not keep Tokio's blocking
/// pool alive when an OS signal wins while stdin is still open.
pub(crate) struct Shutdown {
    sender: watch::Sender<bool>,
    signal: watch::Receiver<bool>,
    listener: JoinHandle<()>,
    tasks: Option<JoinHandle<()>>,
}

impl Shutdown {
    pub(crate) fn listen() -> Self {
        let (sender, signal) = watch::channel(false);
        let stdin_sender = sender.clone();
        let stdin = std::thread::Builder::new()
            .name("gitcrest-stdin-close".into())
            .spawn(move || {
                use std::io::Read;
                let mut stdin = std::io::stdin().lock();
                let mut buffer = [0; 1024];
                loop {
                    match stdin.read(&mut buffer) {
                        Ok(0) | Err(_) => {
                            stdin_sender.send_replace(true);
                            break;
                        }
                        Ok(_) => (),
                    }
                }
            });
        if stdin.is_err() {
            sender.send_replace(true);
        }
        let os_sender = sender.clone();
        let listener = tokio::spawn(async move {
            wait_for_os_signal().await;
            os_sender.send_replace(true);
        });
        Self {
            sender,
            signal,
            listener,
            tasks: None,
        }
    }

    pub(crate) fn watch_tasks(&mut self, tasks: crate::execution::TaskService) {
        let signal = self.subscribe();
        self.tasks = Some(tokio::spawn(async move {
            wait(signal).await;
            tasks.begin_shutdown().await;
        }));
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<bool> {
        self.signal.clone()
    }
    pub(crate) fn is_requested(&self) -> bool {
        *self.signal.borrow()
    }

    pub(crate) fn request(&self) {
        self.sender.send_replace(true);
    }

    /// Hold the read view through publication so readiness cannot be emitted
    /// after shutdown has already been published by either signal source.
    pub(crate) fn publish_if_open(&self, publish: impl FnOnce()) -> bool {
        let closing = self.signal.borrow();
        if *closing {
            return false;
        }
        publish();
        true
    }

    #[cfg(test)]
    fn from_signal(signal: impl std::future::Future<Output = ()> + Send + 'static) -> Self {
        let (sender, receiver) = watch::channel(false);
        let signal_sender = sender.clone();
        let listener = tokio::spawn(async move {
            signal.await;
            signal_sender.send_replace(true);
        });
        Self {
            sender,
            signal: receiver,
            listener,
            tasks: None,
        }
    }
}

impl Drop for Shutdown {
    fn drop(&mut self) {
        self.listener.abort();
        if let Some(tasks) = &self.tasks {
            tasks.abort();
        }
    }
}

pub(crate) async fn wait(mut signal: watch::Receiver<bool>) {
    while !*signal.borrow() {
        if signal.changed().await.is_err() {
            return;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    #[tokio::test]
    async fn a_signal_received_before_tasks_are_registered_still_closes_them() {
        let mut shutdown = Shutdown::from_signal(async {});
        wait(shutdown.subscribe()).await;
        let tasks = crate::execution::TaskService::default();
        shutdown.watch_tasks(tasks.clone());
        tokio::time::timeout(Duration::from_secs(1), wait(tasks.shutdown_receiver()))
            .await
            .unwrap();
        assert!(!tasks.spawn_background(async {
            panic!("late registration must remain closed");
        }));
        assert!(!shutdown.publish_if_open(|| panic!("closed startup must not announce readiness")));
    }

    #[tokio::test]
    async fn closing_during_startup_notifies_work_without_dropping_the_actual_future() {
        let (signal, signalled) = tokio::sync::oneshot::channel();
        let mut shutdown = Shutdown::from_signal(async move {
            let _ = signalled.await;
        });
        let tasks = crate::execution::TaskService::default();
        shutdown.watch_tasks(tasks.clone());
        let observed = Arc::new(AtomicBool::new(false));
        let completed = observed.clone();
        let closing = tasks.shutdown_receiver();
        let (release, released) = tokio::sync::oneshot::channel();
        assert!(tasks.spawn_background(async move {
            wait(closing).await;
            let _ = released.await;
            completed.store(true, Ordering::SeqCst);
        }));
        signal.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), wait(tasks.shutdown_receiver()))
            .await
            .unwrap();
        assert!(!observed.load(Ordering::SeqCst));
        assert!(!shutdown.publish_if_open(|| panic!("recovery is closing")));
        release
            .send(())
            .expect("closing did not abort recovery work");
        tasks.drain_workers(Duration::from_secs(1)).await;
        assert!(observed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn readiness_can_be_published_only_before_shutdown_is_requested() {
        let shutdown = Shutdown::from_signal(std::future::pending());
        let published = AtomicBool::new(false);
        assert!(shutdown.publish_if_open(|| published.store(true, Ordering::SeqCst)));
        assert!(published.load(Ordering::SeqCst));
        shutdown.request();
        assert!(!shutdown.publish_if_open(|| panic!("readiness after shutdown")));
    }
}
