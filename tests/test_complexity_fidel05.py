"""FIDEL-05 regression tests for top_level_dir_width."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.complexity_scorer import FEATURE_KEYS, extract_features, score_features


def test_top_level_dir_width_in_feature_keys():
    assert 'top_level_dir_width' in FEATURE_KEYS


def test_top_level_dir_width_counts_distinct_first_segments():
    features = extract_features(None, {'files_expected': ['a/x.py', 'a/y.py', 'b/z.py', 'c/w.py']})
    assert features['top_level_dir_width'] == 3


def test_top_level_dir_width_single_dir():
    features = extract_features(None, {'files_expected': ['services/foo.py', 'services/bar.py', 'services/baz.py']})
    assert features['top_level_dir_width'] == 1


def test_top_level_dir_width_zero_when_empty():
    features = extract_features(None, {'files_expected': []})
    assert features['top_level_dir_width'] == 0


def test_top_level_dir_width_five_dirs():
    features = extract_features(None, {'files_expected': ['a/1.py', 'b/2.py', 'c/3.py', 'd/4.py', 'e/5.py']})
    assert features['top_level_dir_width'] == 5


def test_top_level_dir_width_bare_filename_ignored():
    features = extract_features(None, {'files_expected': ['bare_file.py', 'services/foo.py']})
    assert features['top_level_dir_width'] == 1


def test_score_features_still_works_with_new_key():
    features = extract_features(None, {'files_expected': ['services/a.py', 'tests/b.py', 'migrations/001.sql']})
    score = score_features(features)
    assert 0 <= score <= 100
