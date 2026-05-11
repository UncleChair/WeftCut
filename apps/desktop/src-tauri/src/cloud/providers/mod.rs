//! Concrete cloud-provider implementations behind the trait surfaces in
//! `cloud::transcriber` and `cloud::synthesizer`.
//!
//! Each provider module is a self-contained "single-file drop-in" — adding
//! Deepgram or ElevenLabs is one new file here plus a variant of
//! `keys::Provider`, nothing else. The picker in `cloud::pick_*` walks
//! `Provider::all()` so a new variant lights up automatically.

pub mod openai;
