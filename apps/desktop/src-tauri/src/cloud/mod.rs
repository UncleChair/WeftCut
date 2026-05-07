//! Optional cloud API integrations (Whisper, Deepgram, AssemblyAI, ...).
//!
//! User-supplied keys live in the OS keyring. Tools return `Unavailable` with a hint
//! to configure a key when none is set — the agent should not see "cloud vs local",
//! only "this tool exists or doesn't."
//!
//! Design: `docs/mcp.md` "Cloud APIs".
