package nas

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
)

func imageURL(name string) string {
	return imagesPath + "/" + base64.RawURLEncoding.EncodeToString([]byte(name))
}
func writePhoto(t *testing.T, f *fixture, name string, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), 100, 180})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.public, name), b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func responseBytes(t *testing.T, r *http.Response) []byte {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	r.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestIIIFLevelZeroAndConditionalReads(t *testing.T) {
	f := newFixture(t)
	writePhoto(t, f, "海边.png", 2400, 1600)
	base := imageURL("海边.png")
	r := f.request(t, "GET", base+"/info.json", "", nil, map[string]string{"Origin": "https://portal.example"})
	status(t, r, 200)
	body := responseBytes(t, r)
	var info struct {
		Context, ID, Type, Protocol, Profile string
		Width, Height, MaxWidth, MaxHeight   int
		Sizes                                []imageSize
	}
	// @context is deliberately checked as the first JSON property for JSON-LD clients.
	if !bytes.HasPrefix(body, []byte(`{"@context":"`+iiifContext+`"`)) {
		t.Fatal(string(body))
	}
	if err := json.Unmarshal(body, &info); err != nil {
		t.Fatal(err)
	}
	if info.Type != "ImageService3" || info.Profile != "level0" || info.Protocol != "http://iiif.io/api/image" || info.ID != f.http.URL+base || info.Width != 2400 || info.Height != 1600 || info.MaxWidth != 1600 || len(info.Sizes) != 3 {
		t.Fatalf("bad IIIF info %+v", info)
	}
	if r.Header.Get("Content-Type") != `application/ld+json;profile="`+iiifContext+`"` || !strings.Contains(r.Header.Get("Link"), iiifProfile) || !strings.Contains(strings.Join(r.Header.Values("Vary"), ","), "Accept") || r.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatal(r.Header)
	}
	status(t, f.request(t, "GET", base+"/info.json", "", nil, map[string]string{"If-None-Match": r.Header.Get("ETag")}), 304)
	jsonResponse := f.request(t, "GET", base+"/info.json", "", nil, map[string]string{"Accept": "application/json"})
	status(t, jsonResponse, 200)
	if jsonResponse.Header.Get("Content-Type") != "application/json" {
		t.Fatal(jsonResponse.Header)
	}
	client := *f.http.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	redirect, err := client.Get(f.http.URL + base)
	if err != nil {
		t.Fatal(err)
	}
	defer redirect.Body.Close()
	if redirect.StatusCode != 303 || redirect.Header.Get("Location") != f.http.URL+base+"/info.json" {
		t.Fatal(redirect.StatusCode, redirect.Header)
	}
	for _, size := range []string{"128,85", "384,256", "1600,1067", "max"} {
		r = f.request(t, "GET", base+"/full/"+size+"/0/default.jpg", "", nil, nil)
		status(t, r, 200)
		data := responseBytes(t, r)
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		width := img.Bounds().Dx()
		if !((size == "128,85" && width == 128) || (size == "384,256" && width == 384) || ((size == "max" || size == "1600,1067") && width == 1600)) {
			t.Fatal(size, img.Bounds())
		}
		etag := r.Header.Get("ETag")
		if etag == "" || r.Header.Get("Content-Type") != "image/jpeg" {
			t.Fatal(r.Header)
		}
		status(t, f.request(t, "GET", base+"/full/"+size+"/0/default.jpg", "", nil, map[string]string{"If-None-Match": etag}), 304)
		head := f.request(t, "HEAD", base+"/full/"+size+"/0/default.jpg", "", nil, nil)
		status(t, head, 200)
		if head.ContentLength != int64(len(data)) || len(responseBytes(t, head)) != 0 {
			t.Fatal("HEAD mismatch")
		}
		ranged := f.request(t, "GET", base+"/full/"+size+"/0/default.jpg", "", nil, map[string]string{"Range": "bytes=0-15"})
		status(t, ranged, 206)
		if !bytes.Equal(responseBytes(t, ranged), data[:16]) {
			t.Fatal("Range mismatch")
		}
	}
	for _, suffix := range []string{"/full/100,/0/default.jpg", "/square/max/0/default.jpg", "/full/max/90/default.jpg", "/full/max/0/default.png"} {
		r = f.request(t, "GET", base+suffix, "", nil, nil)
		status(t, r, 400)
		if r.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cached error")
		}
	}
	status(t, f.request(t, "PUT", base+"/info.json", "", nil, nil), 405)
	status(t, f.request(t, "OPTIONS", base+"/info.json", "", nil, nil), 204)
	status(t, f.request(t, "GET", base+"/info.json", "", nil, map[string]string{"Origin": "https://evil.example"}), 403)
}

func TestIIIFCacheCannotBypassSourceVisibilityOrUpdates(t *testing.T) {
	f := newFixture(t)
	writePhoto(t, f, "photo.png", 60, 40)
	path := imageURL("photo.png") + "/full/max/0/default.jpg"
	r := f.request(t, "GET", path, "", nil, nil)
	status(t, r, 200)
	etag := r.Header.Get("ETag")
	r.Body.Close()
	original, _ := os.Stat(filepath.Join(f.public, "photo.png"))
	// A retained mtime must not hide a changed source from a warm cache.
	time.Sleep(time.Millisecond * 2)
	writePhoto(t, f, "photo.png", 40, 60)
	os.Chtimes(filepath.Join(f.public, "photo.png"), original.ModTime(), original.ModTime())
	r = f.request(t, "GET", path, "", nil, map[string]string{"If-None-Match": etag})
	status(t, r, 200)
	if r.Header.Get("ETag") == etag {
		t.Fatal("stale image after mutation")
	}
	r.Body.Close()
	if err := os.Mkdir(filepath.Join(f.public, "#recycle"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.public, "photo.png"), filepath.Join(f.public, "#recycle", "photo.png")); err != nil {
		t.Fatal(err)
	}
	status(t, f.request(t, "GET", path, "", nil, map[string]string{"If-None-Match": etag}), 404)
	os.Symlink("#recycle/photo.png", filepath.Join(f.public, "photo.png"))
	for _, name := range []string{"photo.png", "#recycle/photo.png", "@rEcYcLe/photo.png", "../data/cache/images/private.jpg", "/photo.png", "#recycle", "."} {
		for _, suffix := range []string{"/info.json", "/full/max/0/default.jpg"} {
			r = f.request(t, "GET", imageURL(name)+suffix, "", nil, map[string]string{"If-None-Match": etag})
			status(t, r, 404)
			if r.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("cached missing source")
			}
		}
	}
	status(t, f.request(t, "GET", "/data/cache/images", "", nil, nil), 404)
}

func TestImageFormatsOrientationAndLimits(t *testing.T) {
	f := newFixture(t)
	img := image.NewRGBA(image.Rect(0, 0, 30, 20))
	for _, format := range []string{"png", "jpeg", "gif", "bmp", "tiff"} {
		var data bytes.Buffer
		switch format {
		case "png":
			png.Encode(&data, img)
		case "jpeg":
			jpeg.Encode(&data, img, nil)
		case "gif":
			gif.Encode(&data, img, nil)
		case "bmp":
			bmp.Encode(&data, img)
		case "tiff":
			tiff.Encode(&data, img, nil)
		}
		name := "photo." + format
		os.WriteFile(filepath.Join(f.public, name), data.Bytes(), 0600)
		status(t, f.request(t, "GET", imageURL(name)+"/full/max/0/default.jpg", "", nil, nil), 200)
	}
	var source bytes.Buffer
	jpeg.Encode(&source, img, nil)
	exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	oriented := append([]byte{0xff, 0xd8, 0xff, 0xe1, 0, byte(len(exif) + 2)}, exif...)
	oriented = append(oriented, source.Bytes()[2:]...)
	os.WriteFile(filepath.Join(f.public, "oriented.jpg"), oriented, 0600)
	r := f.request(t, "GET", imageURL("oriented.jpg")+"/info.json", "", nil, nil)
	status(t, r, 200)
	var info struct{ Width, Height int }
	json.NewDecoder(r.Body).Decode(&info)
	if info.Width != 20 || info.Height != 30 {
		t.Fatal("EXIF orientation ignored", info)
	}
	r = f.request(t, "GET", imageURL("oriented.jpg")+"/full/max/0/default.jpg", "", nil, nil)
	status(t, r, 200)
	result, err := jpeg.Decode(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bounds().Dx() != 20 || result.Bounds().Dy() != 30 {
		t.Fatal("orientation mismatch")
	}
	os.WriteFile(filepath.Join(f.public, "fake.jpg"), []byte("not an image"), 0600)
	status(t, f.request(t, "GET", imageURL("fake.jpg")+"/info.json", "", nil, nil), 415)
	var huge bytes.Buffer
	// BMP dimensions can be rejected from the header without allocating the raster.
	bmp.Encode(&huge, img)
	value := huge.Bytes()
	binary.LittleEndian.PutUint32(value[18:22], 10000)
	binary.LittleEndian.PutUint32(value[22:26], 10000)
	os.WriteFile(filepath.Join(f.public, "huge.bmp"), value, 0600)
	status(t, f.request(t, "GET", imageURL("huge.bmp")+"/info.json", "", nil, nil), 413)
	file, err := os.Create(filepath.Join(f.public, "large.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	file.Truncate(maxImageBytes + 1)
	file.Close()
	status(t, f.request(t, "GET", imageURL("large.jpg")+"/info.json", "", nil, nil), 413)
	for i := 0; i < cap(f.s.images.requests); i++ {
		f.s.images.requests <- struct{}{}
	}
	r = f.request(t, "GET", imageURL("photo.png")+"/info.json", "", nil, nil)
	status(t, r, 503)
	if r.Header.Get("Retry-After") != "1" {
		t.Fatal("missing retry advice")
	}
	for len(f.s.images.requests) > 0 {
		<-f.s.images.requests
	}
}

func TestImageDiskCachePersistsBoundsAndRejectsSymlinks(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	cache, err := newImageCache(root)
	if err != nil {
		t.Fatal(err)
	}
	a, b, c := imageHash([]byte("a"))+".jpg", imageHash([]byte("b"))+".jpg", imageHash([]byte("c"))+".jpg"
	cache.limit = 10
	cache.put(a, []byte("aaaa"))
	cache.put(b, []byte("bbbb"))
	cache.get(a)
	cache.put(c, []byte("cccc"))
	if cache.get(b) != nil || cache.bytes > 10 {
		t.Fatal("LRU budget failed")
	}
	cache.root.WriteFile(".tmp-interrupted", []byte("partial"), 0600)
	cache.root.Close()
	cache, err = newImageCache(root)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.root.Close()
	if string(cache.get(a)) != "aaaa" || string(cache.get(c)) != "cccc" {
		t.Fatal("cache was not restored")
	}
	if _, err = cache.root.Lstat(".tmp-interrupted"); !os.IsNotExist(err) {
		t.Fatal("stale temporary file remains", err)
	}
	cache.root.Remove(a)
	root.WriteFile("sentinel", []byte("private"), 0600)
	cache.root.Symlink("../../sentinel", a)
	if cache.get(a) != nil {
		t.Fatal("followed cache symlink")
	}
	sentinel, _ := root.ReadFile("sentinel")
	if string(sentinel) != "private" {
		t.Fatal("damaged symlink target")
	}
	cache.put("../../sentinel", []byte("overwrite"))
	sentinel, _ = root.ReadFile("sentinel")
	if string(sentinel) != "private" {
		t.Fatal("escaped cache")
	}
}

func TestDAVCacheHeaders(t *testing.T) {
	f := newFixture(t)
	writePhoto(t, f, "photo.png", 10, 10)
	for _, method := range []string{"GET", "HEAD", "PROPFIND"} {
		path := "/dav/photo.png"
		policy := "private, no-cache"
		if method == "PROPFIND" {
			path = "/dav/"
			policy = "private, max-age=15"
		}
		r := f.request(t, method, path, "", nil, map[string]string{"Depth": "1"})
		if r.Header.Get("Cache-Control") != policy {
			t.Fatal(method, r.Header)
		}
		r = f.request(t, method, "/dav/missing", "", nil, map[string]string{"Depth": "1"})
		status(t, r, 404)
		if r.Header.Get("Cache-Control") != "no-store" {
			t.Fatal(method, "cached error", r.Header)
		}
	}
}

func FuzzImageOrientation(f *testing.F) {
	for _, seed := range [][]byte{{}, {0xff, 0xd8}, {'I', 'I', 42, 0, 255, 255, 255, 255}, []byte("Exif\x00\x00")} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		value := imageOrientation(data)
		if value < 1 || value > 8 {
			t.Fatal(value)
		}
	})
}

func TestAllExifTransforms(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	for i := 0; i < 6; i++ {
		source.SetNRGBA(i%3, i/3, color.NRGBA{R: uint8(i + 1), A: 255})
	}
	want := [][]byte{{1, 2, 3, 4, 5, 6}, {3, 2, 1, 6, 5, 4}, {6, 5, 4, 3, 2, 1}, {4, 5, 6, 1, 2, 3}, {1, 4, 2, 5, 3, 6}, {4, 1, 5, 2, 6, 3}, {6, 3, 5, 2, 4, 1}, {3, 6, 2, 5, 1, 4}}
	for orientation, values := range want {
		result := orientImage(source, orientation+1)
		var got []byte
		for y := 0; y < result.Bounds().Dy(); y++ {
			for x := 0; x < result.Bounds().Dx(); x++ {
				r, _, _, _ := result.At(x, y).RGBA()
				got = append(got, byte(r>>8))
			}
		}
		if !bytes.Equal(got, values) {
			t.Fatalf("orientation %d: %v, want %v", orientation+1, got, values)
		}
	}
}
func TestImageVersionDetectsPreservedSizeAndMtime(t *testing.T) {
	name := filepath.Join(t.TempDir(), "photo")
	os.WriteFile(name, []byte("aaaa"), 0600)
	before, _ := os.Stat(name)
	version := imageVersion("photo", before)
	time.Sleep(time.Millisecond * 2)
	os.WriteFile(name, []byte("bbbb"), 0600)
	os.Chtimes(name, before.ModTime(), before.ModTime())
	after, _ := os.Stat(name)
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("test failed to preserve metadata")
	}
	if imageVersion("photo", after) == version {
		t.Fatal("ctime not included in image version")
	}
}

func TestIIIFOriginDoesNotDefaultToTheLoginPortal(t *testing.T) {
	for _, resource := range []string{"", "https://backend.example/"} {
		f := newFixture(t)
		writePhoto(t, f, "photo.png", 30, 20)
		if err := f.s.ConfigureIdentity(IdentityConfig{SiteOrigin: "https://portal.example", ResourceOrigin: resource}); err != nil {
			t.Fatal(err)
		}
		response := f.request(t, "GET", imageURL("photo.png")+"/info.json", "", nil, map[string]string{"X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https"})
		status(t, response, 200)
		var info struct{ ID string }
		json.NewDecoder(response.Body).Decode(&info)
		want := f.http.URL
		if resource != "" {
			want = "https://backend.example"
		}
		if info.ID != want+imageURL("photo.png") {
			t.Fatal("IIIF id must address the NAS, not its login portal or untrusted forwarding headers", info.ID)
		}
	}
}
