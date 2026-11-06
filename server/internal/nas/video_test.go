package nas

import (
	"bytes"
	"context"
	"encoding/json"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func videoFixture(t *testing.T) []byte {
	t.Helper()
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip("video tests require FFmpeg 6+ and ffprobe")
		}
	}
	data, err := os.ReadFile("../../../test/fixtures/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestVideoPosterUsesIIIFAndCannotBypassSourceVisibility(t *testing.T) {
	data := videoFixture(t)
	f := newFixture(t)
	name := "旅行 🎬.mp4"
	source := filepath.Join(f.public, name)
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	base := imageURL(name)
	response := f.request(t, "GET", base+"/info.json", "", nil, nil)
	status(t, response, 200)
	var info struct {
		Width, Height int
		Profile       string
		Sizes         []imageSize
	}
	json.NewDecoder(response.Body).Decode(&info)
	response.Body.Close()
	if info.Width != 640 || info.Height != 360 || info.Profile != "level0" || len(info.Sizes) != 3 {
		t.Fatalf("bad poster info %+v", info)
	}
	response = f.request(t, "GET", base+"/full/128,72/0/default.jpg", "", nil, nil)
	status(t, response, 200)
	picture := responseBytes(t, response)
	config, err := jpeg.DecodeConfig(bytes.NewReader(picture))
	if err != nil || config.Width != 128 || config.Height != 72 {
		t.Fatal(config, err)
	}
	etag := response.Header.Get("ETag")
	status(t, f.request(t, "GET", base+"/full/128,72/0/default.jpg", "", nil, map[string]string{"If-None-Match": etag}), 304)
	raw := f.request(t, "GET", "/dav/"+url.PathEscape(name), "", nil, map[string]string{"Range": "bytes=0-31"})
	status(t, raw, 206)
	if !bytes.Equal(responseBytes(t, raw), data[:32]) {
		t.Fatal("video range differs from original")
	}
	// Large videos are seeked through a descriptor, never loaded into a byte slice.
	file, err := os.OpenFile(source, os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	file.Truncate(maxImageBytes + 1)
	file.Close()
	status(t, f.request(t, "GET", base+"/info.json", "", nil, nil), 200)
	if err := os.Mkdir(filepath.Join(f.public, "#recycle"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(source, filepath.Join(f.public, "#recycle", "video.mp4")); err != nil {
		t.Fatal(err)
	}
	status(t, f.request(t, "GET", base+"/full/128,72/0/default.jpg", "", nil, map[string]string{"If-None-Match": etag}), 404)
	os.Symlink("#recycle/video.mp4", source)
	status(t, f.request(t, "GET", base+"/info.json", "", nil, nil), 404)
	status(t, f.request(t, "GET", imageURL("#recycle/video.mp4")+"/full/max/0/default.jpg", "", nil, nil), 404)
}
func TestVideoRotationMatchesGeneratedPoster(t *testing.T) {
	data := videoFixture(t)
	f := newFixture(t)
	original := filepath.Join(t.TempDir(), "video.mp4")
	os.WriteFile(original, data, 0600)
	rotated := filepath.Join(f.public, "rotated.mov")
	if output, err := exec.Command("ffmpeg", "-v", "error", "-display_rotation:v:0", "90", "-i", original, "-c", "copy", rotated).CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	response := f.request(t, "GET", imageURL("rotated.mov")+"/info.json", "", nil, nil)
	status(t, response, 200)
	var info struct{ Width, Height int }
	json.NewDecoder(response.Body).Decode(&info)
	if info.Width != 360 || info.Height != 640 {
		t.Fatal("rotation ignored", info)
	}
	response = f.request(t, "GET", imageURL("rotated.mov")+"/full/max/0/default.jpg", "", nil, nil)
	status(t, response, 200)
	image, err := jpeg.DecodeConfig(response.Body)
	if err != nil || image.Width != 360 || image.Height != 640 {
		t.Fatal(image, err)
	}
}
func TestVideoInputCannotOpenPlaylistsOrExternalURLs(t *testing.T) {
	videoFixture(t)
	f := newFixture(t)
	var hits atomic.Int32
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.Write([]byte("private")) }))
	defer trap.Close()
	for _, content := range []string{"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n" + trap.URL + "/private.ts\n#EXT-X-ENDLIST\n", "ffconcat version 1.0\nfile '" + trap.URL + "/private.mp4'\n"} {
		name := "playlist.mp4"
		os.WriteFile(filepath.Join(f.public, name), []byte(content), 0600)
		status(t, f.request(t, "GET", imageURL(name)+"/info.json", "", nil, nil), 415)
	}
	if hits.Load() != 0 {
		t.Fatal("FFmpeg fetched an external resource")
	}
	file, err := os.Open(filepath.Join(f.public, "playlist.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = sourceVideoMetadata(ctx, file); err == nil {
		t.Fatal("ignored cancellation")
	}
	output := &boundedOutput{limit: 100}
	n, _ := output.Write(make([]byte, 1000000))
	if n != 1000000 || output.Len() != 100 || !output.overflow {
		t.Fatal("unbounded process output")
	}
}
