"""Evaluate actual skin visibility against the three exclusive audio routes."""
from pathlib import Path
import xml.etree.ElementTree as ET
root=ET.parse(Path(__file__).resolve().parents[1]/'skins/XDJ_RX3_Mixxx/beffect.xml').getroot()
def labels(node,values,parent_visible=True):
    visible=parent_visible
    for connection in node.findall('Connection'):
        if connection.findtext('BindProperty')=='visible':
            value=bool(values.get(connection.findtext('ConfigKey'),0))
            if connection.find('Transform/Not') is not None:value=not value
            visible=visible and value
    result=[]
    name=node.findtext('ObjectName')
    if visible and name in ('RX3FxMaster','RX3FxChannel1','RX3FxChannel2'):
        result.append(node.findtext('Text') or node.findtext('State/Text'))
    for child in node:result.extend(labels(child,values,visible))
    return result
for route,label in (('Master','MASTER'),('Channel1','1'),('Channel2','2')):
    values={f'[EffectRack1_EffectUnit1],group_[{key}]_enable':int(key==route) for key in ('Master','Channel1','Channel2')}
    assert labels(root,values)==[label],(route,labels(root,values))
assert labels(root,{})==['MASTER'],'retain original master button when routing is disabled'
print('PASS: actual skin shows exactly MASTER / 1 / 2 for the matching audio routes')
