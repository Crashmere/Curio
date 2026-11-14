package library

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
)

var errNativeMP4Ordinary = errors.New("MP4 does not need layout normalization")

const (
	nativeMP4MetadataLimit = 16 << 20
	nativeMP4AtomLimit     = 4096
	nativeMP4MinimumMDATs  = 8
	nativeMP4DepthLimit    = 16
	nativeMP4SampleLimit   = 1 << 20
)

type nativeMP4Box struct {
	kind string
	raw  []byte
	body []byte
}

type nativeMP4Span struct{ start, end int64 }

type nativeMP4Chunk struct {
	offset int64
	bytes  int64
}

type nativeMP4Track struct {
	id        uint32
	handler   string
	codec     string
	timescale uint32
	sizes     []uint32
	chunks    []nativeMP4Chunk
	stsc      []byte
}

type nativeMP4 struct {
	ftyp, moov     []byte
	movieTimescale uint32
	tracks         []nativeMP4Track
	mdats          []nativeMP4Span
	moovOffset     int64
}

type nativeMP4Result struct {
	size     int64
	digest   string
	modified int64
}

func nativeMP4Boxes(data []byte) ([]nativeMP4Box, error) {
	var result []nativeMP4Box
	for len(data) > 0 {
		if len(data) < 8 {
			return nil, fmt.Errorf("short MP4 atom")
		}
		n, header := uint64(binary.BigEndian.Uint32(data)), 8
		if n == 1 {
			if len(data) < 16 {
				return nil, fmt.Errorf("short extended MP4 atom")
			}
			n, header = binary.BigEndian.Uint64(data[8:]), 16
		}
		if n < uint64(header) || n > uint64(len(data)) {
			return nil, fmt.Errorf("invalid MP4 atom extent")
		}
		result = append(result, nativeMP4Box{string(data[4:8]), data[:int(n)], data[header:int(n)]})
		if len(result) > nativeMP4AtomLimit {
			return nil, fmt.Errorf("too many MP4 atoms")
		}
		data = data[int(n):]
	}
	return result, nil
}

func nativeMP4Child(data []byte, kind string) (nativeMP4Box, error) {
	boxes, err := nativeMP4Boxes(data)
	if err != nil {
		return nativeMP4Box{}, err
	}
	var found *nativeMP4Box
	for i := range boxes {
		if boxes[i].kind == kind {
			if found != nil {
				return nativeMP4Box{}, fmt.Errorf("duplicate MP4 %s", kind)
			}
			found = &boxes[i]
		}
	}
	if found == nil {
		return nativeMP4Box{}, fmt.Errorf("missing MP4 %s", kind)
	}
	return *found, nil
}

func nativeMP4Word(data []byte, at int) (uint32, error) {
	if at < 0 || at+4 > len(data) {
		return 0, fmt.Errorf("short MP4 field")
	}
	return binary.BigEndian.Uint32(data[at:]), nil
}

func nativeMP4Timescale(data []byte) (uint32, error) {
	if len(data) < 4 || data[0] > 1 {
		return 0, fmt.Errorf("unsupported MP4 timing header")
	}
	at := 12
	if data[0] == 1 {
		at = 20
	}
	n, err := nativeMP4Word(data, at)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("invalid MP4 timescale")
	}
	return n, nil
}

// Only these container paths are traversed; offset-bearing auxiliary layouts
// are excluded rather than copied into a file with different sample positions.
func nativeMP4CheckBoxes(data []byte, parent string) error {
	return nativeMP4CheckBoxesAt(data, parent, 0)
}

func nativeMP4CheckBoxesAt(data []byte, parent string, depth int) error {
	if depth > nativeMP4DepthLimit {
		return fmt.Errorf("MP4 metadata nesting exceeds its bound")
	}
	boxes, err := nativeMP4Boxes(data)
	if err != nil {
		return err
	}
	for _, box := range boxes {
		switch box.kind {
		case "mvex", "moof", "sidx", "saio", "saiz", "senc", "iloc", "uuid", "cmov", "rmra", "rmda", "meco", "sinf", "schi", "schm", "tenc":
			return fmt.Errorf("unsupported MP4 %s", box.kind)
		}
		if nativeMP4KindAllowed(box.kind, "stsd", "stsc", "stco", "co64") && parent != "stbl" {
			return fmt.Errorf("unscoped MP4 sample table %s", box.kind)
		}
		allowed := true
		switch parent {
		case "moov":
			allowed = nativeMP4KindAllowed(box.kind, "mvhd", "trak", "udta", "meta", "iods", "free", "skip")
		case "trak":
			allowed = nativeMP4KindAllowed(box.kind, "tkhd", "tref", "edts", "mdia", "udta", "meta", "free", "skip")
		case "mdia":
			allowed = nativeMP4KindAllowed(box.kind, "mdhd", "hdlr", "elng", "minf", "udta", "free", "skip")
		case "minf":
			allowed = nativeMP4KindAllowed(box.kind, "vmhd", "smhd", "dinf", "stbl", "free", "skip")
		case "edts":
			allowed = nativeMP4KindAllowed(box.kind, "elst", "free", "skip")
		case "dinf":
			allowed = box.kind == "dref"
		case "meta":
			allowed = nativeMP4KindAllowed(box.kind, "hdlr", "keys", "ilst", "free", "skip")
		case "avc1", "avc3":
			allowed = nativeMP4KindAllowed(box.kind, "avcC", "pasp", "colr", "gama", "clap", "btrt", "fiel", "mdcv", "clli", "free")
		case "mp4a":
			allowed = nativeMP4KindAllowed(box.kind, "esds", "chan", "btrt", "free")
		case "stbl":
			switch box.kind {
			case "stsd", "stts", "ctts", "stss", "stsz", "stsc", "stco", "co64", "sdtp", "stdp", "sgpd", "sbgp":
			default:
				allowed = false
			}
		}
		if !allowed {
			return fmt.Errorf("unsupported MP4 %s child %s", parent, box.kind)
		}
		switch box.kind {
		case "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta":
			if err := nativeMP4CheckBoxesAt(box.body, box.kind, depth+1); err != nil {
				return err
			}
		case "meta":
			if len(box.body) < 4 {
				return fmt.Errorf("short MP4 meta")
			}
			if err := nativeMP4CheckBoxesAt(box.body[4:], box.kind, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func nativeMP4KindAllowed(kind string, kinds ...string) bool {
	for _, allowed := range kinds {
		if kind == allowed {
			return true
		}
	}
	return false
}

func readNativeMP4(path string) (*nativeMP4, error) {
	return readNativeMP4WithMinimum(path, 1)
}

func readNativeMP4WithMinimum(path string, minimumMDATs int) (*nativeMP4, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("invalid MP4 file")
	}
	result := &nativeMP4{}
	for offset, count := int64(0), 0; offset < stat.Size(); count++ {
		if count >= nativeMP4AtomLimit || stat.Size()-offset < 8 {
			return nil, fmt.Errorf("MP4 atom scan exceeds its bound")
		}
		var header [16]byte
		if _, err := file.ReadAt(header[:8], offset); err != nil {
			return nil, err
		}
		n, hs := int64(binary.BigEndian.Uint32(header[:4])), int64(8)
		if n == 1 {
			if _, err := file.ReadAt(header[8:], offset+8); err != nil {
				return nil, err
			}
			large := binary.BigEndian.Uint64(header[8:])
			if large > uint64(stat.Size()) {
				return nil, fmt.Errorf("invalid extended MP4 extent")
			}
			n, hs = int64(large), 16
		} else if n == 0 {
			n = stat.Size() - offset
		}
		if n < hs || n > stat.Size()-offset {
			return nil, fmt.Errorf("invalid top-level MP4 extent")
		}
		kind := string(header[4:8])
		switch kind {
		case "mdat":
			result.mdats = append(result.mdats, nativeMP4Span{offset + hs, offset + n})
		case "ftyp", "moov":
			if n > nativeMP4MetadataLimit || (kind == "ftyp" && n > 4096) {
				return nil, fmt.Errorf("MP4 metadata exceeds its bound")
			}
			data := make([]byte, int(n))
			if _, err := file.ReadAt(data, offset); err != nil {
				return nil, err
			}
			if kind == "ftyp" {
				if result.ftyp != nil {
					return nil, fmt.Errorf("duplicate MP4 ftyp")
				}
				result.ftyp = data
			} else {
				if result.moov != nil {
					return nil, fmt.Errorf("duplicate MP4 moov")
				}
				result.moov = data
				result.moovOffset = offset
			}
		case "free", "skip", "wide":
		default:
			return nil, fmt.Errorf("unsupported top-level MP4 %s", kind)
		}
		offset += n
	}
	if result.ftyp == nil || result.moov == nil || len(result.mdats) == 0 {
		return nil, fmt.Errorf("missing MP4 media or metadata")
	}
	if minimumMDATs == 0 && !result.needsNormalization() || minimumMDATs > 0 && len(result.mdats) < minimumMDATs {
		return nil, errNativeMP4Ordinary
	}
	moov, err := nativeMP4Child(result.moov, "moov")
	if err != nil {
		return nil, err
	}
	if err = nativeMP4CheckBoxes(moov.body, "moov"); err != nil {
		return nil, err
	}
	mvhd, err := nativeMP4Child(moov.body, "mvhd")
	if err != nil {
		return nil, err
	}
	result.movieTimescale, err = nativeMP4Timescale(mvhd.body)
	if err != nil {
		return nil, err
	}
	boxes, err := nativeMP4Boxes(moov.body)
	if err != nil {
		return nil, err
	}
	for _, box := range boxes {
		if box.kind != "trak" {
			continue
		}
		track, err := readNativeMP4Track(box, result.mdats)
		if err != nil {
			return nil, err
		}
		if track.id != uint32(len(result.tracks)+1) {
			return nil, fmt.Errorf("unsupported MP4 track numbering")
		}
		for _, previous := range result.tracks {
			if previous.handler == track.handler {
				return nil, fmt.Errorf("multiple MP4 tracks of one type")
			}
		}
		result.tracks = append(result.tracks, track)
	}
	if len(result.tracks) < 1 || len(result.tracks) > 2 {
		return nil, fmt.Errorf("unsupported MP4 track count")
	}
	video := false
	for _, track := range result.tracks {
		video = video || track.handler == "vide"
	}
	if !video {
		return nil, fmt.Errorf("missing MP4 video track")
	}
	var spans []nativeMP4Span
	for _, track := range result.tracks {
		for _, chunk := range track.chunks {
			spans = append(spans, nativeMP4Span{chunk.offset, chunk.offset + chunk.bytes})
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return nil, fmt.Errorf("overlapping MP4 chunks")
		}
	}
	return result, nil
}

func (mp4 *nativeMP4) needsNormalization() bool {
	return len(mp4.mdats) >= nativeMP4MinimumMDATs || len(mp4.mdats) > 0 && mp4.moovOffset > mp4.mdats[0].start
}

func readNativeMP4Track(trak nativeMP4Box, mdats []nativeMP4Span) (nativeMP4Track, error) {
	var result nativeMP4Track
	tkhd, err := nativeMP4Child(trak.body, "tkhd")
	if err != nil || len(tkhd.body) < 4 || tkhd.body[0] > 1 {
		return result, fmt.Errorf("unsupported MP4 track header")
	}
	idAt := 12
	if tkhd.body[0] == 1 {
		idAt = 20
	}
	result.id, err = nativeMP4Word(tkhd.body, idAt)
	if err != nil {
		return result, err
	}
	mdia, err := nativeMP4Child(trak.body, "mdia")
	if err != nil {
		return result, err
	}
	hdlr, err := nativeMP4Child(mdia.body, "hdlr")
	if err != nil || len(hdlr.body) < 12 {
		return result, fmt.Errorf("short MP4 handler")
	}
	result.handler = string(hdlr.body[8:12])
	if result.handler != "vide" && result.handler != "soun" {
		return result, fmt.Errorf("unsupported MP4 track handler")
	}
	mdhd, err := nativeMP4Child(mdia.body, "mdhd")
	if err != nil {
		return result, err
	}
	result.timescale, err = nativeMP4Timescale(mdhd.body)
	if err != nil {
		return result, err
	}
	minf, err := nativeMP4Child(mdia.body, "minf")
	if err != nil {
		return result, err
	}
	dinf, err := nativeMP4Child(minf.body, "dinf")
	if err != nil {
		return result, err
	}
	dref, err := nativeMP4Child(dinf.body, "dref")
	if err != nil || len(dref.body) < 8 || binary.BigEndian.Uint32(dref.body[4:8]) != 1 {
		return result, fmt.Errorf("unsupported MP4 data references")
	}
	refs, err := nativeMP4Boxes(dref.body[8:])
	if err != nil || len(refs) != 1 || refs[0].kind != "url " || len(refs[0].body) != 4 || binary.BigEndian.Uint32(refs[0].body) != 1 {
		return result, fmt.Errorf("external MP4 data reference")
	}
	stbl, err := nativeMP4Child(minf.body, "stbl")
	if err != nil {
		return result, err
	}
	tables, err := nativeMP4Boxes(stbl.body)
	if err != nil {
		return result, err
	}
	offsetTables := 0
	for _, table := range tables {
		if table.kind == "stco" || table.kind == "co64" {
			offsetTables++
		}
	}
	if offsetTables != 1 {
		return result, fmt.Errorf("ambiguous MP4 chunk offsets")
	}
	stsd, err := nativeMP4Child(stbl.body, "stsd")
	if err != nil || len(stsd.body) < 8 || binary.BigEndian.Uint32(stsd.body[4:8]) != 1 {
		return result, fmt.Errorf("multiple MP4 sample descriptions")
	}
	entries, err := nativeMP4Boxes(stsd.body[8:])
	if err != nil || len(entries) != 1 || len(entries[0].body) < 8 || binary.BigEndian.Uint16(entries[0].body[6:8]) != 1 {
		return result, fmt.Errorf("unsupported MP4 sample reference")
	}
	result.codec = entries[0].kind
	if (result.handler == "vide" && result.codec != "avc1" && result.codec != "avc3") || (result.handler == "soun" && result.codec != "mp4a") {
		return result, fmt.Errorf("unsupported native MP4 codec")
	}
	header := 78
	if result.handler == "soun" {
		header = 28
		if len(entries[0].body) < header || binary.BigEndian.Uint16(entries[0].body[8:10]) != 0 {
			return result, fmt.Errorf("unsupported MP4 audio sample entry version")
		}
	}
	if len(entries[0].body) < header {
		return result, fmt.Errorf("short MP4 sample entry")
	}
	if err := nativeMP4CheckBoxes(entries[0].body[header:], result.codec); err != nil {
		return result, err
	}
	stsz, err := nativeMP4Child(stbl.body, "stsz")
	if err != nil || len(stsz.body) < 12 {
		return result, fmt.Errorf("short MP4 sample sizes")
	}
	uniform, samples := binary.BigEndian.Uint32(stsz.body[4:8]), binary.BigEndian.Uint32(stsz.body[8:12])
	if samples == 0 || samples > nativeMP4SampleLimit || (uniform == 0 && uint64(samples)*4 != uint64(len(stsz.body)-12)) {
		return result, fmt.Errorf("invalid MP4 sample count")
	}
	result.sizes = make([]uint32, int(samples))
	for i := range result.sizes {
		result.sizes[i] = uniform
		if uniform == 0 {
			result.sizes[i] = binary.BigEndian.Uint32(stsz.body[12+i*4:])
		}
		if result.sizes[i] == 0 {
			return result, fmt.Errorf("empty MP4 sample")
		}
	}
	co, err := nativeMP4Child(stbl.body, "stco")
	width := 4
	if err != nil {
		co, err = nativeMP4Child(stbl.body, "co64")
		width = 8
	}
	if err != nil || len(co.body) < 8 {
		return result, fmt.Errorf("missing MP4 chunk offsets")
	}
	chunks := binary.BigEndian.Uint32(co.body[4:8])
	if chunks == 0 || chunks > nativeMP4SampleLimit || uint64(chunks)*uint64(width) != uint64(len(co.body)-8) {
		return result, fmt.Errorf("invalid MP4 chunk offsets")
	}
	sc, err := nativeMP4Child(stbl.body, "stsc")
	if err != nil || len(sc.body) < 8 {
		return result, fmt.Errorf("missing MP4 chunk mapping")
	}
	rules := binary.BigEndian.Uint32(sc.body[4:8])
	if rules == 0 || uint64(rules)*12 != uint64(len(sc.body)-8) {
		return result, fmt.Errorf("invalid MP4 chunk mapping")
	}
	var previous uint32
	for i := uint32(0); i < rules; i++ {
		at := 8 + int(i)*12
		first, amount, description := binary.BigEndian.Uint32(sc.body[at:]), binary.BigEndian.Uint32(sc.body[at+4:]), binary.BigEndian.Uint32(sc.body[at+8:])
		if first <= previous || (i == 0 && first != 1) || first > chunks || amount == 0 || description != 1 {
			return result, fmt.Errorf("unsupported MP4 chunk rule")
		}
		previous = first
	}
	result.stsc = sc.raw
	result.chunks = make([]nativeMP4Chunk, 0, int(chunks))
	sample, rule := uint64(0), uint32(0)
	for i := uint32(0); i < chunks; i++ {
		for rule+1 < rules && binary.BigEndian.Uint32(sc.body[8+int(rule+1)*12:]) <= i+1 {
			rule++
		}
		amount := uint64(binary.BigEndian.Uint32(sc.body[12+int(rule)*12:]))
		if sample+amount > uint64(len(result.sizes)) {
			return result, fmt.Errorf("MP4 chunk exceeds sample count")
		}
		position := uint64(binary.BigEndian.Uint32(co.body[8+int(i)*width:]))
		if width == 8 {
			position = binary.BigEndian.Uint64(co.body[8+int(i)*width:])
		}
		var length int64
		for _, n := range result.sizes[int(sample):int(sample+amount)] {
			length += int64(n)
		}
		span := sort.Search(len(mdats), func(i int) bool { return uint64(mdats[i].end) > position })
		if span == len(mdats) || position < uint64(mdats[span].start) || uint64(length) > uint64(mdats[span].end)-position {
			return result, fmt.Errorf("MP4 chunk is outside media data")
		}
		result.chunks = append(result.chunks, nativeMP4Chunk{int64(position), length})
		sample += amount
	}
	if sample != uint64(samples) {
		return result, fmt.Errorf("MP4 chunk and sample counts differ")
	}
	return result, nil
}

func nativeMP4Rewrite(box nativeMP4Box, body []byte) []byte {
	header := len(box.raw) - len(box.body)
	result := make([]byte, header+len(body))
	copy(result, box.raw[:header])
	if header == 16 {
		binary.BigEndian.PutUint64(result[8:16], uint64(len(result)))
	} else {
		binary.BigEndian.PutUint32(result, uint32(len(result)))
	}
	copy(result[header:], body)
	return result
}

func nativeMP4MappedMoov(original, muxed *nativeMP4, payloadStart int64) ([]byte, error) {
	var rewrite func(nativeMP4Box, *nativeMP4Track) ([]byte, error)
	rewrite = func(box nativeMP4Box, track *nativeMP4Track) ([]byte, error) {
		if box.kind == "trak" {
			tkhd, err := nativeMP4Child(box.body, "tkhd")
			if err != nil {
				return nil, err
			}
			at := 12
			if tkhd.body[0] == 1 {
				at = 20
			}
			id, err := nativeMP4Word(tkhd.body, at)
			if err != nil || id == 0 || int(id) > len(muxed.tracks) {
				return nil, fmt.Errorf("unmapped MP4 track")
			}
			track = &muxed.tracks[id-1]
		}
		if box.kind == "stsc" {
			if track == nil {
				return nil, fmt.Errorf("unscoped MP4 chunk mapping")
			}
			return track.stsc, nil
		}
		if box.kind == "stco" || box.kind == "co64" {
			if track == nil {
				return nil, fmt.Errorf("unscoped MP4 chunk offsets")
			}
			data := make([]byte, 16+len(track.chunks)*8)
			binary.BigEndian.PutUint32(data, uint32(len(data)))
			copy(data[4:8], "co64")
			binary.BigEndian.PutUint32(data[12:16], uint32(len(track.chunks)))
			for i, chunk := range track.chunks {
				binary.BigEndian.PutUint64(data[16+i*8:], uint64(payloadStart+chunk.offset-muxed.mdats[0].start))
			}
			return data, nil
		}
		switch box.kind {
		case "moov", "trak", "mdia", "minf", "stbl":
			children, err := nativeMP4Boxes(box.body)
			if err != nil {
				return nil, err
			}
			var body []byte
			for _, child := range children {
				data, err := rewrite(child, track)
				if err != nil {
					return nil, err
				}
				body = append(body, data...)
			}
			if len(body) > nativeMP4MetadataLimit {
				return nil, fmt.Errorf("normalized MP4 metadata exceeds its bound")
			}
			return nativeMP4Rewrite(box, body), nil
		default:
			return box.raw, nil
		}
	}
	moov, err := nativeMP4Child(original.moov, "moov")
	if err != nil {
		return nil, err
	}
	return rewrite(moov, nil)
}

func copyNativeMP4(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buffer := make([]byte, 1<<20)
	return copyNativeMP4Buffer(ctx, dst, src, buffer)
}

func copyNativeMP4Buffer(ctx context.Context, dst io.Writer, src io.Reader, buffer []byte) (int64, error) {
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := src.Read(buffer)
		if n > 0 {
			written, e := dst.Write(buffer[:n])
			total += int64(written)
			if e != nil {
				return total, e
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if err == io.EOF {
			return total, nil
		}
		if err != nil {
			return total, err
		}
	}
}

func nativeMP4TrackDigest(ctx context.Context, file *os.File, track nativeMP4Track) (string, error) {
	digest := sha256.New()
	buffer := make([]byte, 1<<20)
	for _, chunk := range track.chunks {
		if _, err := copyNativeMP4Buffer(ctx, digest, io.NewSectionReader(file, chunk.offset, chunk.bytes), buffer); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("%x", digest.Sum(nil)), nil
}

// FFmpeg orders unchanged samples, but rebuilds edit lists and timing headers.
// Reuse the original moov and change only its physical chunk mapping.
func repackNativeMP4(ctx context.Context, originalPath, muxedPath, outputPath string) (*nativeMP4Result, error) {
	original, err := readNativeMP4(originalPath)
	if err != nil {
		return nil, err
	}
	muxed, err := readNativeMP4(muxedPath)
	if err != nil {
		return nil, err
	}
	if len(muxed.mdats) != 1 || len(original.tracks) != len(muxed.tracks) {
		return nil, fmt.Errorf("unsupported normalized MP4 layout")
	}
	source, err := os.Open(originalPath)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	ordered, err := os.Open(muxedPath)
	if err != nil {
		return nil, err
	}
	defer ordered.Close()
	var payloadBytes int64
	for i, track := range original.tracks {
		other := muxed.tracks[i]
		if track.id != other.id || track.handler != other.handler || track.codec != other.codec || len(track.sizes) != len(other.sizes) {
			return nil, fmt.Errorf("normalized MP4 track differs")
		}
		for j, n := range track.sizes {
			if n != other.sizes[j] {
				return nil, fmt.Errorf("normalized MP4 sample sizes differ")
			}
			payloadBytes += int64(n)
		}
		left, err := nativeMP4TrackDigest(ctx, source, track)
		if err != nil {
			return nil, err
		}
		right, err := nativeMP4TrackDigest(ctx, ordered, other)
		if err != nil || left != right {
			return nil, fmt.Errorf("normalized MP4 encoded samples differ: %v", err)
		}
	}
	mdat := muxed.mdats[0]
	if payloadBytes != mdat.end-mdat.start {
		return nil, fmt.Errorf("unmapped normalized MP4 payload")
	}
	moov, err := nativeMP4MappedMoov(original, muxed, 0)
	if err != nil {
		return nil, err
	}
	start := int64(len(original.ftyp) + len(moov) + 8)
	moov, err = nativeMP4MappedMoov(original, muxed, start)
	if err != nil {
		return nil, err
	}
	if payloadBytes+8 > int64(^uint32(0)) {
		return nil, fmt.Errorf("normalized MP4 exceeds its media bound")
	}
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	complete := false
	defer func() {
		output.Close()
		if !complete {
			os.Remove(outputPath)
		}
	}()
	digest := sha256.New()
	writer := io.MultiWriter(output, digest)
	var header [8]byte
	binary.BigEndian.PutUint32(header[:4], uint32(payloadBytes+8))
	copy(header[4:], "mdat")
	for _, data := range [][]byte{original.ftyp, moov, header[:]} {
		if _, err = writer.Write(data); err != nil {
			return nil, err
		}
	}
	if _, err = copyNativeMP4(ctx, writer, io.NewSectionReader(ordered, mdat.start, payloadBytes)); err != nil {
		return nil, err
	}
	if err = output.Sync(); err != nil {
		return nil, err
	}
	stat, err := output.Stat()
	if err != nil || stat.Size() != start+payloadBytes {
		return nil, fmt.Errorf("normalized MP4 output size differs")
	}
	if err = output.Close(); err != nil {
		return nil, err
	}
	complete = true
	return &nativeMP4Result{size: stat.Size(), digest: fmt.Sprintf("%x", digest.Sum(nil)), modified: stat.ModTime().UnixNano()}, nil
}
