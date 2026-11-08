package library

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
)

type CaptureTimeRecalculation struct {
	Selected int  `json:"selected"`
	Changed  int  `json:"changed"`
	Known    int  `json:"known"`
	Unknown  int  `json:"unknown"`
	Applied  bool `json:"applied"`
}

func RecalculateScreenshotTimes(ctx context.Context, root string, apply, assigned bool) (CaptureTimeRecalculation, error) {
	var result CaptureTimeRecalculation
	path, err := filepath.Abs(filepath.Join(root, "curio.sqlite"))
	if err != nil {
		return result, err
	}
	u := url.URL{Scheme: "file", Path: path}
	q := u.Query()
	q.Set("mode", "ro")
	if apply {
		q.Set("mode", "rw")
	}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return result, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=10000"); err != nil {
		return result, err
	}
	l := &Library{DB: db, Root: filepath.Dir(path), CPU: make(chan struct{}, 1), backgroundCPU: make(chan struct{}, 1)}
	const live = "a.purge_pending=0 AND a.trashed_at='' AND a.kind IN ('image','video')"
	assignment := "s.game_id IS NULL"
	if assigned {
		assignment = "s.game_id IS NOT NULL"
	}
	rows, err := db.QueryContext(ctx, `SELECT a.id,a.name,s.captured_at,s.game_id FROM screenshots s JOIN assets a ON a.id=s.asset_id
 WHERE s.enabled=1 AND `+assignment+` AND `+live+` ORDER BY a.id`)
	if err != nil {
		return result, err
	}
	type candidate struct {
		hash, name, before, after string
		gameID                    sql.NullString
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.hash, &c.name, &c.before, &c.gameID); err != nil {
			rows.Close()
			return result, err
		}
		candidates = append(candidates, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	result.Selected = len(candidates)
	for i := range candidates {
		c := &candidates[i]
		names := []string{c.name}
		rows, err := db.QueryContext(ctx, "SELECT name FROM sources WHERE asset_id=? ORDER BY created_at,id", c.hash)
		if err != nil {
			return result, err
		}
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				rows.Close()
				return result, err
			}
			names = append(names, name)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return result, err
		}
		// A reader failure aborts the batch rather than clearing previously known times.
		c.after, err = l.readScreenshotCaptureTime(ctx, c.hash, names...)
		if err != nil {
			return result, err
		}
		if c.after != c.before {
			result.Changed++
		}
		if c.after == "" {
			result.Unknown++
		} else {
			result.Known++
		}
	}
	if !apply || result.Changed == 0 {
		result.Applied = apply
		return result, nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	for _, c := range candidates {
		if c.before == c.after {
			continue
		}
		updated, err := tx.ExecContext(ctx, `UPDATE screenshots SET captured_at=?
 WHERE asset_id=? AND captured_at=? AND enabled=1 AND game_id IS ?
 AND EXISTS(SELECT 1 FROM assets a WHERE a.id=screenshots.asset_id AND `+live+`)`, c.after, c.hash, c.before, c.gameID)
		if err != nil {
			return result, err
		}
		count, err := updated.RowsAffected()
		if err != nil {
			return result, err
		}
		if count != 1 {
			return result, fmt.Errorf("screenshot selection changed during recalculation; no times committed")
		}
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	result.Applied = true
	return result, nil
}
