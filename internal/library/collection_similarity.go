package library

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
)

func (l *Library) resolveSimilarity(ctx context.Context, collectionID, keepID, discardID, scope string) error {
	if !validID.MatchString(collectionID) {
		return fmt.Errorf("收藏集编号无效")
	}
	if err := parseIDs([]string{keepID, discardID}); err != nil {
		return err
	}
	if keepID == discardID {
		return fmt.Errorf("请选择两项不同的素材")
	}
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = validateGroupMembers(tx, collectionID, scope, []string{keepID, discardID}); err != nil {
		return err
	}
	// Inherit only within this collection; an existing keeper group takes precedence.
	result, err := tx.ExecContext(ctx, `INSERT INTO collection_group_assets(group_id,collection_id,asset_id)
 SELECT group_id,collection_id,? FROM collection_group_assets
 WHERE collection_id=? AND asset_id=?
 AND NOT EXISTS(SELECT 1 FROM collection_group_assets WHERE collection_id=? AND asset_id=?)`,
		keepID, collectionID, discardID, collectionID, keepID)
	if err != nil {
		return err
	}
	added, err := result.RowsAffected()
	if err != nil {
		return err
	}
	stamp := now()
	if added > 0 {
		if _, err = tx.ExecContext(ctx, "UPDATE assets SET updated_at=? WHERE id=?", stamp, keepID); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE assets SET trashed_at=?,updated_at=? WHERE id=?", stamp, stamp, discardID); err != nil {
		return err
	}
	return tx.Commit()
}

func (l *Library) resolveCollectionSimilarity(w http.ResponseWriter, r *http.Request) {
	var p struct {
		KeepID    string `json:"keepId"`
		DiscardID string `json:"discardId"`
	}
	if !decode(w, r, &p) {
		return
	}
	if err := l.resolveSimilarity(r.Context(), chi.URLParam(r, "id"), p.KeepID, p.DiscardID, requestScope(r.URL.Query())); err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
