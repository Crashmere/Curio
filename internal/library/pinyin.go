package library

import (
	"slices"
	"strings"
	"unicode"

	"github.com/mozillazg/go-pinyin"
)

var pinyinArgs = func() pinyin.Args {
	a := pinyin.NewArgs()
	a.Heteronym = true
	return a
}()

// Each Han character supplies all readings; ASCII words remain single matching units.
func pinyinOf(text string) string {
	var units []string
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			units = append(units, word.String())
			word.Reset()
		}
	}
	for _, r := range text {
		switch {
		case r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			word.WriteRune(unicode.ToLower(r))
		case unicode.Is(unicode.Han, r):
			flush()
			var readings []string
			for _, reading := range pinyin.SinglePinyin(r, pinyinArgs) {
				for _, value := range []string{reading, strings.ReplaceAll(reading, "v", "u")} {
					if !slices.Contains(readings, value) {
						readings = append(readings, value)
					}
				}
			}
			if len(readings) == 0 {
				readings = []string{string(r)}
			}
			units = append(units, strings.Join(readings, "/"))
		default:
			flush()
		}
	}
	flush()
	return strings.Join(units, " ")
}
