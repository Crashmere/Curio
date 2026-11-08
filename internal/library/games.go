package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type Game struct {
	ID             string `json:"id"`
	SteamAppID     string `json:"steamAppId"`
	Name           string `json:"name"`
	Count          int64  `json:"count"`
	CoverURL       string `json:"coverUrl,omitempty"`
	LastCapturedAt string `json:"lastCapturedAt,omitempty"`
}

var steamScreenshotName = regexp.MustCompile(`(?i)^([1-9][0-9]{0,9})_([0-9]{14})_[0-9]+\.([a-z0-9]+)$`)

func validSteamAppID(value string) bool {
	n, err := strconv.ParseUint(value, 10, 32)
	return err == nil && n > 0 && strconv.FormatUint(n, 10) == value
}

func parseSteamScreenshot(name string) (string, string) {
	parts := steamScreenshotName.FindStringSubmatch(name)
	if parts == nil || !validSteamAppID(parts[1]) {
		return "", ""
	}
	format := strings.ToLower(parts[3])
	if format != "png" && format != "jpg" && format != "jpeg" && allowedFormats[format] != "video" {
		return "", ""
	}
	captured := parseScreenshotTimestamp(parts[2])
	if captured == "" {
		return "", ""
	}
	return parts[1], captured
}

func parseScreenshotTimestamp(value string) string {
	if len(value) != 14 {
		return ""
	}
	t, err := time.Parse("20060102150405", value)
	if err != nil {
		return ""
	}
	// Filename timestamps contain wall-clock time, not a timezone or UTC offset.
	return t.Format("2006-01-02T15:04:05")
}

func parseScreenshotFilenameTime(name string) string {
	name = filepath.Base(name)
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	// Tokens after the first have a leading underscore and end at '_' or the stem boundary.
	for _, token := range strings.Split(stem, "_")[1:] {
		if captured := parseScreenshotTimestamp(token); captured != "" {
			return captured
		}
	}
	return ""
}

func ensureSteamGame(tx *sql.Tx, appID, scope string) (string, error) {
	var gameID string
	err := tx.QueryRow("SELECT id FROM games WHERE steam_app_id=?", appID).Scan(&gameID)
	if err == nil {
		return gameID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	gameID = id()
	_, err = tx.Exec("INSERT INTO games(id,steam_app_id,created_scope,created_at) VALUES(?,?,?,?)", gameID, appID, scope, now())
	return gameID, err
}

func (l *Library) screenshotCaptureTime(ctx context.Context, hash string, names ...string) string {
	captured, _ := l.readScreenshotCaptureTime(ctx, hash, names...)
	return captured
}

func (l *Library) readScreenshotCaptureTime(ctx context.Context, hash string, names ...string) (string, error) {
	for _, name := range names {
		if _, captured := parseSteamScreenshot(name); captured != "" {
			return captured, nil
		}
	}
	for _, name := range names {
		if captured := parseScreenshotFilenameTime(name); captured != "" {
			return captured, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := l.cpuCommand(ctx, "exiftool", "-j", "-n", "-api", "LargeFileSupport=1",
		"-DateTimeOriginal", "-CreateDate", "-CreationDate", "-CreationTime",
		"-DateCreated", "-MediaCreateDate", "-TrackCreateDate",
		"-ModifyDate", "-ModificationDate", "-ModificationTime", "-DateModified",
		"-MediaModifyDate", "-TrackModifyDate", l.Object(hash))
	if err != nil {
		return "", err
	}
	var values []map[string]any
	if err := json.Unmarshal(raw, &values); err != nil {
		return "", err
	}
	if len(values) == 0 {
		return "", errors.New("metadata reader returned no result")
	}
	return metadataCaptureTime(values[0]), nil
}

func metadataCaptureTime(metadata map[string]any) string {
	earliest := ""
	for _, key := range []string{
		"DateTimeOriginal", "CreateDate", "CreationDate", "CreationTime", "DateCreated", "MediaCreateDate", "TrackCreateDate",
		"ModifyDate", "ModificationDate", "ModificationTime", "DateModified", "MediaModifyDate", "TrackModifyDate",
	} {
		value := strings.TrimSpace(metaString(metadata, key))
		for _, layout := range []string{
			"2006:01:02 15:04:05Z07:00", "2006:01:02 15:04:05-0700", "2006:01:02 15:04:05",
			time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05Z07:00", "2006-01-02 15:04:05",
		} {
			if t, err := time.Parse(layout, value); err == nil && t.Year() > 0 {
				// Keep the recorded wall clock, matching Steam's timezone-free timestamps.
				captured := t.Format("2006-01-02T15:04:05")
				if earliest == "" || captured < earliest {
					earliest = captured
				}
				break
			}
		}
	}
	return earliest
}

func (l *Library) captureTimeForAsset(ctx context.Context, hash, name string, reenable bool) (string, error) {
	var original, kind string
	var pending bool
	var enabled sql.NullBool
	err := l.DB.QueryRow(`SELECT a.name,a.kind,a.purge_pending,s.enabled FROM assets a
 LEFT JOIN screenshots s ON s.asset_id=a.id WHERE a.id=?`, hash).Scan(&original, &kind, &pending, &enabled)
	if err != nil {
		return "", err
	}
	if pending || !supportsGameMedia(kind) || (enabled.Valid && (enabled.Bool || !reenable)) {
		return "", nil
	}
	names := []string{name, original}
	rows, err := l.DB.Query("SELECT name FROM sources WHERE asset_id=? ORDER BY created_at,id", hash)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var source string
		if err = rows.Scan(&source); err != nil {
			rows.Close()
			return "", err
		}
		names = append(names, source)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	// Read embedded metadata before opening the catalog's write transaction.
	return l.screenshotCaptureTime(ctx, hash, names...), nil
}

func recordScreenshot(tx *sql.Tx, hash string, h UploadHints, fallbackTime string) error {
	if !h.Screenshot && h.GameID == "" {
		return nil
	}
	var present int
	if err := tx.QueryRow("SELECT count(*) FROM screenshots WHERE asset_id=?", hash).Scan(&present); err != nil {
		return err
	}
	// Keep manual corrections and explicit opt-outs when the same bytes are imported again.
	if present != 0 {
		return nil
	}
	appID, captured := parseSteamScreenshot(h.Name)
	if captured == "" {
		captured = fallbackTime
	}
	gameID, source := h.GameID, "steam"
	var kind string
	if err := tx.QueryRow("SELECT kind FROM assets WHERE id=?", hash).Scan(&kind); err != nil {
		return err
	}
	if !supportsGameMedia(kind) {
		return nil
	}
	if gameID != "" {
		var exists int
		if err := tx.QueryRow("SELECT count(*) FROM games WHERE id=?", gameID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return fmt.Errorf("游戏已不存在")
		}
		source = "manual"
	} else if appID != "" {
		var err error
		gameID, err = ensureSteamGame(tx, appID, h.Scope)
		if err != nil {
			return err
		}
	} else {
		source = "manual"
	}
	var game any
	if gameID != "" {
		game = gameID
	}
	_, err := tx.Exec("INSERT INTO screenshots(asset_id,game_id,captured_at,source) VALUES(?,?,?,?)", hash, game, captured, source)
	return err
}

func backfillScreenshots(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var done int
	if err = tx.QueryRow("SELECT count(*) FROM catalog_features WHERE name='steam-screenshots-v1'").Scan(&done); err != nil {
		return err
	}
	if done != 0 {
		return tx.Commit()
	}
	rows, err := tx.Query(`SELECT a.id,a.name,CASE WHEN ` + effectiveHidden + ` THEN 'hidden' ELSE 'normal' END
 FROM assets a WHERE a.kind='image' AND a.purge_pending=0
 UNION ALL SELECT a.id,s.name,CASE WHEN ` + effectiveHidden + ` THEN 'hidden' ELSE 'normal' END
 FROM sources s JOIN assets a ON a.id=s.asset_id WHERE a.kind='image' AND a.purge_pending=0`)
	if err != nil {
		return err
	}
	type candidate struct{ hash, name, scope string }
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.hash, &c.name, &c.scope); err != nil {
			rows.Close()
			return err
		}
		if appID, _ := parseSteamScreenshot(c.name); appID != "" {
			candidates = append(candidates, c)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range candidates {
		if err = recordScreenshot(tx, c.hash, UploadHints{Name: c.name, Scope: c.scope, Screenshot: true}, ""); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT INTO catalog_features(name) VALUES('steam-screenshots-v1')"); err != nil {
		return err
	}
	return tx.Commit()
}

func supportsGameMedia(kind string) bool {
	return kind == "image" || kind == "video"
}

func patchScreenshot(tx *sql.Tx, hash string, p assetPatch, captured string) error {
	if p.Screenshot == nil && p.GameID == nil && p.CapturedAt == nil {
		return nil
	}
	var kind, name, scope string
	if err := tx.QueryRow("SELECT a.kind,a.name,CASE WHEN "+effectiveHidden+" THEN 'hidden' ELSE 'normal' END FROM assets a WHERE a.id=?", hash).Scan(&kind, &name, &scope); err != nil {
		return err
	}
	if !supportsGameMedia(kind) {
		return fmt.Errorf("游戏截图支持静态图片和视频")
	}
	if p.Screenshot != nil && *p.Screenshot && p.GameID == nil {
		var enabled bool
		err := tx.QueryRow("SELECT enabled FROM screenshots WHERE asset_id=?", hash).Scan(&enabled)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if enabled && p.CapturedAt == nil {
			return nil
		}
		// Explicit organization can re-enable an opt-out; duplicate imports cannot.
		if _, err = tx.Exec("DELETE FROM screenshots WHERE asset_id=? AND enabled=0", hash); err != nil {
			return err
		}
		if appID, _ := parseSteamScreenshot(name); appID == "" {
			rows, err := tx.Query("SELECT name FROM sources WHERE asset_id=? ORDER BY created_at,id", hash)
			if err != nil {
				return err
			}
			for rows.Next() {
				var candidate string
				if err = rows.Scan(&candidate); err != nil {
					rows.Close()
					return err
				}
				if appID, _ := parseSteamScreenshot(candidate); appID != "" {
					name = candidate
					break
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
		if err = recordScreenshot(tx, hash, UploadHints{Name: filepath.Base(name), Scope: scope, Screenshot: true}, captured); err != nil {
			return err
		}
		if p.CapturedAt == nil {
			return nil
		}
	}
	if p.GameID != nil && *p.GameID != "" {
		var exists int
		if err := tx.QueryRow("SELECT count(*) FROM games WHERE id=?", *p.GameID).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return fmt.Errorf("游戏已不存在")
		}
	}
	if _, err := tx.Exec("INSERT OR IGNORE INTO screenshots(asset_id,captured_at,source) VALUES(?,?,'manual')", hash, captured); err != nil {
		return err
	}
	set, args := []string{"source='manual'"}, []any{}
	if p.Screenshot != nil && !*p.Screenshot {
		set = append(set, "enabled=0", "game_id=NULL", "captured_at=''")
	} else {
		if p.CapturedAt == nil {
			set = append(set, "captured_at=CASE WHEN enabled=0 THEN ? ELSE captured_at END")
			args = append(args, captured)
		}
		set = append(set, "enabled=1")
		if p.GameID != nil {
			set = append(set, "game_id=?")
			var game any
			if *p.GameID != "" {
				game = *p.GameID
			}
			args = append(args, game)
		}
		if p.CapturedAt != nil {
			set = append(set, "captured_at=?")
			args = append(args, *p.CapturedAt)
		}
	}
	args = append(args, hash)
	_, err := tx.Exec("UPDATE screenshots SET "+strings.Join(set, ",")+" WHERE asset_id=?", args...)
	return err
}

const screenshotTimeSQL = `(SELECT s.captured_at FROM screenshots s WHERE s.asset_id=a.id AND s.enabled=1)`

func gameScopeSQL(scope string) string {
	return `EXISTS(SELECT 1 FROM screenshots s JOIN assets a ON a.id=s.asset_id WHERE s.game_id=g.id
 AND s.enabled=1 AND a.purge_pending=0 AND a.trashed_at='' AND ` + scopeSQL(scope) + `)
 OR (g.created_scope=? AND NOT EXISTS(SELECT 1 FROM screenshots s JOIN assets a ON a.id=s.asset_id
 WHERE s.game_id=g.id AND s.enabled=1 AND a.purge_pending=0 AND a.trashed_at=''))`
}

func (l *Library) scopedGames(scope string) ([]Game, error) {
	predicate := "s.enabled=1 AND a.purge_pending=0 AND a.trashed_at='' AND " + scopeSQL(scope)
	rows, err := l.DB.Query(`SELECT g.id,COALESCE(g.steam_app_id,''),g.name,
 (SELECT count(*) FROM screenshots s JOIN assets a ON a.id=s.asset_id WHERE s.game_id=g.id AND `+predicate+`),
 COALESCE((SELECT max(s.captured_at) FROM screenshots s JOIN assets a ON a.id=s.asset_id WHERE s.game_id=g.id AND `+predicate+`),'')
 FROM games g WHERE `+gameScopeSQL(scope)+`
 ORDER BY COALESCE(NULLIF(g.name,''),g.steam_app_id) COLLATE NOCASE,g.id`, scope)
	if err != nil {
		return nil, err
	}
	items := []Game{}
	for rows.Next() {
		var g Game
		if err = rows.Scan(&g.ID, &g.SteamAppID, &g.Name, &g.Count, &g.LastCapturedAt); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range items {
		var hash string
		err = l.DB.QueryRow("SELECT a.id FROM screenshots s JOIN assets a ON a.id=s.asset_id WHERE s.game_id=? AND "+predicate+" AND a.thumbnail_ext!='' ORDER BY s.captured_at DESC,a.created_at DESC,a.id DESC LIMIT 1", items[i].ID).Scan(&hash)
		if err == nil {
			items[i].CoverURL = "/curio/media/" + hash + "/thumbnail"
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	return items, nil
}

func (l *Library) listGames(w http.ResponseWriter, r *http.Request) {
	items, err := l.scopedGames(requestScope(r.URL.Query()))
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (l *Library) saveGame(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Name       *string `json:"name"`
		SteamAppID string  `json:"steamAppId"`
	}
	if !decode(w, r, &p) {
		return
	}
	name := ""
	if p.Name != nil {
		name = strings.TrimSpace(*p.Name)
	}
	if len(name) > 512 || (p.SteamAppID != "" && !validSteamAppID(p.SteamAppID)) {
		fail(w, 400, "游戏名称或 Steam App ID 无效")
		return
	}
	gameID := chi.URLParam(r, "id")
	if gameID != "" {
		if p.Name == nil {
			fail(w, 400, "请输入游戏名称")
			return
		}
		games, err := l.scopedGames(requestScope(r.URL.Query()))
		if err != nil {
			fail(w, 500, err)
			return
		}
		found := false
		for _, game := range games {
			if game.ID == gameID {
				if game.SteamAppID == "" && name == "" {
					fail(w, 400, "请输入游戏名称")
					return
				}
				found = true
				break
			}
		}
		if !found {
			fail(w, 404, "游戏不存在于当前模式")
			return
		}
		// An established Steam identity stays stable; this endpoint edits its display name.
		if _, err = l.DB.Exec("UPDATE games SET name=? WHERE id=?", name, gameID); err != nil {
			fail(w, 500, err)
			return
		}
	} else {
		if name == "" && p.SteamAppID == "" {
			fail(w, 400, "请输入游戏名称或 Steam App ID")
			return
		}
		tx, err := l.DB.Begin()
		if err != nil {
			fail(w, 500, err)
			return
		}
		defer tx.Rollback()
		if p.SteamAppID != "" {
			var existing string
			err = tx.QueryRow("SELECT id FROM games WHERE steam_app_id=?", p.SteamAppID).Scan(&existing)
			if err == nil {
				fail(w, 409, "该 Steam ID 已存在，请编辑已有游戏名称")
				return
			}
			if !errors.Is(err, sql.ErrNoRows) {
				fail(w, 500, err)
				return
			}
		}
		gameID = id()
		var appID any
		if p.SteamAppID != "" {
			appID = p.SteamAppID
		}
		if _, err = tx.Exec("INSERT INTO games(id,steam_app_id,name,created_scope,created_at) VALUES(?,?,?,?,?)", gameID, appID, name, requestScope(r.URL.Query()), now()); err != nil {
			fail(w, 400, "无法创建游戏")
			return
		}
		if err = tx.Commit(); err != nil {
			fail(w, 500, err)
			return
		}
	}
	writeJSON(w, 200, map[string]string{"id": gameID})
}

func (l *Library) deleteGame(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Confirm bool `json:"confirm"`
	}
	if !decode(w, r, &p) {
		return
	}
	if !p.Confirm {
		fail(w, 400, "请确认删除游戏夹")
		return
	}
	gameID := chi.URLParam(r, "id")
	if !validID.MatchString(gameID) {
		fail(w, 404, "游戏不存在于当前模式")
		return
	}
	tx, err := l.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	var available int
	scope := requestScope(r.URL.Query())
	if err = tx.QueryRow("SELECT count(*) FROM games g WHERE g.id=? AND ("+gameScopeSQL(scope)+")", gameID, scope).Scan(&available); err != nil {
		fail(w, 500, err)
		return
	}
	if available == 0 {
		fail(w, 404, "游戏不存在于当前模式")
		return
	}
	// Game identity is shared across scopes; detach every reference, including trash.
	if _, err = tx.Exec("UPDATE assets SET updated_at=? WHERE id IN (SELECT asset_id FROM screenshots WHERE game_id=?)", now(), gameID); err != nil {
		fail(w, 500, err)
		return
	}
	if _, err = tx.Exec("UPDATE screenshots SET game_id=NULL,source='manual' WHERE game_id=?", gameID); err != nil {
		fail(w, 500, err)
		return
	}
	if _, err = tx.Exec("DELETE FROM games WHERE id=?", gameID); err != nil {
		fail(w, 500, err)
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
