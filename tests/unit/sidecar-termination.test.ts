import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { terminateSidecar } from "../../electron/main/sidecar-termination";

it.runIf(process.platform === "win32")("terminates an owned Windows parent and its continuously writing child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitcrest-force-tree-"));
  const progress = join(directory, "progress");
  const writer = join(directory, "writer.cjs");
  const parent = join(directory, "parent.cjs");
  await writeFile(writer, `const fs = require('node:fs');
const file = process.argv[2];
setInterval(() => fs.appendFileSync(file, 'x'), 20);
setTimeout(() => process.exit(), 20000).unref();
`);
  await writeFile(parent, `const {spawn} = require('node:child_process');
spawn(process.execPath, [process.argv[2], process.argv[3]], {windowsHide:true, stdio:'ignore'});
setInterval(() => {}, 1000);
`);
  const core = spawn(process.execPath, [parent, writer, progress], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve, reject) => { core.once("exit", resolve); core.once("error", reject); });
  try {
    await expect.poll(() => readFile(progress, "utf8").then((text) => text.length, () => 0), { timeout: 5_000 }).toBeGreaterThan(2);
    await terminateSidecar(core);
    await exited;
    const stopped = await readFile(progress, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readFile(progress, "utf8")).toBe(stopped);
  } finally {
    if (core.exitCode === null && core.signalCode === null) {
      await terminateSidecar(core);
      await exited;
    }
    // All paths are created beneath this test's dedicated temporary directory.
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
