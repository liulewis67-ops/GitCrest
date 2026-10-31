// Durable review data using the same isolated Git identity as tests/fixtures/temp-repo.ts.
// Usage: node scripts/review-fixture.mjs [new-folder] [--conflict]
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function createReviewFixture(destination, { conflict = false } = {}) {
  // Never reuse a folder: a typo must not alter an existing repository.
  const root = destination ? resolve(destination) : await mkdtemp(join(tmpdir(), "gitcrest-review-"));
  if (destination) await mkdir(root);
  const path = join(root, "repository");
  const remote = join(root, "origin.git");
  const peer = join(root, "remote-writer");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const identity = (cwd) => {
    git(cwd, "config", "user.name", "GitCrest Test");
    git(cwd, "config", "user.email", "gitcrest-test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "config", "core.autocrlf", "false");
  };
  const write = (file, content) => writeFile(join(path, file), content);
  const commit = (message) => {
    git(path, "add", ".");
    git(path, "commit", "--quiet", "-m", message);
  };
  await mkdir(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  identity(path);
  await mkdir(join(path, "src"));
  await write("README.md", "# GitCrest review fixture\n\nA local-only repository for design reviews.\n");
  await write("notes.txt", "Notes to rename during review.\n");
  await write("conflict-one.txt", "Shared base one\n");
  await write("conflict-two.txt", "Shared base two\n");
  await write("src/navigation.ts", Array.from({ length: 80 }, (_, i) =>
    `export function section${i + 1}() {\n  return "Section ${i + 1}";\n}\n`).join("\n"));
  // A real 1×1 PNG exercises binary diff handling without an image dependency.
  await write("preview.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=", "base64"));
  commit("Initialize review workspace");
  git(path, "tag", "v0.1.0");
  for (let i = 1; i <= 19; i++) {
    await write("CHANGELOG.md", `# Progress\n\nReview milestone ${i}\n`);
    commit(`Document review milestone ${i}`);
  }
  git(path, "branch", "feature/search", "HEAD~5");
  git(path, "switch", "--quiet", "feature/search");
  await write("src/search.ts", "export const search = (query: string) => query.trim();\n");
  commit("Add repository search");
  git(path, "switch", "--quiet", "main");
  git(path, "switch", "--quiet", "-c", "feature/shortcuts");
  await write("src/shortcuts.ts", "export const shortcuts = [\"Ctrl+P\", \"Ctrl+Enter\"];\n");
  commit("Define keyboard shortcuts");
  git(path, "switch", "--quiet", "main");
  git(path, "switch", "--quiet", "-c", "feature/merged-notes");
  await write("release-notes.md", "# Release notes\n\nKeyboard and search review.\n");
  commit("Write release notes");
  git(path, "switch", "--quiet", "main");
  git(path, "merge", "--quiet", "--no-ff", "feature/merged-notes", "-m", "Merge release notes");
  git(path, "tag", "v0.2.0");
  git(root, "init", "--quiet", "--bare", remote);
  git(path, "remote", "add", "origin", remote);
  git(path, "push", "--quiet", "--set-upstream", "origin", "main");
  git(path, "push", "--quiet", "origin", "--tags");
  git(root, "clone", "--quiet", "--branch", "main", remote, peer);
  identity(peer);
  await writeFile(join(peer, "remote-note.md"), "An incoming commit from the local remote.\n");
  git(peer, "add", ".");
  git(peer, "commit", "--quiet", "-m", "Add incoming remote note");
  git(peer, "push", "--quiet");
  await write("local-note.md", "An outgoing commit for the local remote.\n");
  commit("Add outgoing local note");
  git(path, "fetch", "--quiet", "origin");
  if (conflict) {
    git(path, "switch", "--quiet", "-c", "feature/conflict");
    await write("conflict-one.txt", "Feature version one\n");
    await write("conflict-two.txt", "Feature version two\n");
    commit("Edit both shared files on feature");
    git(path, "switch", "--quiet", "main");
    await write("conflict-one.txt", "Main version one\n");
    await write("conflict-two.txt", "Main version two\n");
    commit("Edit both shared files on main");
    try { git(path, "merge", "feature/conflict"); } catch (error) {
      if (git(path, "diff", "--name-only", "--diff-filter=U").split("\n").length !== 2) throw error;
    }
    // Keep unrelated edits out of this mode, so the core can safely abort the
    // adopted merge after review. The normal fixture supplies all change kinds.
    return { path, root, remote, conflict };
  }
  git(path, "mv", "notes.txt", "review-notes.txt");
  await write("staged.md", "A staged addition ready to commit.\n");
  git(path, "add", "staged.md");
  await write("README.md", "# GitCrest review fixture\n\nUnstaged documentation changes.\n");
  await write("src/navigation.ts", (await readFile(join(path, "src/navigation.ts"), "utf8")).replace("Section 40", "Updated section 40"));
  await write("preview.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await write("untracked.md", "A new file to review.\n");
  return { path, root, remote, conflict };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg.startsWith("--") && arg !== "--conflict") || args.filter((arg) => !arg.startsWith("--")).length > 1) {
    throw new Error("Usage: node scripts/review-fixture.mjs [new-folder] [--conflict]");
  }
  const fixture = await createReviewFixture(args.find((arg) => !arg.startsWith("--")), { conflict: args.includes("--conflict") });
  console.log(fixture.path);
}
