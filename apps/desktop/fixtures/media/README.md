# Media fixtures

Tiny H.264 clips used by the decoder reading tests (`src/render/decoder/`).
Two containers, identical video stream, so tests prove container parity
(MP4 vs Matroska) for the mediabunny reading path.

## Regenerating

```bash
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -g 15 -movflags +faststart tiny.mp4
ffmpeg -y -i tiny.mp4 -c copy tiny.mkv
```
