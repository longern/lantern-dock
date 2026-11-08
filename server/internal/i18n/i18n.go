// Package i18n provides immutable, request-local translations for the NAS API.
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

//go:embed locales/*.json
var resources embed.FS

// Catalogs are loaded once and never mutated. Translators can be shared safely.
var catalogs = loadCatalogs()

func loadCatalogs() map[string]map[string]string {
	result := make(map[string]map[string]string)
	for _, locale := range []string{"en", "zh-CN"} {
		data, err := resources.ReadFile("locales/" + locale + ".json")
		if err != nil {
			panic(err)
		}
		var catalog map[string]string
		if err := json.Unmarshal(data, &catalog); err != nil {
			panic(err)
		}
		result[locale] = catalog
	}
	return result
}

var languageTag = regexp.MustCompile(`^(en|zh)(-[a-z0-9]{1,8})*$`)
var qualityValue = regexp.MustCompile(`^(0(\.[0-9]{0,3})?|1(\.0{0,3})?)$`)

// Detect selects a supported language from an Accept-Language header. Quality
// values take priority, then header order. Unsupported tags and wildcards are
// skipped, with English as the fallback. Chinese variants use Simplified text.
func Detect(acceptLanguage string) string {
	if len(acceptLanguage) > 4096 {
		acceptLanguage = acceptLanguage[:4096]
	}
	locale, best := "en", 0.0
	for _, item := range strings.Split(acceptLanguage, ",") {
		parts := strings.Split(item, ";")
		tag := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(parts[0])), "_", "-")
		if !languageTag.MatchString(tag) {
			continue
		}
		candidate := "en"
		if strings.HasPrefix(tag, "zh") {
			candidate = "zh-CN"
		}
		quality, valid, seenQuality := 1.0, true, false
		for _, parameter := range parts[1:] {
			name, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if !strings.EqualFold(strings.TrimSpace(name), "q") {
				continue
			}
			value = strings.TrimSpace(value)
			if !ok || seenQuality || !qualityValue.MatchString(value) {
				valid = false
				break
			}
			seenQuality = true
			quality, _ = strconv.ParseFloat(value, 64)
		}
		if valid && quality > best {
			locale, best = candidate, quality
		}
	}
	return locale
}

// Translator is a value, not a process-wide current-language setting.
// Its zero value uses English.
type Translator struct{ locale string }

func New(acceptLanguage string) Translator {
	return Translator{locale: Detect(acceptLanguage)}
}

func (t Translator) Locale() string {
	if t.locale == "" {
		return "en"
	}
	return t.locale
}

// T resolves a catalog key, falling back to English and then to the key itself.
// Optional values replace {{name}} placeholders once, without interpreting
// replacement text. HTTP writers remain responsible for JSON/HTML escaping.
func (t Translator) T(key string, values ...map[string]any) string {
	message, ok := catalogs[t.Locale()][key]
	if !ok {
		message, ok = catalogs["en"][key]
	}
	if !ok {
		return key
	}
	if len(values) != 0 {
		return interpolate(message, values[0])
	}
	return message
}

var placeholder = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+)\s*\}\}`)

func interpolate(message string, values map[string]any) string {
	return placeholder.ReplaceAllStringFunc(message, func(token string) string {
		name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(token, "{{"), "}}"))
		if value, ok := values[name]; ok {
			return fmt.Sprint(value)
		}
		return token
	})
}
