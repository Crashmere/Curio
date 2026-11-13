package library

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, err any) {
	writeJSON(w, status, map[string]any{"error": fmt.Sprint(err)})
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(value); err != nil {
		fail(w, 400, "请求格式不正确")
		return false
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		fail(w, 400, "请求格式不正确")
		return false
	}
	return true
}

func (l *Library) Handler(frontend fs.FS) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.GetHead)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Referrer-Policy", "same-origin")
			if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
				if origin := r.Header.Get("Origin"); origin != "" {
					u, err := url.Parse(origin)
					if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
						fail(w, 403, "请求来源不匹配")
						return
					}
				}
				if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
					fail(w, 403, "不接受跨站写入")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := l.DB.PingContext(ctx); err != nil {
			fail(w, 503, "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok", "service": "Curio"})
	})
	r.Get("/api/info", l.info)
	r.Get("/api/games", l.listGames)
	r.Post("/api/games", l.saveGame)
	r.Patch("/api/games/{id}", l.saveGame)
	r.Delete("/api/games/{id}", l.deleteGame)
	r.Get("/api/playback/{id}", l.playbackInfo)
	r.Get("/api/assets", l.listAssets)
	r.Patch("/api/assets", l.batchUpdate)
	r.Post("/api/assets/purge", l.purgeAssets)
	r.Post("/api/assets/retry", l.retryAssets)
	r.Get("/api/assets/{id}", l.assetDetail)
	r.Patch("/api/assets/{id}", l.updateAsset)
	r.Get("/api/collections/{id}/groups", l.listGroups)
	r.Post("/api/collections/{id}/groups", l.createGroup)
	r.Patch("/api/collections/{id}/groups", l.updateGroup)
	r.Patch("/api/collections/{id}/groups/{group}", l.updateGroup)
	r.Delete("/api/collections/{id}/groups/{group}", l.deleteGroup)
	r.Get("/api/assets/{id}/download", l.downloadAsset)
	for _, kind := range []string{"tags", "collections"} {
		kind := kind
		r.Get("/api/"+kind, func(w http.ResponseWriter, r *http.Request) { l.listContainers(w, r, kind) })
		r.Post("/api/"+kind, func(w http.ResponseWriter, r *http.Request) { l.createContainer(w, r, kind) })
		r.Patch("/api/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) { l.updateContainer(w, r, kind) })
		r.Delete("/api/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) { l.deleteContainer(w, r, kind) })
	}
	r.Get("/api/jobs", l.jobs)
	r.Get("/api/uploads", l.listUploads)
	r.Post("/api/uploads", l.prepareUpload)
	r.Get("/api/uploads/{id}", l.uploadStatus)
	r.Put("/api/uploads/{id}", l.uploadChunk)
	r.Delete("/api/uploads/{id}", l.discardUpload)
	r.Post("/api/uploads/{id}/complete", l.completeUpload)
	r.Get("/api/download", l.downloadZip)
	r.Post("/api/download", l.downloadZip)
	r.Get("/media/{id}/stream/index.m3u8", l.streamPlaylist)
	r.Head("/media/{id}/stream/index.m3u8", l.streamPlaylist)
	r.Get("/media/{id}/stream/{segment}.ts", l.streamSegment)
	r.Head("/media/{id}/stream/{segment}.ts", l.streamSegment)
	r.Get("/media/{id}/{kind}", l.media)
	static := http.FileServer(http.FS(frontend))
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if strings.HasPrefix(name, "api/") || strings.HasPrefix(name, "media/") || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(frontend, name); err != nil {
			if filepath.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}
		if name == "index.html" {
			b, err := fs.ReadFile(frontend, name)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(b)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
			if ext := filepath.Ext(name); ext == ".js" || ext == ".css" {
				w.Header().Add("Vary", "Accept-Encoding")
				if acceptsGzip(r.Header.Get("Accept-Encoding")) {
					if compressed, err := fs.ReadFile(frontend, name+".gz"); err == nil {
						w.Header().Set("Content-Encoding", "gzip")
						w.Header().Set("Content-Type", mime.TypeByExtension(ext))
						if r.Header.Get("Range") == "" {
							w.Header().Set("Content-Length", strconv.Itoa(len(compressed)))
						}
						http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(compressed))
						return
					}
				}
			}
		}
		static.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, rq *http.Request) {
		if strings.HasPrefix(rq.URL.Path, "/curio/") {
			q := rq.Clone(rq.Context())
			u := *rq.URL
			u.Path = strings.TrimPrefix(u.Path, "/curio")
			q.URL = &u
			r.ServeHTTP(w, q)
			return
		}
		if rq.URL.Path == "/curio" {
			http.Redirect(w, rq, "/curio/", http.StatusPermanentRedirect)
			return
		}
		r.ServeHTTP(w, rq)
	})
}

func acceptsGzip(header string) bool {
	explicit, gzipQuality, wildcardQuality := false, 0.0, 0.0
	for _, entry := range strings.Split(header, ",") {
		parts := strings.Split(entry, ";")
		coding := strings.ToLower(strings.TrimSpace(parts[0]))
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, value, found := strings.Cut(parameter, "=")
			if found && strings.EqualFold(strings.TrimSpace(key), "q") {
				parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if err != nil || parsed < 0 || parsed > 1 {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		switch coding {
		case "gzip":
			explicit = true
			gzipQuality = max(gzipQuality, quality)
		case "*":
			wildcardQuality = max(wildcardQuality, quality)
		}
	}
	if explicit {
		return gzipQuality > 0
	}
	return wildcardQuality > 0
}

func (l *Library) info(w http.ResponseWriter, r *http.Request) {
	scope := requestScope(r.URL.Query())
	base := " FROM assets a WHERE a.purge_pending=0 AND " + scopeSQL(scope)
	out := map[string]any{"name": "Curio", "version": Version, "chunkSize": ChunkSize, "workers": l.Workers, "gpuSlots": cap(l.GPU), "cpuOperations": cap(l.CPU), "scope": scope}
	for key, condition := range map[string]string{"total": "a.trashed_at='' AND NOT " + screenshotSQL, "screenshots": "a.trashed_at='' AND " + screenshotSQL, "starred": "a.trashed_at='' AND a.starred=1", "unorganized": "a.trashed_at='' AND NOT " + organizedSQL, "trash": "a.trashed_at!=''", "queued": "a.status IN ('queued','processing')", "errors": "a.status='error'"} {
		var n int64
		if err := l.DB.QueryRow("SELECT count(*)" + base + " AND " + condition).Scan(&n); err != nil {
			fail(w, 500, err)
			return
		}
		out[key] = n
	}
	var size int64
	if err := l.DB.QueryRow("SELECT COALESCE(sum(a.size),0)" + base).Scan(&size); err != nil {
		fail(w, 500, err)
		return
	}
	out["bytes"] = size
	writeJSON(w, 200, out)
}

func assetFilter(q url.Values) (string, []any, error) {
	where := " WHERE a.purge_pending=0 AND " + scopeSQL(requestScope(q))
	args := []any{}
	if q.Get("trash") == "1" {
		where += " AND a.trashed_at!=''"
	} else {
		where += " AND a.trashed_at=''"
	}
	if q.Get("starred") == "1" {
		where += " AND a.starred=1"
	}
	if q.Get("unorganized") == "1" {
		where += " AND NOT " + organizedSQL
	}
	if q.Get("screenshot") == "1" {
		where += " AND " + screenshotSQL
	} else if q.Get("screenshot") == "0" {
		where += " AND NOT " + screenshotSQL
	}
	if value := q.Get("game"); value != "" {
		if value == "unassigned" {
			where += " AND EXISTS(SELECT 1 FROM screenshots s WHERE s.asset_id=a.id AND s.enabled=1 AND s.game_id IS NULL)"
		} else {
			if !validID.MatchString(value) {
				return "", nil, fmt.Errorf("游戏编号无效")
			}
			where += " AND EXISTS(SELECT 1 FROM screenshots s WHERE s.asset_id=a.id AND s.enabled=1 AND s.game_id=?)"
			args = append(args, value)
		}
	}
	if value := q.Get("q"); value != "" {
		if len(value) > 512 {
			return "", nil, fmt.Errorf("搜索内容太长")
		}
		where += ` AND (instr(lower(a.name),lower(?))>0 OR instr(lower(a.title),lower(?))>0 OR instr(lower(a.notes),lower(?))>0 OR instr(lower(a.source_url),lower(?))>0 OR instr(lower(a.author),lower(?))>0 OR EXISTS(SELECT 1 FROM asset_tags j JOIN tags t ON t.id=j.tag_id WHERE j.asset_id=a.id AND instr(lower(t.name),lower(?))>0) OR EXISTS(SELECT 1 FROM asset_collections j JOIN collections c ON c.id=j.collection_id WHERE j.asset_id=a.id AND instr(lower(c.name),lower(?))>0) OR EXISTS(SELECT 1 FROM screenshots s JOIN games g ON g.id=s.game_id WHERE s.asset_id=a.id AND s.enabled=1 AND (instr(lower(g.name),lower(?))>0 OR instr(g.steam_app_id,?)>0)))`
		for i := 0; i < 9; i++ {
			args = append(args, value)
		}
	}
	if value := q.Get("kind"); value != "" {
		if value != "image" && value != "animation" && value != "video" {
			return "", nil, fmt.Errorf("媒体类型无效")
		}
		where += " AND a.kind=?"
		args = append(args, value)
	}
	if value := q.Get("format"); value != "" {
		where += " AND a.format=?"
		args = append(args, strings.ToLower(strings.TrimPrefix(value, ".")))
	}
	for _, entry := range []struct{ param, table, col string }{{"tag", "asset_tags", "tag_id"}, {"collection", "asset_collections", "collection_id"}} {
		if value := q.Get(entry.param); value != "" {
			if !validID.MatchString(value) {
				return "", nil, fmt.Errorf("分类编号无效")
			}
			where += " AND EXISTS(SELECT 1 FROM " + entry.table + " j WHERE j.asset_id=a.id AND j." + entry.col + "=?)"
			args = append(args, value)
		}
	}
	if value := q.Get("group"); value != "" {
		if !validID.MatchString(value) {
			return "", nil, fmt.Errorf("分组编号无效")
		}
		where += " AND EXISTS(SELECT 1 FROM collection_group_assets g WHERE g.asset_id=a.id AND g.group_id=?)"
		args = append(args, value)
	}
	for _, entry := range []struct{ param, column, operator string }{{"minWidth", "width", ">="}, {"maxWidth", "width", "<="}, {"minHeight", "height", ">="}, {"maxHeight", "height", "<="}, {"minDuration", "duration", ">="}, {"maxDuration", "duration", "<="}, {"minSize", "size", ">="}, {"maxSize", "size", "<="}} {
		if raw := q.Get(entry.param); raw != "" {
			value, err := strconv.ParseFloat(raw, 64)
			if err != nil || value < 0 || value > 1e15 {
				return "", nil, fmt.Errorf("筛选数值无效")
			}
			where += " AND a." + entry.column + entry.operator + "?"
			args = append(args, value)
		}
	}
	switch q.Get("aspect") {
	case "":
	case "square":
		where += " AND a.width>0 AND a.width=a.height"
	case "landscape":
		where += " AND a.width>a.height AND a.height>0"
	case "portrait":
		where += " AND a.height>a.width AND a.width>0"
	default:
		return "", nil, fmt.Errorf("横竖比例无效")
	}
	return where, args, nil
}

func pageNumber(q url.Values, key string, defaultValue, minValue, maxValue int) int {
	value, err := strconv.Atoi(q.Get(key))
	if err != nil {
		return defaultValue
	}
	return max(minValue, min(maxValue, value))
}

func assetOrder(q url.Values) (string, error) {
	switch q.Get("sort") {
	case "capturedNewest", "capturedOldest":
		direction := "DESC"
		if q.Get("sort") == "capturedOldest" {
			direction = "ASC"
		}
		return "CASE WHEN COALESCE(" + screenshotTimeSQL + ",'')='' THEN 1 ELSE 0 END," + screenshotTimeSQL + " " + direction + ",a.id " + direction, nil
	case "oldest":
		return "a.created_at ASC,a.id ASC", nil
	case "name":
		return "COALESCE(NULLIF(a.title,''),a.name) COLLATE NOCASE,a.id", nil
	case "size":
		return "a.size DESC,a.id DESC", nil
	case "newest", "":
		return "a.created_at DESC,a.id DESC", nil
	default:
		return "", fmt.Errorf("排序方式无效")
	}
}

func (l *Library) listAssets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where, args, err := assetFilter(q)
	if err != nil {
		fail(w, 400, err)
		return
	}
	maximum := 240
	if raw := q.Get("ids"); raw != "" {
		ids := strings.Split(raw, ",")
		if err = parseIDs(ids); err != nil {
			fail(w, 400, err)
			return
		}
		where += " AND a.id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, value := range ids {
			args = append(args, value)
		}
		maximum = 2000
	}
	var total int64
	if err = l.DB.QueryRow("SELECT count(*) FROM assets a"+where, args...).Scan(&total); err != nil {
		fail(w, 500, err)
		return
	}
	order, err := assetOrder(q)
	if err != nil {
		fail(w, 400, err)
		return
	}
	entryTotal := total
	if q.Get("grouped") == "1" && q.Get("collection") != "" && q.Get("group") == "" && q.Get("ids") == "" {
		// Page by gallery entries, not by the hidden cards inside collapsed groups.
		filterWhere := where
		filterArgs := append([]any{}, args...)
		where += ` AND (NOT EXISTS(SELECT 1 FROM collection_group_assets g WHERE g.asset_id=a.id AND g.collection_id=?)
 OR a.id IN (SELECT id FROM (SELECT a.id,ROW_NUMBER() OVER(PARTITION BY g.group_id ORDER BY ` + order + `) AS group_rank
 FROM assets a JOIN collection_group_assets g ON g.asset_id=a.id AND g.collection_id=?` + filterWhere + `) WHERE group_rank=1))`
		args = append(args, q.Get("collection"), q.Get("collection"))
		args = append(args, filterArgs...)
		if err = l.DB.QueryRow("SELECT count(*) FROM assets a"+where, args...).Scan(&entryTotal); err != nil {
			fail(w, 500, err)
			return
		}
	}
	limit := pageNumber(q, "limit", 120, 1, maximum)
	offset := pageNumber(q, "offset", 0, 0, 100000000)
	rows, err := l.DB.Query("SELECT "+assetColumns+" FROM assets a"+where+" ORDER BY "+order+" LIMIT ? OFFSET ?", append(args, limit, offset)...)
	if err != nil {
		fail(w, 500, err)
		return
	}
	items := []Asset{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			rows.Close()
			fail(w, 500, e)
			return
		}
		items = append(items, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		fail(w, 500, err)
		return
	}
	if err = l.hydrate(items); err != nil {
		fail(w, 500, err)
		return
	}
	var next any = nil
	if int64(offset+len(items)) < entryTotal {
		next = offset + len(items)
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "nextOffset": next})
}

func (l *Library) assetDetail(w http.ResponseWriter, r *http.Request) {
	a, err := scanAsset(l.DB.QueryRow("SELECT "+assetColumns+" FROM assets a WHERE a.id=? AND a.purge_pending=0 AND "+scopeSQL(requestScope(r.URL.Query())), chi.URLParam(r, "id")))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "未找到媒体")
		return
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	items := []Asset{a}
	if err = l.hydrate(items); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, items[0])
}

func (l *Library) media(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	a, err := l.asset(hash)
	if err != nil || a.purgePending {
		http.NotFound(w, r)
		return
	}
	kind := chi.URLParam(r, "kind")
	if kind == "preview" && a.Kind == "video" {
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, "/curio/media/"+hash+"/stream/index.m3u8", http.StatusTemporaryRedirect)
		return
	}
	path := ""
	contentType := ""
	switch kind {
	case "source":
		w.Header().Set("Cache-Control", "no-store")
		_, spec, err := l.playbackRequest(r)
		if err != nil {
			playbackFailure(w, err)
			return
		}
		path, contentType = l.Object(hash), spec.sourceMime
		if contentType == "" {
			contentType = a.MIME
		}
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": a.Name}))
	case "original":
		path = l.Object(hash)
		contentType = a.MIME
		if a.Format == "svg" {
			w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": a.Name}))
			contentType = "application/octet-stream"
		}
	case "thumbnail":
		if a.thumbnailExt != "" {
			path = l.Derived(hash, kind, a.thumbnailExt)
			contentType = mime.TypeByExtension("." + a.thumbnailExt)
		}
	case "preview":
		if a.previewExt != "" {
			path = l.Derived(hash, kind, a.previewExt)
			contentType = mime.TypeByExtension("." + a.previewExt)
		}
	default:
		http.NotFound(w, r)
		return
	}
	if path == "" {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if kind == "source" {
		if err := l.playbackAllowed(hash); err != nil {
			playbackFailure(w, err)
			return
		}
		if stat.Size() != a.Size {
			playbackFailure(w, errPlaybackIntegrity)
			return
		}
		w.Header().Set("ETag", `"`+hash+`"`)
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "private,max-age=3600")
	http.ServeContent(w, r, a.Name, stat.ModTime(), file)
}

func (l *Library) downloadAsset(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	a, err := l.asset(hash)
	if err != nil || a.purgePending {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": a.Name}))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, l.Object(hash))
}

func parseIDs(raw []string) error {
	if len(raw) == 0 || len(raw) > 2000 {
		return fmt.Errorf("每次请选择 1-2000 个媒体")
	}
	for _, hash := range raw {
		if !validHash.MatchString(hash) {
			return fmt.Errorf("媒体编号无效")
		}
	}
	return nil
}

func (l *Library) downloadZip(w http.ResponseWriter, r *http.Request) {
	ids := strings.Split(r.URL.Query().Get("ids"), ",")
	if r.Method == http.MethodPost {
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			fail(w, http.StatusUnsupportedMediaType, "请选择 JSON 或表单格式提交下载请求")
			return
		}
		switch contentType {
		case "application/json":
			var p struct {
				IDs []string `json:"ids"`
			}
			if !decode(w, r, &p) {
				return
			}
			ids = p.IDs
		case "application/x-www-form-urlencoded":
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			if err := r.ParseForm(); err != nil {
				fail(w, http.StatusBadRequest, "下载表单格式不正确或超过大小限制")
				return
			}
			ids = strings.Split(r.PostForm.Get("ids"), ",")
		default:
			fail(w, http.StatusUnsupportedMediaType, "请选择 JSON 或表单格式提交下载请求")
			return
		}
	}
	if err := parseIDs(ids); err != nil {
		fail(w, 400, err)
		return
	}
	items := make([]Asset, 0, len(ids))
	for _, hash := range ids {
		a, err := l.asset(hash)
		if err != nil || a.purgePending {
			fail(w, 404, "部分媒体已不存在")
			return
		}
		if _, err = os.Stat(l.Object(hash)); err != nil {
			fail(w, 409, "部分原件不可用")
			return
		}
		items = append(items, a)
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="Curio.zip"`)
	z := zip.NewWriter(w)
	defer z.Close()
	usedNames := map[string]bool{}
	for _, a := range items {
		if r.Context().Err() != nil {
			return
		}
		name := a.Name
		ext := filepath.Ext(a.Name)
		base := strings.TrimSuffix(a.Name, ext)
		for suffix := 2; usedNames[strings.ToLower(name)]; suffix++ {
			name = base + fmt.Sprintf(" (%d)", suffix) + ext
		}
		usedNames[strings.ToLower(name)] = true
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		if t, err := time.Parse(time.RFC3339Nano, a.CreatedAt); err == nil {
			header.SetModTime(t)
		}
		out, err := z.CreateHeader(header)
		if err != nil {
			return
		}
		file, err := os.Open(l.Object(a.ID))
		if err != nil {
			return
		}
		_, err = io.Copy(out, file)
		file.Close()
		if err != nil {
			return
		}
	}
}
