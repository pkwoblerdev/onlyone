package cart

import "testing"

func TestAdd(t *testing.T) {
	if got := 1 + 1; got != 2 {
		t.Errorf("1+1 = %d, want 2", got)
	}
}

func TestSub(t *testing.T) {
	if got := 3 - 1; got != 2 {
		t.Fatalf("3-1 = %d, want 2", got)
	}
}
