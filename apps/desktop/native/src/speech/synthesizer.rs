//! `Synthesizer` capability surface — text in, audio bytes out.
//!
//! Bytes (not paths) on the way out: the `synthesize_speech` tool
//! content-addresses the result, which means it needs the bytes in hand to
//! hash. Letting providers write their own file would force a re-read just
//! to hash, and require each provider to know our cache layout.
//!
//! Provider impls (OpenAI tts-1 today; ElevenLabs / Deepgram Aura would slot in)
//! live in sibling modules and `impl Synthesizer for ...`.

use async_trait::async_trait;

use super::error::SpeechError;

/// Audio container/codec the provider returned. The synthesize tool uses this
/// to pick the cache-file extension and the lowering-side container hint
/// (ffmpeg generally just sniffs, but the extension matters for OS file
/// associations and for the agent inspecting the path).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Wav,
    Opus,
    Flac,
}

impl AudioFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Opus => "opus",
            Self::Flac => "flac",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SynthesizeRequest {
    pub text: String,
    /// Provider-specific voice identifier. OpenAI tts-1 expects one of
    /// `alloy | echo | fable | onyx | nova | shimmer`; ElevenLabs uses a
    /// voice UUID. Validation is the provider impl's job.
    pub voice: String,
    /// 1.0 = provider default pace. `None` lets the provider use its default
    /// without sending the parameter (which providers handle slightly
    /// differently when explicitly passed at the default value).
    pub speed: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct SynthesizeResponse {
    pub audio: Vec<u8>,
    pub format: AudioFormat,
}

#[async_trait]
pub trait Synthesizer: Send + Sync {
    async fn synthesize(&self, req: SynthesizeRequest) -> Result<SynthesizeResponse, SpeechError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_format_extensions_match_filenames() {
        assert_eq!(AudioFormat::Mp3.extension(), "mp3");
        assert_eq!(AudioFormat::Wav.extension(), "wav");
        assert_eq!(AudioFormat::Opus.extension(), "opus");
        assert_eq!(AudioFormat::Flac.extension(), "flac");
    }
}
