package cart

import "testing"

func TestSkipped(t *testing.T) {
	t.Skip("not implemented yet")
	if 1+1 != 2 {
		t.Errorf("math is broken")
	}
}

func TestSkippedInShortMode(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	if 1+1 != 2 {
		t.Errorf("math is broken")
	}
}
