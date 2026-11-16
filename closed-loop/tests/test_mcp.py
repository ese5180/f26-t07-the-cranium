import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from workbench import mcp,runner
from workbench.build import ROOT


class ToolTests(unittest.TestCase):
    def test_real_stdio_handshake_and_tool_listing(self):
        wire='\n'.join(json.dumps(r) for r in (
            {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
            {'jsonrpc':'2.0','method':'notifications/initialized'},
            {'jsonrpc':'2.0','id':2,'method':'tools/list'}))+'\n'
        p=subprocess.run([str(ROOT/'mcp-server')],input=wire,text=True,capture_output=True,timeout=5,check=True)
        replies=[json.loads(x) for x in p.stdout.splitlines()]
        self.assertEqual(len(replies),2)
        self.assertEqual(replies[0]['result']['serverInfo']['name'],'cranium-bench')
        self.assertEqual(len(replies[1]['result']['tools']),7)

    def test_adapter_rejects_arbitrary_commands_profiles_and_paths(self):
        for name,args in (('shell',{'command':'anything'}),('cranium_start_build',{'profile':'../other'}),
                          ('cranium_job_status',{'job_id':'../../private'})):
            with self.assertRaises(ValueError):mcp.call(name,args)

    def test_simulated_instrument_cannot_satisfy_doctor(self):
        cfg=json.loads((ROOT/'bench.example.json').read_text())
        cfg.update(board_serial='12345',uart_port='test-uart',ppk2_port='test-ppk',power_wiring_verified=True,saleae_device_id='SIM')
        with patch.object(runner,'serial_inventory',return_value=[{'port':'test-uart','vid':0x1366,'serial':'00012345'}]),\
             patch.object(runner,'logic_devices',return_value=[{'id':'SIM','simulation':True}]),\
             patch('ppk2_api.ppk2_api.PPK2_API.list_devices',return_value=['test-ppk']):
            result=runner.doctor(cfg)
        self.assertFalse(result['ready'])
        self.assertTrue(any('real Saleae' in reason for reason in result['blocking']))
