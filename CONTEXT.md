# GitCrest domain glossary

## Repository

A Git working tree that a user opened in GitCrest. Its identity and displayed path refer to the working tree root, even when the user chooses one of its subdirectories. A linked worktree is its own repository context. A bare Git directory is not an opened working tree.

## RepoId

An opaque, stable identifier for one canonical working tree path. Opening that same worktree again yields the same RepoId; a separate linked worktree has a different RepoId. Product and API code use RepoId to refer to an opened repository after the initial open action.

## Git directory

Git's internal metadata directory. A working tree can point to it through a `.git` directory or a `.git` file, as in a linked worktree. It is distinct from the working tree root shown to users.

## HEAD and branch

HEAD identifies the current commit when one exists. A named branch is the symbolic ref that HEAD follows. Detached HEAD has a commit but no current branch. An unborn branch has a symbolic branch name but no commit yet.
