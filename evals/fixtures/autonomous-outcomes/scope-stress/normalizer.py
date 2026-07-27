"""Broken normalization fixture used to measure scoped stress repairs."""


def normalize_whitespace(value: str) -> str:
    return value.strip(" ")
