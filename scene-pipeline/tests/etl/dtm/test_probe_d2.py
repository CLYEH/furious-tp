"""Probe D2 (FTP-53): ruff-clean, deliberately red test. Throwaway."""


def test_probe_d2_fails_on_purpose() -> None:
    """Fail on purpose: proves pytest gates independently of ruff."""
    assert 1 == 2, "probe D2: this failure is the point"
