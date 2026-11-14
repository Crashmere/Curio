package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

func (l *Library) storedObject(a Asset) string {
	hash := a.ContentHash
	if hash == "" {
		hash = a.ID
	}
	return l.Object(hash)
}

func (l *Library) sourcePath(hash string) (string, error) {
	var current string
	err := l.DB.QueryRow("SELECT hash FROM asset_storage WHERE asset_id=? AND state='ready'", hash).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		current, err = hash, nil
	}
	if err != nil {
		return "", err
	}
	if !validHash.MatchString(current) {
		return "", errPlaybackIntegrity
	}
	return l.Object(current), nil
}

// Uploaded and normalized fingerprints resolve to one stable catalog identity.
// An existing exact-byte item takes precedence over an equivalent layout alias.
func (l *Library) uploadAsset(hash string) (Asset, int64, error) {
	a, err := scanAsset(l.DB.QueryRow("SELECT "+assetColumns+" FROM assets a WHERE a.id=? OR EXISTS(SELECT 1 FROM asset_storage s WHERE s.asset_id=a.id AND s.hash=? AND s.state='ready') ORDER BY (a.id=?) DESC,a.created_at,a.id LIMIT 1", hash, hash, hash))
	size := a.uploadSize
	if a.ID != hash {
		size = a.Size
	}
	return a, size, err
}

func (l *Library) objectReferenced(hash, except string) (bool, error) {
	var used bool
	err := l.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id!=? AND (
 COALESCE((SELECT hash FROM asset_storage s WHERE s.asset_id=a.id AND s.state='ready'),a.id)=?
 OR EXISTS(SELECT 1 FROM asset_storage s WHERE s.asset_id=a.id AND s.hash=?)))`, except, hash, hash).Scan(&used)
	return used, err
}

func (l *Library) removeUnreferencedObject(hash, except string) error {
	used, err := l.objectReferenced(hash, except)
	if err != nil || used {
		return err
	}
	path := l.Object(hash)
	if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err = os.Stat(filepath.Dir(path)); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

// The durable publishing row precedes blob publication; only a committed ready
// mapping permits cleanup of the already verified equivalent source.
func (l *Library) normalizeVideo(parent context.Context, hash string) (bool, error) {
	ctx, cancel := context.WithTimeout(parent, nativeRemuxDeadline)
	defer cancel()
	a, err := l.asset(hash)
	if err != nil || a.Kind != "video" || a.Format != "mp4" {
		return false, err
	}
	if a.Normalized {
		if err = l.cleanupNormalizedVideo(hash); err != nil {
			slog.Warn("normalized source cleanup pending", "asset", hash, "error", err)
		}
		return true, nil
	}
	if resumed, err := l.resumeVideoPublication(ctx, hash); resumed || err != nil {
		return resumed, err
	}
	_, stat, err := l.playbackOriginal(hash)
	if err != nil {
		return false, err
	}
	spec, err := l.probePlayback(ctx, hash, playbackStamp(hash, stat))
	if err != nil || !spec.nativeRemux {
		return false, err
	}
	_, _ = l.DB.Exec("UPDATE assets SET stage='normalize',engine='CPU · 无损封装整理' WHERE id=? AND status='processing' AND purge_pending=0", hash)
	record, err := l.generateNativeRemux(ctx, hash, spec.stamp)
	if err != nil {
		return false, err
	}
	unlock := l.lock(hash)
	defer unlock()
	l.storageMu.Lock()
	defer l.storageMu.Unlock()
	if err = ctx.Err(); err != nil {
		return false, err
	}
	current, currentStat, err := l.playbackOriginal(hash)
	if err != nil || current.Normalized || playbackStamp(hash, currentStat) != spec.stamp {
		return false, fmt.Errorf("source changed before normalization publication: %w", errPlaybackIntegrity)
	}
	size, digest, err := hashFile(l.Object(hash))
	if err != nil || size != record.OriginalSize || digest != hash {
		return false, fmt.Errorf("source checksum differs before normalization publication: %w", errPlaybackIntegrity)
	}
	path := l.nativeRemuxPath(hash, "mp4")
	size, digest, err = hashFile(path)
	if err != nil || size != record.Size || digest != record.Digest {
		return false, fmt.Errorf("normalized checksum differs before publication: %w", errPlaybackIntegrity)
	}
	_, err = l.DB.Exec(`INSERT INTO asset_storage(asset_id,hash,size,recipe,state,cleanup_pending) VALUES(?,?,?,?,'publishing',1)
 ON CONFLICT(asset_id) DO UPDATE SET hash=excluded.hash,size=excluded.size,recipe=excluded.recipe,state='publishing',cleanup_pending=1`, hash, digest, size, nativeRemuxRecipe)
	if err != nil {
		return false, err
	}
	if err = l.publish(path, digest, size); err != nil {
		return false, err
	}
	if _, err = l.DB.Exec("UPDATE asset_storage SET state='ready' WHERE asset_id=? AND hash=? AND state='publishing'", hash, digest); err != nil {
		return false, err
	}
	if err = l.cleanupNormalizedVideoLocked(hash); err != nil {
		// A verified canonical object is already committed; cleanup retries do not
		// invalidate media readiness or revert the mapping to a deleted source.
		slog.Warn("normalized source cleanup pending", "asset", hash, "error", err)
	}
	slog.Info("video storage normalized", "asset", hash, "sha256", digest, "size", size)
	return true, nil
}

func (l *Library) resumeVideoPublication(ctx context.Context, hash string) (bool, error) {
	unlock := l.lock(hash)
	defer unlock()
	l.storageMu.Lock()
	defer l.storageMu.Unlock()
	var digest, recipe string
	var size int64
	err := l.DB.QueryRow("SELECT hash,size,recipe FROM asset_storage WHERE asset_id=? AND state='publishing'", hash).Scan(&digest, &size, &recipe)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !validHash.MatchString(digest) || recipe != nativeRemuxRecipe {
		return false, errPlaybackIntegrity
	}
	if _, err = os.Lstat(l.Object(digest)); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if err = l.playbackAllowed(hash); err != nil {
		return false, err
	}
	if err = ctx.Err(); err != nil {
		return false, err
	}
	_, actual, err := hashFile(l.Object(hash))
	if err != nil || actual != hash {
		return false, errPlaybackIntegrity
	}
	actualSize, actual, err := hashFile(l.Object(digest))
	if err != nil || actualSize != size || actual != digest {
		return false, errPlaybackIntegrity
	}
	if _, err = l.DB.Exec("UPDATE asset_storage SET state='ready' WHERE asset_id=? AND state='publishing'", hash); err != nil {
		return false, err
	}
	if err = l.cleanupNormalizedVideoLocked(hash); err != nil {
		slog.Warn("resumed normalized source cleanup pending", "asset", hash, "error", err)
	}
	return true, nil
}

func (l *Library) cleanupNormalizedVideo(hash string) error {
	unlock := l.lock(hash)
	defer unlock()
	l.storageMu.Lock()
	defer l.storageMu.Unlock()
	return l.cleanupNormalizedVideoLocked(hash)
}

func (l *Library) cleanupNormalizedVideoLocked(hash string) error {
	var digest string
	var pending bool
	var size int64
	err := l.DB.QueryRow("SELECT hash,size,cleanup_pending FROM asset_storage WHERE asset_id=? AND state='ready'", hash).Scan(&digest, &size, &pending)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !pending {
		return nil
	}
	if err != nil {
		return err
	}
	actualSize, actualHash, err := hashFile(l.Object(digest))
	if err != nil || actualSize != size || actualHash != digest {
		return fmt.Errorf("canonical video integrity mismatch; source retained")
	}
	if digest != hash {
		if _, err = os.Lstat(l.Object(hash)); err == nil {
			_, actual, e := hashFile(l.Object(hash))
			if e != nil || actual != hash {
				return fmt.Errorf("obsolete source integrity mismatch; file retained")
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err = l.removeUnreferencedObject(hash, hash); err != nil {
			return err
		}
	}
	for _, ext := range []string{"mp4", "json"} {
		if err = os.Remove(l.nativeRemuxPath(hash, ext)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if _, err = os.Stat(filepath.Dir(l.nativeRemuxPath(hash, "json"))); err == nil {
		if err = syncDir(filepath.Dir(l.nativeRemuxPath(hash, "json"))); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE asset_storage SET cleanup_pending=0 WHERE asset_id=? AND hash=? AND state='ready'", hash, digest); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM catalog_settings WHERE key=?", nativeRemuxIntentPrefix+hash); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Library) nextNormalizedCleanup() bool {
	var hash string
	if err := l.DB.QueryRow("SELECT asset_id FROM asset_storage s JOIN assets a ON a.id=s.asset_id WHERE s.state='ready' AND s.cleanup_pending=1 AND a.purge_pending=0 LIMIT 1").Scan(&hash); err != nil {
		return false
	}
	if err := l.cleanupNormalizedVideo(hash); err != nil {
		slog.Warn("normalized source cleanup", "asset", hash, "error", err)
		return false
	}
	return true
}
