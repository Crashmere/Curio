package library

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type coverTarget struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CollectionID   string `json:"collectionId,omitempty"`
	CollectionName string `json:"collectionName,omitempty"`
	Selected       bool   `json:"selected"`
}

func containerCoverKey(kind, targetID string) string {
	return kind + "_cover:" + targetID
}

func (l *Library) coverTargets(w http.ResponseWriter, r *http.Request) {
	hash := chi.URLParam(r, "id")
	if !validHash.MatchString(hash) {
		fail(w, 400, "素材编号无效")
		return
	}
	tx, err := l.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	var exists bool
	err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets a WHERE a.id=? AND a.purge_pending=0 AND a.trashed_at='' AND "+scopeSQL(requestScope(r.URL.Query()))+")", hash).Scan(&exists)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if !exists {
		fail(w, 404, "素材已不在当前模式中或已移入回收站")
		return
	}
	collections, groups := []coverTarget{}, []coverTarget{}
	for _, entry := range []struct {
		query string
		items *[]coverTarget
	}{
		{`SELECT c.id,c.name,'','',COALESCE(s.value,'')=? FROM asset_collections j
 JOIN collections c ON c.id=j.collection_id
 LEFT JOIN catalog_settings s ON s.key='collection_cover:'||c.id
 WHERE j.asset_id=? ORDER BY c.name COLLATE NOCASE,c.id`, &collections},
		{`SELECT g.id,g.name,c.id,c.name,COALESCE(s.value,'')=? FROM collection_group_assets j
 JOIN collection_groups g ON g.id=j.group_id JOIN collections c ON c.id=j.collection_id
 LEFT JOIN catalog_settings s ON s.key='group_cover:'||g.id
 WHERE j.asset_id=? ORDER BY c.name COLLATE NOCASE,g.name,g.id`, &groups},
	} {
		rows, err := tx.Query(entry.query, hash, hash)
		if err != nil {
			fail(w, 500, err)
			return
		}
		for rows.Next() {
			var target coverTarget
			if err = rows.Scan(&target.ID, &target.Name, &target.CollectionID, &target.CollectionName, &target.Selected); err != nil {
				rows.Close()
				fail(w, 500, err)
				return
			}
			*entry.items = append(*entry.items, target)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			fail(w, 500, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"collections": collections, "groups": groups})
}

func (l *Library) setContainerCover(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Kind     string `json:"kind"`
		TargetID string `json:"targetId"`
	}
	if !decode(w, r, &p) {
		return
	}
	if err := l.selectContainerCover(chi.URLParam(r, "id"), p.Kind, p.TargetID, requestScope(r.URL.Query())); err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (l *Library) selectContainerCover(hash, kind, targetID, scope string) error {
	if !validHash.MatchString(hash) || !validID.MatchString(targetID) || (kind != "collection" && kind != "group") {
		return fmt.Errorf("封面目标无效")
	}
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	relation := "asset_collections j"
	column := "j.collection_id"
	if kind == "group" {
		relation = "collection_group_assets j"
		column = "j.group_id"
	}
	var exists bool
	err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM "+relation+" JOIN assets a ON a.id=j.asset_id WHERE "+column+"=? AND a.id=? AND a.purge_pending=0 AND a.trashed_at='' AND "+scopeSQL(scope)+")", targetID, hash).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("素材已不在该分组、收藏集或当前模式中，请重试")
	}
	// Store the member, not its image revision, so video frame changes propagate.
	if _, err = tx.Exec("INSERT INTO catalog_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", containerCoverKey(kind, targetID), hash); err != nil {
		return err
	}
	return tx.Commit()
}

func pruneContainerCovers(tx *sql.Tx) error {
	for _, entry := range []struct{ kind, table, column string }{
		{"collection", "asset_collections", "collection_id"},
		{"group", "collection_group_assets", "group_id"},
	} {
		_, err := tx.Exec("DELETE FROM catalog_settings WHERE key GLOB ? AND NOT EXISTS(SELECT 1 FROM "+entry.table+" j WHERE catalog_settings.key=?||j."+entry.column+" AND catalog_settings.value=j.asset_id)", entry.kind+"_cover:*", entry.kind+"_cover:")
		if err != nil {
			return err
		}
	}
	return nil
}
