package nas

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
)

func invitationAAD(id string) []byte { return []byte("lantern-dock:invitation:" + id) }

// Encryption uses only the deployment-managed SECRET_KEY. Never create or
// read a second key in the data volume: runtime UID/GID changes must not affect
// access to invitation credentials.
func (s *Store) configureInvitationKey(secret string) error {
	if secret == "" {
		return fmt.Errorf("SECRET_KEY is required; configure a persistent NAS secret of at least 32 characters")
	}
	if len(secret) < 32 || strings.TrimSpace(secret) != secret || strings.ContainsAny(secret, "\r\n") {
		return fmt.Errorf("SECRET_KEY must contain at least 32 characters without surrounding whitespace")
	}
	// Match the site's purpose-separated HMAC derivation convention. The
	// master secret is never persisted or used directly as an AES key.
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("lantern-dock:nas:invitation-encryption:v1"))
	return s.setInvitationCipher(mac.Sum(nil))
}

func (s *Store) setInvitationCipher(key []byte) error {
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	s.tokenCipher, err = cipher.NewGCMWithRandomNonce(block)
	return err
}

// Invitation returns an existing credential without changing its lifetime,
// quota or identity. Only the separately authorized admin endpoint calls it.
func (s *Store) Invitation(ctx context.Context, id string) (Link, string, error) {
	var link Link
	var expiry int64
	var encrypted, hash []byte
	err := s.DB.QueryRowContext(ctx, `SELECT l.id,l.title,l.expires_at,l.max_file_bytes,l.max_total_bytes,l.max_files,l.revoked,
 (SELECT COALESCE(SUM(size),0) FROM uploads WHERE link_id=l.id AND `+usageWhere+`),
 (SELECT COUNT(*) FROM uploads WHERE link_id=l.id AND `+usageWhere+`),
 (SELECT encrypted_token FROM invitation_tokens WHERE link_id=l.id), l.token_hash
 FROM links l WHERE l.id=? AND l.id NOT IN
 (SELECT link_id FROM personal_inboxes UNION ALL SELECT link_id FROM member_grants)`,
		time.Now().Unix(), time.Now().Unix(), id).Scan(&link.ID, &link.Title, &expiry, &link.MaxFileBytes, &link.MaxTotalBytes, &link.MaxFiles, &link.Revoked, &link.UsedBytes, &link.UsedFiles, &encrypted, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return Link{}, "", fault(404, "LINK_NOT_FOUND", "errors.linkNotFound")
	}
	if err != nil {
		return Link{}, "", err
	}
	link.ExpiresAt = time.Unix(expiry, 0).UTC()
	if err = live(link); err != nil {
		return Link{}, "", err
	}
	if link.UsedFiles >= link.MaxFiles || link.UsedBytes >= link.MaxTotalBytes {
		return Link{}, "", fault(409, "QUOTA_EXCEEDED", "errors.quotaExceeded")
	}
	if encrypted == nil {
		return Link{}, "", fault(409, "LINK_NOT_RECOVERABLE", "errors.linkNotRecoverable")
	}
	failure := fault(503, "STORAGE_UNAVAILABLE", "errors.storageUnavailable")
	if len(encrypted) < 1+s.tokenCipher.Overhead() || encrypted[0] != 1 {
		return Link{}, "", failure
	}
	plain, err := s.tokenCipher.Open(nil, nil, encrypted[1:], invitationAAD(id))
	if err != nil {
		return Link{}, "", failure
	}
	raw, err := base64.RawURLEncoding.DecodeString(string(plain))
	expected := sha256.Sum256(plain)
	if err != nil || len(raw) != 32 || subtle.ConstantTimeCompare(expected[:], hash) != 1 {
		return Link{}, "", failure
	}
	link.Shareable = true
	return link, string(plain), nil
}
