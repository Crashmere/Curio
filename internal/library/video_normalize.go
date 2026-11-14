package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

type VideoNormalizationItem struct {
	ID       string `json:"id"`
	Size     int64  `json:"size"`
	Format   string `json:"format"`
	Category string `json:"category"`
	Reason   string `json:"reason,omitempty"`
	MDATs    int    `json:"mdats,omitempty"`
	TailMoov bool   `json:"tailMoov,omitempty"`
}

type VideoNormalizationReport struct {
	Items      []VideoNormalizationItem `json:"items"`
	Categories map[string]int           `json:"categories"`
	Eligible   []string                 `json:"eligible"`
	Applied    []string                 `json:"applied,omitempty"`
}

// Audit uses the same admission as upload processing, reads metadata only, and
// never opens the catalog through the schema-upgrading runtime path.
func AuditVideoNormalization(ctx context.Context, root string) (*VideoNormalizationReport, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: filepath.Join(root, "curio.sqlite")}
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	l := &Library{DB: db, Root: root, CPU: make(chan struct{}, 1)}
	var storageTable bool
	if err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='asset_storage' AND type='table')").Scan(&storageTable); err != nil {
		return nil, err
	}
	columns := "a.id,a.size,a.duration,a.format,a.mime,a.has_alpha,a.id"
	if storageTable {
		columns = "a.id," + storedSizeSQL + ",a.duration,a.format,a.mime,a.has_alpha," + storedHashSQL
	}
	rows, err := db.QueryContext(ctx, "SELECT "+columns+" FROM assets a WHERE a.kind='video' AND a.purge_pending=0 ORDER BY a.id")
	if err != nil {
		return nil, err
	}
	var assets []Asset
	for rows.Next() {
		a := Asset{Kind: "video"}
		if err = rows.Scan(&a.ID, &a.Size, &a.Duration, &a.Format, &a.MIME, &a.HasAlpha, &a.ContentHash); err != nil {
			rows.Close()
			return nil, err
		}
		assets = append(assets, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	report := &VideoNormalizationReport{Items: []VideoNormalizationItem{}, Categories: map[string]int{}, Eligible: []string{}}
	for _, a := range assets {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		item := VideoNormalizationItem{ID: a.ID, Size: a.Size, Format: a.Format, Category: "other-format"}
		switch {
		case a.ContentHash != a.ID:
			item.Category = "normalized"
		case a.Format != "mp4":
		default:
			path := l.storedObject(a)
			parsed, e := readNativeMP4WithMinimum(path, 0)
			switch {
			case errors.Is(e, errNativeMP4Ordinary):
				item.Category = "ordinary-layout"
			case e != nil:
				item.Category, item.Reason = "unsupported-layout", e.Error()
			default:
				item.MDATs = len(parsed.mdats)
				item.TailMoov = parsed.moovOffset > parsed.mdats[0].start
				stat, e := os.Lstat(path)
				if e != nil {
					return nil, e
				}
				spec, e := l.probePlaybackSource(ctx, a.ID, playbackStamp(a.ID, stat), a, stat)
				if e != nil {
					item.Category, item.Reason = "probe-error", e.Error()
				} else if !spec.nativeRemux {
					item.Category, item.Reason = "unsupported-codec-or-clock", "requires browser-compatible SDR H.264/AAC-LC and native timestamp admission"
				} else {
					item.Category = "eligible"
					report.Eligible = append(report.Eligible, a.ID)
				}
			}
		}
		report.Items = append(report.Items, item)
		report.Categories[item.Category]++
	}
	return report, nil
}

// Explicit maintenance runs select stable IDs from a prior audit. Run with the
// application stopped and its maintenance/deployment locks held.
func NormalizeSelectedVideos(ctx context.Context, root string, ids []string) ([]string, error) {
	if err := parseIDs(ids); err != nil {
		return nil, err
	}
	l, err := Open(root)
	if err != nil {
		return nil, err
	}
	defer l.DB.Close()
	var applied []string
	for _, hash := range ids {
		changed, err := l.normalizeVideo(ctx, hash)
		if err != nil {
			return applied, fmt.Errorf("normalize %s: %w", hash, err)
		}
		if changed {
			applied = append(applied, hash)
		}
	}
	return applied, nil
}
