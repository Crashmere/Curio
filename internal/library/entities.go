package library

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type assetPatch struct {
	IDs                 []string  `json:"ids"`
	Title               *string   `json:"title"`
	Notes               *string   `json:"notes"`
	SourceURL           *string   `json:"sourceUrl"`
	Author              *string   `json:"author"`
	Hidden              *bool     `json:"hidden"`
	Organized           *bool     `json:"organized"`
	Starred             *bool     `json:"starred"`
	Trash               *bool     `json:"trash"`
	TagIDs              *[]string `json:"tagIds"`
	CollectionIDs       *[]string `json:"collectionIds"`
	AddTagIDs           []string  `json:"addTagIds"`
	RemoveTagIDs        []string  `json:"removeTagIds"`
	AddCollectionIDs    []string  `json:"addCollectionIds"`
	RemoveCollectionIDs []string  `json:"removeCollectionIds"`
}

func validateContainers(ids []string) error {
	if len(ids) > 500 {
		return fmt.Errorf("分类数量过多")
	}
	for _, value := range ids {
		if !validID.MatchString(value) {
			return fmt.Errorf("分类编号无效")
		}
	}
	return nil
}

func (p *assetPatch) validate() error {
	if err := parseIDs(p.IDs); err != nil {
		return err
	}
	for _, entry := range []struct {
		value   *string
		maximum int
	}{{p.Title, 512}, {p.Notes, 20000}, {p.Author, 512}, {p.SourceURL, 4096}} {
		if entry.value != nil && len(*entry.value) > entry.maximum {
			return fmt.Errorf("文字内容超过长度限制")
		}
	}
	if p.SourceURL != nil && *p.SourceURL != "" {
		u, err := url.Parse(*p.SourceURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("来源链接应为 HTTP 或 HTTPS 地址")
		}
	}
	for _, ids := range [][]string{p.AddTagIDs, p.RemoveTagIDs, p.AddCollectionIDs, p.RemoveCollectionIDs} {
		if err := validateContainers(ids); err != nil {
			return err
		}
	}
	if p.TagIDs != nil {
		if err := validateContainers(*p.TagIDs); err != nil {
			return err
		}
	}
	if p.CollectionIDs != nil {
		if err := validateContainers(*p.CollectionIDs); err != nil {
			return err
		}
	}
	return nil
}

func (l *Library) patch(p assetPatch) error {
	if err := p.validate(); err != nil {
		return err
	}
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, hash := range p.IDs {
		var pending bool
		if err = tx.QueryRow("SELECT purge_pending FROM assets WHERE id=?", hash).Scan(&pending); err != nil {
			return fmt.Errorf("部分媒体已不存在")
		}
		if pending {
			return fmt.Errorf("媒体正在永久删除，不能修改")
		}
		set := []string{"updated_at=?"}
		args := []any{now()}
		for _, entry := range []struct {
			column string
			value  *string
		}{{"title", p.Title}, {"notes", p.Notes}, {"source_url", p.SourceURL}, {"author", p.Author}} {
			if entry.value != nil {
				set = append(set, entry.column+"=?")
				args = append(args, *entry.value)
			}
		}
		for _, entry := range []struct {
			column string
			value  *bool
		}{{"hidden", p.Hidden}, {"organized", p.Organized}, {"starred", p.Starred}} {
			if entry.value != nil {
				set = append(set, entry.column+"=?")
				args = append(args, *entry.value)
			}
		}
		if p.Trash != nil {
			value := ""
			if *p.Trash {
				value = now()
			}
			set = append(set, "trashed_at=?")
			args = append(args, value)
		}
		args = append(args, hash)
		if _, err = tx.Exec("UPDATE assets SET "+strings.Join(set, ",")+" WHERE id=?", args...); err != nil {
			return err
		}
		if err = changeMemberships(tx, hash, "tags", p.TagIDs, p.AddTagIDs, p.RemoveTagIDs); err != nil {
			return err
		}
		if err = changeMemberships(tx, hash, "collections", p.CollectionIDs, p.AddCollectionIDs, p.RemoveCollectionIDs); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func relation(kind string) (table, column string) {
	if kind == "tags" {
		return "asset_tags", "tag_id"
	}
	return "asset_collections", "collection_id"
}

func changeMemberships(tx *sql.Tx, hash, kind string, replace *[]string, add, remove []string) error {
	table, column := relation(kind)
	if replace != nil {
		if _, err := tx.Exec("DELETE FROM "+table+" WHERE asset_id=?", hash); err != nil {
			return err
		}
		add = append(add, (*replace)...)
	}
	for _, value := range add {
		var exists int
		if err := tx.QueryRow("SELECT count(*) FROM "+kind+" WHERE id=?", value).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return fmt.Errorf("分类已不存在")
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO "+table+"(asset_id,"+column+") VALUES(?,?)", hash, value); err != nil {
			return err
		}
	}
	for _, value := range remove {
		if _, err := tx.Exec("DELETE FROM "+table+" WHERE asset_id=? AND "+column+"=?", hash, value); err != nil {
			return err
		}
	}
	return nil
}

func (l *Library) batchUpdate(w http.ResponseWriter, r *http.Request) {
	var p assetPatch
	if !decode(w, r, &p) {
		return
	}
	if err := l.patch(p); err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "updated": len(p.IDs)})
}

func (l *Library) updateAsset(w http.ResponseWriter, r *http.Request) {
	var p assetPatch
	if !decode(w, r, &p) {
		return
	}
	p.IDs = []string{chi.URLParam(r, "id")}
	if err := l.patch(p); err != nil {
		fail(w, 400, err)
		return
	}
	a, err := l.asset(p.IDs[0])
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

func (l *Library) container(kind, entityID, scope string) (Container, error) {
	var c Container
	err := l.DB.QueryRow("SELECT id,name,hidden,created_at FROM "+kind+" WHERE id=?", entityID).Scan(&c.ID, &c.Name, &c.Hidden, &c.CreatedAt)
	if err != nil {
		return c, err
	}
	table, column := relation(kind)
	predicate := "a.purge_pending=0 AND a.trashed_at='' AND " + scopeSQL(scope)
	if err = l.DB.QueryRow("SELECT count(*) FROM "+table+" j JOIN assets a ON a.id=j.asset_id WHERE j."+column+"=? AND "+predicate, entityID).Scan(&c.Count); err != nil {
		return c, err
	}
	var hash string
	err = l.DB.QueryRow("SELECT a.id FROM "+table+" j JOIN assets a ON a.id=j.asset_id WHERE j."+column+"=? AND "+predicate+" AND a.thumbnail_ext!='' ORDER BY a.created_at DESC,a.id DESC LIMIT 1", entityID).Scan(&hash)
	if err == nil {
		c.CoverURL = "/curio/media/" + hash + "/thumbnail"
	} else if !errors.Is(err, sql.ErrNoRows) {
		return c, err
	}
	return c, nil
}

func (l *Library) listContainers(w http.ResponseWriter, r *http.Request, kind string) {
	scope := requestScope(r.URL.Query())
	table, column := relation(kind)
	predicate := "c.hidden=0"
	if scope == "hidden" {
		predicate = "(c.hidden=1 OR EXISTS(SELECT 1 FROM " + table + " j JOIN assets a ON a.id=j.asset_id WHERE j." + column + "=c.id AND a.purge_pending=0 AND " + scopeSQL(scope) + "))"
	}
	rows, err := l.DB.Query("SELECT c.id FROM " + kind + " c WHERE " + predicate + " ORDER BY c.name COLLATE NOCASE,c.id")
	if err != nil {
		fail(w, 500, err)
		return
	}
	ids := []string{}
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			rows.Close()
			fail(w, 500, err)
			return
		}
		ids = append(ids, value)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		fail(w, 500, err)
		return
	}
	items := []Container{}
	for _, value := range ids {
		c, e := l.container(kind, value, scope)
		if e != nil {
			fail(w, 500, e)
			return
		}
		items = append(items, c)
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

type containerPatch struct {
	Name   *string `json:"name"`
	Hidden *bool   `json:"hidden"`
}

func (p containerPatch) validate() error {
	if p.Name != nil && (strings.TrimSpace(*p.Name) == "" || len(*p.Name) > 512) {
		return fmt.Errorf("请输入 1-512 字节的名称")
	}
	return nil
}

func (l *Library) createContainer(w http.ResponseWriter, r *http.Request, kind string) {
	var p containerPatch
	if !decode(w, r, &p) {
		return
	}
	if p.Name == nil {
		fail(w, 400, "请输入名称")
		return
	}
	if err := p.validate(); err != nil {
		fail(w, 400, err)
		return
	}
	name := strings.TrimSpace(*p.Name)
	hidden := requestScope(r.URL.Query()) == "hidden"
	if p.Hidden != nil {
		hidden = *p.Hidden
	}
	entityID := id()
	created := now()
	_, err := l.DB.Exec("INSERT INTO "+kind+"(id,name,hidden,created_at) VALUES(?,?,?,?)", entityID, name, hidden, created)
	if err != nil {
		if kind == "tags" {
			var existingID string
			if e := l.DB.QueryRow("SELECT id FROM tags WHERE name=? COLLATE NOCASE", name).Scan(&existingID); e == nil {
				c, e := l.container(kind, existingID, requestScope(r.URL.Query()))
				if e == nil {
					if c.Hidden != hidden {
						fail(w, 409, "同名标签已存在，隐藏状态不同，请明确选择或修改原标签")
						return
					}
					writeJSON(w, 200, c)
					return
				}
			}
		}
		fail(w, 400, "名称已存在或无法创建")
		return
	}
	writeJSON(w, 201, Container{ID: entityID, Name: name, Hidden: hidden, CreatedAt: created})
}

func (l *Library) updateContainer(w http.ResponseWriter, r *http.Request, kind string) {
	var p containerPatch
	if !decode(w, r, &p) {
		return
	}
	if err := p.validate(); err != nil {
		fail(w, 400, err)
		return
	}
	entityID := chi.URLParam(r, "id")
	if !validID.MatchString(entityID) {
		fail(w, 404, "分类不存在")
		return
	}
	set := []string{}
	args := []any{}
	if p.Name != nil {
		set = append(set, "name=?")
		args = append(args, strings.TrimSpace(*p.Name))
	}
	if p.Hidden != nil {
		set = append(set, "hidden=?")
		args = append(args, *p.Hidden)
	}
	if len(set) > 0 {
		args = append(args, entityID)
		result, err := l.DB.Exec("UPDATE "+kind+" SET "+strings.Join(set, ",")+" WHERE id=?", args...)
		if err != nil {
			fail(w, 400, "名称冲突或无法修改")
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			fail(w, 404, "分类不存在")
			return
		}
	}
	c, err := l.container(kind, entityID, requestScope(r.URL.Query()))
	if err != nil {
		fail(w, 404, "分类不存在")
		return
	}
	writeJSON(w, 200, c)
}

func (l *Library) deleteContainer(w http.ResponseWriter, r *http.Request, kind string) {
	entityID := chi.URLParam(r, "id")
	if !validID.MatchString(entityID) {
		fail(w, 404, "分类不存在")
		return
	}
	result, err := l.DB.Exec("DELETE FROM "+kind+" WHERE id=?", entityID)
	if err != nil {
		fail(w, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		fail(w, 404, "分类不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (l *Library) retryAssets(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs []string `json:"ids"`
	}
	if !decode(w, r, &p) {
		return
	}
	if err := parseIDs(p.IDs); err != nil {
		fail(w, 400, err)
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	for _, hash := range p.IDs {
		if _, err = tx.Exec("UPDATE assets SET status='queued',stage='queued',error='',progress=0,updated_at=? WHERE id=? AND purge_pending=0 AND status!='processing'", now(), hash); err != nil {
			fail(w, 500, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	l.Notify()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (l *Library) purgeAssets(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs     []string `json:"ids"`
		Confirm bool     `json:"confirm"`
	}
	if !decode(w, r, &p) {
		return
	}
	if !p.Confirm {
		fail(w, 400, "永久删除需要明确确认")
		return
	}
	if err := parseIDs(p.IDs); err != nil {
		fail(w, 400, err)
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	for _, hash := range p.IDs {
		var trashed string
		if err = tx.QueryRow("SELECT trashed_at FROM assets WHERE id=?", hash).Scan(&trashed); err != nil || trashed == "" {
			fail(w, 409, "只能永久删除回收站中的媒体")
			return
		}
		if _, err = tx.Exec("UPDATE assets SET purge_pending=1,status='deleting',stage='deleting',error='',updated_at=? WHERE id=?", now(), hash); err != nil {
			fail(w, 500, err)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	l.cancelPlayback(p.IDs)
	l.activeMu.Lock()
	for _, hash := range p.IDs {
		if job := l.active[hash]; job != nil {
			job.cancel()
		}
	}
	l.activeMu.Unlock()
	l.Notify()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "pending": len(p.IDs)})
}

func (l *Library) jobs(w http.ResponseWriter, r *http.Request) {
	rows, err := l.DB.Query("SELECT "+assetColumns+" FROM assets a WHERE "+scopeSQL(requestScope(r.URL.Query()))+" AND (a.status!='ready' OR a.updated_at>?) ORDER BY a.purge_pending DESC,a.created_at DESC LIMIT 120", timeBeforeDay())
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			fail(w, 500, e)
			return
		}
		items = append(items, map[string]any{"id": a.ID, "assetId": a.ID, "name": a.Name, "status": a.Status, "stage": a.Stage, "error": a.Error, "engine": a.Engine, "progress": a.Progress, "createdAt": a.CreatedAt, "updatedAt": a.UpdatedAt, "thumbnailUrl": a.ThumbnailURL})
	}
	if err = rows.Err(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func timeBeforeDay() string { return time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339Nano) }
