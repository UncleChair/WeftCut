//! The per-source Decode Route — where preview and export each read pixels.
//! Persisted as the source of truth (replaces the old flat proxy flags). The
//! readiness paths live INSIDE the variants so a route↔path contradiction
//! (a Bypass carrying a proxy) is unrepresentable. See docs/adr/0028 and CONTEXT.md.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::jobs::proxy_decision::{ExportSource, PreviewSource, ProxyRoute};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "route", rename_all = "kebab-case")]
pub enum DecodeRoute {
    /// Preview + export both decode the original. No proxy.
    Bypass,
    /// Export decodes the original; preview decodes the quick proxy
    /// (`None` until it lands).
    DirectExport {
        #[serde(default)]
        quick_proxy: Option<PathBuf>,
    },
    /// Preview decodes the quick proxy; export decodes the full export master.
    Proxied {
        #[serde(default)]
        quick_proxy: Option<PathBuf>,
        #[serde(default)]
        full_proxy: Option<PathBuf>,
        #[serde(default)]
        format_version: u32,
    },
}

impl DecodeRoute {
    /// The initial variant for a freshly-decided import (no derivatives yet).
    pub fn from_proxy_route(route: ProxyRoute) -> Self {
        match (route.export, route.preview) {
            (ExportSource::Original, PreviewSource::Original) => DecodeRoute::Bypass,
            (ExportSource::Original, PreviewSource::Proxy) => {
                DecodeRoute::DirectExport { quick_proxy: None }
            }
            (ExportSource::FullProxy, PreviewSource::Proxy) => DecodeRoute::Proxied {
                quick_proxy: None,
                full_proxy: None,
                format_version: 0,
            },
            (ExportSource::FullProxy, PreviewSource::Original) => {
                unreachable!("preview=Original implies export=Original")
            }
        }
    }

    /// Export-decode failed on this machine → become Proxied, carrying any
    /// quick proxy already produced. Bypass/Proxied are unchanged.
    pub fn route_corrected(self) -> Self {
        match self {
            DecodeRoute::DirectExport { quick_proxy } => DecodeRoute::Proxied {
                quick_proxy,
                full_proxy: None,
                format_version: 0,
            },
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Golden {
        tags: Vec<String>,
        samples: std::collections::BTreeMap<String, serde_json::Value>,
    }

    fn golden() -> Golden {
        // Same relative-path convention the roleGate/snapFrame Rust golden
        // tests use to read their TS-colocated fixtures.
        let raw = include_str!(
            "../../../src/renderer/render/decodeRouteWireGolden.fixture.json"
        );
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn wire_tags_match_golden() {
        let g = golden();
        assert_eq!(g.tags, vec!["bypass", "direct-export", "proxied"]);
        let bypass = serde_json::to_value(DecodeRoute::Bypass).unwrap();
        assert_eq!(bypass, g.samples["bypass"]);
        let de = serde_json::to_value(DecodeRoute::DirectExport { quick_proxy: None }).unwrap();
        assert_eq!(de, g.samples["direct-export"]);
        let px = serde_json::to_value(DecodeRoute::Proxied {
            quick_proxy: None,
            full_proxy: None,
            format_version: 0,
        })
        .unwrap();
        assert_eq!(px, g.samples["proxied"]);
    }

    #[test]
    fn route_correct_promotes_direct_export_carrying_quick() {
        let q = Some(PathBuf::from("q.mp4"));
        assert_eq!(
            DecodeRoute::DirectExport { quick_proxy: q.clone() }.route_corrected(),
            DecodeRoute::Proxied { quick_proxy: q, full_proxy: None, format_version: 0 }
        );
        assert_eq!(DecodeRoute::Bypass.route_corrected(), DecodeRoute::Bypass);
    }
}
