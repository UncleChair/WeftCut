package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"os"
	"os/exec"
	"strings"
)

type patch struct {
	ID  string `json:"id"`
	X   int    `json:"x"`
	Y   int    `json:"y"`
	W   int    `json:"w"`
	H   int    `json:"h"`
	RGB [3]int `json:"rgb"`
}

type manifest struct {
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	Patches []patch `json:"patches"`
}

// 5x4 grid of large flat patches with deliberate diagnostic values.
func colorPatches(width, height int) []patch {
	cols, rows := 5, 4
	cw, ch := width/cols, height/rows
	vals := [][3]int{
		{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {0, 255, 255}, {255, 0, 255},
		{255, 255, 0}, {255, 255, 255}, {0, 0, 0}, {16, 16, 16}, {235, 235, 235},
		{128, 128, 128}, {64, 64, 64}, {192, 192, 192}, {255, 128, 0}, {128, 0, 255},
		{200, 150, 120}, {30, 60, 90}, {120, 200, 60}, {245, 245, 245}, {10, 10, 10},
	}
	ids := []string{
		"red", "green", "blue", "cyan", "magenta",
		"yellow", "white", "black", "near_black_16", "near_white_235",
		"gray_128", "gray_64", "gray_192", "orange", "violet",
		"skin", "navy", "lime", "near_white_245", "near_black_10",
	}
	out := make([]patch, 0, cols*rows)
	for i := 0; i < cols*rows; i++ {
		r, c := i/cols, i%cols
		out = append(out, patch{
			ID: ids[i], X: c * cw, Y: r * ch, W: cw, H: ch, RGB: vals[i],
		})
	}
	return out
}

func writeColorChart(width, height int) (string, error) {
	patches := colorPatches(width, height)
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for _, p := range patches {
		col := color.RGBA{uint8(p.RGB[0]), uint8(p.RGB[1]), uint8(p.RGB[2]), 255}
		draw.Draw(img, image.Rect(p.X, p.Y, p.X+p.W, p.Y+p.H), &image.Uniform{col}, image.Point{}, draw.Src)
	}
	pf, err := os.Create("color_chart.png")
	if err != nil {
		return "", err
	}
	defer pf.Close()
	if err := png.Encode(pf, img); err != nil {
		return "", err
	}
	mf, err := os.Create("color_manifest.json")
	if err != nil {
		return "", err
	}
	defer mf.Close()
	enc := json.NewEncoder(mf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(manifest{Width: width, Height: height, Patches: patches}); err != nil {
		return "", err
	}
	return "color_chart.png", nil
}

func main() {
	fps := flag.Int("fps", 0, "frame rate (required, positive integer)")
	format := flag.String("format", "mp4", "output format: mp4, mkv, mov, webm, gif, prores")
	audio := flag.Bool("audio", false, "add a per-second frequency-stepped tone track (test marker) + name output *_audio.mp4")
	eosTail := flag.Bool("eostail", false, "EOS-tail geometry: keyframes every 5s only (final GOP spans multiple 60-frame export chunks) + tone track 1s LONGER than the video; names output *_eostail.mp4")
	colorEnc := flag.String("color", "", "color chart encoding: 709ltd|601ltd|709full|601full (draws chart + manifest, ignores --fps content)")
	gradient := flag.Bool("gradient", false, "emit a 10-bit BT.709 grayscale gradient ramp (HEVC Main10) for axis B")
	flag.Parse()

	if *colorEnc != "" {
		const width, height, duration = 1920, 1080, 1
		var matrix, prim, trc, rng, outRange string
		switch *colorEnc {
		case "709ltd":
			matrix, prim, trc, rng, outRange = "bt709", "bt709", "bt709", "tv", "tv"
		case "601ltd":
			matrix, prim, trc, rng, outRange = "smpte170m", "smpte170m", "smpte170m", "tv", "tv"
		case "709full":
			matrix, prim, trc, rng, outRange = "bt709", "bt709", "bt709", "pc", "pc"
		case "601full":
			matrix, prim, trc, rng, outRange = "smpte170m", "smpte170m", "smpte170m", "pc", "pc"
		default:
			log.Fatalf("unknown --color %q (709ltd|601ltd|709full|601full)", *colorEnc)
		}
		chart, err := writeColorChart(width, height)
		if err != nil {
			log.Fatalf("chart: %v", err)
		}
		out := fmt.Sprintf("test_%dp_color_%s.mp4", height, *colorEnc)
		vf := fmt.Sprintf("format=rgb24,scale=out_color_matrix=%s:out_range=%s,format=yuv420p", matrix, outRange)
		args := []string{
			"-y", "-loop", "1", "-i", chart, "-t", fmt.Sprintf("%d", duration), "-r", "30",
			"-vf", vf, "-c:v", "libx264", "-crf", "18", "-preset", "medium",
			"-colorspace", matrix, "-color_primaries", prim, "-color_trc", trc, "-color_range", rng,
			"-an", out,
		}
		fmt.Printf("Generating %s (%s)\n", out, *colorEnc)
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("ffmpeg failed: %v", err)
		}
		fmt.Printf("Done: %s\n", out)
		return
	}

	if *gradient {
		const width, height, duration = 1920, 1080, 1
		out := fmt.Sprintf("test_%dp_gradient10.mp4", height)
		// True 10-bit BT.709 luma ramp. `format=yuv420p10le` BEFORE `geq` is the
		// crux: geq then evaluates and writes at 10-bit depth, so `(X/(W-1))*1023`
		// maps the 1920 columns onto ~1024 distinct luma levels (verified ~877
		// distinct after HEVC). Authoring on an 8-bit source first would collapse
		// the ramp to 256 levels — a fake 10-bit clip that merely ffprobes as
		// yuv420p10le. cb=cr=512 is neutral chroma at 10-bit.
		vf := "format=yuv420p10le,geq=lum='(X/(W-1))*1023':cb=512:cr=512,scale=out_color_matrix=bt709:out_range=tv"
		args := []string{
			"-y", "-f", "lavfi", "-i",
			fmt.Sprintf("nullsrc=size=%dx%d:rate=30:duration=%d", width, height, duration),
			"-vf", vf,
			"-c:v", "libx265",
			"-x265-params", "profile=main10:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
			"-pix_fmt", "yuv420p10le",
			"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
			"-tag:v", "hvc1", "-an", out,
		}
		fmt.Printf("Generating %s (10-bit BT.709 gradient, HEVC Main10)\n", out)
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("ffmpeg failed: %v", err)
		}
		fmt.Printf("Done: %s\n", out)
		return
	}

	if *fps <= 0 {
		log.Fatal("--fps must be a positive integer")
	}

	const (
		width    = 1920
		height   = 1080
		duration = 10
	)
	out := fmt.Sprintf("test_%dp_%dfps.%s", height, *fps, *format)

	font := `C\:/Windows/Fonts/consola.ttf`
	common := fmt.Sprintf(`fontfile='%s':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`, font)

	filters := []string{
		fmt.Sprintf(`drawtext=%s:text='FRAME %%{eif\:n+1\:d\:5}':fontsize=42:x=20:y=20`, common),
		fmt.Sprintf(`drawtext=%s:timecode='00\:00\:00\:00':timecode_rate=%d:fontsize=42:x=20:y=85`, common, *fps),
		fmt.Sprintf(`drawtext=%s:text='%d fps  1920x1080':fontsize=42:x=20:y=150`, common, *fps),
		fmt.Sprintf(`drawtext=%s:text='%%{eif\:mod(n\,%d)+1\:d\:2}':fontsize=300:x=(w-text_w)/2:y=(h-text_h)/2`, common, *fps),
	}
	// Emit a colorimetrically UNAMBIGUOUS stream: testsrc2 + drawtext are RGB,
	// so force the RGB->YUV through BT.709 limited (`format=rgb24` removes any
	// input-matrix ambiguity; `scale=out_color_matrix=bt709:out_range=tv` does
	// the conversion), then tag the stream 709 (the `-color_*` output flags
	// below). Without this the clip is untagged and ffmpeg's default RGB->YUV is
	// 601 — leaving a 601-pixel/no-tag asset that WebCodecs (709-default for HD)
	// and ffmpeg interpret differently. (See the media-conformance investigation.)
	colorVF := "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
	vfChain := strings.Join(filters, ",")
	// Container/bitstream color tags so decoders read 709 instead of guessing.
	colorTags := []string{
		"-colorspace", "bt709",
		"-color_primaries", "bt709",
		"-color_trc", "bt709",
		"-color_range", "tv",
	}

	input := []string{
		"-y",
		"-f", "lavfi",
		"-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=%d:duration=%d", width, height, *fps, duration),
	}

	var args []string
	switch *format {
	case "mp4", "mkv", "mov":
		if *eosTail {
			// Export tail-deadlock gate fixture (see export_eos_tail.e2e.js).
			// Two deliberate properties:
			//   - Keyframes pinned to one per 5s (-g 5*fps, scenecut off): a 10s
			//     clip has keys at 0s and 5s ONLY, so the export's 60-frame chunks
			//     hit true end-of-stream while dispatching a NON-final chunk and
			//     the decoder's reorder tail must drain across chunk boundaries
			//     (the floated-flush path).
			//   - The tone track runs 1s LONGER than the video: ffprobe duration
			//     is the max across streams, so the placed clip + composition
			//     outrun the final video frame by a second and the tail output
			//     frames must clamp to it (hold-last) instead of waiting for
			//     frames that can never arrive.
			out = fmt.Sprintf("test_%dp_%dfps_eostail.%s", height, *fps, *format)
			const audioBaseHz = 400
			const audioStepHz = 120
			const audioSR = 48000
			audioSecs := duration + 1
			args = append([]string{}, input...)
			for k := 0; k < audioSecs; k++ {
				freq := audioBaseHz + audioStepHz*k
				args = append(args, "-f", "lavfi", "-i",
					fmt.Sprintf("sine=frequency=%d:duration=1:sample_rate=%d", freq, audioSR))
			}
			var concatIn strings.Builder
			for k := 1; k <= audioSecs; k++ {
				concatIn.WriteString(fmt.Sprintf("[%d:a]", k))
			}
			fc := fmt.Sprintf("[0:v]%s,%s[v];%sconcat=n=%d:v=0:a=1[a]",
				vfChain, colorVF, concatIn.String(), audioSecs)
			gop := fmt.Sprintf("%d", 5**fps)
			args = append(args, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
				"-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
				"-g", gop, "-keyint_min", gop, "-sc_threshold", "0")
			args = append(args, colorTags...)
			args = append(args, "-c:a", "aac", "-b:a", "192k", out)
		} else if *audio {
			out = fmt.Sprintf("test_%dp_%dfps_audio.%s", height, *fps, *format)
			const audioBaseHz = 400
			const audioStepHz = 120
			const audioSR = 48000
			args = append([]string{}, input...)
			for k := 0; k < duration; k++ {
				freq := audioBaseHz + audioStepHz*k
				args = append(args, "-f", "lavfi", "-i",
					fmt.Sprintf("sine=frequency=%d:duration=1:sample_rate=%d", freq, audioSR))
			}
			var concatIn strings.Builder
			for k := 1; k <= duration; k++ {
				concatIn.WriteString(fmt.Sprintf("[%d:a]", k))
			}
			fc := fmt.Sprintf("[0:v]%s,%s[v];%sconcat=n=%d:v=0:a=1[a]",
				vfChain, colorVF, concatIn.String(), duration)
			args = append(args, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
				"-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium")
			args = append(args, colorTags...)
			args = append(args, "-c:a", "aac", "-b:a", "192k", out)
		} else {
			args = append(input, "-vf", vfChain+","+colorVF, "-c:v", "libx264",
				"-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium")
			args = append(args, colorTags...)
			args = append(args, "-an", out)
		}
	case "webm":
		args = append(input,
			"-vf", vfChain,
			"-c:v", "libvpx-vp9",
			"-pix_fmt", "yuv420p",
			"-crf", "32",
			"-b:v", "0",
			"-an",
			out,
		)
	case "gif":
		filterComplex := fmt.Sprintf("%s,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer", vfChain)
		args = append(input,
			"-filter_complex", filterComplex,
			"-an",
			out,
		)
	case "prores":
		out = fmt.Sprintf("test_%dp_%dfps_prores.mov", height, *fps)
		// 10-bit 4:2:2 variant of the 709 conversion (the shared colorVF targets
		// 8-bit 4:2:0, which would be wrong for ProRes).
		colorVF422 := "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le"
		args = append(input, "-vf", vfChain+","+colorVF422, "-c:v", "prores_ks",
			"-profile:v", "3", "-vendor", "apl0")
		args = append(args, colorTags...)
		args = append(args, "-an", out)
	default:
		log.Fatalf("unsupported --format %q (supported: mp4, mkv, mov, webm, gif, prores)", *format)
	}

	fmt.Printf("Generating %s (%dx%d, %d fps, %ds)\n", out, width, height, *fps, duration)
	cmd := exec.Command("ffmpeg", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("ffmpeg failed: %v", err)
	}
	fmt.Printf("Done: %s\n", out)
}
