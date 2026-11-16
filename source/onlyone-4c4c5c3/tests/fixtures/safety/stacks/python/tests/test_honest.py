import unittest


class TestCart(unittest.TestCase):
    def test_add(self):
        self.assertEqual(1 + 1, 2)

    def test_names(self):
        self.assertNotEqual('a', 'b')


def test_subtract():
    assert 3 - 1 == 2
