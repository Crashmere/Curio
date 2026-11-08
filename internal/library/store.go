package library

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const ChunkSize int64 = 128 << 20
const Version = "1.0.0"

var validHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var validID = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Library struct {
	DB            *sql.DB
	Root          string
	Wake          chan struct{}
	Workers       int
	GPU           chan struct{}
	CPU           chan struct{}
	backgroundCPU chan struct{}
	playbackMu    sync.Mutex
	playback      *playbackCache
	runtimeCtx    context.Context
	lockMu        sync.Mutex
	locks         map[string]*objectLock
	activeMu      sync.Mutex
	active        map[string]*activeJob
	gpuOnce       sync.Once
	gpuAvailable  bool
	imageMu       sync.Mutex
	imageWorkers  []*imageWorker
}

type objectLock struct {
	mu    sync.Mutex
	users int
}
type activeJob struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type HiddenReason struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Container struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Hidden    bool   `json:"hidden"`
	Count     int64  `json:"count"`
	CoverURL  string `json:"coverUrl,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
}

type Asset struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Title            string         `json:"title"`
	Notes            string         `json:"notes"`
	SourceURL        string         `json:"sourceUrl"`
	Author           string         `json:"author"`
	Kind             string         `json:"kind"`
	Format           string         `json:"format"`
	MIME             string         `json:"mime"`
	Size             int64          `json:"size"`
	Width            int            `json:"width"`
	Height           int            `json:"height"`
	Duration         float64        `json:"duration"`
	HasAlpha         bool           `json:"hasAlpha"`
	Hidden           bool           `json:"hidden"`
	EffectiveHidden  bool           `json:"effectiveHidden"`
	HiddenReasons    []HiddenReason `json:"hiddenReasons"`
	Organized        bool           `json:"organized"`
	Starred          bool           `json:"starred"`
	TrashedAt        string         `json:"trashedAt"`
	CreatedAt        string         `json:"createdAt"`
	UpdatedAt        string         `json:"updatedAt"`
	Status           string         `json:"status"`
	Stage            string         `json:"stage"`
	Error            string         `json:"error"`
	Engine           string         `json:"engine"`
	Progress         float64        `json:"progress"`
	Tags             []Container    `json:"tags"`
	Collections      []Container    `json:"collections"`
	Screenshot       bool           `json:"screenshot"`
	Game             *Game          `json:"game,omitempty"`
	CapturedAt       string         `json:"capturedAt"`
	ScreenshotSource string         `json:"screenshotSource,omitempty"`
	ThumbnailURL     string         `json:"thumbnailUrl"`
	PreviewURL       string         `json:"previewUrl"`
	OriginalURL      string         `json:"originalUrl"`
	DownloadURL      string         `json:"downloadUrl"`
	thumbnailExt     string
	previewExt       string
	purgePending     bool
}

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=10000;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL DEFAULT 'image', format TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
 duration REAL NOT NULL DEFAULT 0, has_alpha INTEGER NOT NULL DEFAULT 0,
 -- Keep the unused organized column for compatibility without rewriting existing catalogs.
 hidden INTEGER NOT NULL DEFAULT 0, organized INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
 trashed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
 engine TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0,
 thumbnail_ext TEXT NOT NULL DEFAULT '', preview_ext TEXT NOT NULL DEFAULT '', purge_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_tags (asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(asset_id,tag_id));
CREATE TABLE IF NOT EXISTS asset_collections (asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, PRIMARY KEY(asset_id,collection_id));
CREATE TABLE IF NOT EXISTS collection_groups (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE, created_at TEXT NOT NULL, UNIQUE(id,collection_id));
CREATE TABLE IF NOT EXISTS collection_group_assets (
 group_id TEXT NOT NULL, collection_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 PRIMARY KEY(collection_id,asset_id),
 FOREIGN KEY(group_id,collection_id) REFERENCES collection_groups(id,collection_id) ON DELETE CASCADE,
 FOREIGN KEY(asset_id,collection_id) REFERENCES asset_collections(asset_id,collection_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS collection_group_assets_group ON collection_group_assets(group_id,asset_id);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, hints TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'uploading', offset INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(asset_id,name));
CREATE TABLE IF NOT EXISTS games (
 id TEXT PRIMARY KEY, steam_app_id TEXT UNIQUE, name TEXT NOT NULL DEFAULT '',
 created_scope TEXT NOT NULL DEFAULT 'normal', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screenshots (
 asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
 game_id TEXT REFERENCES games(id), captured_at TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS screenshots_game_time ON screenshots(game_id,enabled,captured_at,asset_id);
CREATE TABLE IF NOT EXISTS catalog_features (name TEXT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags(tag_id,asset_id);
CREATE INDEX IF NOT EXISTS asset_collections_collection ON asset_collections(collection_id,asset_id);
CREATE INDEX IF NOT EXISTS assets_time ON assets(trashed_at,created_at DESC,id);
CREATE INDEX IF NOT EXISTS assets_jobs ON assets(status,created_at);
CREATE INDEX IF NOT EXISTS assets_purge ON assets(purge_pending);
PRAGMA user_version=1;
`

func Init(root string) (*Library, error) {
	if _, err := os.Lstat(filepath.Join(root, "curio.sqlite")); err == nil || !os.IsNotExist(err) {
		return nil, fmt.Errorf("database already exists or cannot be inspected")
	}
	for _, name := range []string{"", "assets", "derived", "incoming", "work"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			return nil, err
		}
	}
	return open(root)
}

func Open(root string) (*Library, error) {
	if stat, err := os.Lstat(filepath.Join(root, "curio.sqlite")); err != nil || !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("existing database required; initialize explicitly with curio init")
	}
	return open(root)
}

func open(root string) (*Library, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"derived", "incoming", "work"} {
		if err = os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "curio.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err = backfillScreenshots(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Library{DB: db, Root: root, Wake: make(chan struct{}, 1), Workers: 2, GPU: make(chan struct{}, 1), CPU: make(chan struct{}, 2), backgroundCPU: make(chan struct{}, 1), locks: map[string]*objectLock{}, active: map[string]*activeJob{}}, nil
}

func (l *Library) Configure(workers, gpuSlots int) error {
	if workers < 1 || workers > 8 || gpuSlots < 1 || gpuSlots > workers {
		return fmt.Errorf("workers must be 1-8 and gpu-slots must be 1-workers")
	}
	l.Workers, l.GPU = workers, make(chan struct{}, gpuSlots)
	l.CPU = make(chan struct{}, min(4, workers))
	l.backgroundCPU = make(chan struct{}, max(1, cap(l.CPU)-1))
	return nil
}

func (l *Library) Notify() {
	select {
	case l.Wake <- struct{}{}:
	default:
	}
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func id() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func marshal(v any) string                   { b, _ := json.Marshal(v); return string(b) }
func (l *Library) Object(hash string) string { return filepath.Join(l.Root, "assets", hash[:2], hash) }
func (l *Library) Derived(hash, kind, ext string) string {
	return filepath.Join(l.Root, "derived", hash[:2], hash, kind+"."+ext)
}
func (l *Library) Incoming(hash string) string { return filepath.Join(l.Root, "incoming", hash) }

func (l *Library) lock(hash string) func() {
	l.lockMu.Lock()
	entry := l.locks[hash]
	if entry == nil {
		entry = &objectLock{}
		l.locks[hash] = entry
	}
	entry.users++
	l.lockMu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		l.lockMu.Lock()
		entry.users--
		if entry.users == 0 {
			delete(l.locks, hash)
		}
		l.lockMu.Unlock()
	}
}

const effectiveHidden = `(a.hidden=1 OR EXISTS(SELECT 1 FROM asset_tags at JOIN tags t ON t.id=at.tag_id WHERE at.asset_id=a.id AND t.hidden=1) OR EXISTS(SELECT 1 FROM asset_collections ac JOIN collections c ON c.id=ac.collection_id WHERE ac.asset_id=a.id AND c.hidden=1))`

func scopeSQL(scope string) string {
	if scope == "hidden" {
		return effectiveHidden
	}
	return "NOT " + effectiveHidden
}
func requestScope(q url.Values) string {
	if q.Get("scope") == "hidden" {
		return "hidden"
	}
	return "normal"
}

const organizedSQL = `(EXISTS(SELECT 1 FROM asset_tags j WHERE j.asset_id=a.id) OR EXISTS(SELECT 1 FROM asset_collections j WHERE j.asset_id=a.id))`

const assetColumns = `a.id,a.name,a.title,a.notes,a.source_url,a.author,a.kind,a.format,a.mime,a.size,a.width,a.height,a.duration,a.has_alpha,a.hidden,` + organizedSQL + `,a.starred,a.trashed_at,a.created_at,a.updated_at,a.status,a.stage,a.error,a.engine,a.progress,a.thumbnail_ext,a.preview_ext,a.purge_pending`

type scanner interface{ Scan(...any) error }

func scanAsset(row scanner) (Asset, error) {
	var a Asset
	err := row.Scan(&a.ID, &a.Name, &a.Title, &a.Notes, &a.SourceURL, &a.Author, &a.Kind, &a.Format, &a.MIME, &a.Size, &a.Width, &a.Height, &a.Duration, &a.HasAlpha, &a.Hidden, &a.Organized, &a.Starred, &a.TrashedAt, &a.CreatedAt, &a.UpdatedAt, &a.Status, &a.Stage, &a.Error, &a.Engine, &a.Progress, &a.thumbnailExt, &a.previewExt, &a.purgePending)
	a.Tags = []Container{}
	a.Collections = []Container{}
	a.HiddenReasons = []HiddenReason{}
	if a.Hidden {
		a.HiddenReasons = append(a.HiddenReasons, HiddenReason{Kind: "media", ID: a.ID, Name: a.Name})
	}
	if a.thumbnailExt != "" {
		a.ThumbnailURL = "/curio/media/" + a.ID + "/thumbnail"
	}
	if a.previewExt != "" {
		a.PreviewURL = "/curio/media/" + a.ID + "/preview"
	}
	if a.Kind == "video" {
		a.PreviewURL = "/curio/media/" + a.ID + "/preview"
	}
	if a.Kind == "animation" {
		a.PreviewURL = "/curio/media/" + a.ID + "/original"
	}
	a.OriginalURL = "/curio/media/" + a.ID + "/original"
	a.DownloadURL = "/curio/api/assets/" + a.ID + "/download"
	return a, err
}

func (l *Library) asset(hash string) (Asset, error) {
	return scanAsset(l.DB.QueryRow("SELECT "+assetColumns+" FROM assets a WHERE a.id=?", hash))
}

func (l *Library) hydrate(items []Asset) error {
	if len(items) == 0 {
		return nil
	}
	lookup := map[string]int{}
	args := make([]any, 0, len(items))
	placeholders := ""
	for i := range items {
		lookup[items[i].ID] = i
		args = append(args, items[i].ID)
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	for _, rel := range []struct{ table, join, col, kind string }{{"tags", "asset_tags", "tag_id", "tag"}, {"collections", "asset_collections", "collection_id", "collection"}} {
		rows, err := l.DB.Query("SELECT j.asset_id,c.id,c.name,c.hidden FROM "+rel.join+" j JOIN "+rel.table+" c ON c.id=j."+rel.col+" WHERE j.asset_id IN ("+placeholders+") ORDER BY c.name COLLATE NOCASE", args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var assetID string
			var c Container
			if err = rows.Scan(&assetID, &c.ID, &c.Name, &c.Hidden); err != nil {
				rows.Close()
				return err
			}
			a := &items[lookup[assetID]]
			if rel.kind == "tag" {
				a.Tags = append(a.Tags, c)
			} else {
				a.Collections = append(a.Collections, c)
			}
			if c.Hidden {
				a.HiddenReasons = append(a.HiddenReasons, HiddenReason{Kind: rel.kind, ID: c.ID, Name: c.Name})
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	for i := range items {
		items[i].EffectiveHidden = len(items[i].HiddenReasons) > 0
	}
	rows, err := l.DB.Query(`SELECT s.asset_id,s.captured_at,s.source,g.id,COALESCE(g.steam_app_id,''),COALESCE(g.name,'')
 FROM screenshots s LEFT JOIN games g ON g.id=s.game_id WHERE s.enabled=1 AND s.asset_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var hash string
		var gameID sql.NullString
		var game Game
		var captured, source string
		if err = rows.Scan(&hash, &captured, &source, &gameID, &game.SteamAppID, &game.Name); err != nil {
			return err
		}
		a := &items[lookup[hash]]
		a.Screenshot, a.CapturedAt, a.ScreenshotSource = true, captured, source
		if gameID.Valid {
			game.ID = gameID.String
			a.Game = &game
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return nil
}

func (l *Library) Check(ctx context.Context, full bool) error {
	var result string
	if err := l.DB.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("SQLite integrity: %s", result)
	}
	rows, err := l.DB.QueryContext(ctx, "SELECT id,size FROM assets WHERE purge_pending=0")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var hash string
		var size int64
		if err = rows.Scan(&hash, &size); err != nil {
			return err
		}
		if !validHash.MatchString(hash) {
			return fmt.Errorf("invalid original identifier")
		}
		stat, e := os.Lstat(l.Object(hash))
		if e != nil {
			return fmt.Errorf("missing original %s: %w", hash, e)
		}
		if !stat.Mode().IsRegular() || stat.Size() != size {
			return fmt.Errorf("original integrity mismatch: %s", hash)
		}
		if full {
			_, actual, e := hashFile(l.Object(hash))
			if e != nil {
				return e
			}
			if actual != hash {
				return fmt.Errorf("original checksum mismatch: %s", hash)
			}
		}
	}
	return rows.Err()
}

func CheckData(ctx context.Context, root string, full bool) error {
	path, err := filepath.Abs(filepath.Join(root, "curio.sqlite"))
	if err != nil {
		return err
	}
	if _, err = os.Stat(path); err != nil {
		return err
	}
	u := url.URL{Scheme: "file", Path: path}
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	l := &Library{DB: db, Root: filepath.Dir(path)}
	if err = l.Check(ctx, full); err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("SQLite foreign-key violation")
	}
	return rows.Err()
}
