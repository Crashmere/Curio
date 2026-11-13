package library

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

type mediaGroup struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	AssetIDs []string `json:"assetIds"`
}

func ensureGroupNames(db *sql.DB) error {
	var exists bool
	if err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_groups') WHERE name='name')").Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err := db.Exec("ALTER TABLE collection_groups ADD COLUMN name TEXT NOT NULL DEFAULT ''")
	return err
}

func (l *Library) listGroups(w http.ResponseWriter, r *http.Request) {
	collectionID := chi.URLParam(r, "id")
	if !validID.MatchString(collectionID) {
		fail(w, 400, "收藏集编号无效")
		return
	}
	q := r.URL.Query()
	q.Set("collection", collectionID)
	where, args, err := assetFilter(q)
	if err != nil {
		fail(w, 400, err)
		return
	}
	order, err := assetOrder(q)
	if err != nil {
		fail(w, 400, err)
		return
	}
	args = append([]any{collectionID}, args...)
	rows, err := l.DB.Query("SELECT g.group_id,cg.name,a.id FROM assets a JOIN collection_group_assets g ON g.asset_id=a.id AND g.collection_id=? JOIN collection_groups cg ON cg.id=g.group_id"+where+" ORDER BY "+order, args...)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer rows.Close()
	items := []mediaGroup{}
	indices := map[string]int{}
	for rows.Next() {
		var groupID, name, assetID string
		if err = rows.Scan(&groupID, &name, &assetID); err != nil {
			fail(w, 500, err)
			return
		}
		index, exists := indices[groupID]
		if !exists {
			index = len(items)
			indices[groupID] = index
			items = append(items, mediaGroup{ID: groupID, Name: name, AssetIDs: []string{}})
		}
		items[index].AssetIDs = append(items[index].AssetIDs, assetID)
	}
	if err = rows.Err(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func validateGroupMembers(tx *sql.Tx, collectionID, scope string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if err := parseIDs(ids); err != nil {
		return err
	}
	for _, hash := range ids {
		var exists bool
		err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM asset_collections c JOIN assets a ON a.id=c.asset_id WHERE c.collection_id=? AND a.id=? AND a.purge_pending=0 AND a.trashed_at='' AND "+scopeSQL(scope)+")", collectionID, hash).Scan(&exists)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("部分素材已不在当前收藏集或模式中，请刷新后重试")
		}
	}
	return nil
}

func moveGroupMembers(tx *sql.Tx, collectionID, groupID string, add, remove []string) error {
	for _, hash := range add {
		if _, err := tx.Exec(`INSERT INTO collection_group_assets(group_id,collection_id,asset_id) VALUES(?,?,?)
 ON CONFLICT(collection_id,asset_id) DO UPDATE SET group_id=excluded.group_id`, groupID, collectionID, hash); err != nil {
			return err
		}
	}
	for _, hash := range remove {
		query := "DELETE FROM collection_group_assets WHERE collection_id=? AND asset_id=?"
		args := []any{collectionID, hash}
		if groupID != "" {
			query += " AND group_id=?"
			args = append(args, groupID)
		}
		if _, err := tx.Exec(query, args...); err != nil {
			return err
		}
	}
	_, err := tx.Exec("DELETE FROM collection_groups WHERE collection_id=? AND NOT EXISTS(SELECT 1 FROM collection_group_assets g WHERE g.group_id=collection_groups.id)", collectionID)
	return err
}

func (l *Library) createGroup(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs  []string `json:"ids"`
		Name string   `json:"name"`
	}
	if !decode(w, r, &p) {
		return
	}
	collectionID := chi.URLParam(r, "id")
	groupID := id()
	err := l.editGroup(collectionID, groupID, requestScope(r.URL.Query()), p.IDs, nil, true, &p.Name)
	if err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 201, map[string]string{"id": groupID})
}

func (l *Library) editGroup(collectionID, groupID, scope string, add, remove []string, create bool, name *string) error {
	if !validID.MatchString(collectionID) || (groupID != "" && !validID.MatchString(groupID)) || (groupID == "" && (create || len(add) > 0)) {
		return fmt.Errorf("分组编号无效")
	}
	if len(add)+len(remove) > 2000 {
		return fmt.Errorf("每次最多修改 2000 个素材")
	}
	if name != nil {
		if groupID == "" {
			return fmt.Errorf("请指定要命名的分组")
		}
		trimmed := strings.TrimSpace(*name)
		if utf8.RuneCountInString(trimmed) > 80 {
			return fmt.Errorf("分组名称最多 80 个字符")
		}
		name = &trimmed
	}
	tx, err := l.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = validateGroupMembers(tx, collectionID, scope, append(append([]string{}, add...), remove...)); err != nil {
		return err
	}
	if create {
		ungrouped := make([]string, 0, len(add))
		seen := map[string]bool{}
		for _, hash := range add {
			if seen[hash] {
				continue
			}
			seen[hash] = true
			var grouped bool
			if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM collection_group_assets WHERE collection_id=? AND asset_id=?)", collectionID, hash).Scan(&grouped); err != nil {
				return err
			}
			if !grouped {
				ungrouped = append(ungrouped, hash)
			}
		}
		if len(ungrouped) < 2 {
			return fmt.Errorf("至少选择两个未分组的素材组成一组")
		}
		add = ungrouped
		_, err = tx.Exec("INSERT INTO collection_groups(id,collection_id,created_at) VALUES(?,?,?)", groupID, collectionID, now())
	} else if groupID != "" {
		var exists bool
		err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM collection_groups WHERE id=? AND collection_id=?)", groupID, collectionID).Scan(&exists)
		if err == nil && !exists {
			err = fmt.Errorf("分组已不存在，请刷新后重试")
		}
	}
	if err != nil {
		return err
	}
	if name != nil {
		if _, err = tx.Exec("UPDATE collection_groups SET name=? WHERE id=? AND collection_id=?", *name, groupID, collectionID); err != nil {
			return err
		}
	}
	if len(add)+len(remove) > 0 {
		if err = moveGroupMembers(tx, collectionID, groupID, add, remove); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Library) updateGroup(w http.ResponseWriter, r *http.Request) {
	var p struct {
		AddIDs    []string `json:"addIds"`
		RemoveIDs []string `json:"removeIds"`
		Name      *string  `json:"name"`
	}
	if !decode(w, r, &p) {
		return
	}
	if err := l.editGroup(chi.URLParam(r, "id"), chi.URLParam(r, "group"), requestScope(r.URL.Query()), p.AddIDs, p.RemoveIDs, false, p.Name); err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (l *Library) deleteGroup(w http.ResponseWriter, r *http.Request) {
	collectionID, groupID := chi.URLParam(r, "id"), chi.URLParam(r, "group")
	if !validID.MatchString(collectionID) || !validID.MatchString(groupID) {
		fail(w, 400, "分组编号无效")
		return
	}
	result, err := l.DB.Exec("DELETE FROM collection_groups WHERE id=? AND collection_id=?", groupID, collectionID)
	if err != nil {
		fail(w, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		fail(w, 404, "分组已不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
