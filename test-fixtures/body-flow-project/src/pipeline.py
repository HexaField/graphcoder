def load(path):
    with open(path) as handle:
        return handle.read()


def transform(data):
    return data.upper()


def process(path, retries=3):
    for attempt in range(retries):
        try:
            data = load(path)
        except OSError:
            continue
        if not data:
            raise ValueError("empty")
        return transform(data)
    return None
