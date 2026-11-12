package nas

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const mediaPageSize = 64
const mediaEntryLimit = 10000

type mediaProbe struct {
	Schema     int     `json:"schema"`
	AssetID    string  `json:"assetId,omitempty"`
	Offset     int64   `json:"offset,omitempty"`
	Length     int64   `json:"length,omitempty"`
	PosterTime float64 `json:"posterTime,omitempty"`
}
type mediaFile struct {
	name, version string
	size          int64
	photo         bool
	probe         mediaProbe
	index         int
}
type liveMedia struct {
	Image       string  `json:"image"`
	Video       string  `json:"video"`
	PairedVideo string  `json:"pairedVideo,omitempty"`
	Kind        string  `json:"kind"`
	Length      int64   `json:"length"`
	PosterTime  float64 `json:"posterTime"`
}

func mediaPhoto(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".jpg", ".jpeg", ".heic", ".heif":
		return true
	}
	return false
}
func mediaVideo(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".mov", ".mp4", ".m4v":
		return true
	}
	return false
}
func mediaID(name string) string {
	if name == "" {
		name = "."
	}
	return base64.RawURLEncoding.EncodeToString([]byte(name))
}
func mediaName(id string, directory bool) (string, bool) {
	data, err := base64.RawURLEncoding.DecodeString(id)
	name := string(data)
	if err != nil || name == "" || len(data) > 8192 || !utf8.Valid(data) || mediaID(name) != id {
		return "", false
	}
	if directory && name == "." {
		return "", true
	}
	return name, !strings.HasPrefix(name, "/") && !strings.HasSuffix(name, "/") && publicPathAllowed(name)
}
func publicHref(name string) string {
	parts := strings.Split(name, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return filesPath + "/" + strings.Join(parts, "/")
}
func mediaProbeKey(version string) string { return imageHash([]byte("motion-v2:"+version)) + ".json" }
func (s *Server) cachedProbe(file *mediaFile) bool {
	data := s.images.get(mediaProbeKey(file.version))
	if len(data) > 4096 || json.Unmarshal(data, &file.probe) != nil || file.probe.Schema != 1 || len(file.probe.AssetID) > 512 {
		return false
	}
	return file.probe.Offset >= 0 && file.probe.Length >= 0 && file.probe.Offset <= file.size && file.probe.Length <= file.size-file.probe.Offset
}
func tagNumber(value any) int64 {
	switch v := value.(type) {
	case float64:
		if v >= -1 && v <= 1<<53 && v == float64(int64(v)) {
			return int64(v)
		}
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
}
func probeTags(tags map[string]any, size int64, photo bool) mediaProbe {
	p := mediaProbe{Schema: 1}
	key := "Keys:ContentIdentifier"
	if photo {
		key = "Apple:ContentIdentifier"
	}
	if value, ok := tags[key].(string); ok && len(value) <= 512 {
		p.AssetID = strings.TrimSpace(value)
	}
	// Modern MotionPhoto=0 overrides residual legacy MicroVideo metadata.
	motion, modern := tags["XMP-GCamera:MotionPhoto"]
	if !photo || (modern && tagNumber(motion) != 1) {
		return p
	}
	if modern && tagNumber(motion) == 1 && tagNumber(tags["XMP-GCamera:MotionPhotoVersion"]) == 1 {
		container, present := tags["XMP-GContainer:ContainerDirectory"]
		if !present {
			// Older ExifTool releases expose this standard namespace as an
			// unregistered XMP structure, using its original prefix and tag name.
			container = tags["XMP-Container:Directory"]
		}
		if entries, ok := container.([]any); ok {
			for i, raw := range entries {
				entry, _ := raw.(map[string]any)
				item, _ := entry["Item"].(map[string]any)
				if item["Semantic"] == "MotionPhoto" {
					// Only a single final video can use an EOF-relative section.
					if i != len(entries)-1 || (item["Mime"] != "video/mp4" && item["Mime"] != "video/quicktime") {
						return p
					}
					p.Length = tagNumber(item["Length"])
				}
			}
		}
		p.PosterTime = float64(tagNumber(tags["XMP-GCamera:MotionPhotoPresentationTimestampUs"])) / 1e6
	} else if !modern && tagNumber(tags["XMP-GCamera:MicroVideo"]) == 1 {
		p.Length = tagNumber(tags["XMP-GCamera:MicroVideoOffset"])
		p.PosterTime = float64(tagNumber(tags["XMP-GCamera:MicroVideoPresentationTimestampUs"])) / 1e6
	}
	if p.Length >= 16 && p.Length < size {
		p.Offset = size - p.Length
	} else {
		p.Length = 0
	}
	if p.PosterTime < 0 {
		p.PosterTime = 0
	}
	return p
}

// Metadata subprocesses receive confined, read-only descriptors, never user paths.
// Disabling config loading also prevents ExifTool from loading local Perl config.
func (s *Server) inspectMedia(ctx context.Context, files []*mediaFile) error {
	var pending []*mediaFile
	for _, file := range files {
		if !s.cachedProbe(file) {
			pending = append(pending, file)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	select {
	case s.mediaProbe <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.mediaProbe }()
	// Another request may have populated these entries while this one queued.
	remaining := pending[:0]
	for _, file := range pending {
		if !s.cachedProbe(file) {
			remaining = append(remaining, file)
		}
	}
	pending = remaining
	for len(pending) > 0 {
		batch := pending[:min(mediaPageSize, len(pending))]
		pending = pending[len(batch):]
		if err := s.inspectMediaBatch(ctx, batch); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) inspectMediaBatch(ctx context.Context, batch []*mediaFile) error {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := []string{"-config", "", "-json", "-G1", "-n", "-struct", "-ContentIdentifier", "-MotionPhoto", "-MotionPhotoVersion", "-MotionPhotoPresentationTimestampUs", "-ContainerDirectory", "-XMP-Container:Directory", "-MicroVideo", "-MicroVideoOffset", "-MicroVideoPresentationTimestampUs"}
	var sources []*os.File
	defer func() {
		for _, f := range sources {
			f.Close()
		}
	}()
	for i, file := range batch {
		f, err := (publicFS{s.public}).open(file.name)
		if err != nil {
			return err
		}
		sources = append(sources, f.File)
		info, err := f.Stat()
		if err != nil || imageVersion(file.name, info) != file.version {
			return os.ErrNotExist
		}
		args = append(args, fmt.Sprintf("/dev/fd/%d", i+3))
	}
	command := exec.CommandContext(ctx, s.mediaTool, args...)
	command.ExtraFiles = sources
	output, stderr := &boundedOutput{limit: 2 << 20}, &boundedOutput{limit: 2048}
	command.Stdout, command.Stderr, command.WaitDelay = output, stderr, time.Second
	err := command.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
			return fault(503, "MEDIA_UNAVAILABLE", "errors.mediaUnavailable")
		}
	}
	var tags []map[string]any
	if output.overflow || json.Unmarshal(output.Bytes(), &tags) != nil || len(tags) != len(batch) {
		return fault(503, "MEDIA_UNAVAILABLE", "errors.mediaUnavailable")
	}
	for i, file := range batch {
		if tags[i]["SourceFile"] != fmt.Sprintf("/dev/fd/%d", i+3) || !s.currentImage(file.name, file.version) {
			return os.ErrNotExist
		}
		file.probe = probeTags(tags[i], file.size, file.photo)
		if file.probe.Length > 0 && !validMotionSection(sources[i], file.probe.Offset, file.probe.Length) {
			file.probe.Offset, file.probe.Length = 0, 0
		}
		data, _ := json.Marshal(file.probe)
		s.images.put(mediaProbeKey(file.version), data)
	}
	return nil
}
func validMotionSection(file *os.File, offset, length int64) bool {
	if offset <= 0 || length < 16 {
		return false
	}
	var header [16]byte
	if _, err := file.ReadAt(header[:], offset); err != nil {
		return false
	}
	size := int64(binary.BigEndian.Uint32(header[:4]))
	return string(header[4:8]) == "ftyp" && size >= 16 && size <= length
}
func (s *Server) mediaDirectory(name string) ([]*mediaFile, string, error) {
	dir, err := (publicFS{s.public}).open(name)
	if err != nil {
		return nil, "", err
	}
	defer dir.Close()
	var result []*mediaFile
	total := 0
	for {
		entries, readErr := dir.Readdir(256)
		total += len(entries)
		if total > mediaEntryLimit {
			return nil, "", fault(413, "MEDIA_DIRECTORY_TOO_LARGE", "errors.mediaDirectoryTooLarge")
		}
		for _, info := range entries {
			if !info.Mode().IsRegular() || (!mediaPhoto(info.Name()) && !mediaVideo(info.Name())) {
				continue
			}
			fileName := path.Join(name, info.Name())
			result = append(result, &mediaFile{name: fileName, version: imageVersion(fileName, info), size: info.Size(), photo: mediaPhoto(fileName)})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, "", readErr
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].name < result[j].name })
	var fingerprint strings.Builder
	for i, file := range result {
		file.index = i
		fingerprint.WriteString(file.version)
		fingerprint.WriteByte(0)
	}
	return result, imageHash([]byte(fingerprint.String())), nil
}
func liveVersion(image, video *mediaFile, offset, length int64) string {
	return imageHash([]byte(fmt.Sprintf("motion-resource-v1:%s:%s:%d:%d", image.version, video.version, offset, length)))
}
func liveDescriptor(image, video *mediaFile, embedded bool) liveMedia {
	offset, length, kind, paired := int64(0), video.size, "apple", publicHref(video.name)
	if embedded {
		offset, length, kind, paired = image.probe.Offset, image.probe.Length, "motion-photo", ""
	}
	version := liveVersion(image, video, offset, length)
	return liveMedia{publicHref(image.name), mediaPath + "/" + mediaID(image.name) + "/" + mediaID(video.name) + "/" + version + "/video.mp4", paired, kind, length, image.probe.PosterTime}
}
func (s *Server) serveMedia(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "GET, HEAD, OPTIONS")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		writeError(w, r, fault(405, "METHOD_NOT_ALLOWED", "errors.mediaReadOnly"))
		return
	}
	if s.mediaTool == "" {
		writeError(w, r, fault(503, "MEDIA_UNAVAILABLE", "errors.mediaUnavailable"))
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, mediaPath+"/"), "/")
	var slots chan struct{}
	switch {
	case len(parts) == 2 && parts[1] == "index.json":
		slots = s.mediaIndexes
	case len(parts) == 4 && parts[3] == "video.mp4":
		slots = s.mediaVideos
	default:
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
		return
	}
	select {
	case slots <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, r, fault(503, "MEDIA_BUSY", "errors.mediaBusy"))
		return
	}
	defer func() { <-slots }()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	if slots == s.mediaIndexes {
		name, ok := mediaName(parts[0], true)
		if !ok {
			writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
			return
		}
		s.serveMediaIndex(ctx, w, r, name)
		return
	}
	s.serveMotionVideo(ctx, w, r, parts)
}
func (s *Server) serveMediaIndex(ctx context.Context, w http.ResponseWriter, r *http.Request, name string) {
	offset := 0
	if raw := r.URL.Query().Get("offset"); raw != "" {
		var err error
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 || offset > mediaEntryLimit {
			writeError(w, r, fault(400, "INVALID_PATH", "errors.invalidPath"))
			return
		}
	}
	files, revision, err := s.mediaDirectory(name)
	if err != nil {
		if os.IsNotExist(err) {
			err = fault(404, "NOT_FOUND", "errors.notFound")
		}
		writeError(w, r, err)
		return
	}
	if expected := r.URL.Query().Get("revision"); expected != "" && expected != revision {
		writeError(w, r, fault(409, "MEDIA_CHANGED", "errors.mediaChanged"))
		return
	}
	end := min(offset+mediaPageSize, len(files))
	if offset > len(files) {
		writeError(w, r, fault(409, "MEDIA_CHANGED", "errors.mediaChanged"))
		return
	}
	if err = s.inspectMedia(ctx, files[:end]); err != nil {
		writeError(w, r, fault(503, "MEDIA_UNAVAILABLE", "errors.mediaUnavailable"))
		return
	}
	photos, videos := map[string][]*mediaFile{}, map[string][]*mediaFile{}
	items := []liveMedia{}
	for _, file := range files[:end] {
		if file.photo && (end == len(files) || file.index >= offset) && file.probe.Length > 0 {
			items = append(items, liveDescriptor(file, file, true))
		}
		if file.probe.AssetID == "" {
			continue
		}
		if file.photo {
			photos[file.probe.AssetID] = append(photos[file.probe.AssetID], file)
		} else {
			videos[file.probe.AssetID] = append(videos[file.probe.AssetID], file)
		}
	}
	for id, images := range photos {
		movies := videos[id]
		if len(images) == 1 && len(movies) == 1 && images[0].probe.Length == 0 && (end == len(files) || images[0].index >= offset || movies[0].index >= offset) {
			items = append(items, liveDescriptor(images[0], movies[0], false))
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Image < items[j].Image })
	// Every referenced source is rechecked even for metadata/conditional responses.
	_, current, err := s.mediaDirectory(name)
	if err != nil || current != revision {
		writeError(w, r, fault(409, "MEDIA_CHANGED", "errors.mediaChanged"))
		return
	}
	var next *int
	if end < len(files) {
		n := end
		next = &n
	}
	body, _ := json.Marshal(struct {
		Version  int         `json:"version"`
		Revision string      `json:"revision"`
		Items    []liveMedia `json:"items"`
		Next     *int        `json:"nextOffset"`
	}{1, revision, items, next})
	if len(body) > 2<<20 {
		writeError(w, r, fault(413, "MEDIA_DIRECTORY_TOO_LARGE", "errors.mediaDirectoryTooLarge"))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=15")
	w.Header().Set("ETag", `"`+imageHash(body)+`"`)
	controller := http.NewResponseController(w)
	deadline, _ := ctx.Deadline()
	_ = controller.SetWriteDeadline(deadline)
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

type motionVideoWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
}

func (w motionVideoWriter) Write(p []byte) (int, error) {
	_ = w.controller.SetWriteDeadline(time.Now().Add(time.Minute))
	return w.ResponseWriter.Write(p)
}

func (s *Server) serveMotionVideo(ctx context.Context, w http.ResponseWriter, r *http.Request, parts []string) {
	imageName, a := mediaName(parts[0], false)
	videoName, b := mediaName(parts[1], false)
	if !a || !b || !mediaPhoto(imageName) || (imageName != videoName && (!mediaVideo(videoName) || path.Dir(imageName) != path.Dir(videoName))) {
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
		return
	}
	var records []*mediaFile
	var sources []*publicFile
	defer func() {
		for _, f := range sources {
			f.Close()
		}
	}()
	for _, name := range []string{imageName, videoName} {
		f, err := (publicFS{s.public}).open(name)
		if err != nil {
			writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
			return
		}
		sources = append(sources, f)
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
			return
		}
		records = append(records, &mediaFile{name: name, version: imageVersion(name, info), size: info.Size(), photo: mediaPhoto(name)})
	}
	if err := s.inspectMedia(ctx, records); err != nil {
		writeError(w, r, fault(503, "MEDIA_UNAVAILABLE", "errors.mediaUnavailable"))
		return
	}
	image, video := records[0], records[1]
	offset, length := int64(0), video.size
	if imageName == videoName {
		offset, length = image.probe.Offset, image.probe.Length
		if !validMotionSection(sources[1].File, offset, length) {
			writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
			return
		}
	} else if image.probe.Length != 0 || image.probe.AssetID == "" || image.probe.AssetID != video.probe.AssetID {
		writeError(w, r, fault(404, "NOT_FOUND", "errors.notFound"))
		return
	}
	if parts[2] != liveVersion(image, video, offset, length) || !s.currentImage(imageName, image.version) || !s.currentImage(videoName, video.version) {
		writeError(w, r, fault(409, "MEDIA_CHANGED", "errors.mediaChanged"))
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	if strings.EqualFold(path.Ext(videoName), ".mov") {
		w.Header().Set("Content-Type", "video/quicktime")
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", `"`+parts[2]+`"`)
	controller := http.NewResponseController(w)
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	http.ServeContent(motionVideoWriter{w, controller}, r, "motion.mp4", time.Time{}, io.NewSectionReader(sources[1].File, offset, length))
}
