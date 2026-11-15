package library

import (
	"cmp"
	"strings"
	"unicode"
	"unicode/utf8"

	"modernc.org/sqlite"
)

const groupMemberOrder = "a.name COLLATE curio_natural_filename,a.id"

func init() {
	sqlite.MustRegisterCollationUtf8("curio_natural_filename", compareNaturalFilenames)
}

func filenameDigit(c byte) bool { return c >= '0' && c <= '9' }

func compareNaturalFilenames(left, right string) int {
	i, j := 0, 0
	for i < len(left) && j < len(right) {
		if filenameDigit(left[i]) && filenameDigit(right[j]) {
			leftEnd, rightEnd := i, j
			for leftEnd < len(left) && filenameDigit(left[leftEnd]) {
				leftEnd++
			}
			for rightEnd < len(right) && filenameDigit(right[rightEnd]) {
				rightEnd++
			}
			// Compare significant digits without overflowing on long artwork IDs.
			leftNumber := strings.TrimLeft(left[i:leftEnd], "0")
			rightNumber := strings.TrimLeft(right[j:rightEnd], "0")
			if order := cmp.Compare(len(leftNumber), len(rightNumber)); order != 0 {
				return order
			}
			if order := strings.Compare(leftNumber, rightNumber); order != 0 {
				return order
			}
			i, j = leftEnd, rightEnd
			continue
		}
		leftRune, leftSize := utf8.DecodeRuneInString(left[i:])
		rightRune, rightSize := utf8.DecodeRuneInString(right[j:])
		if order := cmp.Compare(unicode.ToLower(leftRune), unicode.ToLower(rightRune)); order != 0 {
			return order
		}
		i, j = i+leftSize, j+rightSize
	}
	if order := cmp.Compare(len(left)-i, len(right)-j); order != 0 {
		return order
	}
	return strings.Compare(left, right)
}
