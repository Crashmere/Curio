package library

import (
	"archive/zip"
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
	r.Get("/api/assets", l.listAssets)
	r.Patch("/api/assets", l.batchUpdate)
	r.Post("/api/assets/purge", l.purgeAssets)
	r.Post("/api/assets/retry", l.retryAssets)
	r.Get("/api/assets/{id}", l.assetDetail)
	r.Patch("/api/assets/{id}", l.updateAsset)
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
	r.Post("/api/uploads/{id}/complete", l.completeUpload)
	r.Get("/api/download", l.downloadZip)
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

func (l *Library) info(w http.ResponseWriter, r *http.Request) {
	scope := requestScope(r.URL.Query())
	base := " FROM assets a WHERE a.purge_pending=0 AND " + scopeSQL(scope)
	out := map[string]any{"name": "Curio", "version": Version, "chunkSize": ChunkSize, "workers": l.Workers, "gpuSlots": cap(l.GPU), "scope": scope}
	for key, condition := range map[string]string{"total": "a.trashed_at=''", "starred": "a.trashed_at='' AND a.starred=1", "unorganized": "a.trashed_at='' AND a.organized=0", "trash": "a.trashed_at!=''", "queued": "a.status IN ('queued','processing')", "errors": "a.status='error'"} {
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
		where += " AND a.organized=0"
	}
	if value := q.Get("q"); value != "" {
		if len(value) > 512 {
			return "", nil, fmt.Errorf("搜索内容太长")
		}
		where += ` AND (instr(lower(a.name),lower(?))>0 OR instr(lower(a.title),lower(?))>0 OR instr(lower(a.notes),lower(?))>0 OR instr(lower(a.source_url),lower(?))>0 OR instr(lower(a.author),lower(?))>0 OR EXISTS(SELECT 1 FROM asset_tags j JOIN tags t ON t.id=j.tag_id WHERE j.asset_id=a.id AND instr(lower(t.name),lower(?))>0) OR EXISTS(SELECT 1 FROM asset_collections j JOIN collections c ON c.id=j.collection_id WHERE j.asset_id=a.id AND instr(lower(c.name),lower(?))>0))`
		for i := 0; i < 7; i++ {
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
	order := "a.created_at DESC,a.id DESC"
	switch q.Get("sort") {
	case "oldest":
		order = "a.created_at ASC,a.id ASC"
	case "name":
		order = "COALESCE(NULLIF(a.title,''),a.name) COLLATE NOCASE,a.id"
	case "size":
		order = "a.size DESC,a.id DESC"
	case "newest", "":
	default:
		fail(w, 400, "排序方式无效")
		return
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
	if int64(offset+len(items)) < total {
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
	path := ""
	contentType := ""
	switch kind {
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
