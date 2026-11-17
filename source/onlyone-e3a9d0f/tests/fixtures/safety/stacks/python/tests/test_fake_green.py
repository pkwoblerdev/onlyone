import unittest

import pytest


class TestCart(unittest.TestCase):
    def test_tautology_true(self):
        self.assertTrue(True)

    def test_tautology_equal(self):
        self.assertEqual(1, 1)


@pytest.mark.skip(reason='later')
def test_skipped_by_marker():
    assert 1 + 1 == 2


def test_skipped_at_runtime():
    pytest.skip('not today')
    assert 1 + 1 == 2
