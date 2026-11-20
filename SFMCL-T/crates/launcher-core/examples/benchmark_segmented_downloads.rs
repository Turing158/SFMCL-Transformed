//! Reproducible download/resource measurements; input is a JSON manifest.
//! Plain mode seeds empty legacy partials to use the ordinary production path.
use anyhow::{Context, Result};
use serde::Deserialize;
use sfmcl_t_core::{
    downloads::{DownloadManager, DownloadSpec},
    minecraft::download_source::MinecraftDownloadSource,
};
use sha1::{Digest, Sha1};
use std::{
    io::Read,
    path::PathBuf,
    time::{Duration, Instant},
};
use sysinfo::{ProcessesToUpdate, System};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    mode: String,
    files: Vec<DownloadSpec>,
    #[serde(default = "budget")]
    connection_limit: usize,
}
fn budget() -> usize {
    16
}

#[tokio::main]
async fn main() -> Result<()> {
    let manifest = std::env::args_os()
        .nth(1)
        .context("Pass a JSON manifest path")?;
    let input: Input = serde_json::from_slice(&std::fs::read(manifest)?)?;
    anyhow::ensure!(
        matches!(input.mode.as_str(), "plain" | "segmented"),
        "Unknown mode"
    );
    let scratch = tempfile::tempdir()?;
    let state = scratch.path().join("state");
    let root = scratch.path().join("game");
    let cache = std::env::var_os("SFMCL_TEST_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| state.join("cache"));
    std::fs::create_dir_all(&state)?;
    let id = uuid::Uuid::new_v4().to_string();
    if input.mode == "plain" {
        let owned = cache.join(format!("tmcl-downloads/{id}"));
        std::fs::create_dir_all(&owned)?;
        for file in &input.files {
            let name = format!("{}.part", hex::encode(Sha1::digest(file.path.as_bytes())));
            std::fs::write(owned.join(name), [])?;
        }
        let files: Vec<_> = input
            .files
            .iter()
            .map(|spec| {
                serde_json::json!({
                    "spec": spec, "status": "paused", "downloaded": 0,
                    "total": spec.size, "attempts": 0, "error": null,
                })
            })
            .collect();
        std::fs::write(
            state.join(format!("{id}.json")),
            serde_json::to_vec(&serde_json::json!({
                "id": id, "title": "benchmark", "retention": "persistent",
                "root": root, "cacheDir": cache, "status": "paused", "files": files,
                "steps": [
                    { "name": "download", "status": "paused", "detail": "" },
                    { "name": "verify", "status": "paused", "detail": "" }
                ], "bytesPerSecond": 0, "activeWorkers": 0, "error": null, "createdAt": 0,
            }))?,
        )?;
    }
    let manager = DownloadManager::open(&state, 8)?;
    manager.set_cache_directory(&cache)?;
    manager.set_connection_limit(input.connection_limit);
    manager
        .sources()
        .set_mode(MinecraftDownloadSource::Official);
    let pid = sysinfo::get_current_pid().map_err(anyhow::Error::msg)?;
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let initial_cpu = system
        .process(pid)
        .context("Process missing")?
        .accumulated_cpu_time();
    let mut peak_memory = system.process(pid).unwrap().memory();
    let mut peak_cpu = 0.0f32;
    let mut peak_files = 0;
    let mut planned_segments = vec![0; input.files.len()];
    let started = Instant::now();
    let id = if input.mode == "plain" {
        manager.resume(&id).await?;
        id
    } else {
        manager
            .enqueue("benchmark".into(), root, input.files)
            .await?
    };
    let cancel = CancellationToken::new();
    let wait = tokio::time::timeout(Duration::from_secs(180), manager.wait(&id, &cancel));
    tokio::pin!(wait);
    let result = loop {
        tokio::select! {
            result = &mut wait => break result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
                if let Some(process) = system.process(pid) {
                    peak_memory = peak_memory.max(process.memory());
                    peak_cpu = peak_cpu.max(process.cpu_usage());
                }
                let snapshot = manager.snapshot(&id).await?;
                peak_files = peak_files.max(snapshot.active_workers);
                for (index, file) in snapshot.files.iter().enumerate() {
                    let name = format!("{}.part.segments.json", hex::encode(Sha1::digest(file.spec.path.as_bytes())));
                    let path = cache.join(format!("tmcl-downloads/{id}")).join(name);
                    let count = std::fs::read(path).ok()
                        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                        .and_then(|value| value["segments"].as_array().map(Vec::len))
                        .unwrap_or(0);
                    planned_segments[index] = planned_segments[index].max(count);
                }
            }
        }
    };
    let elapsed = started.elapsed().as_secs_f64();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system.process(pid).context("Process missing")?;
    peak_memory = peak_memory.max(process.memory());
    let cpu_seconds = (process.accumulated_cpu_time() - initial_cpu) as f64 / 1000.0;
    manager.pause_all().await?;
    let snapshot = manager.snapshot(&id).await?;
    // Independent evidence checks run outside the measured production transfer.
    let mut sha256 = Vec::new();
    for file in &snapshot.files {
        if let Ok(mut input) = std::fs::File::open(snapshot.root.join(&file.spec.path)) {
            let mut hash = sha2::Sha256::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                let bytes = input.read(&mut buffer)?;
                if bytes == 0 {
                    break;
                }
                hash.update(&buffer[..bytes]);
            }
            sha256.push(hex::encode(hash.finalize()));
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "mode": input.mode, "files": snapshot.files.len(), "bytes": snapshot.downloaded(),
            "seconds": elapsed, "mibPerSecond": snapshot.downloaded() as f64 / 1048576.0 / elapsed,
            "cpuSeconds": cpu_seconds, "cpuPercent": cpu_seconds / elapsed * 100.0,
            "peakCpuPercent": peak_cpu, "peakMemoryMiB": peak_memory as f64 / 1048576.0,
            "peakFiles": peak_files, "connectionLimit": input.connection_limit,
            "status": snapshot.status, "error": snapshot.error,
        "sha256": sha256,
        "plannedSegments": planned_segments,
        })
    );
    manager.clear(&id).await?;
    result??;
    Ok(())
}
