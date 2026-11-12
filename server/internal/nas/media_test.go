package nas

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testLiveID = "8F6AB9E4-1234-4A9B-9876-100000000001"

func mediaFixture(t *testing.T) *fixture {
	t.Helper()
	if _, err := exec.LookPath("exiftool"); err != nil {
		t.Skip("requires ExifTool")
	}
	return newFixture(t)
}
func putMedia(t *testing.T, f *fixture, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.public, name), data, 0600); err != nil {
		t.Fatal(err)
	}
}
func motionJPEG(t *testing.T, flag, length int, modern bool) []byte {
	t.Helper()
	jpeg, err := os.ReadFile("../../../test/fixtures/album-thumbnail.jpg")
	if err != nil {
		t.Fatal(err)
	}
	video := videoFixture(t)
	if length == 0 {
		length = len(video)
	}
	attributes := fmt.Sprintf(`GCamera:MicroVideo="1" GCamera:MicroVideoOffset="%d"`, length)
	if modern {
		attributes += fmt.Sprintf(` GCamera:MotionPhoto="%d" GCamera:MotionPhotoVersion="1"`, flag)
	}
	xmp := fmt.Sprintf(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" %s><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="%d"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`, attributes, length)
	payload := []byte("http://ns.adobe.com/xap/1.0/\x00" + xmp)
	header := []byte{255, 225, 0, 0}
	binary.BigEndian.PutUint16(header[2:], uint16(len(payload)+2))
	return bytes.Join([][]byte{jpeg[:2], header, payload, jpeg[2:], video}, nil)
}
func appleMovie(t *testing.T) []byte {
	t.Helper()
	videoFixture(t)
	output := filepath.Join(t.TempDir(), "paired.mov")
	command := exec.Command("ffmpeg", "-v", "error", "-i", "../../../test/fixtures/video.mp4", "-c", "copy", "-metadata", "com.apple.quicktime.content.identifier="+testLiveID, "-movflags", "use_metadata_tags", output)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

type mediaIndex struct {
	Version    int
	Revision   string
	Items      []liveMedia
	NextOffset *int
}

func readMediaIndex(t *testing.T, f *fixture, path string) mediaIndex {
	t.Helper()
	r := f.request(t, "GET", path, "", nil, nil)
	status(t, r, 200)
	var index mediaIndex
	if err := json.NewDecoder(r.Body).Decode(&index); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	return index
}
func TestMotionPhotoEmbeddedRangeAndSourceVisibility(t *testing.T) {
	for _, modern := range []bool{true, false} {
		t.Run(fmt.Sprint(modern), func(t *testing.T) {
			f := mediaFixture(t)
			data := motionJPEG(t, 1, 0, modern)
			putMedia(t, f, "旅行.jpg", data)
			base := mediaPath + "/" + mediaID("") + "/index.json"
			index := readMediaIndex(t, f, base)
			if index.Version != 1 || len(index.Items) != 1 || index.Items[0].Kind != "motion-photo" || index.Items[0].PairedVideo != "" {
				t.Fatalf("bad index %+v", index)
			}
			live := index.Items[0]
			video := videoFixture(t)
			r := f.request(t, "GET", live.Video, "", nil, map[string]string{"Range": "bytes=0-31"})
			status(t, r, 206)
			if !bytes.Equal(responseBytes(t, r), video[:32]) || r.Header.Get("Content-Range") != fmt.Sprintf("bytes 0-31/%d", len(video)) {
				t.Fatal("section range differs from embedded video")
			}
			etag := r.Header.Get("ETag")
			r = f.request(t, "HEAD", live.Video, "", nil, nil)
			status(t, r, 200)
			if r.ContentLength != int64(len(video)) || read(t, r) != "" {
				t.Fatal("bad virtual HEAD")
			}
			status(t, f.request(t, "GET", live.Video, "", nil, map[string]string{"If-None-Match": etag}), 304)
			r = f.request(t, "GET", live.Video, "", nil, map[string]string{"Range": "bytes=0-31", "If-Range": "\"stale\""})
			status(t, r, 200)
			if !bytes.Equal(responseBytes(t, r), video) {
				t.Fatal("If-Range must return full virtual video")
			}
			status(t, f.request(t, "GET", live.Video, "", nil, map[string]string{"Range": fmt.Sprintf("bytes=%d-", len(video))}), 416)
			if err := os.Mkdir(filepath.Join(f.public, "#recycle"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(filepath.Join(f.public, "旅行.jpg"), filepath.Join(f.public, "#recycle", "旅行.jpg")); err != nil {
				t.Fatal(err)
			}
			status(t, f.request(t, "GET", live.Video, "", nil, map[string]string{"If-None-Match": etag}), 404)
			if err := os.Symlink(filepath.Join("#recycle", "旅行.jpg"), filepath.Join(f.public, "旅行.jpg")); err != nil {
				t.Fatal(err)
			}
			status(t, f.request(t, "GET", live.Video, "", nil, map[string]string{"If-None-Match": etag}), 404)
			if got := readMediaIndex(t, f, base); len(got.Items) != 0 {
				t.Fatal("symlink leaked in index")
			}
			status(t, f.request(t, "GET", mediaPath+"/"+mediaID("#recycle")+"/index.json", "", nil, nil), 404)
		})
	}
}
func TestMotionPhotoRejectsDisabledCorruptAndStaleMetadata(t *testing.T) {
	f := mediaFixture(t)
	for _, entry := range []struct {
		name         string
		flag, length int
	}{{"disabled.jpg", 0, 0}, {"outside.jpg", 1, 1 << 30}, {"wrong-offset.jpg", 1, 64}, {"negative.jpg", 1, -1}} {
		putMedia(t, f, entry.name, motionJPEG(t, entry.flag, entry.length, true))
	}
	base := mediaPath + "/" + mediaID("") + "/index.json"
	if got := readMediaIndex(t, f, base); len(got.Items) != 0 {
		t.Fatal("invalid metadata produced live assets", got)
	}
	putMedia(t, f, "good.jpg", motionJPEG(t, 1, 0, true))
	before := readMediaIndex(t, f, base)
	if len(before.Items) != 1 {
		t.Fatal(before)
	}
	putMedia(t, f, "good.jpg", motionJPEG(t, 0, 0, true))
	status(t, f.request(t, "GET", before.Items[0].Video, "", nil, nil), 404)
	status(t, f.request(t, "GET", base+"?offset=0&revision="+before.Revision, "", nil, nil), 409)
	if got := readMediaIndex(t, f, base); len(got.Items) != 0 {
		t.Fatal("cached probe survived replacement")
	}
	for _, method := range []string{"PUT", "POST", "DELETE", "PROPFIND"} {
		r := f.request(t, method, base, "", nil, nil)
		status(t, r, 405)
		if r.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cached error")
		}
	}
	for _, id := range []string{mediaID("../private"), mediaID("/data"), mediaID("#recycle"), "bad!"} {
		status(t, f.request(t, "GET", mediaPath+"/"+id+"/index.json", "", nil, nil), 404)
	}
}
func TestAppleLivePhotoUsesContentIDNotFilenameAndHandlesHEIC(t *testing.T) {
	movie := appleMovie(t)
	for _, ext := range []string{"jpg", "heic"} {
		t.Run(ext, func(t *testing.T) {
			f := mediaFixture(t)
			photo, err := os.ReadFile("../../../test/fixtures/live-photo." + ext)
			if err != nil {
				t.Fatal(err)
			}
			putMedia(t, f, "renamed."+ext, photo)
			putMedia(t, f, "different.mov", movie)
			putMedia(t, f, "renamed.mov", videoFixture(t))
			index := readMediaIndex(t, f, mediaPath+"/"+mediaID("")+"/index.json")
			if len(index.Items) != 1 || index.Items[0].PairedVideo != "/dav/different.mov" || index.Items[0].Kind != "apple" {
				t.Fatal("pair must use metadata", index)
			}
			r := f.request(t, "GET", index.Items[0].Video, "", nil, map[string]string{"Range": "bytes=0-127"})
			status(t, r, 206)
			if !bytes.Equal(responseBytes(t, r), movie[:128]) {
				t.Fatal("paired source differs")
			}
			forged := strings.Replace(index.Items[0].Video, "/"+mediaID("different.mov")+"/", "/"+mediaID("renamed.mov")+"/", 1)
			status(t, f.request(t, "GET", forged, "", nil, nil), 404)
			if ext == "heic" {
				// Older standalone FFmpeg builds lack HEIF demuxing. The shipped
				// image verifies HEIC rendering in smoke-nas-image.sh as well.
				probe := exec.Command("ffprobe", "-v", "error", "../../../test/fixtures/live-photo.heic")
				if err := probe.Run(); err == nil {
					r = f.request(t, "GET", imageURL("renamed.heic")+"/info.json", "", nil, nil)
					status(t, r, 200)
					read(t, r)
					status(t, f.request(t, "GET", imageURL("renamed.heic")+"/full/384,256/0/default.jpg", "", nil, nil), 200)
				}
			}
			putMedia(t, f, "duplicate.mov", movie)
			if got := readMediaIndex(t, f, mediaPath+"/"+mediaID("")+"/index.json"); len(got.Items) != 0 {
				t.Fatal("ambiguous ID must not pair", got)
			}
		})
	}
}

func TestMediaInspectionCancellationAndAdmissionLimits(t *testing.T) {
	f := mediaFixture(t)
	putMedia(t, f, "motion.jpg", motionJPEG(t, 1, 0, true))
	files, _, err := f.s.mediaDirectory("")
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(t.TempDir(), "slow-metadata")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 10\n"), 0700); err != nil {
		t.Fatal(err)
	}
	f.s.mediaTool = script
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := f.s.inspectMedia(ctx, files); err == nil || time.Since(start) > time.Second {
		t.Fatal("metadata process escaped cancellation", err)
	}
	f.s.mediaVideos <- struct{}{}
	f.s.mediaVideos <- struct{}{}
	f.s.mediaTool, err = exec.LookPath("exiftool")
	if err != nil {
		t.Fatal(err)
	}
	readMediaIndex(t, f, mediaPath+"/"+mediaID("")+"/index.json")
	<-f.s.mediaVideos
	<-f.s.mediaVideos
	f.s.mediaIndexes <- struct{}{}
	f.s.mediaIndexes <- struct{}{}
	r := f.request(t, "GET", mediaPath+"/"+mediaID("")+"/index.json", "", nil, nil)
	status(t, r, 503)
	if r.Header.Get("Retry-After") != "1" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing admission headers")
	}
	<-f.s.mediaIndexes
	<-f.s.mediaIndexes
}

func TestMotionTagsRequireSupportedFinalContainer(t *testing.T) {
	for _, key := range []string{"XMP-GContainer:ContainerDirectory", "XMP-Container:Directory"} {
		t.Run(key, func(t *testing.T) {
			base := func() map[string]any {
				return map[string]any{
					"XMP-GCamera:MotionPhoto":                        float64(1),
					"XMP-GCamera:MotionPhotoVersion":                 float64(1),
					"XMP-GCamera:MotionPhotoPresentationTimestampUs": float64(1511511),
					"XMP-GCamera:MicroVideo":                         float64(1),
					"XMP-GCamera:MicroVideoOffset":                   float64(100),
					key: []any{
						map[string]any{"Item": map[string]any{"Semantic": "Primary", "Mime": "image/jpeg"}},
						map[string]any{"Item": map[string]any{"Semantic": "GainMap", "Mime": "image/jpeg", "Length": float64(20)}},
						map[string]any{"Item": map[string]any{"Semantic": "MotionPhoto", "Mime": "video/mp4", "Length": float64(100)}},
					},
				}
			}
			tags := base()
			if p := probeTags(tags, 200, true); p.Length != 100 || p.Offset != 100 || p.PosterTime != 1.511511 {
				t.Fatal(p)
			}
			tags = base()
			tags["XMP-GCamera:MotionPhoto"] = float64(0)
			if p := probeTags(tags, 200, true); p.Length != 0 {
				t.Fatal("disabled motion accepted", p)
			}
			tags = base()
			tags["XMP-GCamera:MotionPhotoVersion"] = float64(2)
			if p := probeTags(tags, 200, true); p.Length != 0 {
				t.Fatal("unknown version accepted", p)
			}
			tags = base()
			entries := tags[key].([]any)
			tags[key] = append(entries, map[string]any{"Item": map[string]any{"Semantic": "Other", "Length": float64(50)}})
			if p := probeTags(tags, 200, true); p.Length != 0 {
				t.Fatal("non-final motion item accepted", p)
			}
		})
	}
}
func TestMediaPagingWaitsForLateDuplicateAndKeepsFinalComplete(t *testing.T) {
	f := mediaFixture(t)
	movie := appleMovie(t)
	photo, err := os.ReadFile("../../../test/fixtures/live-photo.jpg")
	if err != nil {
		t.Fatal(err)
	}
	putMedia(t, f, "a.jpg", photo)
	putMedia(t, f, "a.mov", movie)
	plain, err := os.ReadFile("../../../test/fixtures/album-thumbnail.jpg")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 65; i++ {
		putMedia(t, f, fmt.Sprintf("b%03d.jpg", i), plain)
	}
	putMedia(t, f, "z.jpg", motionJPEG(t, 1, 0, true))
	base := mediaPath + "/" + mediaID("") + "/index.json"
	first := readMediaIndex(t, f, base)
	if first.NextOffset == nil || *first.NextOffset != 64 {
		t.Fatal(first)
	}
	last := readMediaIndex(t, f, base+"?offset=64&revision="+first.Revision)
	if last.NextOffset != nil || len(last.Items) != 2 {
		t.Fatal("final index must include earlier pairs", last)
	}
	putMedia(t, f, "zz.mov", movie)
	first = readMediaIndex(t, f, base)
	last = readMediaIndex(t, f, base+"?offset=64&revision="+first.Revision)
	if len(last.Items) != 1 || last.Items[0].Kind != "motion-photo" {
		t.Fatal("late duplicate must remove earlier provisional pair", last)
	}
}
