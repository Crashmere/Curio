package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

type collectionIndexGroup struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Scope         string   `json:"scope"`
	CollectionIDs []string `json:"collectionIds"`
}

type collectionLayout struct {
	Revision        int64                  `json:"revision"`
	Groups          []collectionIndexGroup `json:"groups"`
	CollectionOrder []string               `json:"collectionOrder"`
}

type collectionLayoutQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

var errCollectionGroupMissing = errors.New("分组已不存在，请刷新后重试")

func collectionIDs(ctx context.Context, q collectionLayoutQuery) ([]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT id FROM collections ORDER BY name COLLATE NOCASE,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			return nil, err
		}
		ids = append(ids, value)
	}
	return ids, rows.Err()
}

func readCollectionLayout(ctx context.Context, q collectionLayoutQuery) (collectionLayout, bool, error) {
	layout := collectionLayout{Groups: []collectionIndexGroup{}, CollectionOrder: []string{}}
	var value string
	err := q.QueryRowContext(ctx, "SELECT value FROM catalog_settings WHERE key='collection_groups'").Scan(&value)
	stored := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return layout, false, err
	}
	if stored {
		if err = json.Unmarshal([]byte(value), &layout); err != nil {
			return layout, true, err
		}
	}
	ids, err := collectionIDs(ctx, q)
	if err != nil {
		return layout, stored, err
	}
	known := make(map[string]bool, len(ids))
	for _, value := range ids {
		known[value] = true
	}
	order := make([]string, 0, len(ids))
	ordered := make(map[string]bool, len(ids))
	for _, value := range layout.CollectionOrder {
		if known[value] && !ordered[value] {
			order = append(order, value)
			ordered[value] = true
		}
	}
	for _, value := range ids {
		if !ordered[value] {
			order = append(order, value)
		}
	}
	layout.CollectionOrder = order
	if layout.Groups == nil {
		layout.Groups = []collectionIndexGroup{}
	}
	// Older programs ignore the layout when creating or deleting collections.
	for i := range layout.Groups {
		kept := []string{}
		for _, value := range layout.Groups[i].CollectionIDs {
			if known[value] {
				kept = append(kept, value)
			}
		}
		layout.Groups[i].CollectionIDs = kept
	}
	return layout, stored, nil
}

func writeCollectionLayout(ctx context.Context, tx *sql.Tx, layout collectionLayout) error {
	data, err := json.Marshal(layout)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO catalog_settings(key,value) VALUES('collection_groups',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(data))
	return err
}

func validateCollectionLayout(groups []collectionIndexGroup, order []string, ids []string) error {
	if len(groups) > 200 {
		return fmt.Errorf("最多创建 200 个分组")
	}
	known := make(map[string]bool, len(ids))
	for _, value := range ids {
		known[value] = true
	}
	groupIDs, names, grouped := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for i := range groups {
		group := &groups[i]
		group.Name = strings.TrimSpace(group.Name)
		if !validID.MatchString(group.ID) || groupIDs[group.ID] {
			return fmt.Errorf("分组编号无效或重复")
		}
		if group.Name == "" || group.Name == "未分组" || utf8.RuneCountInString(group.Name) > 80 || names[group.Name] {
			return fmt.Errorf("分组名称须为 1-80 个字符，不能重复或使用未分组")
		}
		if group.Scope != "normal" && group.Scope != "hidden" {
			return fmt.Errorf("分组展示模式无效")
		}
		groupIDs[group.ID], names[group.Name] = true, true
		if group.CollectionIDs == nil {
			group.CollectionIDs = []string{}
		}
		for _, value := range group.CollectionIDs {
			if !known[value] || grouped[value] {
				return fmt.Errorf("收藏集已不存在或在多个分组中，请刷新后重试")
			}
			grouped[value] = true
		}
	}
	if len(order) != len(ids) {
		return fmt.Errorf("收藏集排序必须包含全部收藏集，请刷新后重试")
	}
	ordered := make(map[string]bool, len(order))
	for _, value := range order {
		if !known[value] || ordered[value] {
			return fmt.Errorf("收藏集排序包含无效或重复项目，请刷新后重试")
		}
		ordered[value] = true
	}
	return nil
}

func (l *Library) getCollectionLayout(w http.ResponseWriter, r *http.Request) {
	tx, err := l.DB.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	layout, _, err := readCollectionLayout(r.Context(), tx)
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, layout)
}

func (l *Library) saveCollectionLayout(w http.ResponseWriter, r *http.Request) {
	var patch struct {
		BaseRevision    *int64                  `json:"baseRevision"`
		Groups          *[]collectionIndexGroup `json:"groups"`
		CollectionOrder *[]string               `json:"collectionOrder"`
	}
	if !decode(w, r, &patch) {
		return
	}
	if patch.BaseRevision == nil || *patch.BaseRevision < 0 || patch.Groups == nil {
		fail(w, 400, "请提交完整分组配置和当前版本")
		return
	}
	tx, err := l.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	current, _, err := readCollectionLayout(r.Context(), tx)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if *patch.BaseRevision != current.Revision {
		writeJSON(w, 409, map[string]any{"error": "收藏集分组已更新，请刷新后重试", "code": "collection_groups_changed", "revision": current.Revision})
		return
	}
	order := current.CollectionOrder
	if patch.CollectionOrder != nil {
		order = *patch.CollectionOrder
	}
	if err = validateCollectionLayout(*patch.Groups, order, current.CollectionOrder); err != nil {
		fail(w, 400, err)
		return
	}
	next := collectionLayout{Revision: current.Revision + 1, Groups: *patch.Groups, CollectionOrder: order}
	if next.Groups == nil {
		next.Groups = []collectionIndexGroup{}
	}
	if err = writeCollectionLayout(r.Context(), tx, next); err != nil {
		fail(w, 500, err)
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, next)
}

func syncCollectionLayout(ctx context.Context, tx *sql.Tx) error {
	layout, stored, err := readCollectionLayout(ctx, tx)
	if err != nil || !stored {
		return err
	}
	layout.Revision++
	return writeCollectionLayout(ctx, tx, layout)
}

func (l *Library) createCollectionWithLayout(ctx context.Context, entityID string, groupID *string, columns, values string, args []any) error {
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	layout, stored, err := readCollectionLayout(ctx, tx)
	if err != nil {
		return err
	}
	groupIndex := -1
	if groupID != nil {
		for i, group := range layout.Groups {
			if group.ID == *groupID {
				groupIndex = i
				break
			}
		}
		if groupIndex < 0 {
			return errCollectionGroupMissing
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO collections("+columns+") VALUES("+values+")", args...); err != nil {
		return err
	}
	if stored {
		layout.CollectionOrder = append(layout.CollectionOrder, entityID)
		if groupIndex >= 0 {
			layout.Groups[groupIndex].CollectionIDs = append(layout.Groups[groupIndex].CollectionIDs, entityID)
		}
		layout.Revision++
		if err = writeCollectionLayout(ctx, tx, layout); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Library) deleteCollectionWithLayout(ctx context.Context, entityID string) (int64, error) {
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "DELETE FROM collections WHERE id=?", entityID)
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil || n == 0 {
		return n, err
	}
	if err = syncCollectionLayout(ctx, tx); err != nil {
		return 0, err
	}
	if err = pruneContainerCovers(tx); err != nil {
		return 0, err
	}
	return n, tx.Commit()
}
