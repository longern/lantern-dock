package i18n

import (
	"strings"
	"sync"
	"testing"
)

func TestDetectBrowserLanguage(t *testing.T) {
	for _, tt := range []struct {
		header string
		want   string
	}{
		{"", "en"},
		{"en", "en"},
		{"en-GB,en-US;q=0.8", "en"},
		{"zh", "zh-CN"},
		{"zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"},
		{"zh-TW", "zh-CN"},
		{"ZH-hant-HK", "zh-CN"},
		{"fr-FR,de;q=0.8", "en"},
		{"fr-FR,zh-TW;q=0.8,en;q=0.7", "zh-CN"},
		{"zh-CN;q=0.5,en-US;q=0.9", "en"},
		{"en-US;q=0.5,zh-CN;q=0.9", "zh-CN"},
		{"zh-CN;q=0.9,en-US;q=0.9", "zh-CN"},
		{"en;q=0,zh;q=0.1", "zh-CN"},
		{"zh;q=0,en;q=0.1", "en"},
		{"zh;q=0", "en"},
		{"zh;q=NaN,en;q=0.1", "en"},
		{"zh;q=Inf,en;q=0.1", "en"},
		{"zh;q=-0.5,en;q=0.1", "en"},
		{"zh;q=1.1,en;q=0.1", "en"},
		{"zh;q=invalid,en;q=0.1", "en"},
		{"zh;q,en;q=0.1", "en"},
		{"zh;q=1;q=0,en;q=0.1", "en"},
		{" zh-HK ; Q=0.8 , en ; q=0.5 ", "zh-CN"},
		{"*", "en"},
		{"zh;q=0.4,*;q=0.8", "zh-CN"},
		{"zh-!,en;q=0.1", "en"},
		{"zh--CN,en;q=0.1", "en"},
		{"zh-123456789,en;q=0.1", "en"},
		{"zh_CN", "zh-CN"},
		{"zh;q=0.9999,en;q=0.1", "en"},
		{"zh;q=.9,en;q=0.1", "en"},
		{"zh;q=01,en;q=0.1", "en"},
		{"zh;q=1e0,en;q=0.1", "en"},
		{"zh;q=1.000,en;q=0.1", "zh-CN"},
		{"zh;q=1.,en;q=0.1", "zh-CN"},
	} {
		t.Run(tt.header, func(t *testing.T) {
			if got := Detect(tt.header); got != tt.want {
				t.Fatalf("Detect(%q) = %q, want %q", tt.header, got, tt.want)
			}
		})
	}
}

func TestDetectBoundsHeader(t *testing.T) {
	if got := Detect(strings.Repeat("fr,", 1365) + " zh"); got != "en" {
		t.Fatalf("language beyond header limit was considered: %q", got)
	}
}

func TestKnownTranslations(t *testing.T) {
	if got := New("en").T("errors.loginRequired"); got != "Please sign in first." {
		t.Fatalf("English copy = %q", got)
	}
	if got := New("zh-TW").T("errors.loginRequired"); got != "\u8bf7\u5148\u767b\u5f55\u3002" {
		t.Fatalf("Chinese copy = %q", got)
	}
}

func TestCatalogsAndFallback(t *testing.T) {
	english, chinese := catalogs["en"], catalogs["zh-CN"]
	if len(english) == 0 || len(english) != len(chinese) {
		t.Fatal("catalogs must be nonempty and have the same keys")
	}
	for key, value := range english {
		if value == "" || chinese[key] == "" {
			t.Errorf("missing translation for %q", key)
		}
		if got := New("zh-TW").T(key); got != chinese[key] {
			t.Errorf("Chinese translation for %q = %q", key, got)
		}
	}
	if got := (Translator{}).T("errors.notFound"); got != english["errors.notFound"] {
		t.Errorf("zero-value translator = %q", got)
	}
	if got := (Translator{locale: "unsupported"}).T("errors.notFound"); got != english["errors.notFound"] {
		t.Errorf("English fallback = %q", got)
	}
	if got := New("zh-CN").T("missing.key"); got != "missing.key" {
		t.Errorf("missing-key fallback = %q", got)
	}
}

func TestInterpolationIsSinglePass(t *testing.T) {
	values := map[string]any{"name": "{{count}} <photo>", "count": 2}
	got := interpolate("{{name}}: {{ count }} / {{missing}} / {{count}}", values)
	want := "{{count}} <photo>: 2 / {{missing}} / 2"
	if got != want {
		t.Fatalf("interpolation = %q, want %q", got, want)
	}
	if got := interpolate("{{name}}", nil); got != "{{name}}" {
		t.Fatalf("missing values = %q", got)
	}
}

func TestConcurrentTranslatorsAreIsolated(t *testing.T) {
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		locale := "en"
		if i%2 != 0 {
			locale = "zh-CN"
		}
		wg.Go(func() {
			translator := New(locale)
			for j := 0; j < 100; j++ {
				if got := translator.T("errors.notFound"); got != catalogs[locale]["errors.notFound"] {
					t.Errorf("translation leaked across requests: %q", got)
				}
			}
		})
	}
	wg.Wait()
}
