"""Exercise shared image helpers with actual image files and the process pool."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from PIL import Image, ImageChops, features

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python_backend'))
from tasks.alpha import flatten_alpha_one
from tasks.augment import cutout_one, perspective_one, gaussian_blur_noise_one
from tasks.convert import convert_one
from tasks.crop import crop_one, crop_auto_one
from tasks.flip import flip_one
from tasks import resize, parallel


class ImageOperationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.png'
        image = Image.new('RGB', (120, 80))
        image.putdata([(x * 7 % 256, y * 11 % 256, (x * y) % 256) for y in range(80) for x in range(120)])
        image.save(self.source)
        self.original = self.source.read_bytes()

    def test_shared_operations_keep_output_sizes_names_and_source(self):
        detector = Mock()
        detector.get.return_value = []
        with patch.object(resize, '_get_detector', return_value=detector):
            cases = [
                (flip_one(str(self.source), str(self.root)), 'source_flip.png', (120, 80)),
                (crop_one(str(self.source), str(self.root), 1, 1), 'source_crop.png', (80, 80)),
                (resize.resize_one(str(self.source), str(self.root), 60, 60), 'source_resized.png', (60, 60)),
                (convert_one(str(self.source), str(self.root), 'jpg'), 'source.jpg', (120, 80)),
                (cutout_one(str(self.source), str(self.root)), 'source_cutout.png', (120, 80)),
                (perspective_one(str(self.source), str(self.root)), 'source_persp.png', (120, 80)),
                (gaussian_blur_noise_one(str(self.source), str(self.root)), 'source_blurnoise.png', (120, 80)),
                (crop_auto_one(str(self.source), str(self.root), [(1, 1), (3, 2)]), 'source.png', (120, 80)),
            ]
        for result, name, size in cases:
            with self.subTest(name=name):
                self.assertTrue(result['ok'], result)
                self.assertEqual(Path(result['output']).name, name)
                with Image.open(result['output']) as image:
                    self.assertEqual(image.size, size)
        self.assertEqual(self.source.read_bytes(), self.original)
        rgba = self.root / 'alpha.png'
        Image.new('RGBA', (20, 10), (255, 0, 0, 0)).save(rgba)
        result = flatten_alpha_one(str(rgba), str(self.root), 'white')
        self.assertTrue(result['ok'], result)
        with Image.open(result['output']) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    @unittest.skipUnless(features.check('avif'), 'Pillow AVIF support unavailable')
    def test_avif_flip_preserves_the_previous_quality_95_encoding(self):
        avif = self.root / 'source.avif'
        reference = self.root / 'reference.avif'
        with Image.open(self.source) as image:
            image.save(avif, quality=95)
        with Image.open(avif) as image:
            image.transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(reference, quality=95)
        result = flip_one(str(avif), str(self.root))
        self.assertTrue(result['ok'], result)
        with Image.open(result['output']) as actual, Image.open(reference) as expected:
            self.assertIsNone(ImageChops.difference(actual, expected).getbbox())

    def test_real_process_pool_reports_bad_image_and_keeps_successful_output(self):
        try:
            results = parallel.run_parallel(flip_one, [
                (str(self.source), str(self.root)),
                (str(self.root / 'missing.png'), str(self.root)),
            ])
        finally:
            pool = parallel._pool
            parallel._pool = None
            if pool is not None:
                pool.shutdown(wait=True, cancel_futures=True)
        self.assertTrue(results[0]['ok'])
        self.assertFalse(results[1]['ok'])
        self.assertTrue(Path(results[0]['output']).exists())


if __name__ == '__main__':
    unittest.main()
