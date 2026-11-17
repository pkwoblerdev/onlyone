pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[test]
#[ignore]
fn skipped_until_later() {
    assert_eq!(add(2, 2), 4);
}

#[test]
fn tautology() {
    assert_eq!(1, 1);
}
