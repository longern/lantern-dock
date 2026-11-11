package nas

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvitationCredentialSurvivesRestartAndIsEncrypted(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenStore(directory, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, token, err := store.CreateLink(ctx, Link{Title: "Photos", ExpiresAt: time.Now().Add(time.Hour), MaxFileBytes: 10, MaxTotalBytes: 20, MaxFiles: 3})
	if err != nil {
		t.Fatal(err)
	}
	var encrypted []byte
	if err = store.DB.QueryRow(`SELECT encrypted_token FROM invitation_tokens WHERE link_id=?`, created.ID).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if len(encrypted) <= len(token) || bytes.Contains(encrypted, []byte(token)) {
		t.Fatal("credential was not encrypted")
	}
	if _, err = store.Reserve(ctx, created.ID, "photo.jpg", 5); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(directory, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for range 2 {
		link, recovered, err := store.Invitation(ctx, created.ID)
		if err != nil || recovered != token || link.ID != created.ID || !link.ExpiresAt.Equal(created.ExpiresAt) || link.UsedBytes != 5 || link.UsedFiles != 1 || !link.Shareable || link.MaxFiles != created.MaxFiles || link.MaxTotalBytes != created.MaxTotalBytes {
			t.Fatalf("sharing changed invitation: %+v, %v", link, err)
		}
	}
	if _, err = os.Stat(filepath.Join(directory, "invitation.key")); !os.IsNotExist(err) {
		t.Fatal("restart created an implicit key file")
	}
}

func TestInvitationSecretRequiredBeforeOpeningStorage(t *testing.T) {
	for _, secret := range []string{"", "short", " " + fixtureSecret, fixtureSecret + "\n"} {
		directory := filepath.Join(t.TempDir(), "data")
		store, err := OpenStore(directory, WithSecretKey(secret))
		if err == nil {
			store.Close()
			t.Fatal("missing or invalid SECRET_KEY accepted")
		}
		if !strings.Contains(err.Error(), "SECRET_KEY") {
			t.Fatal("missing actionable configuration error", err)
		}
		if _, err = os.Stat(directory); !os.IsNotExist(err) {
			t.Fatal("invalid configuration modified storage")
		}
	}
}

func TestInvitationIgnoresLegacyKeyFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "invitation.key")
	if err := os.WriteFile(path, []byte("legacy-key-do-not-overwrite"), 0000); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(directory, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal("startup accessed the legacy key file", err)
	}
	store.Close()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0 || info.Size() != int64(len("legacy-key-do-not-overwrite")) {
		t.Fatal("legacy key file was modified", err)
	}
	// A leftover file must not satisfy a missing environment configuration.
	if store, err = OpenStore(directory); err == nil {
		store.Close()
		t.Fatal("legacy file used as a fallback")
	}
	if !strings.Contains(err.Error(), "SECRET_KEY") {
		t.Fatal(err)
	}
}

func TestInvitationDeploymentSecretKey(t *testing.T) {
	directory := t.TempDir()
	secret := strings.Repeat("a1", 32)
	store, err := OpenStore(directory, WithSecretKey(secret))
	if err != nil {
		t.Fatal(err)
	}
	link, token, err := store.CreateLink(context.Background(), Link{Title: "Configured secret", ExpiresAt: time.Now().Add(time.Hour), MaxFileBytes: 10, MaxTotalBytes: 20, MaxFiles: 3})
	if err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = OpenStore(directory, WithSecretKey(secret))
	if err != nil {
		t.Fatal(err)
	}
	_, recovered, err := store.Invitation(context.Background(), link.ID)
	store.Close()
	if err != nil || recovered != token {
		t.Fatal("configured secret failed", err)
	}
	if _, err = os.Stat(filepath.Join(directory, "invitation.key")); !os.IsNotExist(err) {
		t.Fatal("configured secret created a fallback")
	}
	if store, err = OpenStore(directory); err == nil {
		store.Close()
		t.Fatal("missing secret accepted")
	}
	for _, invalid := range []string{"short", " " + secret, secret + "\n", secret[:32] + "\n" + secret[32:]} {
		if store, err = OpenStore(t.TempDir(), WithSecretKey(invalid)); err == nil {
			store.Close()
			t.Fatal("invalid secret accepted")
		}
	}
}

func TestAdminInvitationSharingAndLegacyCompatibility(t *testing.T) {
	f := newAdminFixture(t, "")
	link, token := f.createLink(t)
	upload := f.reserve(t, token, "photo.jpg", 5)
	path := adminPath + "/links/" + link.ID + "/share"
	for range 2 {
		r := f.admin(t, "GET", path, linksWriteScope, "")
		status(t, r, 200)
		if r.Header.Get("Cache-Control") != "no-store" || r.Header.Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("unsafe response caching")
		}
		got := decodeResponse[struct {
			Link  Link
			Token string
		}](t, r)
		if got.Token != token || got.Link.ID != link.ID || got.Link.UsedBytes != 5 || got.Link.UsedFiles != 1 || !got.Link.ExpiresAt.Equal(link.ExpiresAt) || !got.Link.Shareable {
			t.Fatalf("unexpected invitation: %+v", got.Link)
		}
	}
	for _, scenario := range []struct {
		sql    string
		status int
		code   string
	}{
		{`UPDATE links SET revoked=1 WHERE id=?`, 410, "LINK_REVOKED"},
		{`UPDATE links SET revoked=0,expires_at=0 WHERE id=?`, 410, "LINK_EXPIRED"},
		{`UPDATE links SET expires_at=unixepoch()+3600,max_files=1 WHERE id=?`, 409, "QUOTA_EXCEEDED"},
	} {
		if _, err := f.s.Store.DB.Exec(scenario.sql, link.ID); err != nil {
			t.Fatal(err)
		}
		r := f.admin(t, "GET", path, linksWriteScope, "")
		status(t, r, scenario.status)
		body := read(t, r)
		if strings.Contains(body, token) || !strings.Contains(body, scenario.code) {
			t.Fatal("incorrect share failure", body)
		}
	}
	if _, err := f.s.Store.DB.Exec(`UPDATE links SET max_files=3 WHERE id=?`, link.ID); err != nil {
		t.Fatal(err)
	}
	// Old deployments have a hash but no encrypted credential. The original
	// bearer token remains valid; sharing must never rotate it implicitly.
	if _, err := f.s.Store.DB.Exec(`DELETE FROM invitation_tokens WHERE link_id=?`, link.ID); err != nil {
		t.Fatal(err)
	}
	r := f.admin(t, "GET", path, linksWriteScope, "")
	status(t, r, 409)
	if body := read(t, r); !strings.Contains(body, "LINK_NOT_RECOVERABLE") {
		t.Fatal(body)
	}
	if _, err := f.s.Store.Authenticate(context.Background(), token); err != nil {
		t.Fatal("legacy bearer stopped working", err)
	}
	r = f.admin(t, "GET", adminPath+"/links", linksReadScope, "")
	status(t, r, 200)
	var list struct{ Links []Link }
	if err := json.Unmarshal([]byte(read(t, r)), &list); err != nil || len(list.Links) != 1 || list.Links[0].Shareable {
		t.Fatal("legacy link claimed recoverability", err)
	}
	status(t, f.admin(t, "GET", adminPath+"/links/"+randomID()+"/share", linksWriteScope, ""), 404)
	personal, err := f.s.Store.personalInbox(context.Background(), "owner")
	if err != nil {
		t.Fatal(err)
	}
	status(t, f.admin(t, "GET", adminPath+"/links/"+personal.ID+"/share", linksWriteScope, ""), 404)
	var count int
	if err = f.s.Store.DB.QueryRow(`SELECT COUNT(*) FROM uploads WHERE id=? AND link_id=?`, upload.ID, link.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("sharing removed upload", err)
	}
}

func TestInvitationCiphertextIsBoundToItsRecord(t *testing.T) {
	f := newAdminFixture(t, "")
	one, token := f.createLink(t)
	two, _ := f.createLink(t)
	var encrypted []byte
	if err := f.s.Store.DB.QueryRow(`SELECT encrypted_token FROM invitation_tokens WHERE link_id=?`, one.ID).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Store.DB.Exec(`UPDATE invitation_tokens SET encrypted_token=? WHERE link_id=?`, encrypted, two.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.Store.Invitation(context.Background(), two.ID); err == nil {
		t.Fatal("credential moved between invitations")
	}
	if _, err := rand.Read(encrypted[1:]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Store.DB.Exec(`UPDATE invitation_tokens SET encrypted_token=? WHERE link_id=?`, encrypted, one.ID); err != nil {
		t.Fatal(err)
	}
	r := f.admin(t, "GET", adminPath+"/links/"+one.ID+"/share", linksWriteScope, "")
	status(t, r, 503)
	if body := read(t, r); strings.Contains(body, token) {
		t.Fatal("failure disclosed token")
	}
	if _, err := f.s.Store.Authenticate(context.Background(), token); err != nil {
		t.Fatal("credential was rotated after decrypt failure", err)
	}
}

func TestInvitationLegacySchemaMigration(t *testing.T) {
	directory := t.TempDir()
	store, err := OpenStore(directory, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	input := Link{Title: "Before upgrade", ExpiresAt: time.Now().Add(time.Hour), MaxFileBytes: 10, MaxTotalBytes: 20, MaxFiles: 3}
	old, token, err := store.CreateLink(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce the previous schema: links contain hashes, with no credential
	// table. Opening it must preserve those links unchanged.
	if _, err = store.DB.Exec(`DROP TABLE invitation_tokens`); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = OpenStore(directory, WithSecretKey(fixtureSecret))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = store.Authenticate(ctx, token); err != nil {
		t.Fatal("upgrade invalidated saved invitation", err)
	}
	links, err := store.ListLinks(ctx)
	if err != nil || len(links) != 1 || links[0].ID != old.ID || links[0].Shareable || !links[0].ExpiresAt.Equal(old.ExpiresAt) {
		t.Fatal("upgrade changed old invitation", err)
	}
	if _, _, err = store.Invitation(ctx, old.ID); err == nil {
		t.Fatal("invented old credential")
	}
	created, newToken, err := store.CreateLink(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	_, recovered, err := store.Invitation(ctx, created.ID)
	if err != nil || recovered != newToken {
		t.Fatal("new invitation not recoverable after upgrade", err)
	}
}
