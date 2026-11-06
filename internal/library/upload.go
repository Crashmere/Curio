package library

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type UploadHints struct {
	Hash          string   `json:"hash"`
	Name          string   `json:"name"`
	Size          int64    `json:"size"`
	MIME          string   `json:"mime"`
	Scope         string   `json:"scope"`
	TagIDs        []string `json:"tagIds,omitempty"`
	CollectionIDs []string `json:"collectionIds,omitempty"`
}

var allowedFormats = map[string]string{
	"jpg": "image", "jpeg": "image", "png": "image", "webp": "image", "avif": "image", "svg": "image", "ico": "image", "gif": "animation", "apng": "animation", "bmp": "image", "tif": "image", "tiff": "image", "heic": "image", "heif": "image",
	"mp4": "video", "webm": "video", "mov": "video", "m4v": "video", "mkv": "video", "avi": "video", "mpeg": "video", "mpg": "video", "3gp": "video", "mts": "video", "m2ts": "video",
}

func (h *UploadHints) validate() error {
	h.Name = filepath.Base(strings.ReplaceAll(h.Name, "\\", "/"))
	format := strings.ToLower(strings.TrimPrefix(filepath.Ext(h.Name), "."))
	if !validHash.MatchString(h.Hash) || h.Size <= 0 || h.Size > 1<<40 || len(h.Name) > 512 || h.Name == "." || h.Name == "" || allowedFormats[format] == "" {
		return fmt.Errorf("文件参数无效或格式不支持")
	}
	if h.Scope != "hidden" {
		h.Scope = "normal"
	}
	if err := validateContainers(h.TagIDs); err != nil {
		return err
	}
	return validateContainers(h.CollectionIDs)
}

func hashFile(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return n, hex.EncodeToString(h.Sum(nil)), err
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (l *Library) originalPresent(a Asset) (bool, error) {
	stat, err := os.Lstat(l.Object(a.ID))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !stat.Mode().IsRegular() || stat.Size() != a.Size {
		return false, fmt.Errorf("原件完整性异常，未覆盖现有文件")
	}
	return true, nil
}

func (l *Library) uploadState(hash string) (UploadHints, string, int64, string, error) {
	var h UploadHints
	var raw, state, created string
	var offset int64
	err := l.DB.QueryRow("SELECT hints,state,offset,created_at FROM uploads WHERE id=?", hash).Scan(&raw, &state, &offset, &created)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &h)
	}
	return h, state, offset, created, err
}

// The database offset records only fsynced bytes. An interrupted request may
// leave an unacknowledged tail, which is truncated before the next request.
func (l *Library) reconcileOffset(hash string, offset int64) error {
	f, err := os.OpenFile(l.Incoming(hash), os.O_RDWR, 0600)
	if os.IsNotExist(err) {
		if offset == 0 {
			return nil
		}
		stat, e := os.Lstat(l.Object(hash))
		if e == nil && stat.Mode().IsRegular() && stat.Size() == offset {
			return nil
		}
		return fmt.Errorf("已确认上传分片缺失，请检查数据后重试")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	if !stat.Mode().IsRegular() || stat.Size() < offset {
		return fmt.Errorf("上传分片完整性异常")
	}
	if stat.Size() > offset {
		if err = f.Truncate(offset); err != nil {
			return err
		}
		return f.Sync()
	}
	return nil
}

func uploadResult(h UploadHints, offset int64, complete bool) map[string]any {
	out := map[string]any{"id": h.Hash, "offset": offset, "size": h.Size, "complete": complete, "chunkSize": ChunkSize}
	if complete {
		out["assetId"] = h.Hash
	}
	return out
}

func (l *Library) rememberExisting(a Asset, h UploadHints) error {
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT OR IGNORE INTO sources(id,asset_id,name,created_at) VALUES(?,?,?,?)", id(), a.ID, h.Name, now()); err != nil {
		return err
	}
	if err = changeMemberships(tx, a.ID, "tags", nil, h.TagIDs, nil); err != nil {
		return err
	}
	if err = changeMemberships(tx, a.ID, "collections", nil, h.CollectionIDs, nil); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Library) prepareUpload(w http.ResponseWriter, r *http.Request) {
	var h UploadHints
	if !decode(w, r, &h) {
		return
	}
	if h.Scope == "" {
		h.Scope = requestScope(r.URL.Query())
	}
	if err := h.validate(); err != nil {
		fail(w, 400, err)
		return
	}
	unlock := l.lock(h.Hash)
	defer unlock()
	a, assetErr := l.asset(h.Hash)
	if assetErr == nil {
		if a.purgePending {
			fail(w, 409, "该媒体正在永久删除")
			return
		}
		if a.Size != h.Size {
			fail(w, 409, "文件长度与已有原件不一致")
			return
		}
		present, err := l.originalPresent(a)
		if err != nil {
			fail(w, 409, err)
			return
		}
		if present {
			if err = l.rememberExisting(a, h); err != nil {
				fail(w, 400, err)
				return
			}
			result := uploadResult(h, h.Size, true)
			result["duplicate"] = true
			result["trashed"] = a.TrashedAt != ""
			result["existingHidden"] = a.Hidden
			writeJSON(w, 200, result)
			return
		}
	} else if !errors.Is(assetErr, sql.ErrNoRows) {
		fail(w, 500, assetErr)
		return
	}
	old, _, offset, _, err := l.uploadState(h.Hash)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = l.DB.Exec("INSERT INTO uploads(id,hints,created_at) VALUES(?,?,?)", h.Hash, marshal(h), now())
		offset = 0
	} else if err == nil {
		if old.Size != h.Size {
			fail(w, 409, "上传长度冲突")
			return
		}
		_, err = l.DB.Exec("UPDATE uploads SET hints=?,state='uploading' WHERE id=?", marshal(h), h.Hash)
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	if err = l.reconcileOffset(h.Hash, offset); err != nil {
		fail(w, 409, err)
		return
	}
	writeJSON(w, 200, uploadResult(h, offset, false))
}

func (l *Library) uploadStatus(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		fail(w, 404, "上传不存在")
		return
	}
	unlock := l.lock(hash)
	defer unlock()
	if a, err := l.asset(hash); err == nil {
		if a.purgePending {
			fail(w, 409, "该媒体正在永久删除")
			return
		}
		present, err := l.originalPresent(a)
		if err != nil {
			fail(w, 409, err)
			return
		}
		if present {
			writeJSON(w, 200, uploadResult(UploadHints{Hash: hash, Size: a.Size}, a.Size, true))
			return
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, err)
		return
	}
	h, state, offset, _, err := l.uploadState(hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "上传不存在")
		} else {
			fail(w, 500, err)
		}
		return
	}
	if state == "complete" {
		fail(w, 409, "已提交原件缺失，请重新选择原文件进行修复")
		return
	}
	if err = l.reconcileOffset(hash, offset); err != nil {
		fail(w, 409, err)
		return
	}
	writeJSON(w, 200, uploadResult(h, offset, false))
}

func (l *Library) uploadChunk(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		fail(w, 404, "上传不存在")
		return
	}
	raw := r.Header.Get("Upload-Offset")
	if raw == "" {
		raw = r.URL.Query().Get("offset")
	}
	offset, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || offset < 0 {
		fail(w, 400, "缺少有效 Upload-Offset")
		return
	}
	unlock := l.lock(hash)
	defer unlock()
	h, state, accepted, _, err := l.uploadState(hash)
	if err != nil || state != "uploading" {
		fail(w, 409, "上传不存在或已完成")
		return
	}
	if a, e := l.asset(hash); e == nil && a.purgePending {
		fail(w, 409, "该媒体正在永久删除")
		return
	}
	if offset != accepted {
		w.Header().Set("Upload-Offset", strconv.FormatInt(accepted, 10))
		writeJSON(w, 409, map[string]any{"error": "请从服务器已确认的位置继续", "offset": accepted})
		return
	}
	if err = l.reconcileOffset(hash, accepted); err != nil {
		fail(w, 409, err)
		return
	}
	maximum := min(ChunkSize, h.Size-offset)
	if maximum <= 0 {
		fail(w, 409, "文件已收齐，请完成上传")
		return
	}
	if r.ContentLength > maximum {
		fail(w, 413, "分片超过单段上限或文件剩余长度")
		return
	}
	f, err := os.OpenFile(l.Incoming(hash), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer f.Close()
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		fail(w, 500, err)
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(600 * time.Second))
	defer controller.SetReadDeadline(time.Time{})
	n, err := io.Copy(f, http.MaxBytesReader(w, r.Body, maximum))
	if err != nil || n == 0 {
		_ = f.Truncate(offset)
		_ = f.Sync()
		fail(w, 400, "分片接收未完成，请重试")
		return
	}
	if err = f.Sync(); err == nil {
		err = syncDir(filepath.Join(l.Root, "incoming"))
	}
	if err != nil {
		_ = f.Truncate(offset)
		_ = f.Sync()
		fail(w, 500, err)
		return
	}
	if _, err = l.DB.Exec("UPDATE uploads SET offset=? WHERE id=? AND state='uploading'", offset+n, hash); err != nil {
		_ = f.Truncate(offset)
		_ = f.Sync()
		fail(w, 500, err)
		return
	}
	w.Header().Set("Upload-Offset", strconv.FormatInt(offset+n, 10))
	writeJSON(w, 200, map[string]any{"offset": offset + n})
}

func (l *Library) publish(path, hash string, size int64) error {
	output := l.Object(hash)
	if path == output {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return err
	}
	if err := syncDir(filepath.Join(l.Root, "assets")); err != nil {
		return err
	}
	if err := os.Link(path, output); err != nil {
		if !os.IsExist(err) {
			return err
		}
		stat, e := os.Lstat(output)
		if e != nil || !stat.Mode().IsRegular() || stat.Size() != size {
			return fmt.Errorf("原件完整性异常，未覆盖现有文件")
		}
		_, actual, e := hashFile(output)
		if e != nil || actual != hash {
			return fmt.Errorf("原件完整性异常，未覆盖现有文件")
		}
	}
	if err := syncDir(filepath.Dir(output)); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func (l *Library) completeUpload(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		fail(w, 404, "上传不存在")
		return
	}
	unlock := l.lock(hash)
	defer unlock()
	existing, assetErr := l.asset(hash)
	repair := assetErr == nil
	if repair {
		if existing.purgePending {
			fail(w, 409, "该媒体正在永久删除")
			return
		}
		present, err := l.originalPresent(existing)
		if err != nil {
			fail(w, 409, err)
			return
		}
		if present {
			out := uploadResult(UploadHints{Hash: hash, Size: existing.Size}, existing.Size, true)
			out["duplicate"] = true
			writeJSON(w, 200, out)
			return
		}
	} else if !errors.Is(assetErr, sql.ErrNoRows) {
		fail(w, 500, assetErr)
		return
	}
	h, state, offset, _, err := l.uploadState(hash)
	if err != nil {
		fail(w, 404, "上传不存在")
		return
	}
	if state != "uploading" || offset != h.Size {
		fail(w, 409, "文件尚未传完")
		return
	}
	path := l.Incoming(hash)
	if _, e := os.Stat(path); os.IsNotExist(e) {
		path = l.Object(hash)
	}
	size, actual, err := hashFile(path)
	if err != nil || size != h.Size {
		fail(w, 409, "文件尚未完整或原件不可读")
		return
	}
	if actual != hash {
		if path != l.Object(hash) {
			if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
				fail(w, 500, e)
				return
			}
			if _, e := l.DB.Exec("UPDATE uploads SET offset=0 WHERE id=?", hash); e != nil {
				fail(w, 500, e)
				return
			}
			_ = syncDir(filepath.Dir(path))
		}
		fail(w, 422, "完整文件 SHA-256 校验失败，请重新上传")
		return
	}
	if err = l.publish(path, hash, h.Size); err != nil {
		fail(w, 409, err)
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	if repair {
		_, err = tx.Exec("UPDATE assets SET status='queued',stage='queued',error='',updated_at=? WHERE id=? AND purge_pending=0", now(), hash)
	} else {
		format := strings.ToLower(strings.TrimPrefix(filepath.Ext(h.Name), "."))
		contentType := mime.TypeByExtension("." + format)
		if contentType == "" {
			contentType = h.MIME
		}
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		contentType = strings.Split(contentType, ";")[0]
		created := now()
		_, err = tx.Exec("INSERT INTO assets(id,name,size,format,mime,kind,hidden,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", hash, h.Name, h.Size, format, contentType, allowedFormats[format], h.Scope == "hidden", created, created)
	}
	if err == nil {
		_, err = tx.Exec("INSERT OR IGNORE INTO sources(id,asset_id,name,created_at) VALUES(?,?,?,?)", id(), hash, h.Name, now())
	}
	if err == nil {
		err = changeMemberships(tx, hash, "tags", nil, h.TagIDs, nil)
	}
	if err == nil {
		err = changeMemberships(tx, hash, "collections", nil, h.CollectionIDs, nil)
	}
	if err == nil {
		_, err = tx.Exec("UPDATE uploads SET state='complete' WHERE id=?", hash)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 400, err)
		return
	}
	l.Notify()
	writeJSON(w, 200, uploadResult(h, h.Size, true))
}

func (l *Library) listUploads(w http.ResponseWriter, r *http.Request) {
	scope := requestScope(r.URL.Query())
	hidden := `(json_extract(hints,'$.scope')='hidden' OR EXISTS(SELECT 1 FROM json_each(uploads.hints,'$.tagIds') j JOIN tags t ON t.id=j.value WHERE t.hidden=1) OR EXISTS(SELECT 1 FROM json_each(uploads.hints,'$.collectionIds') j JOIN collections c ON c.id=j.value WHERE c.hidden=1))`
	if scope == "normal" {
		hidden = "NOT " + hidden
	}
	rows, err := l.DB.Query("SELECT id,hints,offset,created_at FROM uploads WHERE state='uploading' AND " + hidden + " ORDER BY created_at DESC LIMIT 120")
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var hash, raw, created string
		var offset int64
		if err = rows.Scan(&hash, &raw, &offset, &created); err != nil {
			fail(w, 500, err)
			return
		}
		var h UploadHints
		if err = json.Unmarshal([]byte(raw), &h); err != nil {
			fail(w, 500, err)
			return
		}
		items = append(items, map[string]any{"id": hash, "name": h.Name, "size": h.Size, "offset": offset, "scope": h.Scope, "createdAt": created, "state": "uploading"})
	}
	if err = rows.Err(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
