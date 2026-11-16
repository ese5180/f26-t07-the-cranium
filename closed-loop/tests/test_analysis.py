import csv
import math
from pathlib import Path
import tempfile
import unittest
from workbench.analysis import uart_bytes, uart_lines, validate_uart, power_stats, compare_power
from workbench.instruments import stimulus
from workbench.runner import requirements


def transitions(wire, start, baud=115200):
    edges=[(0,1)];level=1;t=start
    for byte in wire:
        for value in [0]+[(byte>>i)&1 for i in range(8)]+[1]:
            if value!=level:edges.append((t,value));level=value
            t+=1/baud
        t+=2/baud
    edges.append((t+.01,1))
    return edges


class AnalysisTests(unittest.TestCase):
    def test_independent_uart_decoder(self):
        wire=b'CRANIUM:READY\nACK:7:OK:0\n'
        decoded=uart_bytes(transitions(wire,.001))
        self.assertEqual(bytes(b for _,b,_ in decoded),wire)
        self.assertEqual(len(uart_lines(decoded)),2)

    def capture(self,folder,request,response,delay):
        rx=transitions(request,.001)
        end=uart_bytes(rx)[-1][2]
        tx=transitions(response,end+delay)
        times=sorted(set(t for t,_ in rx+tx))
        values=[1,1];positions=[0,0];lists=[rx,tx]
        path=folder/'digital.csv'
        with path.open('w',newline='') as f:
            w=csv.writer(f);w.writerow(['Time [s]','Channel 0','Channel 1'])
            for t in times:
                for i in range(2):
                    while positions[i]<len(lists[i]) and lists[i][positions[i]][0]<=t:
                        values[i]=lists[i][positions[i]][1];positions[i]+=1
                w.writerow([t,*values])
        return path

    def test_capture_must_prove_exact_bytes_and_timing(self):
        req=requirements();test=stimulus(req)[0]
        with tempfile.TemporaryDirectory() as d:
            path=self.capture(Path(d),bytes.fromhex(test['wire_hex']),b'ACK:0:OK:0\n',.001)
            cfg={'rx_channel':0,'tx_channel':1}
            self.assertTrue(validate_uart(path,cfg,req,[test])['passed'])
            wrong=dict(test,wire_hex=test['wire_hex'].replace('42656e6368','42656e6369'))
            with self.assertRaises(ValueError):validate_uart(path,cfg,req,[wrong])
            path=self.capture(Path(d),bytes.fromhex(test['wire_hex']),b'ACK:0:OK:0\n',.060)
            with self.assertRaises(ValueError):validate_uart(path,cfg,req,[test])

    def test_power_rejects_missing_sample_coverage_and_nonfinite(self):
        req=requirements()
        for values in ([],[1]*100,[float('nan')]*10000,[-1]*10000,[0]*10000):
            with self.assertRaises(ValueError):power_stats(values,.1,req)
        self.assertEqual(power_stats([3000]*10000,.1,req)['mean_uA'],3000)

    def test_power_requires_all_pairs_and_threshold(self):
        req=requirements()
        b=[{'mean_uA':3000}]*3;a=[{'mean_uA':1000}]*3
        self.assertTrue(compare_power(b,a,req)['passed'])
        self.assertFalse(compare_power(b,[{'mean_uA':2900}]*3,req)['passed'])
        self.assertFalse(compare_power(b,[{'mean_uA':1000},{'mean_uA':1000},{'mean_uA':4000}],req)['passed'])
        with self.assertRaises(ValueError):compare_power(b,a[:2],req)
