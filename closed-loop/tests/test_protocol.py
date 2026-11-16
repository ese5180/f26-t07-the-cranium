import binascii
import ctypes as c
import random
import subprocess
import tempfile
import unittest
from pathlib import Path
from workbench.build import ROOT
from workbench.protocol import encode


class Frame(c.Structure):
    _fields_ = [('seq', c.c_uint32), ('length', c.c_size_t), ('payload', c.c_char*481)]


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path = Path(cls.temp.name)/'protocol.so'
        subprocess.run(['cc','-shared','-fPIC','-std=c11','-Wall','-Wextra','-Werror',
                        str(ROOT/'app/src/protocol.c'),'-o',str(path)],check=True)
        cls.lib = c.CDLL(str(path))
        cls.lib.cranium_parse.argtypes=[c.c_char_p,c.c_size_t,c.POINTER(Frame)]
        cls.lib.cranium_crc.argtypes=[c.c_char_p,c.c_size_t];cls.lib.cranium_crc.restype=c.c_uint16
        cls.lib.cranium_sequence_new.argtypes=[c.c_uint32,c.c_uint32,c.c_bool]
        cls.lib.cranium_sequence_new.restype=c.c_bool

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def parse(self,wire):
        out=Frame(); result=self.lib.cranium_parse(wire,len(wire),c.byref(out));return result,out

    def test_known_crc_vector(self):
        self.assertEqual(self.lib.cranium_crc(b'123456789',9),0x29b1)

    def test_host_to_actual_firmware_parser_unicode_and_boundaries(self):
        for seq in (0,99,0xffffffff):
            for payload in ({'title':'Nanana'},{'title':'Beyoncé 漢字 🎵'},{'value':'*:*:C1:'},{'s':'x'*472}):
                wire=encode(seq,payload);code,frame=self.parse(wire)
                self.assertEqual(code,0);self.assertEqual(frame.seq,seq)
                self.assertEqual(len(frame.payload),frame.length)

    def test_corruption_rejected_by_real_firmware(self):
        wire=bytearray(encode(1,{'title':'Nanana'}));wire[wire.index(b'Nanana')]=ord('X')
        self.assertEqual(self.parse(bytes(wire))[0],2)

    def test_truncation_overflow_and_embedded_newline_rejected(self):
        wire=encode(1,{'title':'a'})
        for malformed in (wire[:-4],b'C1:4294967296:2:{}*0000\n',b'C1:1:9999999999999:{}*0000\n',
                          b'C1:1:600:'+b'a'*600+b'*0000\n',b'C1:1:2:\n\n*0000\n'):
            self.assertNotEqual(self.parse(malformed)[0],0)
        with self.assertRaises(ValueError):encode(1,{'s':'x'*481})

    def test_duplicates_stale_and_wrap(self):
        f=self.lib.cranium_sequence_new
        self.assertTrue(f(0,0,False));self.assertFalse(f(99,99,True))
        self.assertFalse(f(98,99,True));self.assertTrue(f(0,0xffffffff,True))

    def test_fuzz_bounded_parser(self):
        rng=random.Random(5180)
        for _ in range(1500):
            n=rng.randrange(600)
            self.assertIn(self.parse(bytes(rng.randrange(256) for _ in range(n)))[0],range(4))
