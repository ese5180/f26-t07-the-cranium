import importlib.util
from pathlib import Path
import unittest
from unittest import mock
import json
import tempfile
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent

def module(name):
    spec=importlib.util.spec_from_file_location(name,HERE/'pi'/f'{name}.py')
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

kiosk=module('kiosk');session=module('session')

class KioskChecks(unittest.TestCase):
    def test_config_preserves_hardware_but_removes_desktop_startup(self):
        original='''set $mod Mod1
output DSI-1 mode 800x480 transform 180
output * bg /home/pi/wallpaper.jpg fill
input "touch" {
 map_to_output DSI-1
 calibration_matrix 1 0 0 0 1 0
}
bar {
 swaybar_command waybar
}
popup_during_fullscreen leave_fullscreen
exec firefox
exec nm-applet
'''
        value=kiosk.configure_sway(original)
        self.assertIn('mode 800x480 transform 180',value)
        self.assertIn('calibration_matrix 1 0 0 0 1 0',value)
        self.assertIn('map_to_output DSI-1',value)
        self.assertNotIn('waybar',value)
        self.assertNotIn('exec firefox',value)
        self.assertNotIn('nm-applet',value)
        self.assertNotIn('leave_fullscreen',value)
        self.assertNotIn('/home/pi/wallpaper.jpg',value)
        self.assertEqual(value.count('exec /usr/local/bin/cranium-launch auto'),1)
        self.assertEqual(value.count('exec /usr/local/bin/cranium-media'),1)
        self.assertNotIn('exec devmon',value)
        self.assertNotIn('exec udiskie',value)
        self.assertNotIn('exec /usr/local/bin/cranium-osk-supervisor',value)
        self.assertEqual(kiosk.hardware_settings(value),kiosk.hardware_settings(kiosk.configure_sway(value)))

    def test_normal_mode_quarantines_foreign_windows_without_destroying_them(self):
        tree={'nodes':[{'id':1,'app_id':'org.mixxx.Mixxx','name':'CRANIUM','fullscreen_mode':0},
                       {'id':2,'app_id':'firefox','name':'untrusted "; exec anything','focused':True,'scratchpad_state':'none'}]}
        self.assertEqual(session.kiosk_actions(tree),['[con_id=2] move scratchpad','[con_id=1] fullscreen enable','[con_id=1] focus'])
        tree['nodes'][0].update(fullscreen_mode=1,focused=True)
        tree['nodes'][1].update(scratchpad_state='fresh',focused=False)
        self.assertEqual(session.kiosk_actions(tree),[])
        self.assertNotIn('kill',' '.join(session.kiosk_actions(tree)))

    def test_older_sway_scratchpad_tree_does_not_repeat_hide_commands(self):
        tree={'nodes':[{'type':'workspace','name':'__i3_scratch','floating_nodes':[
            {'id':2,'app_id':'foreign','name':'browser'}]},
            {'id':1,'app_id':'org.mixxx.Mixxx','name':'CRANIUM','fullscreen_mode':1,'focused':True}]}
        self.assertEqual(session.kiosk_actions(tree),[])

    def test_return_from_a_trial_relaunches_cranium_but_does_not_duplicate_it(self):
        with tempfile.TemporaryDirectory() as directory:
            for present in (True,False):
                tree={'nodes':[{'id':1,'app_id':'org.mixxx.Mixxx','name':'CRANIUM' if present else 'Mixxx'}]}
                with mock.patch.object(session,'RUNTIME',Path(directory)), \
                        mock.patch.object(session,'MARKER',Path(directory)/'developer'), \
                        mock.patch.object(session,'stop_bar'), mock.patch.object(session,'ipc'), \
                        mock.patch.object(session,'enforce'), \
                        mock.patch.object(session.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(tree))), \
                        mock.patch.object(session.subprocess,'Popen') as launch:
                    session.change_mode(False)
                    self.assertEqual(launch.call_count,0 if present else 1)

    def test_null_window_title_and_no_app_are_safe(self):
        self.assertEqual(session.kiosk_actions({'nodes':[{'app_id':'x','name':None}]}),[])

    def test_keyboard_stop_checks_process_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime=Path(directory)
            (runtime/'osk-supervisor.pid').write_text('123')
            with mock.patch.object(session,'RUNTIME',runtime), \
                    mock.patch.object(Path,'read_bytes',return_value=b'/usr/bin/unrelated\0'), \
                    mock.patch.object(session.os,'kill') as kill:
                session.keyboard_supervisor(False)
                kill.assert_not_called()
            with mock.patch.object(session,'RUNTIME',runtime), \
                    mock.patch.object(Path,'read_bytes',return_value=b'/usr/bin/python3\0/usr/local/bin/cranium-osk-supervisor\0'), \
                    mock.patch.object(session.os,'kill') as kill:
                session.keyboard_supervisor(False)
                kill.assert_called_once_with(123,session.signal.SIGTERM)

if __name__=='__main__':unittest.main(verbosity=2)
