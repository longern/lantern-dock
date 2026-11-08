package nas

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func videoSource(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ogv":
		return true
	}
	return false
}

type boundedOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedOutput) Len() int      { return b.buffer.Len() }
func (b *boundedOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *boundedOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := b.limit - b.Len()
	if n > remaining {
		b.overflow = true
		data = data[:remaining]
	}
	_, _ = b.buffer.Write(data)
	return n, nil
}

// Inherit only the already-confined source descriptor. Neither a filename nor
// a caller-supplied URL reaches FFmpeg. The fd-only input protocol also denies
// network URLs and local sidecar/external-track reads inside a media container.
func runVideoTool(ctx context.Context, file *os.File, program string, limit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, program, args...)
	command.ExtraFiles = []*os.File{file}
	output := &boundedOutput{limit: limit}
	stderr := &boundedOutput{limit: 2048}
	command.Stdout = output
	command.Stderr = stderr
	command.WaitDelay = time.Second
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fault(415, "VIDEO_UNSUPPORTED", "errors.videoUnsupported")
	}
	if output.overflow {
		return nil, fault(413, "IMAGE_TOO_LARGE", "errors.videoPreviewTooLarge")
	}
	return output.Bytes(), nil
}
func videoInput() []string {
	return []string{"-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "fd", "-format_whitelist", "mov,matroska,webm,avi,ogg", "-probesize", "8388608", "-analyzeduration", "3000000", "-threads", "1", "-fd", "3"}
}
func sourceVideoMetadata(ctx context.Context, file *os.File) (imageMetadata, error) {
	args := append(videoInput(), "-i", "fd:", "-show_entries", "stream=index,codec_type,width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:stream_disposition=attached_pic:format=duration", "-of", "json")
	data, err := runVideoTool(ctx, file, "ffprobe", 32768, args...)
	if err != nil {
		return imageMetadata{}, err
	}
	var info struct {
		Streams []struct {
			Index         int    `json:"index"`
			CodecType     string `json:"codec_type"`
			Width, Height int
			SAR           string                  `json:"sample_aspect_ratio"`
			Tags          struct{ Rotate string } `json:"tags"`
			SideData      []struct {
				Rotation *float64 `json:"rotation"`
			} `json:"side_data_list"`
			Disposition struct {
				Attached int `json:"attached_pic"`
			} `json:"disposition"`
		} `json:"streams"`
		Format struct{ Duration string } `json:"format"`
	}
	if json.Unmarshal(data, &info) != nil {
		return imageMetadata{}, fault(415, "VIDEO_UNSUPPORTED", "errors.videoMetadataUnavailable")
	}
	for _, stream := range info.Streams {
		if stream.CodecType != "video" || stream.Disposition.Attached != 0 {
			continue
		}
		m := imageMetadata{Width: stream.Width, Height: stream.Height, Orientation: 1, Video: true, Stream: stream.Index}
		if !m.valid() {
			return m, fault(413, "IMAGE_TOO_LARGE", "errors.videoDimensionsTooLarge")
		}
		if a, b, ok := strings.Cut(stream.SAR, ":"); ok {
			n, _ := strconv.Atoi(a)
			d, _ := strconv.Atoi(b)
			if n > 0 && d > 0 {
				m.Width = int(math.Round(float64(m.Width) * float64(n) / float64(d)))
			}
		}
		rotation, _ := strconv.ParseFloat(stream.Tags.Rotate, 64)
		for _, data := range stream.SideData {
			if data.Rotation != nil {
				rotation = *data.Rotation
				break
			}
		}
		if math.Abs(math.Remainder(rotation, 180)) == 90 {
			m.Width, m.Height = m.Height, m.Width
		}
		duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
		if duration > 0 && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			m.Seek = math.Min(1, duration/2)
		}
		if !m.valid() {
			return m, fault(413, "IMAGE_TOO_LARGE", "errors.videoDimensionsTooLarge")
		}
		return m, nil
	}
	return imageMetadata{}, fault(415, "VIDEO_UNSUPPORTED", "errors.videoFramesUnavailable")
}
func videoRendition(ctx context.Context, file *os.File, m imageMetadata, size imageSize) ([]byte, error) {
	args := append(videoInput(), "-ss", strconv.FormatFloat(m.Seek, 'f', 3, 64), "-i", "fd:", "-map", "0:"+strconv.Itoa(m.Stream), "-frames:v", "1", "-an", "-sn", "-dn", "-vf", fmt.Sprintf("scale=%d:%d:flags=bilinear,setsar=1", size.Width, size.Height), "-map_metadata", "-1", "-threads", "1", "-filter_threads", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1")
	data, err := runVideoTool(ctx, file, "ffmpeg", imageBodyLimit, args...)
	if err != nil {
		return nil, err
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != size.Width || config.Height != size.Height {
		return nil, fault(415, "VIDEO_UNSUPPORTED", "errors.videoPreviewUnavailable")
	}
	return data, nil
}
