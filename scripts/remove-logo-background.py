"""Deterministically recover transparency from the approved logo's white matte."""

import argparse
from pathlib import Path

from PIL import Image


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
BACKGROUND_NOISE = 12


def unmatte_white(red: int, green: int, blue: int) -> tuple[int, int, int, int]:
    # The source was flattened over an almost-white checkerboard. For white
    # compositing, 255 - min(channel) is a conservative alpha estimate. It
    # preserves violet fringe pixels while treating the checker's 0..12 level
    # variation as background noise.
    raw_alpha = 255 - min(red, green, blue)
    if raw_alpha <= BACKGROUND_NOISE:
        return (0, 0, 0, 0)

    alpha = round((raw_alpha - BACKGROUND_NOISE) * 255 / (255 - BACKGROUND_NOISE))
    alpha = max(1, min(255, alpha))

    def recover(channel: int) -> int:
        value = (channel * 255 - 255 * (255 - alpha)) / alpha
        return max(0, min(255, round(value)))

    return (recover(red), recover(green), recover(blue), alpha)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=REPOSITORY_ROOT / "assets/source/t3-studio-logo-baked-background.png",
    )
    parser.add_argument(
        "--target", type=Path, default=REPOSITORY_ROOT / "assets/t3-studio-logo.png"
    )
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--preview-background", default="#121218")
    parser.add_argument(
        "--rendition",
        action="append",
        default=[],
        metavar="PATH:SIZE",
        help="Write an additional square transparent PNG rendition.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = Image.open(args.source).convert("RGB")
    transparent = Image.new("RGBA", source.size)
    transparent.putdata([unmatte_white(*pixel) for pixel in source.get_flattened_data()])
    args.target.parent.mkdir(parents=True, exist_ok=True)
    transparent.save(args.target, "PNG", optimize=True)

    for rendition in args.rendition:
        path_text, size_text = rendition.rsplit(":", 1)
        rendition_path = Path(path_text)
        rendition_size = int(size_text)
        rendition_path.parent.mkdir(parents=True, exist_ok=True)
        transparent.resize(
            (rendition_size, rendition_size), Image.Resampling.LANCZOS
        ).save(rendition_path, "PNG", optimize=True)

    if args.preview:
        background = args.preview_background.removeprefix("#")
        red, green, blue = (int(background[offset : offset + 2], 16) for offset in (0, 2, 4))
        preview_background = Image.new("RGBA", source.size, (red, green, blue, 255))
        preview_background.alpha_composite(transparent)
        preview_background.convert("RGB").save(args.preview, "PNG", optimize=True)


if __name__ == "__main__":
    main()
