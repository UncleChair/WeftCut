//! Concrete backend implementations behind the trait surfaces in
//! `speech::transcriber` and `speech::synthesizer`.
//!
//! Each backend module is a self-contained "single-file drop-in" — adding a
//! backend is one new file here plus a variant of `backend::SpeechBackend`,
//! nothing else. The resolver in `speech::resolve_*` walks
//! `backend::DEFAULT_ORDER` so a new variant lights up automatically once its
//! constructor is wired into `speech::construct_*`.

pub mod funasr;
pub mod openai;
pub mod sidecar;
pub mod whisper_cpp;
