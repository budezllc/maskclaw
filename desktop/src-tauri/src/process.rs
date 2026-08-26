use std::collections::VecDeque;
use std::io;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const LOG_CAP: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Restarting,
    Failed,
}

pub trait ManagedChild: Send {
    fn id(&self) -> u32;
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
    fn kill(&mut self) -> io::Result<()>;
}

pub struct ProcessManager<C: ManagedChild> {
    pub state: EngineState,
    pub child: Option<C>,
    pub last_error: Option<String>,
}

impl<C: ManagedChild> Default for ProcessManager<C> {
    fn default() -> Self {
        Self {
            state: EngineState::Stopped,
            child: None,
            last_error: None,
        }
    }
}

impl<C: ManagedChild> ProcessManager<C> {
    pub fn attach_running(&mut self, child: C) {
        self.child = Some(child);
        self.state = EngineState::Running;
        self.last_error = None;
    }

    pub fn mark_failed(&mut self, error: impl Into<String>) {
        self.state = EngineState::Failed;
        self.last_error = Some(error.into());
        self.child = None;
    }

    pub fn stop(&mut self, _timeout: Duration) -> io::Result<()> {
        if self.child.is_none() {
            self.state = EngineState::Stopped;
            return Ok(());
        }
        self.state = EngineState::Stopping;
        if let Some(child) = self.child.as_mut() {
            let pid = child.id();
            child.kill().map_err(|e| {
                io::Error::new(e.kind(), format!("failed to kill engine process {pid}: {e}"))
            })?;
            let _ = child.try_wait();
        }
        self.child = None;
        self.state = EngineState::Stopped;
        Ok(())
    }

    pub fn restart_begin(&mut self) {
        self.state = EngineState::Restarting;
    }
}

pub struct RealChild {
    inner: Child,
}

impl RealChild {
    pub fn spawn(
        program: &str,
        args: &[String],
        env: &[(String, String)],
        logs: Arc<Mutex<VecDeque<String>>>,
    ) -> io::Result<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .envs(env.iter().cloned())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        if let Some(stdout) = child.stdout.take() {
            spawn_pipe_reader(stdout, logs.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_pipe_reader(stderr, logs);
        }
        Ok(Self { inner: child })
    }
}

fn spawn_pipe_reader<R: io::Read + Send + 'static>(reader: R, logs: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || {
        use std::io::BufRead;
        let buf = io::BufReader::new(reader);
        for line in buf.lines().map_while(Result::ok) {
            if let Ok(mut ring) = logs.lock() {
                if ring.len() >= LOG_CAP {
                    ring.pop_front();
                }
                ring.push_back(line);
            }
        }
    });
}

impl ManagedChild for RealChild {
    fn id(&self) -> u32 {
        self.inner.id()
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        Ok(self.inner.try_wait()?.map(|s| s.code().unwrap_or(-1)))
    }

    fn kill(&mut self) -> io::Result<()> {
        self.inner.kill()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeChild {
        id: u32,
        running: bool,
        kills: u32,
        kill_fails: bool,
    }

    impl ManagedChild for FakeChild {
        fn id(&self) -> u32 {
            self.id
        }
        fn try_wait(&mut self) -> io::Result<Option<i32>> {
            Ok(if self.running { None } else { Some(0) })
        }
        fn kill(&mut self) -> io::Result<()> {
            if self.kill_fails {
                return Err(io::Error::other("kill refused"));
            }
            self.kills += 1;
            self.running = false;
            Ok(())
        }
    }

    fn fake(id: u32) -> FakeChild {
        FakeChild {
            id,
            running: true,
            kills: 0,
            kill_fails: false,
        }
    }

    #[test]
    fn stop_kills_engine_without_console_ctrl_c() {
        let mut mgr = ProcessManager::default();
        let child = fake(11);
        mgr.attach_running(child);
        mgr.stop(Duration::from_millis(200)).unwrap();
        assert_eq!(mgr.state, EngineState::Stopped);
        assert!(mgr.child.is_none());
    }

    #[test]
    fn start_stop_kills_engine_child() {
        let mut mgr = ProcessManager::default();
        assert_eq!(mgr.state, EngineState::Stopped);
        mgr.attach_running(fake(7));
        assert_eq!(mgr.child.as_ref().map(ManagedChild::id), Some(7));
        assert_eq!(mgr.state, EngineState::Running);
        mgr.stop(Duration::from_millis(200)).unwrap();
        assert_eq!(mgr.state, EngineState::Stopped);
        assert!(mgr.child.is_none());
    }

    #[test]
    fn restart_then_stop_kills_engine() {
        let mut mgr = ProcessManager::default();
        mgr.attach_running(fake(9));
        mgr.restart_begin();
        assert_eq!(mgr.state, EngineState::Restarting);
        mgr.stop(Duration::from_millis(60)).unwrap();
        assert_eq!(mgr.state, EngineState::Stopped);
    }

    #[test]
    fn kill_error_includes_process_id() {
        let mut mgr = ProcessManager::default();
        let mut child = fake(42);
        child.kill_fails = true;
        mgr.attach_running(child);
        let err = mgr.stop(Duration::from_millis(40)).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("42"),
            "expected pid in kill error, got: {msg}"
        );
        assert!(
            msg.contains("failed to kill engine process"),
            "expected kill error prefix, got: {msg}"
        );
    }

    #[test]
    fn failed_clears_child() {
        let mut mgr = ProcessManager::default();
        mgr.attach_running(fake(1));
        mgr.mark_failed("boom");
        assert_eq!(mgr.state, EngineState::Failed);
        assert!(mgr.child.is_none());
        assert_eq!(mgr.last_error.as_deref(), Some("boom"));
    }
}
