import { describe, expect, it } from "vitest";
import { remoteWebUrl } from "../../src/shared/lib/remote-web-url";

describe("remoteWebUrl", () => {
  it("turns the common Git URL shapes into the repository page", () => {
    expect(remoteWebUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo");
    expect(remoteWebUrl("ssh://git@gitlab.example.com/group/sub/repo.git")).toBe("https://gitlab.example.com/group/sub/repo");
    expect(remoteWebUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(remoteWebUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
    expect(remoteWebUrl("http://host.example/org/repo.git/")).toBe("https://host.example/org/repo");
    expect(remoteWebUrl("git://host.example/org/repo.git")).toBe("https://host.example/org/repo");
  });

  it("never carries credentials or a port into the page address", () => {
    expect(remoteWebUrl("https://user:secret@github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(remoteWebUrl("https://ghp_token@github.com/org/repo.git")).toBe("https://github.com/org/repo");
    expect(remoteWebUrl("https://user:secret@github.com/org/repo.git")).not.toContain("secret");
  });

  it("has no page for local paths, files and odd input", () => {
    for (const value of ["", "   ", "C:\\work\\repo", "C:/work/repo", "/srv/git/repo.git", "../repo", "file:///srv/repo.git", "javascript:alert(1)", "ftp://host/org/repo", "github.com", "https://host/", "a b", "git@host:", "git@host:org/../x"]) {
      expect(remoteWebUrl(value), value).toBeUndefined();
    }
  });
});
