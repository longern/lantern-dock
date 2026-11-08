package nas

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/longern/lantern-dock/server/internal/i18n"
)

func TestLocalizedAPIErrors(t *testing.T) {
	f := newFixture(t)
	_, token := f.link(t, 10, 20, 2)
	for _, locale := range []string{"en", "zh-CN"} {
		for _, tt := range []struct {
			name, method, path, token, body, code, key string
			status                                     int
		}{
			{"not found", "GET", "/unknown", "", "", "NOT_FOUND", "errors.notFound", 404},
			{"invalid path", "GET", "/dav/%2e%2e/private", "", "", "INVALID_PATH", "errors.invalidPath", 400},
			{"DAV read only", "DELETE", "/dav/file.txt", "", "", "READ_ONLY", "errors.readOnly", 405},
			{"capabilities read only", "POST", capabilitiesPath, "", "", "METHOD_NOT_ALLOWED", "errors.capabilitiesReadOnly", 405},
			{"upload token", "GET", inboxPath, "", "", "INVALID_UPLOAD_TOKEN", "errors.invalidUploadToken", 401},
			{"upload input", "POST", inboxPath, token, `{}`, "INVALID_FILE", "errors.fileDetailsRequired", 400},
			{"upload file size", "POST", inboxPath, token, `{"name":"photo.jpg","size":11}`, "FILE_TOO_LARGE", "errors.fileTooLarge", 413},
			{"image request", "POST", imagesPath, "", "", "METHOD_NOT_ALLOWED", "errors.imagesReadOnly", 405},
			{"identity disabled", "GET", accountPath, "", "", "IDENTITY_DISABLED", "errors.identityDisabled", 503},
		} {
			t.Run(locale+"/"+tt.name, func(t *testing.T) {
				response := f.request(t, tt.method, tt.path, tt.token, strings.NewReader(tt.body), map[string]string{"Accept-Language": locale})
				status(t, response, tt.status)
				var body map[string]string
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				message := body["error"]
				if body["message"] != "" {
					message = body["message"]
				}
				if body["code"] != tt.code || message != i18n.New(locale).T(tt.key) {
					t.Fatalf("unexpected localized error: %+v", body)
				}
				if response.Header.Get("Content-Language") != locale || !strings.Contains(strings.Join(response.Header.Values("Vary"), ","), "Accept-Language") {
					t.Fatalf("missing language response headers: %+v", response.Header)
				}
			})
		}
	}
}

func TestLocalizedErrorFallbackDoesNotExposeInternalDetails(t *testing.T) {
	for _, locale := range []string{"en", "zh-CN"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Accept-Language", locale)
		for _, identity := range []bool{false, true} {
			w := httptest.NewRecorder()
			internal := errors.New("private database path and credential details")
			key := "errors.storageUnavailable"
			if identity {
				writeIdentityError(w, r, internal)
				key = "errors.authUnavailable"
			} else {
				writeError(w, r, internal)
			}
			if w.Code != 503 || strings.Contains(w.Body.String(), internal.Error()) || !strings.Contains(w.Body.String(), i18n.New(locale).T(key)) {
				t.Fatalf("unsafe fallback: %d %s", w.Code, w.Body.String())
			}
		}
	}
}

func TestIdentityProtocolFieldsStayStableAcrossLanguages(t *testing.T) {
	for _, locale := range []string{"en", "zh-CN"} {
		for _, tt := range []struct {
			code, key, protocol string
			status              int
		}{
			{"LOGIN_REQUIRED", "errors.loginRequired", "invalid_token", 401},
			{"INVALID_PROOF", "errors.invalidProof", "invalid_dpop_proof", 401},
			{"INSUFFICIENT_SCOPE", "errors.insufficientScope", "insufficient_scope", 403},
		} {
			r := httptest.NewRequest("GET", accountPath, nil)
			r.Header.Set("Accept-Language", locale)
			w := httptest.NewRecorder()
			writeIdentityError(w, r, fault(tt.status, tt.code, tt.key))
			var body map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != tt.status || body["error"] != tt.protocol || body["code"] != tt.code || body["message"] != i18n.New(locale).T(tt.key) {
				t.Fatalf("identity protocol changed: %d %+v", w.Code, body)
			}
			challenge := w.Header().Get("WWW-Authenticate")
			if !strings.HasPrefix(challenge, "DPoP ") || (tt.code == "LOGIN_REQUIRED" && strings.Contains(challenge, "error=")) || (tt.code != "LOGIN_REQUIRED" && !strings.Contains(challenge, `error="`+tt.protocol+`"`)) {
				t.Fatalf("identity challenge changed: %s", challenge)
			}
			for _, c := range body["error_description"] {
				if c > 127 {
					t.Fatal("OAuth error_description must remain an ASCII protocol diagnostic")
				}
			}
		}
	}
}

func TestConcurrentAPIResponsesKeepTheirLanguage(t *testing.T) {
	f := newFixture(t)
	var wg sync.WaitGroup
	failures := make(chan error, 100)
	for i := 0; i < 100; i++ {
		locale := "en"
		if i%2 != 0 {
			locale = "zh-CN"
		}
		wg.Go(func() {
			r := httptest.NewRequest("GET", "/unknown", nil)
			r.Header.Set("Accept-Language", locale)
			w := httptest.NewRecorder()
			f.s.ServeHTTP(w, r)
			var body map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				failures <- err
				return
			}
			if w.Code != 404 || body["error"] != i18n.New(locale).T("errors.notFound") || w.Header().Get("Content-Language") != locale {
				failures <- fmt.Errorf("wrong language for %s: %d %s", locale, w.Code, w.Body.String())
			}
		})
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
}

func TestBrowserLanguageDoesNotTranslateStoredTitle(t *testing.T) {
	f := newFixture(t)
	link, token := f.link(t, 10, 20, 2)
	for _, locale := range []string{"en", "zh-CN"} {
		response := f.request(t, "GET", inboxPath, token, nil, map[string]string{"Accept-Language": locale})
		status(t, response, http.StatusOK)
		var got Link
		if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if got.Title != link.Title {
			t.Fatalf("stored title changed: %q, want %q", got.Title, link.Title)
		}
	}
}
