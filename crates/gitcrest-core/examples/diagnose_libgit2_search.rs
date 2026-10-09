use std::{process::Command, time::Instant};

use git2::{Repository, Sort};

fn git_search(path: &str) -> Result<(Vec<String>, f64), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let git = Command::new("git")
        .current_dir(path)
        .args([
            "log",
            "--fixed-strings",
            "--regexp-ignore-case",
            "--grep=benchmark commit 099999",
            "--format=%H",
            "--max-count=51",
            "HEAD",
            "--branches",
            "--remotes",
        ])
        .output()?;
    let matches = String::from_utf8(git.stdout)?
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok((matches, started.elapsed().as_secs_f64() * 1000.0))
}

fn libgit2_search(path: &str) -> Result<(Vec<String>, f64), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let repository = Repository::open(path)?;
    let mut walk = repository.revwalk()?;
    walk.set_sorting(Sort::TIME)?;
    walk.push_head()?;
    walk.push_glob("refs/heads/*")?;
    walk.push_glob("refs/remotes/*")?;
    let query = b"benchmark commit 099999";
    let mut matches = Vec::new();
    for oid in walk {
        let commit = repository.find_commit(oid?)?;
        if commit
            .message_bytes()
            .to_ascii_lowercase()
            .windows(query.len())
            .any(|window| window == query)
        {
            matches.push(commit.id().to_string());
            if matches.len() == 51 {
                break;
            }
        }
    }
    Ok((matches, started.elapsed().as_secs_f64() * 1000.0))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("fixture path required")?;
    let expected = git_search(&path)?.0;
    let mut libgit2_samples = Vec::new();
    let mut git_samples = Vec::new();
    let mut actual = Vec::new();
    for iteration in 0..20 {
        let (git_result, libgit2_result) = if iteration % 2 == 0 {
            (git_search(&path)?, libgit2_search(&path)?)
        } else {
            let libgit2_result = libgit2_search(&path)?;
            (git_search(&path)?, libgit2_result)
        };
        if git_result.0 != expected {
            return Err("Git search result changed within the sample".into());
        }
        git_samples.push(git_result.1);
        libgit2_samples.push(libgit2_result.1);
        actual = libgit2_result.0;
    }
    libgit2_samples.sort_by(f64::total_cmp);
    git_samples.sort_by(f64::total_cmp);
    let p95_index = (20.0_f64 * 0.95).ceil() as usize - 1;
    println!("expected={} actual={} equal={} libgit2_p50_ms={:.3} libgit2_p95_ms={:.3} libgit2_max_ms={:.3} git_p50_ms={:.3} git_p95_ms={:.3} git_max_ms={:.3}", expected.len(), actual.len(), expected == actual, libgit2_samples[9], libgit2_samples[p95_index], libgit2_samples[19], git_samples[9], git_samples[p95_index], git_samples[19]);
    Ok(())
}
