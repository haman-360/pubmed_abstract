"""Raster sizes for the existing paper/checkmark logo; no remote images or AI calls."""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[2]
try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.path.insert(0, str(ROOT / 'ledger_private/app-build/vendor'))
    from PIL import Image, ImageDraw


def icon(size, maskable=False):
    scale = size * 4 / 192
    image = Image.new('RGB', (size * 4, size * 4), '#153d35')
    draw = ImageDraw.Draw(image)
    def point(p):
        return tuple((24 + v * .75 if maskable else v) * scale for v in p)
    def line(points, color, width):
        draw.line([point(p) for p in points], fill=color, width=round(width * scale * (.75 if maskable else 1)), joint='curve')
    draw.polygon([point(p) for p in [(47,48),(116,48),(145,77),(145,144),(47,144)]], fill='#f2f1e6')
    line([(116,48),(116,78),(145,78)], '#568575', 8)
    line([(65,95),(126,95)], '#568575', 8)
    line([(65,113),(109,113)], '#568575', 8)
    draw.ellipse([*point((113,117)),*point((161,165))], fill='#dfb66a')
    line([(125,141),(133,149),(149,131)], '#153d35', 7)
    return image.resize((size,size), Image.Resampling.LANCZOS)


if __name__ == '__main__':
    folder = Path(__file__).parent / 'app-icons'
    folder.mkdir(exist_ok=True)
    for filename,size,maskable in [('apple-touch-icon.png',180,False),('icon-192.png',192,False),('icon-512.png',512,False),('icon-maskable-512.png',512,True)]:
        icon(size,maskable).save(folder/filename,optimize=True)
    print('Generated four opaque PNG icons from the existing logo geometry.')
