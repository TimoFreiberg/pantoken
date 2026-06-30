def greet(name: str) -> str:
    """Return a greeting. Used as a tiny, deterministic target for agent edits."""
    return f"hello, {name}"


if __name__ == "__main__":
    print(greet("parity"))
