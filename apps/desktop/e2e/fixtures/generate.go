package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
)

func main() {
	fps := flag.Int("fps", 0, "frame rate (required, positive integer)")
	format := flag.String("format", "mp4", "output format: mp4, mkv, mov, webm, gif, prores")
	audio := flag.Bool("audio", false, "add a per-second frequency-stepped tone track (test marker) + name output *_audio.mp4")
	flag.Parse()

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
		if *audio {
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
