import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from workbench import setup


class DownloadTests(unittest.TestCase):
    def fetch(self,body,digest,existing=None):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'archive.zip'
            if existing is not None:path.write_bytes(existing)
            with patch.object(setup.urllib.request,'urlopen',return_value=io.BytesIO(body)) as urlopen:
                try:setup.download('https://example.invalid/archive.zip',path,digest);error=None
                except RuntimeError as e:error=e
            return urlopen,(path.read_bytes() if path.exists() else None),sorted(p.name for p in Path(d).iterdir()),error

    def test_sends_explicit_user_agent(self):
        body=b'logic archive'
        urlopen,saved,_,error=self.fetch(body,hashlib.sha256(body).hexdigest())
        self.assertIsNone(error);self.assertEqual(saved,body)
        request=urlopen.call_args.args[0]
        self.assertEqual(request.full_url,'https://example.invalid/archive.zip')
        self.assertEqual(request.get_header('User-agent'),setup.USER_AGENT)
        self.assertTrue(setup.USER_AGENT.startswith('cranium-bench-setup/'))
        self.assertNotIn('Python-urllib',setup.USER_AGENT)

    def test_checksum_mismatch_rejected_and_nothing_kept(self):
        urlopen,saved,names,error=self.fetch(b'tampered',hashlib.sha256(b'expected').hexdigest())
        urlopen.assert_called_once()
        self.assertIsInstance(error,RuntimeError);self.assertIn('checksum mismatch',str(error))
        self.assertIsNone(saved);self.assertEqual(names,[])

    def test_verified_existing_archive_not_downloaded_again(self):
        body=b'already here'
        urlopen,saved,_,error=self.fetch(b'',hashlib.sha256(body).hexdigest(),existing=body)
        self.assertIsNone(error);urlopen.assert_not_called();self.assertEqual(saved,body)


if __name__=='__main__':
    unittest.main()
