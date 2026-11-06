package nas

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"
)

const iiifContext = "http://iiif.io/api/image/3/context.json"
const iiifProfile = "http://iiif.io/api/image/3/level0.json"
const maxImagePixels = 64_000_000
const maxImageBytes = 128 << 20
const maxImageSide = 1600

type imageSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}
type imageMetadata struct {
	Width       int `json:"width"`
	Height      int `json:"height"`
	Orientation int `json:"orientation"`
}

func (m imageMetadata) sizes() []imageSize {
	var result []imageSize
	for _, side := range []int{128, 384, maxImageSide} {
		w, h := m.Width, m.Height
		if w > side || h > side {
			if w >= h {
				h = max(1, int(float64(h)*float64(side)/float64(w)+0.5))
				w = side
			} else {
				w = max(1, int(float64(w)*float64(side)/float64(h)+0.5))
				h = side
			}
		}
		size := imageSize{w, h}
		if len(result) == 0 || result[len(result)-1] != size {
			result = append(result, size)
		}
	}
	return result
}
func (m imageMetadata) valid() bool {
	return m.Width > 0 && m.Height > 0 && m.Width <= 65535 && m.Height <= 65535 && int64(m.Width)*int64(m.Height) <= maxImagePixels && m.Orientation >= 1 && m.Orientation <= 8
}
func sourceImageMetadata(file *os.File) (imageMetadata, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return imageMetadata{}, err
	}
	config, format, err := image.DecodeConfig(io.LimitReader(file, maxImageBytes+1))
	if err != nil {
		return imageMetadata{}, fault(415, "IMAGE_UNSUPPORTED", "此图片格式暂不支持生成预览。")
	}
	m := imageMetadata{config.Width, config.Height, 1}
	if !m.valid() {
		return m, fault(413, "IMAGE_TOO_LARGE", "图片尺寸超过预览处理限制。")
	}
	if format == "jpeg" || format == "tiff" {
		_, _ = file.Seek(0, io.SeekStart)
		header, _ := io.ReadAll(io.LimitReader(file, 1<<20))
		m.Orientation = imageOrientation(header)
		if m.Orientation >= 5 {
			m.Width, m.Height = m.Height, m.Width
		}
	}
	return m, nil
}
func orientImage(img image.Image, orientation int) image.Image {
	switch orientation {
	case 2:
		return imaging.FlipH(img)
	case 3:
		return imaging.Rotate180(img)
	case 4:
		return imaging.FlipV(img)
	case 5:
		return imaging.Transpose(img)
	case 6:
		return imaging.Rotate270(img)
	case 7:
		return imaging.Transverse(img)
	case 8:
		return imaging.Rotate90(img)
	}
	return img
}

func (s *Server) currentImage(name, version string) bool {
	file, err := (publicFS{s.public}).open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	return err == nil && imageVersion(name, info) == version
}
func (s *Server) imageMetadata(file *os.File, name, version string) (imageMetadata, error) {
	key := imageHash([]byte(version+":info")) + ".json"
	var m imageMetadata
	if data := s.images.get(key); len(data) < 8192 && json.Unmarshal(data, &m) == nil && m.valid() {
		return m, nil
	}
	m, err := sourceImageMetadata(file)
	if err != nil {
		return m, err
	}
	if !s.currentImage(name, version) {
		return m, fault(409, "IMAGE_CHANGED", "文件已更新，请刷新后重试。")
	}
	data, _ := json.Marshal(m)
	s.images.put(key, data)
	return m, nil
}
func (s *Server) imageRendition(ctx context.Context, file *os.File, name, version string, m imageMetadata, size imageSize) ([]byte, error) {
	key := imageHash([]byte(fmt.Sprintf("%s:%d:%d:jpg82-white", version, size.Width, size.Height))) + ".jpg"
	if data := s.images.get(key); data != nil {
		return data, nil
	}
	select {
	case s.images.renderer <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.images.renderer }()
	if data := s.images.get(key); data != nil {
		return data, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	source, err := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
	if err != nil || len(source) > maxImageBytes {
		return nil, fault(413, "IMAGE_TOO_LARGE", "图片大小超过预览处理限制。")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(source))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return nil, fault(415, "IMAGE_UNSUPPORTED", "无法解码此图片。")
	}
	img, err := imaging.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, fault(415, "IMAGE_UNSUPPORTED", "无法解码此图片。")
	}
	// Do not trust a header check if a file was replaced or edited during decode.
	if img.Bounds().Dx() <= 0 || img.Bounds().Dy() <= 0 || int64(img.Bounds().Dx())*int64(img.Bounds().Dy()) > maxImagePixels {
		return nil, fault(413, "IMAGE_TOO_LARGE", "图片尺寸超过预览处理限制。")
	}
	img = orientImage(img, m.Orientation)
	if img.Bounds().Dx() != m.Width || img.Bounds().Dy() != m.Height {
		return nil, fault(409, "IMAGE_CHANGED", "文件已更新，请刷新后重试。")
	}
	img = imaging.Resize(img, size.Width, size.Height, imaging.Box)
	// Re-encoding drops source metadata; flatten transparency on white for JPG.
	canvas := image.NewRGBA(image.Rect(0, 0, size.Width, size.Height))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(canvas, canvas.Bounds(), img, img.Bounds().Min, draw.Over)
	var output bytes.Buffer
	if err = jpeg.Encode(&output, canvas, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !s.currentImage(name, version) {
		return nil, fault(409, "IMAGE_CHANGED", "文件已更新，请刷新后重试。")
	}
	data := output.Bytes()
	s.images.put(key, data)
	return data, nil
}

func (s *Server) serveImage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, HEAD, OPTIONS")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		writeError(w, fault(405, "METHOD_NOT_ALLOWED", "图片服务仅支持读取。"))
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, imagesPath+"/"), "/")
	if len(parts) != 1 && len(parts) != 2 && len(parts) != 5 {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	name := string(raw)
	if err != nil || len(name) == 0 || len(name) > 8192 || !utf8.ValidString(name) || strings.HasPrefix(name, "/") || !publicPathAllowed(name) || base64.RawURLEncoding.EncodeToString(raw) != parts[0] {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	if len(parts) == 2 && parts[1] != "info.json" {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	file, err := (publicFS{s.public}).open(name)
	if err != nil {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	if info.Size() > maxImageBytes {
		writeError(w, fault(413, "IMAGE_TOO_LARGE", "图片大小超过预览处理限制。"))
		return
	}
	select {
	case s.images.requests <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, fault(503, "IMAGE_BUSY", "图片处理繁忙，请稍后重试。"))
		return
	}
	defer func() { <-s.images.requests }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	version := imageVersion(name, info)
	m, err := s.imageMetadata(file.File, name, version)
	if err != nil {
		writeError(w, err)
		return
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	origin := scheme + "://" + r.Host
	if s.identity != nil {
		origin = s.identity.config.ResourceOrigin
	}
	base := origin + imagesPath + "/" + parts[0]
	if len(parts) == 1 {
		w.Header().Set("Location", base+"/info.json")
		w.WriteHeader(303)
		return
	}
	var data []byte
	contentType := "image/jpeg"
	if len(parts) == 2 {
		document := struct {
			Context   string      `json:"@context"`
			ID        string      `json:"id"`
			Type      string      `json:"type"`
			Protocol  string      `json:"protocol"`
			Profile   string      `json:"profile"`
			Width     int         `json:"width"`
			Height    int         `json:"height"`
			MaxWidth  int         `json:"maxWidth"`
			MaxHeight int         `json:"maxHeight"`
			Sizes     []imageSize `json:"sizes"`
		}{iiifContext, base, "ImageService3", "http://iiif.io/api/image", "level0", m.Width, m.Height, maxImageSide, maxImageSide, m.sizes()}
		data, _ = json.Marshal(document)
		contentType = `application/ld+json;profile="` + iiifContext + `"`
		w.Header().Add("Vary", "Accept")
		if strings.Contains(r.Header.Get("Accept"), "application/json") && !strings.Contains(r.Header.Get("Accept"), "application/ld+json") {
			contentType = "application/json"
		}
	} else {
		if parts[1] != "full" || parts[3] != "0" || parts[4] != "default.jpg" {
			writeError(w, fault(400, "IMAGE_REQUEST_UNSUPPORTED", "此图片服务支持完整画面的固定尺寸 JPG 预览。"))
			return
		}
		sizes := m.sizes()
		size := sizes[len(sizes)-1]
		if parts[2] != "max" {
			matched := false
			for _, candidate := range sizes {
				if parts[2] == strconv.Itoa(candidate.Width)+","+strconv.Itoa(candidate.Height) {
					size = candidate
					matched = true
					break
				}
			}
			if !matched {
				writeError(w, fault(400, "IMAGE_SIZE_UNSUPPORTED", "请使用 info.json 中列出的预览尺寸。"))
				return
			}
		}
		data, err = s.imageRendition(ctx, file.File, name, version, m, size)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				w.Header().Set("Retry-After", "1")
				err = fault(503, "IMAGE_BUSY", "图片处理超时，请稍后重试。")
			}
			writeError(w, err)
			return
		}
	}
	if !s.currentImage(name, version) {
		writeError(w, fault(404, "NOT_FOUND", "找不到这个地址。"))
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", `"`+imageHash(data)+`"`)
	w.Header().Set("Link", "<"+iiifProfile+">; rel=\"profile\"")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}
