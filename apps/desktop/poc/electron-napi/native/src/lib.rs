use imbl::Vector;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Serialize, Deserialize)]
struct Layer {
    id: String,
    t_start_us: i64,
    t_end_us: i64,
    kind: String,
    opacity: f64,
    x: f64,
    y: f64,
    scale: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Project {
    layers: Vector<Layer>,
    duration_us: i64,
}

fn sample_project(n: usize) -> Project {
    let layers = (0..n)
        .map(|i| Layer {
            id: format!("layer-{i}"),
            t_start_us: (i as i64) * 1_000_000,
            t_end_us: (i as i64) * 1_000_000 + 2_000_000,
            kind: if i % 2 == 0 { "video" } else { "audio" }.to_string(),
            opacity: 1.0,
            x: 0.0,
            y: 0.0,
            scale: 1.0,
        })
        .collect();
    Project { layers, duration_us: (n as i64) * 1_000_000 }
}

#[derive(Deserialize)]
struct MoveMutation {
    #[serde(rename = "layerIndex")]
    layer_index: usize,
    #[serde(rename = "deltaUs")]
    delta_us: i64,
}

/// Pure mutation: returns a new project with one layer moved (persistent update).
fn move_layer(proj: &Project, m: &MoveMutation) -> Project {
    let mut next = proj.clone();
    if let Some(layer) = next.layers.get(m.layer_index).cloned() {
        let mut moved = layer;
        moved.t_start_us += m.delta_us;
        moved.t_end_us += m.delta_us;
        next.layers = next.layers.update(m.layer_index, moved);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_layer_shifts_only_target() {
        let proj = sample_project(50);
        let before = proj.layers.get(3).unwrap().t_start_us;
        let next = move_layer(&proj, &MoveMutation { layer_index: 3, delta_us: 500 });
        assert_eq!(next.layers.get(3).unwrap().t_start_us, before + 500);
        assert_eq!(next.layers.get(4).unwrap().t_start_us, proj.layers.get(4).unwrap().t_start_us);
    }
}

static STATE: OnceLock<Mutex<Project>> = OnceLock::new();
fn state() -> &'static Mutex<Project> {
    STATE.get_or_init(|| Mutex::new(sample_project(50)))
}

#[napi]
pub async fn apply_mutation(payload: String) -> Result<String> {
    let m: MoveMutation =
        serde_json::from_str(&payload).map_err(|e| Error::from_reason(format!("bad payload: {e}")))?;
    let view = {
        let mut proj = state().lock().unwrap();
        *proj = move_layer(&proj, &m);
        serde_json::to_string(&*proj).map_err(|e| Error::from_reason(format!("serialize: {e}")))?
    };
    Ok(view)
}

#[napi]
pub async fn heavy_mutation(rounds: u32) -> Result<f64> {
    let sum = tokio::task::spawn_blocking(move || {
        let mut acc = 0f64;
        for i in 0..(rounds as u64) * 1_000_000 {
            acc += (i as f64).sqrt();
        }
        acc
    })
    .await
    .map_err(|e| Error::from_reason(format!("join: {e}")))?;
    Ok(sum)
}

#[napi]
pub fn subscribe_and_fire(callback: ThreadsafeFunction<String>) -> Result<()> {
    std::thread::spawn(move || {
        for i in 0..5 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            callback.call(Ok(format!("project:changed #{i}")), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });
    Ok(())
}
