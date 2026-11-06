import { execFile, type ChildProcess } from "node:child_process";

/** Only accepts the child object owned by the supervisor; never searches by name. */
export async function terminateSidecar(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const pid = String(child.pid);
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else {
    // Git runners create their own process groups. Killing the core's group
    // would not prove those descendants stopped; keep this limitation explicit.
    child.kill("SIGKILL");
  }
}
