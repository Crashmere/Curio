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
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	AssetIDs     []string `json:"assetIds"`
	CoverAssetID string   `json:"coverAssetId"`
	CoverURL     string   `json:"coverUrl"`
}

type collectionGroupSelection struct {
	CollectionID string   `json:"collectionId"`
	GroupIDs     []string `json:"groupIds"`
}

func selectedCollectionGroups(tx *sql.Tx, p assetPatch, scope string) ([]mediaGroup, error) {
	selection := p.PreserveCollectionGroups
	if selection == nil {
		return nil, nil
	}
	args := []any{selection.CollectionID}
	for _, groupID := range selection.GroupIDs {
		args = append(args, groupID)
	}
	for _, hash := range p.IDs {
		args = append(args, hash)
	}
	placeholders := func(count int) string { return strings.TrimSuffix(strings.Repeat("?,", count), ",") }
	rows, err := tx.Query(`SELECT g.id,g.name,j.asset_id,COALESCE(s.value,'') FROM collection_group_assets j
 JOIN collection_groups g ON g.id=j.group_id JOIN assets a ON a.id=j.asset_id
 LEFT JOIN catalog_settings s ON s.key='group_cover:'||g.id
 WHERE j.collection_id=? AND g.id IN (`+placeholders(len(selection.GroupIDs))+`) AND a.id IN (`+placeholders(len(p.IDs))+`)
 AND a.purge_pending=0 AND a.trashed_at='' AND `+scopeSQL(scope)+` ORDER BY g.id,a.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := []mediaGroup{}
	indices := map[string]int{}
	for rows.Next() {
		var groupID, name, hash, coverID string
		if err = rows.Scan(&groupID, &name, &hash, &coverID); err != nil {
			return nil, err
		}
		index, exists := indices[groupID]
		if !exists {
			index = len(groups)
			indices[groupID] = index
			groups = append(groups, mediaGroup{ID: groupID, Name: name, CoverAssetID: coverID})
		}
		groups[index].AssetIDs = append(groups[index].AssetIDs, hash)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for _, groupID := range selection.GroupIDs {
		if _, exists := indices[groupID]; !exists {
			return nil, fmt.Errorf("所选分组已变化或不在当前模式中，请刷新后重试")
		}
	}
	return groups, nil
}

func preserveCollectionGroups(tx *sql.Tx, p assetPatch, groups []mediaGroup) error {
	if len(groups) == 0 {
		return nil
	}
	seen := map[string]bool{p.PreserveCollectionGroups.CollectionID: true}
	for _, collectionID := range p.AddCollectionIDs {
		if seen[collectionID] {
			continue
		}
		seen[collectionID] = true
		for _, group := range groups {
			targetID, existing := "", 0
			for _, hash := range group.AssetIDs {
				var groupID string
				err := tx.QueryRow("SELECT group_id FROM collection_group_assets WHERE collection_id=? AND asset_id=?", collectionID, hash).Scan(&groupID)
				if err == sql.ErrNoRows {
					continue
				}
				if err != nil {
					return err
				}
				if targetID != "" && targetID != groupID {
					return fmt.Errorf("目标收藏集已有不同的分组，请先调整目标分组后重试")
				}
				targetID = groupID
				existing++
			}
			created := targetID == ""
			if created {
				targetID = id()
				if _, err := tx.Exec("INSERT INTO collection_groups(id,collection_id,name,created_at) VALUES(?,?,?,?)", targetID, collectionID, group.Name, now()); err != nil {
					return err
				}
			} else {
				var total int
				if err := tx.QueryRow("SELECT count(*) FROM collection_group_assets WHERE group_id=?", targetID).Scan(&total); err != nil {
					return err
				}
				// Reuse a compatible group without merging in unrelated target members.
				if total != existing {
					return fmt.Errorf("目标收藏集的分组包含其他素材，请先调整目标分组后重试")
				}
			}
			for _, hash := range group.AssetIDs {
				if _, err := tx.Exec("INSERT OR IGNORE INTO collection_group_assets(group_id,collection_id,asset_id) VALUES(?,?,?)", targetID, collectionID, hash); err != nil {
					return err
				}
				if created && hash == group.CoverAssetID {
					if _, err := tx.Exec("INSERT INTO catalog_settings(key,value) VALUES(?,?)", containerCoverKey("group", targetID), hash); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
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
	rows, err := l.DB.Query("SELECT g.group_id,cg.name,a.id,COALESCE(s.value,'') FROM assets a JOIN collection_group_assets g ON g.asset_id=a.id AND g.collection_id=? JOIN collection_groups cg ON cg.id=g.group_id LEFT JOIN catalog_settings s ON s.key='group_cover:'||cg.id"+where+" ORDER BY "+order, args...)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer rows.Close()
	items := []mediaGroup{}
	indices := map[string]int{}
	for rows.Next() {
		var groupID, name, assetID, coverID string
		if err = rows.Scan(&groupID, &name, &assetID, &coverID); err != nil {
			fail(w, 500, err)
			return
		}
		index, exists := indices[groupID]
		if !exists {
			index = len(items)
			indices[groupID] = index
			items = append(items, mediaGroup{ID: groupID, Name: name, AssetIDs: []string{}, CoverAssetID: coverID})
		}
		items[index].AssetIDs = append(items[index].AssetIDs, assetID)
	}
	if err = rows.Err(); err != nil {
		fail(w, 500, err)
		return
	}
	rows.Close()
	for i := range items {
		group := &items[i]
		matched := false
		for _, hash := range group.AssetIDs {
			if hash == group.CoverAssetID {
				matched = true
				break
			}
		}
		if !matched {
			group.CoverAssetID = group.AssetIDs[0]
		}
		group.CoverURL = l.coverThumbnailURL(group.CoverAssetID)
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
	if err != nil {
		return err
	}
	return pruneContainerCovers(tx)
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
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.Exec("DELETE FROM collection_groups WHERE id=? AND collection_id=?", groupID, collectionID)
	if err != nil {
		fail(w, 500, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		fail(w, 404, "分组已不存在")
		return
	}
	if err = pruneContainerCovers(tx); err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
